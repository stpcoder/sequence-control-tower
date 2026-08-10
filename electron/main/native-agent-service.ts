import { randomUUID } from 'node:crypto'
import type {
  EngineerWorkflowMemoryView, NativeAgentBackendStatusView, NativeAgentCompleteEvaluationInput,
  NativeAgentCompleteEvaluationResult, NativeAgentConfirmWorkflowInput, NativeAgentDismissWorkflowInput,
  NativeAgentReuseKnowledgeInput, NativeAgentReuseKnowledgeResult,
  NativeAgentSearchEventInput, NativeAgentSessionSummary, NativeAgentSessionView
} from '../shared/contracts'
import type { OpenAiCompatibleClient } from './llm-service'
import type { ProjectStore } from './project-store'
import type { ArtifactService } from './artifact-service'
import { NativeAgentStore, type StoredNativeAgentSession } from './native-agent-store'
import {
  LPDDR_AGENT_TOOL_DESCRIPTIONS, type LpddrAgentToolCall, type LpddrAgentToolResult,
  sourceEngineeringContext, type LpddrAgentToolService
} from './lpddr-agent-tools'
import type { OpenCodeHost } from './opencode-host'
import { NATIVE_AGENT_SYSTEM_PROMPT } from './native-agent-prompt'

const safe = (value: unknown, max = 12_000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const now = (): string => new Date().toISOString()

function uniquePlan(calls: LpddrAgentToolCall[]): LpddrAgentToolCall[] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    const key = `${call.name}:${JSON.stringify(call.args ?? {})}`
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, 8)
}

/** Small built-in skill router used when OpenCode is not installed. It does
 * not pretend to reason about arithmetic: it only selects bounded SCT tools. */
export function planLpddrTools(content: string): LpddrAgentToolCall[] {
  const text = content.toLowerCase()
  const calls: LpddrAgentToolCall[] = [
    { name: 'project_context_get' }, { name: 'project_history_get' }
  ]
  if (/(새|올렸|파일|로그|무슨 평가|어떤 평가|조건|온도|vdd|전압|자재|sample|샘플|lot|주파수|skew|tm|mode|sub.?channel|rank|row|column)/i.test(text)) {
    calls.push({ name: 'filename_dimensions_scan' })
  }
  if (/(soc|퀄컴|qualcomm|미디어텍|mediatek|mtk|sm[-_ ]?\d|부팅|boot|pbl|xbl|abl|uefi|post.?pbl|lk2?)/i.test(text)) calls.push({ name: 'soc_boot_profile_scan' })
  if (/(콘솔|console|명령|command|입력|prompt|sleep|uefi\s*>|lk2?\s*>)/i.test(text)) calls.push({ name: 'console_transcript_scan' })
  if (/(pass|fail|불량|판정|reboot|halt|training|fast)/i.test(text)) calls.push({ name: 'pass_fail_scan' })
  if (/(새 로그|이 로그|무슨 평가|어떤 평가|pass|fail|판정|분석 절차|적용)/i.test(text)) calls.push({ name: 'engineer_workflow_apply' })
  if (/(경향|집중|불량률|dq|bl|channel|채널|sub.?channel|rank|bank|row|column|pattern|패턴|frequency|주파수|temperature|온도|vdd|전압|개선|비교)/i.test(text)) calls.push({ name: 'failure_trends_get' })
  if (/(과거|이전|유사|lpddr5|다음|추천|어떻게|시도)/i.test(text)) calls.push({ name: 'similar_case_search', args: { query: content.slice(0, 240) } })
  if (/(무슨 평가|어떤 평가|평가 목적|검색 기록|ctrl.?f|정규식|regex|찾아봤|분석 절차|boot|uefi|training|retest|\brt\b)/i.test(text)) {
    calls.push({ name: 'engineer_workflow_memory_get' })
  }
  if (/(검색 기록|ctrl.?f|정규식|regex|찾아봤)/i.test(text)) calls.push({ name: 'search_history_get' })
  const quoted = content.match(/[“"']([^”"']{2,120})[”"']/)?.[1]
  if (quoted && /(검색|찾|marker|문장|라인)/i.test(text)) calls.push({ name: 'log_search', args: { query: quoted, mode: /정규식|regex/i.test(text) ? 'regex' : 'literal' } })
  return uniquePlan(calls)
}

