import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  EngineerBootProfileBindingView, EngineerCommandKnowledgeView, EngineerConsolePromptRuleView, EngineerEvaluationAttemptView, EngineerWorkflowMemoryView, EngineerWorkflowReviewView, EngineerWorkflowResult,
  NativeAgentBackend, NativeAgentCompleteEvaluationResult, NativeAgentMessageView, NativeAgentSearchEventInput,
  NativeAgentSessionStatus, NativeAgentSessionSummary, NativeAgentSessionView,
  NativeAgentToolTraceView, ProjectEvaluationDimensions
} from '../shared/contracts'
import { AtomicJsonStore } from './json-store'
import { buildEngineerWorkflowCandidate, engineerWorkflowSimilarity } from '../../src/domain/engineer-behavior'

export interface StoredNativeAgentSession extends NativeAgentSessionView {
  externalSessionId?: string
  lastRequest?: { content: string; sourceIds: string[] }
}

export interface SearchEvent extends NativeAgentSearchEventInput { id: string; occurredAt: string }
interface StoredEngineerWorkflow extends EngineerWorkflowMemoryView { fingerprint: string }
interface StoredEngineerWorkflowReview extends EngineerWorkflowReviewView {
  fingerprint: string
  dimensions?: Partial<ProjectEvaluationDimensions>
  searchEventIds: string[]
}
interface NativeAgentDatabase {
  schemaVersion: 5
  sessions: Record<string, StoredNativeAgentSession>
  searches: Record<string, SearchEvent[]>
  workflows: Record<string, StoredEngineerWorkflow[]>
  reviews: Record<string, StoredEngineerWorkflowReview[]>
  attempts: Record<string, EngineerEvaluationAttemptView[]>
  commandKnowledge: Record<string, EngineerCommandKnowledgeView[]>
  profileBindings: Record<string, EngineerBootProfileBindingView[]>
  consolePromptRules: Record<string, EngineerConsolePromptRuleView[]>
}

