import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  EngineerWorkflowMemoryView, EngineerWorkflowReviewView, EngineerWorkflowResult,
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
  schemaVersion: 2
  sessions: Record<string, StoredNativeAgentSession>
  searches: Record<string, SearchEvent[]>
  workflows: Record<string, StoredEngineerWorkflow[]>
  reviews: Record<string, StoredEngineerWorkflowReview[]>
}

const MAX_SESSIONS_PER_PROJECT = 100
const MAX_MESSAGES = 500
const MAX_TOOLS = 300
const MAX_SEARCHES = 500
const MAX_WORKFLOWS = 100
const MAX_REVIEWS = 200
const clean = (value: unknown, max: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const now = (): string => new Date().toISOString()

export class NativeAgentStore {
  private readonly store: AtomicJsonStore<NativeAgentDatabase>

  constructor(dataRoot: string, private readonly id: () => string = randomUUID) {
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'native-agent.json'), {
      schemaVersion: 2,
      sessions: {},
      searches: {},
      workflows: {},
      reviews: {}
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
      }
      if ((legacy.schemaVersion !== 1 && legacy.schemaVersion !== 2) || !legacy.sessions || !legacy.searches) {
        return { schemaVersion: 2, sessions: {}, searches: {}, workflows: {}, reviews: {} }
      }
      database.schemaVersion = 2
      database.workflows = legacy.workflows && typeof legacy.workflows === 'object' ? legacy.workflows : {}
      database.reviews = legacy.reviews && typeof legacy.reviews === 'object' ? legacy.reviews : {}
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
      .map(({ messages, tools, externalSessionId, lastRequest, ...summary }) => summary)
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
  }): Promise<NativeAgentCompleteEvaluationResult> {
    const projectId = clean(input.projectId, 160)
    const sourceId = clean(input.sourceId, 160)
    if (!projectId || !sourceId) return { kind: 'ignored' }
    let result: NativeAgentCompleteEvaluationResult = { kind: 'ignored' }
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
        result = { kind: 'review', review: this.review(latestReview) }
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
        result = { kind: 'applied', memory: this.workflow(exact) }
        return
      }
      const priorReview = [...projectReviews].reverse().find((item) => item.sourceId === sourceId && item.fingerprint === fingerprint)
      if (priorReview) {
        if (priorReview.state === 'pending') result = { kind: 'review', review: this.review(priorReview) }
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
      result = { kind: 'review', review: this.review(review) }
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