function fallbackSummary(results: LpddrAgentToolResult[]): string {
  const facts = results.filter((item) => item.summary).map((item) => `- ${item.label}: ${item.summary}`)
  return `확인된 사실\n${facts.join('\n') || '- 저장된 근거가 없습니다.'}\n\n추정 또는 미확인\n- LLM 응답을 받지 못해 인과관계와 다음 평가 제안은 보류했습니다. 아래 도구 결과는 로컬에서 계산된 값입니다.`
}

export function userFacingAgentContent(value: string): string {
  const content = safe(value)
  const visible = content.split('\n').filter((line) => !/(?:Maximum Steps|최대 분석 단계|tool budget|도구 예산)/i.test(line)).join('\n').trim()
  return visible || '확보한 근거 안에서 분석을 마쳤습니다. 미확인 항목은 확정하지 않았습니다.'
}

export function hasConfirmedWorkflowEvidence(results: readonly LpddrAgentToolResult[]): boolean {
  return results.some((result) => {
    if (result.name === 'engineer_workflow_memory_get') {
      return ((result.data as { confirmed?: unknown[] } | undefined)?.confirmed?.length ?? 0) > 0
    }
    if (result.name === 'engineer_workflow_apply') {
      return ((result.data as { rows?: unknown[] } | undefined)?.rows?.length ?? 0) > 0
    }
    return false
  })
}

/** A model may summarize raw Ctrl-F history, but it cannot promote that history to an engineer-confirmed workflow. */
export function enforceWorkflowProvenance(content: string, confirmedWorkflow: boolean): string {
  const visible = userFacingAgentContent(content)
  if (confirmedWorkflow) return visible
  return visible
    .replace(/엔지니어가\s*확정한\s*(검색\s*)?순서/gi, '최근 검색에서 관찰된 미확정 $1순서')
    .replace(/엔지니어\s*확정\s*(검색\s*)?절차/gi, '미확정 $1절차')
}