const MAX_SESSIONS_PER_PROJECT = 100
const MAX_MESSAGES = 500
const MAX_TOOLS = 300
const MAX_SEARCHES = 500
const MAX_WORKFLOWS = 100
const MAX_REVIEWS = 200
const MAX_ATTEMPTS = 5_000
const MAX_COMMAND_KNOWLEDGE = 500
const FAILURE_RESULTS = new Set<EngineerWorkflowResult>(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
const clean = (value: unknown, max: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const now = (): string => new Date().toISOString()

export class NativeAgentStore {
  private readonly store: AtomicJsonStore<NativeAgentDatabase>

  constructor(dataRoot: string, private readonly id: () => string = randomUUID) {
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'native-agent.json'), {
      schemaVersion: 5,
      sessions: {},
      searches: {},
      workflows: {},
      reviews: {},
      attempts: {},
      commandKnowledge: {},
      profileBindings: {},
      consolePromptRules: {}
    })
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    await this.store.update((database) => {
      const legacy = database as unknown as {
        schemaVersion?: number
        sessions?: NativeAgentDatabase['sessions']
        searches?: NativeAgentDatabase['searches']
        workflows?: NativeAgentDatabase['workflows']
        reviews?: NativeAgentDatabase['reviews']
        attempts?: NativeAgentDatabase['attempts']
        commandKnowledge?: NativeAgentDatabase['commandKnowledge']
        profileBindings?: NativeAgentDatabase['profileBindings']
        consolePromptRules?: NativeAgentDatabase['consolePromptRules']
      }
      if (![1, 2, 3, 4, 5].includes(legacy.schemaVersion ?? 0) || !legacy.sessions || !legacy.searches) {
        return { schemaVersion: 5, sessions: {}, searches: {}, workflows: {}, reviews: {}, attempts: {}, commandKnowledge: {}, profileBindings: {}, consolePromptRules: {} }
      }
      database.schemaVersion = 5
      database.workflows = legacy.workflows && typeof legacy.workflows === 'object' ? legacy.workflows : {}
      database.reviews = legacy.reviews && typeof legacy.reviews === 'object' ? legacy.reviews : {}
      database.attempts = legacy.attempts && typeof legacy.attempts === 'object' ? legacy.attempts : {}
      database.commandKnowledge = legacy.commandKnowledge && typeof legacy.commandKnowledge === 'object' ? legacy.commandKnowledge : {}
      database.profileBindings = legacy.profileBindings && typeof legacy.profileBindings === 'object' ? legacy.profileBindings : {}
      database.consolePromptRules = legacy.consolePromptRules && typeof legacy.consolePromptRules === 'object' ? legacy.consolePromptRules : {}
      for (const session of Object.values(database.sessions)) {
        if (session.status === 'queued' || session.status === 'running') {
          session.status = 'paused'
          session.failure = '앱이 종료되어 대기 중이던 분석을 멈췄습니다. 재시도할 수 있습니다.'
          session.updatedAt = now()
        }
      }
    })
  }

  async create(projectId: string, title: string, backend: NativeAgentBackend): Promise<StoredNativeAgentSession> {
    const stamp = now()
    const session: StoredNativeAgentSession = {
      id: this.id(), projectId: clean(projectId, 160), title: clean(title, 160) || '새 분석', backend,
      status: 'idle', createdAt: stamp, updatedAt: stamp, messages: [], tools: []
    }
    if (!session.projectId) throw new Error('프로젝트를 선택해 주세요.')
    await this.store.update((database) => {
      database.sessions[session.id] = session
      const all = Object.values(database.sessions)
        .filter((item) => item.projectId === session.projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      all.slice(MAX_SESSIONS_PER_PROJECT).forEach((item) => { delete database.sessions[item.id] })
    })
    return structuredClone(session)
  }

  async list(projectId: string): Promise<NativeAgentSessionSummary[]> {
    const wanted = clean(projectId, 160)
    const database = await this.store.read()
    return Object.values(database.sessions)
      .filter((session) => session.projectId === wanted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ messages, tools, question: _question, externalSessionId, lastRequest, ...summary }) => summary)
  }

  async get(sessionId: string): Promise<StoredNativeAgentSession | null> {
    const value = (await this.store.read()).sessions[clean(sessionId, 160)]
    return value ? structuredClone(value) : null
  }

  async update(
    sessionId: string,
    change: (session: StoredNativeAgentSession) => void
  ): Promise<StoredNativeAgentSession> {
    let result: StoredNativeAgentSession | undefined
    await this.store.update((database) => {
      const session = database.sessions[clean(sessionId, 160)]
      if (!session) throw new Error('에이전트 대화를 찾을 수 없습니다.')
      change(session)
      session.title = clean(session.title, 160) || '새 분석'
      session.failure = session.failure ? clean(session.failure, 500) : undefined
      session.messages = session.messages.slice(-MAX_MESSAGES).map(this.message)
      session.tools = session.tools.slice(-MAX_TOOLS).map(this.tool)
      if (session.question) {
        const base = {
          id: clean(session.question.id, 160), prompt: clean(session.question.prompt, 500),
          choices: session.question.choices.map((choice) => clean(choice, 160)).filter(Boolean).slice(0, 8),
        }
        if (session.question.kind === 'boot-profile') session.question = {
          ...base, kind: 'boot-profile',
          sourceIds: [...new Set(session.question.sourceIds.map((sourceId) => clean(sourceId, 160)).filter(Boolean))].slice(0, 100),
        }
        else if (session.question.kind === 'console-role') session.question = {
          ...base, kind: 'console-role', sourceId: clean(session.question.sourceId, 160),
          lineNumber: Number.isSafeInteger(session.question.lineNumber) && session.question.lineNumber > 0 ? session.question.lineNumber : 1,
          promptSignature: clean(session.question.promptSignature, 160), promptKind: clean(session.question.promptKind, 80), command: clean(session.question.command, 500),
        }
        else session.question = {
          ...base, kind: 'command-purpose', command: clean(session.question.command, 160),
          ...(session.question.bootProfileId ? { bootProfileId: clean(session.question.bootProfileId, 160) } : {}),
          ...(session.question.socModel ? { socModel: clean(session.question.socModel, 160) } : {}),
        }
      }
      session.updatedAt = now()
      session.lastMessage = [...session.messages].reverse().find((item) => item.role !== 'tool')?.content.slice(0, 160)
      result = structuredClone(session)
    })
    return result!
  }

  async appendMessage(sessionId: string, message: Omit<NativeAgentMessageView, 'id' | 'createdAt'>): Promise<StoredNativeAgentSession> {
    return this.update(sessionId, (session) => {
      session.messages.push(this.message({ ...message, id: this.id(), createdAt: now() }))
    })
  }

  async setStatus(sessionId: string, status: NativeAgentSessionStatus, failure?: string): Promise<StoredNativeAgentSession> {
    return this.update(sessionId, (session) => {
      session.status = status
      session.failure = failure ? clean(failure, 500) : undefined
    })
  }

  async recordSearch(input: NativeAgentSearchEventInput): Promise<void> {
    const projectId = clean(input.projectId, 160)
    const query = clean(input.query, 500)
    if (!projectId || !query || !Array.isArray(input.sourceIds)) return
    const sourceIds = [...new Set(input.sourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100)
    const activeSourceId = clean(input.activeSourceId, 160)
    const matchedSourceIds = [...new Set((input.matchedSourceIds ?? []).map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100)
    const event: SearchEvent = {
      id: this.id(), projectId, sourceIds, query,
      mode: input.mode === 'regex' ? 'regex' : 'literal', caseSensitive: input.caseSensitive === true,
      scope: input.scope === 'open' || input.scope === 'project' ? input.scope : 'current',
      matchCount: Number.isSafeInteger(input.matchCount) && input.matchCount >= 0 ? input.matchCount : 0,
      ...(activeSourceId ? { activeSourceId } : {}),
      ...(matchedSourceIds.length ? { matchedSourceIds } : {}),
      ...(Number.isSafeInteger(input.activeMatchCount) && input.activeMatchCount! >= 0 ? { activeMatchCount: input.activeMatchCount } : {}),
      occurredAt: now()
    }
    await this.store.update((database) => {
      const previous = database.searches[projectId] ?? []
      const last = previous[previous.length - 1]
      if (last && last.query === event.query && last.mode === event.mode && last.caseSensitive === event.caseSensitive
        && last.scope === event.scope && last.matchCount === event.matchCount && last.activeSourceId === event.activeSourceId
        && last.activeMatchCount === event.activeMatchCount
        && Date.parse(event.occurredAt) - Date.parse(last.occurredAt) < 10_000) return
      database.searches[projectId] = [...previous, event].slice(-MAX_SEARCHES)
    })
  }

  async searchHistory(projectId: string, limit = 30): Promise<SearchEvent[]> {
    const rows = (await this.store.read()).searches[clean(projectId, 160)] ?? []
    return rows.slice(-Math.min(Math.max(limit, 1), 100)).reverse()
  }

  async completeEvaluation(input: {
    projectId: string
    sourceId: string
    result: EngineerWorkflowResult
    evidenceLines?: number[]
    dimensions?: Partial<ProjectEvaluationDimensions>
    sequenceSignature?: string
    explicitRetest?: boolean
    filenameAttemptNo?: number
  }): Promise<NativeAgentCompleteEvaluationResult> {
    const projectId = clean(input.projectId, 160)
    const sourceId = clean(input.sourceId, 160)
    if (!projectId || !sourceId) return { kind: 'ignored' }
    const attempt = await this.recordAttempt({ ...input, projectId, sourceId })
    let result: NativeAgentCompleteEvaluationResult = { kind: 'ignored', attempt }
    await this.store.update((database) => {
      const projectReviews = database.reviews[projectId] ?? []
      const latestReview = [...projectReviews].reverse().find((item) => item.sourceId === sourceId)
      const allSearches = database.searches[projectId] ?? []
      const lastConsumedId = latestReview?.searchEventIds?.at(-1)
      const lastConsumedIndex = lastConsumedId ? allSearches.findIndex((event) => event.id === lastConsumedId) : -1
      const searches = allSearches.slice(lastConsumedIndex + 1).filter((event) => {
        const relevant = event.activeSourceId === sourceId
          || (!event.activeSourceId && event.sourceIds.length === 1 && event.sourceIds[0] === sourceId)
        return relevant && Date.parse(event.occurredAt) >= Date.now() - 8 * 60 * 60 * 1_000
      })
      if (!searches.length && latestReview?.state === 'pending') {
        result = { kind: 'review', review: this.review(latestReview), attempt }
        return
      }
      const candidate = buildEngineerWorkflowCandidate(searches, input.result, input.dimensions)
      if (!candidate) return
      const fingerprint = createHash('sha256').update(candidate.signature).digest('hex')
      const workflows = database.workflows[projectId] ?? []
      const exact = workflows.find((item) => item.fingerprint === fingerprint)
      const stamp = now()
      if (exact) {
        exact.appliedCount += 1
        exact.lastUsedAt = stamp
        exact.updatedAt = stamp
        exact.sourceIds = [...new Set([...exact.sourceIds, sourceId])].slice(-100)
        result = { kind: 'applied', memory: this.workflow(exact), attempt }
        return
      }
      const priorReview = [...projectReviews].reverse().find((item) => item.sourceId === sourceId && item.fingerprint === fingerprint)
      if (priorReview) {
        if (priorReview.state === 'pending') result = { kind: 'review', review: this.review(priorReview), attempt }
        if (priorReview.state !== 'dismissed' || Date.now() - Date.parse(priorReview.createdAt) < 7 * 24 * 60 * 60 * 1_000) return
      }
      const similar = workflows
        .map((memory) => ({ memory, score: engineerWorkflowSimilarity(candidate, memory) }))
        .filter((item) => item.score >= 0.45)
        .sort((a, b) => b.score - a.score)[0]?.memory
      const suggestions = [...new Set([...(similar ? [similar.purpose] : []), ...candidate.suggestions, '직접 입력'])].slice(0, 4)
      const review: StoredEngineerWorkflowReview = {
        id: this.id(), projectId, sourceId, result: input.result, stages: candidate.stages,
        checks: candidate.checks, evidenceLines: this.lines(input.evidenceLines), suggestions,
        ...(similar ? { similarMemoryId: similar.id } : {}),
        state: 'pending', createdAt: stamp, fingerprint,
        searchEventIds: searches.map((item) => item.id),
        ...(input.dimensions ? { dimensions: structuredClone(input.dimensions) } : {}),
      }
      database.reviews[projectId] = [...projectReviews, review].slice(-MAX_REVIEWS)
      result = { kind: 'review', review: this.review(review), attempt }
    })
    return result
  }

  async confirmWorkflow(projectIdValue: string, reviewIdValue: string, purposeValue: string): Promise<EngineerWorkflowMemoryView> {
    const projectId = clean(projectIdValue, 160)
    const reviewId = clean(reviewIdValue, 160)
    const purpose = clean(purposeValue, 160)
    if (!purpose || purpose === '직접 입력') throw new Error('평가 목적을 짧게 입력해 주세요.')
    let result: EngineerWorkflowMemoryView | undefined
    await this.store.update((database) => {
      const review = (database.reviews[projectId] ?? []).find((item) => item.id === reviewId)
      if (!review || review.projectId !== projectId) throw new Error('확인할 분석 절차를 찾을 수 없습니다.')
      const workflows = database.workflows[projectId] ?? []
      let memory = workflows.find((item) => item.fingerprint === review.fingerprint)
      const stamp = now()
      if (memory) {
        memory.confirmedCount += 1
        memory.purpose = purpose
        memory.name = purpose
        memory.updatedAt = stamp
        memory.sourceIds = [...new Set([...memory.sourceIds, review.sourceId])].slice(-100)
      } else {
        memory = {
          id: this.id(), projectId, name: purpose, purpose, stages: review.stages, checks: review.checks,
          result: review.result, sourceIds: [review.sourceId], evidenceLines: review.evidenceLines,
          ...(review.dimensions ? { dimensions: review.dimensions } : {}),
          confirmedCount: 1, appliedCount: 0, createdAt: stamp, updatedAt: stamp,
          fingerprint: review.fingerprint,
        }
        database.workflows[projectId] = [...workflows, memory].slice(-MAX_WORKFLOWS)
      }
      review.state = 'confirmed'
      result = this.workflow(memory)
    })
    return result!
  }

  async dismissWorkflow(projectIdValue: string, reviewIdValue: string): Promise<void> {
    const projectId = clean(projectIdValue, 160)
    const reviewId = clean(reviewIdValue, 160)
    await this.store.update((database) => {
      const review = (database.reviews[projectId] ?? []).find((item) => item.id === reviewId)
      if (!review || review.projectId !== projectId) throw new Error('확인할 분석 절차를 찾을 수 없습니다.')
      review.state = 'dismissed'
    })
  }

  async workflowMemories(projectId: string, limit = 50): Promise<EngineerWorkflowMemoryView[]> {
    const rows = (await this.store.read()).workflows[clean(projectId, 160)] ?? []
    return rows.slice(-Math.min(Math.max(limit, 1), 100)).reverse().map((item) => this.workflow(item))
  }

  async conversationHistory(projectId: string, limit = 20): Promise<Array<{
    sessionId: string; title: string; role: 'user' | 'assistant'; content: string; createdAt: string; evidenceSourceIds?: string[]
  }>> {
    const wanted = clean(projectId, 160)
    const database = await this.store.read()
    return Object.values(database.sessions)
      .filter((session) => session.projectId === wanted)
      .flatMap((session) => session.messages.flatMap((message) => message.role === 'user' || message.role === 'assistant'
        ? [{ sessionId: session.id, title: session.title, role: message.role, content: message.content, createdAt: message.createdAt, evidenceSourceIds: message.evidenceSourceIds }]
        : []))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-Math.min(Math.max(limit, 1), 50))
  }

  async attemptHistory(projectId: string, limit = 200): Promise<EngineerEvaluationAttemptView[]> {
    const rows = (await this.store.read()).attempts[clean(projectId, 160)] ?? []
    return rows.slice(-Math.min(Math.max(limit, 1), 500)).reverse().map((item) => structuredClone(item))
  }

  async commandKnowledge(projectId: string, limit = 200): Promise<EngineerCommandKnowledgeView[]> {
    const rows = (await this.store.read()).commandKnowledge[clean(projectId, 160)] ?? []
    return rows.slice(-Math.min(Math.max(limit, 1), 500)).reverse().map((item) => structuredClone(item))
  }

  async profileBindings(projectId: string): Promise<EngineerBootProfileBindingView[]> {
    return structuredClone((await this.store.read()).profileBindings[clean(projectId, 160)] ?? [])
  }

  async consolePromptRules(projectId: string): Promise<EngineerConsolePromptRuleView[]> {
    return structuredClone((await this.store.read()).consolePromptRules[clean(projectId, 160)] ?? [])
  }

  async confirmConsolePromptRule(input: { projectId: string; promptSignature: string; promptKind: string; role: 'input' | 'output' }): Promise<EngineerConsolePromptRuleView> {
    const projectId = clean(input.projectId, 160); const promptSignature = clean(input.promptSignature, 160); const promptKind = clean(input.promptKind, 80)
    if (!projectId || !promptSignature || !promptKind) throw new Error('콘솔 입력 형식을 확인할 수 없습니다.')
    let result: EngineerConsolePromptRuleView | undefined
    await this.store.update((database) => {
      const rows = database.consolePromptRules[projectId] ?? []
      const existing = rows.find((item) => item.promptSignature === promptSignature)
      const stamp = now()
      if (existing) {
        existing.promptKind = promptKind; existing.role = input.role; existing.confirmedCount += 1; existing.updatedAt = stamp
        result = structuredClone(existing)
      } else {
        result = { id: this.id(), projectId, promptSignature, promptKind, role: input.role, confirmedCount: 1, createdAt: stamp, updatedAt: stamp }
        database.consolePromptRules[projectId] = [...rows, result].slice(-100)
      }
    })
    return result!
  }

  async confirmProfileBinding(input: { projectId: string; sourceIds: string[]; vendor: 'qualcomm' | 'mediatek'; profileId: string }): Promise<EngineerBootProfileBindingView> {
    const projectId = clean(input.projectId, 160); const sourceIds = [...new Set(input.sourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100)
    const profileId = clean(input.profileId, 160)
    if (!projectId || !sourceIds.length || !profileId) throw new Error('SoC profile 확인 범위가 올바르지 않습니다.')
    let result: EngineerBootProfileBindingView | undefined
    await this.store.update((database) => {
      const rows = database.profileBindings[projectId] ?? []
      const retained = rows.filter((item) => !item.sourceIds.some((sourceId) => sourceIds.includes(sourceId)))
      result = { id: this.id(), projectId, vendor: input.vendor, profileId, sourceIds, confirmedAt: now() }
      database.profileBindings[projectId] = [...retained, result].slice(-200)
    })
    return result!
  }

  async confirmCommandKnowledge(input: { projectId: string; command: string; purpose: string; bootProfileId?: string; socModel?: string }): Promise<EngineerCommandKnowledgeView> {
    const projectId = clean(input.projectId, 160); const command = clean(input.command, 160); const purpose = clean(input.purpose, 240)
    if (!projectId || !command || !purpose) throw new Error('명령 목적을 입력해 주세요.')
    let result: EngineerCommandKnowledgeView | undefined
    await this.store.update((database) => {
      const rows = database.commandKnowledge[projectId] ?? []
      const scope = `${clean(input.bootProfileId, 160)}:${clean(input.socModel, 160)}`
      const existing = rows.find((item) => item.command.toLowerCase() === command.toLowerCase()
        && `${item.bootProfileId ?? ''}:${item.socModel ?? ''}` === scope)
      const stamp = now()
      if (existing) {
        existing.purpose = purpose; existing.confirmedCount += 1; existing.updatedAt = stamp; result = structuredClone(existing)
      } else {
        result = { id: this.id(), projectId, command, purpose, confirmedCount: 1, createdAt: stamp, updatedAt: stamp,
          ...(clean(input.bootProfileId, 160) ? { bootProfileId: clean(input.bootProfileId, 160) } : {}),
          ...(clean(input.socModel, 160) ? { socModel: clean(input.socModel, 160) } : {}) }
        database.commandKnowledge[projectId] = [...rows, result].slice(-MAX_COMMAND_KNOWLEDGE)
      }
    })
    return result!
  }

  private async recordAttempt(input: {
    projectId: string; sourceId: string; result: EngineerWorkflowResult; dimensions?: Partial<ProjectEvaluationDimensions>
    sequenceSignature?: string; explicitRetest?: boolean; filenameAttemptNo?: number
  }): Promise<EngineerEvaluationAttemptView> {
    let result: EngineerEvaluationAttemptView | undefined
    await this.store.update((database) => {
      const rows = database.attempts[input.projectId] ?? []
      const existingIndex = rows.findIndex((item) => item.sourceId === input.sourceId)
      const dimensions = structuredClone(input.dimensions ?? {})
      const signature = clean(input.sequenceSignature, 200)
      const identityKeys: Array<keyof ProjectEvaluationDimensions> = ['skew', 'lot', 'material', 'die']
      const related = rows.filter((item) => item.sourceId !== input.sourceId && signature && item.sequenceSignature === signature
        && Boolean(dimensions.sample) && item.dimensions.sample === dimensions.sample
        && identityKeys.every((key) => dimensions[key] === undefined || item.dimensions[key] === undefined || String(dimensions[key]) === String(item.dimensions[key])))
      const previous = related.at(-1)
      const requestedAttempt = Number.isSafeInteger(input.filenameAttemptNo) && input.filenameAttemptNo! > 0 ? input.filenameAttemptNo! : undefined
      const attemptNo = requestedAttempt ?? ((previous?.attemptNo ?? 0) + 1)
      const relation = input.explicitRetest
        ? previous && FAILURE_RESULTS.has(previous.result) ? 'retest' as const : 'unresolved-retest' as const
        : previous ? FAILURE_RESULTS.has(previous.result) ? 'retest' as const : 'repeat' as const : 'initial' as const
      const attempt: EngineerEvaluationAttemptView = {
        id: existingIndex >= 0 ? rows[existingIndex].id : this.id(), projectId: input.projectId, sourceId: input.sourceId,
        result: input.result, occurredAt: existingIndex >= 0 ? rows[existingIndex].occurredAt : now(), dimensions,
        ...(signature ? { sequenceSignature: signature } : {}), attemptNo, relation,
        ...(relation === 'retest' && previous ? { retestOf: previous.id } : {}),
      }
      if (existingIndex >= 0) rows[existingIndex] = attempt
      else rows.push(attempt)
      database.attempts[input.projectId] = rows.slice(-MAX_ATTEMPTS)
      result = structuredClone(attempt)
    })
    return result!
  }

  public(session: StoredNativeAgentSession): NativeAgentSessionView {
    const { externalSessionId, lastRequest, ...view } = structuredClone(session)
    return view
  }

  private message = (message: NativeAgentMessageView): NativeAgentMessageView => ({
    id: clean(message.id, 160), role: message.role, content: clean(message.content, 12_000),
    createdAt: clean(message.createdAt, 80),
    ...(message.toolTraceId ? { toolTraceId: clean(message.toolTraceId, 160) } : {}),
    ...(message.evidenceSourceIds?.length ? { evidenceSourceIds: [...new Set(message.evidenceSourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100) } : {})
  })

  private tool = (tool: NativeAgentToolTraceView): NativeAgentToolTraceView => ({
    id: clean(tool.id, 160), name: clean(tool.name, 100), label: clean(tool.label, 160), state: tool.state,
    startedAt: clean(tool.startedAt, 80), ...(tool.completedAt ? { completedAt: clean(tool.completedAt, 80) } : {}),
    ...(tool.summary ? { summary: clean(tool.summary, 1_000) } : {}),
    ...(tool.evidenceSourceIds?.length ? { evidenceSourceIds: [...new Set(tool.evidenceSourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100) } : {})
  })

  private lines(values: readonly number[] | undefined): number[] {
    return [...new Set((values ?? []).filter((value) => Number.isSafeInteger(value) && value > 0).map(Math.trunc))].slice(0, 40)
  }

  private workflow(value: StoredEngineerWorkflow): EngineerWorkflowMemoryView {
    const { fingerprint, ...view } = structuredClone(value)
    return view
  }

  private review(value: StoredEngineerWorkflowReview): EngineerWorkflowReviewView {
    const { fingerprint, dimensions, searchEventIds, ...view } = structuredClone(value)
    return view
  }
}