export class NativeAgentService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<(session: NativeAgentSessionView) => void>()

  constructor(private readonly deps: {
    store: NativeAgentStore
    tools: LpddrAgentToolService
    projects: Pick<ProjectStore, 'get'>
    artifacts: Pick<ArtifactService, 'list'>
    llm: Pick<OpenAiCompatibleClient, 'complete'>
    opencode: OpenCodeHost
  }) {}

  async initialize(): Promise<void> { await this.deps.store.initialize() }

  onUpdate(listener: (session: NativeAgentSessionView) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }

  async backendStatus(): Promise<NativeAgentBackendStatusView> {
    const opencodeAvailable = await this.deps.opencode.available()
    return {
      preferred: 'opencode', active: opencodeAvailable ? 'opencode' : 'internal', opencodeAvailable,
      detail: opencodeAvailable
        ? 'OpenCode headless harness · SCT 읽기 전용 도구 · 내부 LLM'
        : '내장 bounded harness · SCT 읽기 전용 도구 · OpenCode 설치 시 자동 전환'
    }
  }

  async create(projectId: string, title?: string): Promise<NativeAgentSessionView> {
    const project = await this.deps.projects.get(safe(projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const backend = (await this.deps.opencode.available()) ? 'opencode' : 'internal'
    let session = await this.deps.store.create(project.id, safe(title, 160) || `${project.name} 분석`, backend)
    if (project.artifacts.length) {
      const sourceIds = project.artifacts.slice(0, 100).map((item) => item.sourceId)
      try {
        const [filenames, statuses, workflows, boot, consoleScan] = await Promise.all([
          this.deps.tools.execute(project.id, { name: 'filename_dimensions_scan' }, sourceIds),
          this.deps.tools.execute(project.id, { name: 'pass_fail_scan' }, sourceIds),
          this.deps.tools.execute(project.id, { name: 'engineer_workflow_memory_get' }, sourceIds),
          this.deps.tools.execute(project.id, { name: 'soc_boot_profile_scan' }, sourceIds),
          this.deps.tools.execute(project.id, { name: 'console_transcript_scan' }, sourceIds),
        ])
        session = await this.deps.store.update(session.id, (draft) => {
          for (const result of [filenames, statuses, workflows, boot, consoleScan]) draft.tools.push({ id: randomUUID(), name: result.name, label: result.label, state: 'completed', startedAt: now(), completedAt: now(), summary: result.summary, evidenceSourceIds: result.evidenceSourceIds })
        })
        session = await this.deps.store.appendMessage(session.id, {
          role: 'assistant', content: this.onboardingQuestion(filenames, statuses, workflows, boot, consoleScan),
          evidenceSourceIds: [...new Set([...filenames.evidenceSourceIds, ...statuses.evidenceSourceIds, ...workflows.evidenceSourceIds])]
        })
        const question = this.profileQuestion(filenames) ?? this.consoleQuestion(consoleScan) ?? await this.commandQuestion(project.id, filenames)
        if (question) session = await this.deps.store.update(session.id, (draft) => { draft.question = question })
      } catch {
        session = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `프로젝트 로그 ${project.artifacts.length}개가 연결되어 있습니다. 평가 목적을 적으면 조건과 Pass/Fail marker부터 확인하겠습니다.` })
      }
    } else {
      session = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: '프로젝트에 로그를 연결하면 파일명 조건, Pass/Fail marker, 과거 평가 이력을 함께 확인할 수 있습니다.' })
    }
    return this.public(session)
  }

  list(projectId: string): Promise<NativeAgentSessionSummary[]> { return this.deps.store.list(projectId) }

  async get(sessionId: string): Promise<NativeAgentSessionView | null> {
    const session = await this.deps.store.get(sessionId)
    return session ? this.public(session) : null
  }

  async send(sessionId: string, content: string, requestedSourceIds?: string[]): Promise<NativeAgentSessionView> {
    const session = await this.require(sessionId)
    if (session.status === 'queued' || session.status === 'running') throw new Error('현재 분석이 끝난 후 다시 보내 주세요.')
    const message = safe(content, 4_000)
    if (!message) throw new Error('메시지를 입력해 주세요.')
    if (session.question?.kind === 'boot-profile') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message })
      if (message === '미확인으로 유지' || message === '건너뛰기') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: 'SoC profile을 확정하지 않았습니다. 해당 로그는 미확인 상태로 유지합니다.' })
        this.emit(next); return this.public(next)
      }
      const vendor = message.startsWith('Qualcomm') ? 'qualcomm' : message.startsWith('MediaTek') ? 'mediatek' : null
      if (!vendor) throw new Error('Qualcomm 또는 MediaTek profile을 선택해 주세요.')
      await this.deps.store.confirmProfileBinding({ projectId: session.projectId, sourceIds: session.question.sourceIds, vendor, profileId: vendor === 'qualcomm' ? 'qualcomm-default' : 'mediatek-default' })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
      next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `${vendor === 'qualcomm' ? 'Qualcomm · UEFI' : 'MediaTek · Post-PBL/LK'} profile로 저장했습니다. 다음 분석부터 해당 부팅 단계를 사용합니다.` })
      this.emit(next); return this.public(next)
    }
    if (session.question?.kind === 'console-role') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message })
      if (message === '건너뛰기') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: '이 줄은 분류하지 않았습니다.' })
        this.emit(next); return this.public(next)
      }
      const rememberedRole = message === '입력 명령 · 형식 기억' ? 'input' : message === '장비 출력 · 형식 제외' ? 'output' : null
      if (!rememberedRole && message !== '이번 줄만 입력') throw new Error('이 줄이 입력인지 출력인지 선택해 주세요.')
      if (rememberedRole) await this.deps.store.confirmConsolePromptRule({
        projectId: session.projectId, promptSignature: session.question.promptSignature,
        promptKind: session.question.promptKind, role: rememberedRole,
      })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
      let following: NativeAgentSessionView['question'] | undefined
      if (rememberedRole) {
        const project = await this.deps.projects.get(session.projectId)
        if (project?.artifacts.length) {
          const scan = await this.deps.tools.execute(session.projectId, { name: 'console_transcript_scan' }, project.artifacts.slice(0, 100).map((item) => item.sourceId))
          following = this.consoleQuestion(scan)
        }
      }
      next = await this.deps.store.appendMessage(session.id, {
        role: 'assistant',
        content: rememberedRole === 'input'
          ? `입력 형식을 저장했습니다.${following ? ' 다른 형식 하나만 더 확인해 주세요.' : ' 다음 로그부터 명령만 수집합니다.'}`
          : rememberedRole === 'output'
            ? `출력 형식으로 저장했습니다.${following ? ' 다른 형식 하나만 더 확인해 주세요.' : ''}`
            : '이번 줄만 입력 명령으로 확인했습니다.',
      })
      if (following) next = await this.deps.store.update(session.id, (draft) => { draft.question = following })
      this.emit(next); return this.public(next)
    }
    if (session.question?.kind === 'command-purpose') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message })
      if (message === '건너뛰기') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: '명령 목적을 저장하지 않았습니다.' })
        this.emit(next); return this.public(next)
      }
      const knowledge = await this.deps.store.confirmCommandKnowledge({
        projectId: session.projectId, command: session.question.command, purpose: message,
        bootProfileId: session.question.bootProfileId, socModel: session.question.socModel,
      })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = undefined })
      next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `${knowledge.command} 목적을 “${knowledge.purpose}”로 저장했습니다. 같은 프로젝트와 SoC 조건에서 다음 분석에 재사용합니다.` })
      this.emit(next); return this.public(next)
    }
    const sourceIds = await this.authorize(session.projectId, requestedSourceIds)
    const project = await this.deps.projects.get(session.projectId)
    let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message })
    next = await this.deps.store.update(session.id, (draft) => {
      draft.status = 'queued'; draft.failure = undefined; draft.lastRequest = { content: message, sourceIds }
      if (draft.messages.filter((item) => item.role === 'user').length === 1 || (project && draft.title === `${project.name} 분석`)) draft.title = message.slice(0, 48)
    })
    this.emit(next)
    queueMicrotask(() => { void this.run(next.id) })
    return this.public(next)
  }

  async retry(sessionId: string): Promise<NativeAgentSessionView> {
    const session = await this.require(sessionId)
    if (!session.lastRequest) throw new Error('재시도할 요청이 없습니다.')
    if (session.status === 'queued' || session.status === 'running') return this.public(session)
    const next = await this.deps.store.setStatus(session.id, 'queued')
    this.emit(next); queueMicrotask(() => { void this.run(next.id) })
    return this.public(next)
  }

  async cancel(sessionId: string): Promise<NativeAgentSessionView> {
    const session = await this.require(sessionId)
    this.controllers.get(session.id)?.abort()
    if (session.externalSessionId) await this.deps.opencode.abort(session.externalSessionId)
    let next = await this.deps.store.setStatus(session.id, 'idle')
    next = await this.deps.store.appendMessage(session.id, { role: 'system', content: '사용자가 분석을 중지했습니다.' })
    this.emit(next); return this.public(next)
  }

  async recordSearch(input: NativeAgentSearchEventInput): Promise<void> {
    const project = await this.deps.projects.get(safe(input.projectId, 160))
    if (!project) return
    const allowed = new Set(project.artifacts.map((item) => item.sourceId))
    if (input.sourceIds.some((item) => !allowed.has(item))) throw new Error('프로젝트 검색 범위가 올바르지 않습니다.')
    if (input.activeSourceId && !allowed.has(input.activeSourceId)) throw new Error('현재 로그가 프로젝트 범위에 없습니다.')
    if (input.matchedSourceIds?.some((item) => !allowed.has(item))) throw new Error('검색 결과 범위가 올바르지 않습니다.')
    if (input.activeSourceId && !input.sourceIds.includes(input.activeSourceId)) throw new Error('현재 로그가 검색 범위에 없습니다.')
    if (input.matchedSourceIds?.some((item) => !input.sourceIds.includes(item))) throw new Error('검색 결과가 검색 범위에 없습니다.')
    await this.deps.store.recordSearch(input)
  }

  async completeEvaluation(input: NativeAgentCompleteEvaluationInput): Promise<NativeAgentCompleteEvaluationResult> {
    const project = await this.deps.projects.get(safe(input.projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const sourceId = safe(input.sourceId, 160)
    const source = project.artifacts.find((item) => item.sourceId === sourceId)
    if (!source) throw new Error('현재 로그가 프로젝트 범위에 없습니다.')
    const results = new Set(['PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED'])
    if (!results.has(input.result)) throw new Error('판정 결과가 올바르지 않습니다.')
    const artifact = (await this.deps.artifacts.list()).find((item) => item.id === source.artifactId)
    const context = sourceEngineeringContext(source.relativePath, artifact, project.equipmentProfiles)
    return this.deps.store.completeEvaluation({
      projectId: project.id,
      sourceId,
      result: input.result,
      evidenceLines: input.evidenceLines,
      dimensions: context.dimensions,
      sequenceSignature: context.sequenceSignature,
      explicitRetest: context.explicitRetest,
      filenameAttemptNo: context.filenameAttemptNo,
      workflowSelection: input.workflowSelection?.slice(0, 20).map((check) => ({
        query: safe(check.query, 500), mode: check.mode === 'regex' ? 'regex' as const : 'literal' as const, caseSensitive: check.caseSensitive === true,
      })).filter((check) => check.query.length >= 2),
    })
  }

  async confirmWorkflow(input: NativeAgentConfirmWorkflowInput): Promise<EngineerWorkflowMemoryView> {
    const project = await this.deps.projects.get(safe(input.projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    return this.deps.store.confirmWorkflow(project.id, input.reviewId, input.purpose, input.checks)
  }

  async dismissWorkflow(input: NativeAgentDismissWorkflowInput): Promise<void> {
    const project = await this.deps.projects.get(safe(input.projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    await this.deps.store.dismissWorkflow(project.id, input.reviewId)
  }

  async listWorkflows(projectId: string): Promise<EngineerWorkflowMemoryView[]> {
    const project = await this.deps.projects.get(safe(projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    return this.deps.store.workflowMemories(project.id)
  }

  async reuseConfirmedKnowledge(input: NativeAgentReuseKnowledgeInput): Promise<NativeAgentReuseKnowledgeResult> {
    const [source, target] = await Promise.all([
      this.deps.projects.get(safe(input.sourceProjectId, 160)),
      this.deps.projects.get(safe(input.targetProjectId, 160)),
    ])
    if (!source || !target) throw new Error('재사용할 프로젝트를 찾을 수 없습니다.')
    return this.deps.store.reuseConfirmedKnowledge(source.id, target.id)
  }

  close(): void { this.controllers.forEach((controller) => controller.abort()); this.deps.opencode.close() }

  private async run(sessionId: string): Promise<void> {
    const controller = new AbortController(); this.controllers.set(sessionId, controller)
    try {
      let session = await this.require(sessionId)
      if (!session.lastRequest) throw new Error('분석 요청이 없습니다.')
      const lastRequest = session.lastRequest
      session = await this.deps.store.setStatus(session.id, 'running'); this.emit(session)
      if (session.backend === 'opencode') {
        try {
          const response = await this.deps.opencode.send({
            externalSessionId: session.externalSessionId, projectId: session.projectId,
            sourceIds: lastRequest.sourceIds, title: session.title, content: lastRequest.content
          })
          session = await this.deps.store.update(session.id, (draft) => {
            draft.externalSessionId = response.externalSessionId
            for (const name of response.toolNames.slice(0, 20)) draft.tools.push({ id: randomUUID(), name, label: name, state: 'completed', startedAt: now(), completedAt: now() })
          })
          session = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: userFacingAgentContent(response.content) })
          session = await this.deps.store.setStatus(session.id, 'idle'); this.emit(session); return
        } catch (error) {
          if (controller.signal.aborted) throw error
          session = await this.deps.store.update(session.id, (draft) => { draft.backend = 'internal' })
          this.emit(session)
        }
      }
      await this.runInternal(session.id, controller.signal)
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted ? undefined : this.failure(error)
      const session = await this.deps.store.setStatus(sessionId, aborted ? 'idle' : 'paused', message).catch(() => null)
      if (session) this.emit(session)
    } finally {
      if (this.controllers.get(sessionId) === controller) this.controllers.delete(sessionId)
    }
  }

  private async runInternal(sessionId: string, signal: AbortSignal): Promise<void> {
    let session = await this.require(sessionId)
    const request = session.lastRequest!
    const results: LpddrAgentToolResult[] = []
    for (const call of planLpddrTools(request.content)) {
      if (signal.aborted) throw new Error('ABORTED')
      const traceId = randomUUID()
      session = await this.deps.store.update(session.id, (draft) => {
        draft.tools.push({ id: traceId, name: call.name, label: LPDDR_AGENT_TOOL_DESCRIPTIONS[call.name].split('.')[0], state: 'running', startedAt: now() })
      }); this.emit(session)
      try {
        const result = await this.deps.tools.execute(session.projectId, call, request.sourceIds)
        results.push(result)
        session = await this.deps.store.update(session.id, (draft) => {
          const trace = draft.tools.find((item) => item.id === traceId)
          if (trace) { trace.state = 'completed'; trace.completedAt = now(); trace.summary = result.summary; trace.evidenceSourceIds = result.evidenceSourceIds }
        }); this.emit(session)
      } catch (error) {
        session = await this.deps.store.update(session.id, (draft) => {
          const trace = draft.tools.find((item) => item.id === traceId)
          if (trace) { trace.state = 'failed'; trace.completedAt = now(); trace.summary = this.failure(error) }
        }); this.emit(session)
      }
    }
    const conversation = session.messages.filter((item) => item.role === 'user' || item.role === 'assistant').slice(-12).map((item) => `${item.role}: ${item.content}`).join('\n')
    const evidence = results.map((item) => ({ tool: item.name, summary: item.summary, data: item.data, sourceIds: item.evidenceSourceIds })).slice(0, 6)
    const confirmedWorkflow = hasConfirmedWorkflowEvidence(results)
    const workflowInstruction = confirmedWorkflow
      ? '확정 분석 절차 상태: 있음. 도구가 반환한 절차만 엔지니어 확정으로 표현하십시오.'
      : '확정 분석 절차 상태: 없음. Ctrl-F 기록이나 대화에 순서가 보여도 엔지니어 확정이라고 쓰지 말고 “최근 검색에서 관찰된 미확정 순서”로 표시하십시오.'
    const prompt = `${NATIVE_AGENT_SYSTEM_PROMPT}\n\n대화 기록:\n${conversation.slice(-12_000)}\n\n도구 실행 결과(JSON):\n${JSON.stringify(evidence).slice(0, 24_000)}\n\n${workflowInstruction}\n현재 사용자 요청에 답하십시오. tool output에 없는 수치나 인과관계를 만들지 마십시오.`
    try {
      const completed = await this.deps.llm.complete(prompt, signal, () => undefined)
      session = await this.deps.store.appendMessage(session.id, {
        role: 'assistant', content: enforceWorkflowProvenance(completed.content, confirmedWorkflow),
        evidenceSourceIds: [...new Set(results.flatMap((item) => item.evidenceSourceIds))]
      })
      session = await this.deps.store.setStatus(session.id, 'idle'); this.emit(session)
    } catch (error) {
      if (signal.aborted) throw error
      session = await this.deps.store.appendMessage(session.id, {
        role: 'assistant', content: fallbackSummary(results),
        evidenceSourceIds: [...new Set(results.flatMap((item) => item.evidenceSourceIds))]
      })
      session = await this.deps.store.setStatus(session.id, 'paused', `${this.failure(error)} · 로컬 도구 결과는 보존되었습니다.`)
      this.emit(session)
    }
  }

  private async authorize(projectId: string, requested?: string[]): Promise<string[]> {
    const project = await this.deps.projects.get(projectId)
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const wanted = requested?.length ? [...new Set(requested.map((item) => safe(item, 160)).filter(Boolean))] : project.artifacts.slice(0, 100).map((item) => item.sourceId)
    const allowed = new Set(project.artifacts.map((item) => item.sourceId))
    if (wanted.length > 100 || wanted.some((item) => !allowed.has(item))) throw new Error('프로젝트 로그 범위가 올바르지 않습니다.')
    return wanted
  }

  private async require(sessionId: string): Promise<StoredNativeAgentSession> {
    const session = await this.deps.store.get(safe(sessionId, 160))
    if (!session) throw new Error('에이전트 대화를 찾을 수 없습니다.')
    return session
  }

  private emit(session: StoredNativeAgentSession): void {
    const view = this.public(session); this.listeners.forEach((listener) => listener(view))
  }
  private public(session: StoredNativeAgentSession): NativeAgentSessionView { return this.deps.store.public(session) }
  private failure(error: unknown): string {
    const raw = error instanceof Error ? error.message : 'AGENT_FAILED'
    if (/timeout|429|LLM_REQUEST_TIMEOUT/i.test(raw)) return '사내 LLM 응답이 늦거나 사용량 제한에 도달했습니다.'
    if (/LLM_UNAVAILABLE/i.test(raw)) return '설정에서 LLM 주소와 모델을 연결해 주세요.'
    if (/OPENCODE/i.test(raw)) return 'OpenCode harness를 시작하지 못해 내장 분석으로 전환했습니다.'
    return safe(raw, 300) || '에이전트 분석을 완료하지 못했습니다.'
  }

  private onboardingQuestion(filenames: LpddrAgentToolResult, statuses: LpddrAgentToolResult, workflows: LpddrAgentToolResult, boot: LpddrAgentToolResult, consoleScan: LpddrAgentToolResult): string {
    const rows = (filenames.data as { rows?: Array<{ dimensions?: Record<string, unknown> }> })?.rows ?? []
    const dimensions = ['testMode', 'temperatureC', 'vdd', 'material', 'dq', 'pattern'] as const
    const leaders = dimensions.flatMap((dimension) => {
      const counts = new Map<string, number>()
      rows.forEach((row) => {
        const value = row.dimensions?.[dimension]
        if (value !== undefined && value !== '') counts.set(String(value), (counts.get(String(value)) ?? 0) + 1)
      })
      const first = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      if (!first) return []
      const label = dimension === 'temperatureC' ? `${first[0]}°C` : dimension === 'vdd' ? `VDD ${first[0]}V` : dimension === 'dq' ? `DQ${first[0]}` : first[0]
      return first[1] >= 2 ? [label] : []
    }).slice(0, 4)
    const remembered = (workflows.data as { confirmed?: unknown[] })?.confirmed?.length ?? 0
    return `파일명, 콘솔 입력과 종료 marker를 확인했습니다.\n${filenames.summary}\n${boot.summary}\n${consoleScan.summary}\n${statuses.summary || '확정 상태 없음'}${remembered ? `\n저장된 분석 절차 ${remembered}개를 함께 확인합니다.` : ''}\n\n${leaders.length ? `${leaders.join(' · ')} 조건이 반복됩니다. 어떤 목적의 평가인가요?` : '이번 평가 목적을 짧게 적어주세요.'}`
  }

  private consoleQuestion(scan: LpddrAgentToolResult): NativeAgentSessionView['question'] | undefined {
    const row = (scan.data as { ambiguous?: Array<{ sourceId?: string; lineNumber?: number; promptSignature?: string; promptKind?: string; command?: string }> })?.ambiguous?.[0]
    if (!row?.sourceId || !row.promptSignature || !row.promptKind || !row.command || !Number.isSafeInteger(row.lineNumber)) return undefined
    return {
      id: `console-${randomUUID()}`, kind: 'console-role', sourceId: row.sourceId, lineNumber: row.lineNumber!,
      promptSignature: row.promptSignature, promptKind: row.promptKind, command: safe(row.command, 500),
      prompt: `“${safe(row.command, 120)}”은 엔지니어가 입력한 명령인가요?`,
      choices: ['입력 명령 · 형식 기억', '이번 줄만 입력', '장비 출력 · 형식 제외', '건너뛰기'],
    }
  }

  private async commandQuestion(projectId: string, filenames: LpddrAgentToolResult): Promise<NativeAgentSessionView['question'] | undefined> {
    const known = await this.deps.store.commandKnowledge(projectId, 500)
    const keys = new Set(known.map((item) => `${item.command.toLowerCase()}:${item.bootProfileId ?? ''}:${item.socModel ?? ''}`))
    const rows = (filenames.data as { rows?: Array<{ commandSignatures?: string[]; dimensions?: { bootProfileId?: string; socModel?: string } }> })?.rows ?? []
    for (const row of rows) {
      for (const command of row.commandSignatures ?? []) {
        const key = `${command.toLowerCase()}:${row.dimensions?.bootProfileId ?? ''}:${row.dimensions?.socModel ?? ''}`
        if (keys.has(key) || /^unclassified:/i.test(command) || /^shell:(?:unknown|\[?\d)/i.test(command)) continue
        return {
          id: `command-${randomUUID()}`, kind: 'command-purpose', command,
          prompt: `${command} 명령이 처음 확인되었습니다. 어떤 목적으로 사용했나요?`,
          choices: ['부팅 단계 확인', 'Training 조건 설정', '불량 가속 조건 탐색', '개선 조건 검증', 'Screening', '직접 입력', '건너뛰기'],
          ...(row.dimensions?.bootProfileId ? { bootProfileId: row.dimensions.bootProfileId } : {}),
          ...(row.dimensions?.socModel ? { socModel: row.dimensions.socModel } : {}),
        }
      }
    }
    return undefined
  }

  private profileQuestion(filenames: LpddrAgentToolResult): NativeAgentSessionView['question'] | undefined {
    const rows = (filenames.data as { rows?: Array<{ sourceId?: string; dimensions?: { socVendor?: string } }> })?.rows ?? []
    const unknown = rows.filter((row) => !row.dimensions?.socVendor).flatMap((row) => row.sourceId ? [row.sourceId] : []).slice(0, 100)
    if (!unknown.length) return undefined
    return {
      id: `profile-${randomUUID()}`, kind: 'boot-profile', sourceIds: unknown,
      prompt: `SoC profile을 확인하지 못한 로그 ${unknown.length}개가 있습니다. 어떤 부팅 계열인가요?`,
      choices: ['Qualcomm · UEFI', 'MediaTek · Post-PBL/LK', '미확인으로 유지'],
    }
  }
}
