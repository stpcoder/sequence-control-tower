import { randomUUID } from 'node:crypto'
import type {
  EngineerWorkflowMemoryView, NativeAgentBackendStatusView, NativeAgentCompleteEvaluationInput,
  NativeAgentCompleteEvaluationResult, NativeAgentConfirmWorkflowInput, NativeAgentDismissWorkflowInput,
  NativeAgentReuseKnowledgeInput, NativeAgentReuseKnowledgeResult,
  NativeAgentContextKind, NativeAgentSearchEventInput, NativeAgentSessionSummary, NativeAgentSessionView, ProjectSnapshot
} from '../shared/contracts'
import type { OpenAiCompatibleClient } from './llm-service'
import type { ProjectStore } from './project-store'
import type { ArtifactService } from './artifact-service'
import { NativeAgentStore, type StoredNativeAgentSession } from './native-agent-store'
import {
  LPDDR_AGENT_TOOL_DESCRIPTIONS, type LpddrAgentToolCall, type LpddrAgentToolName, type LpddrAgentToolResult,
  sourceEngineeringContext, type LpddrAgentToolService
} from './lpddr-agent-tools'
import type { OpenCodeHost } from './opencode-host'
import type { SctMcpToolTrace } from './sct-mcp-server'
import { NATIVE_AGENT_SYSTEM_PROMPT } from './native-agent-prompt'
import { hasMeaningfulAgentMessage } from '../../src/domain/agent-message'
import { extractAnalysisViewProposal } from '../../src/domain/agent-analysis-view'

const MAX_AGENT_SOURCE_SCOPE = 32

const safe = (value: unknown, max = 12_000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const now = (): string => new Date().toISOString()
const CONTEXT_KINDS = new Set<NativeAgentContextKind>(['free_chat', 'log_search', 'results', 'analysis_view', 'evaluation_history', 'project_compare'])
const contextKind = (value: unknown): NativeAgentContextKind | undefined => typeof value === 'string' && CONTEXT_KINDS.has(value as NativeAgentContextKind) ? value as NativeAgentContextKind : undefined

const EVALUATION_PURPOSE_LABELS: Record<string, string> = {
  screening: '불량 검출 강화',
  improvement: '개선 조건 확인',
  reproduction: '동일 불량 재현',
  characterization: '불량 경향 파악',
  verification: '개선 효과 검증',
  'stage-verification': '부팅·Training 확인',
}

function confirmedEvaluationLabel(node: NonNullable<ProjectSnapshot['evaluationNodes']>[number] | undefined): string {
  if (!node) return ''
  const name = safe(node.name, 400)
  const genericName = /^(?:agent proposal|screening|improvement|reproduction|characterization|verification|stage-verification)$/i.test(name)
  return (!genericName && name) || EVALUATION_PURPOSE_LABELS[node.purpose ?? ''] || name
}

function uniquePlan(calls: LpddrAgentToolCall[]): LpddrAgentToolCall[] {
  const seen = new Set<string>()
  return calls.filter((call) => {
    const key = `${call.name}:${JSON.stringify(call.args ?? {})}`
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, 8)
}

export function isStandardCommandSignature(command: string): boolean {
  return [
    /^shell:stressapptest(?:\b|$)/i,
    /^diagnostic:(?:hdiag|diag)(?:\b|$)/i,
    /^shell:set_freq(?:\b|$)/i,
    /^voltage-control:set_rail(?:\b|$)/i,
    /^(?:sleep|wait)\s+\d+(?:\b|$)/i,
    /^(?:uefi|lk|shell):(?:exit|reboot|reset|poweroff)(?:\b|$)/i,
  ].some((pattern) => pattern.test(command.trim()))
}

export function openCodeToolPresentation(rawName: string): { name: string; label: string } {
  if (safe(rawName, 120).toLowerCase() === 'skill:lpddr-failure-analysis') {
    return { name: 'skill:lpddr-failure-analysis', label: 'LPDDR 분석 기준' }
  }
  const name = safe(rawName, 100).replace(/^sct_/, '') as keyof typeof LPDDR_AGENT_TOOL_DESCRIPTIONS
  const labels: Partial<Record<keyof typeof LPDDR_AGENT_TOOL_DESCRIPTIONS, string>> = {
    project_context_get: '프로젝트 조건', project_history_get: '이전 평가', evaluation_relation_suggest: '평가 관계 제안', similar_case_search: '유사 사례',
    search_history_get: '검색 기록', engineer_workflow_memory_get: '확정 분석 절차', engineer_workflow_apply: '분석 절차 적용',
    filename_dimensions_scan: '파일명 조건', soc_boot_profile_scan: '부팅 단계', console_transcript_scan: '입력 명령',
    pass_fail_scan: 'Pass/Fail 판정', evaluation_grid_scan: 'Grid · Sequence', log_search: '로그 검색', log_read_window: '근거 구간', failure_trends_get: '조건별 경향',
  }
  return { name, label: labels[name] ?? 'Agent 근거 확인' }
}

/** Small built-in skill router used when OpenCode is not installed. It does
 * not pretend to reason about arithmetic: it only selects bounded SCT tools. */
export function planLpddrTools(content: string): LpddrAgentToolCall[] {
  const text = content.toLowerCase()
  const calls: LpddrAgentToolCall[] = [
    { name: 'project_context_get' }, { name: 'project_history_get' }
  ]
  const relationIntent = /(브랜치|이력\s*(?:연결|관계)|어느\s*(?:불량|이슈)|같은\s*불량|별도\s*불량|retest|\brt\b|재현|가속|개선|side\s*effect|(?:평가|효과)\s*검증|검증\s*평가)/i.test(text)
  const workflowIntent = /(무슨 평가|어떤 평가|평가 목적|검색 기록|ctrl.?f|정규식|regex|찾아봤|분석 절차|검색\s*(?:순서|절차)|저장된\s*(?:검색|ctrl.?f)|boot|uefi|training|retest|\brt\b)/i.test(text)
  const workflowApplyIntent = workflowIntent && /(적용|재사용|호환|반복|확장|순서로)/i.test(text)
  if (workflowIntent) calls.push({ name: 'engineer_workflow_memory_get' })
  if (workflowApplyIntent) calls.push({ name: 'engineer_workflow_apply' })
  if (relationIntent) {
    calls.push({ name: 'evaluation_relation_suggest' })
    calls.push({ name: 'pass_fail_scan' })
  }
  if (/(새|올렸|파일|로그|무슨 평가|어떤 평가|조건|온도|vdd|전압|자재|sample|샘플|lot|주파수|skew|tm|mode|sub.?channel|rank|row|column)/i.test(text)) {
    calls.push({ name: 'filename_dimensions_scan' })
  }
  if (/(soc|퀄컴|qualcomm|미디어텍|mediatek|mtk|sm[-_ ]?\d|부팅|boot|pbl|xbl|abl|uefi|post.?pbl|lk2?)/i.test(text)) calls.push({ name: 'soc_boot_profile_scan' })
  if (/(콘솔|console|명령|command|입력|prompt|sleep|uefi\s*>|lk2?\s*>)/i.test(text)) calls.push({ name: 'console_transcript_scan' })
  if (/(grid|그리드|sequence|시퀀스|전원\s*인가|4.?corner|corner|조건\s*(?:조합|변경))/i.test(text)) calls.push({ name: 'evaluation_grid_scan' })
  if (/(pass|fail|불량|판정|reboot|halt|training|fast)/i.test(text)) calls.push({ name: 'pass_fail_scan' })
  if (/(새 로그|이 로그|무슨 평가|어떤 평가|pass|fail|판정|분석 절차|적용)/i.test(text)) calls.push({ name: 'engineer_workflow_apply' })
  if (/(경향|집중|불량률|dq|bl|channel|채널|sub.?channel|rank|bank|row|column|pattern|패턴|frequency|주파수|temperature|온도|vdd|전압|개선|비교)/i.test(text)) calls.push({ name: 'failure_trends_get' })
  if (/(과거|이전|유사|lpddr5|다음|추천|어떻게|시도)/i.test(text)) calls.push({ name: 'similar_case_search', args: { query: content.slice(0, 240) } })
  if (workflowIntent) calls.push({ name: 'engineer_workflow_memory_get' })
  if (/(검색 기록|ctrl.?f|정규식|regex|찾아봤)/i.test(text)) calls.push({ name: 'search_history_get' })
  const quoted = content.match(/[“"']([^”"']{2,120})[”"']/)?.[1]
  if (quoted && /(검색|찾|marker|문장|라인)/i.test(text)) calls.push({ name: 'log_search', args: { query: quoted, mode: /정규식|regex/i.test(text) ? 'regex' : 'literal' } })
  return uniquePlan(calls)
}

/** OpenCode may choose additional tools, but these intent-specific tools are
 * the minimum evidence needed before its answer can be shown. Missing tools
 * make the request fall back to the deterministic built-in planner. */
export function requiredOpenCodeTools(content: string): LpddrAgentToolName[] {
  const text = content.toLowerCase()
  const required: LpddrAgentToolName[] = []
  if (/(브랜치|이력\s*(?:연결|관계)|어느\s*(?:불량|이슈)|같은\s*불량|별도\s*불량|retest|\brt\b|재현|가속|개선|side\s*effect|검증)/i.test(text)) {
    required.push('project_history_get', 'evaluation_relation_suggest')
  }
  if (/(ctrl.?f|정규식|regex|검색\s*(?:순서|절차|행동)|분석\s*절차|확정\s*절차|workflow)/i.test(text)) {
    required.push('engineer_workflow_memory_get')
  }
  if (/(적용|재사용|호환|다른\s*(?:폴더|평가)|반복|확장)/i.test(text)
    && /(절차|검색|workflow|ctrl.?f)/i.test(text)) {
    required.push('engineer_workflow_apply')
  }
  if (/(pass|fail|불량\s*판정|reboot|halt|training\s*fail|fast\s*fail)/i.test(text)) required.push('pass_fail_scan')
  if (/(경향|집중|불량률|dq|bl|channel|채널|sub.?channel|rank|bank|row|column|pattern|패턴|frequency|주파수|temperature|온도|vdd|전압)/i.test(text)) {
    required.push('failure_trends_get')
  }
  if (/(soc|qualcomm|퀄컴|mediatek|미디어텍|mtk|부팅|boot|pbl|xbl|abl|uefi|post.?pbl|lk2?)/i.test(text)) required.push('soc_boot_profile_scan')
  if (/(콘솔|console|명령|command|입력\s*명령|prompt)/i.test(text)) required.push('console_transcript_scan')
  if (/(grid|그리드|sequence|시퀀스|전원\s*인가|4.?corner|corner|조건\s*(?:조합|변경))/i.test(text)) required.push('evaluation_grid_scan')
  if (/(새\s*(?:로그|파일)|무슨\s*평가|어떤\s*평가|평가\s*조건)/i.test(text)) required.push('filename_dimensions_scan')
  return [...new Set(required)].slice(0, 4)
}

export function missingRequiredOpenCodeTools(required: readonly string[], actual: readonly string[]): string[] {
  const normalize = (name: string): string => safe(name, 100).replace(/^sct_/, '')
  const called = new Set(actual.map(normalize))
  return required.map(normalize).filter((name) => !called.has(name))
}

function fallbackSummary(results: LpddrAgentToolResult[]): string {
  const facts = results.filter((item) => item.summary).map((item) => `- ${item.label}: ${item.summary}`)
  return `확인된 사실\n${facts.join('\n') || '- 저장된 근거가 없습니다.'}\n\n추정 또는 미확인\n- LLM 응답을 받지 못해 인과관계와 다음 평가 제안은 보류했습니다. 아래 도구 결과는 로컬에서 계산된 값입니다.`
}

export function userFacingAgentContent(value: string): string {
  const content = safe(value)
    .replace(/\s*\(\s*(?:sample-(?:n|h)-[a-z0-9-]+|ea-[a-z0-9-]+)\s*\)/gi, '')
    .replace(/\b(?:sample-(?:n|h)-[a-z0-9-]+|ea-[a-z0-9-]+)\b/gi, '연결된 평가')
    .replace(
      /\b(?:[a-f0-9]{24,64}|[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\b/gi,
      '연결된 항목',
    )
  const visible = content.split('\n').filter((line) => !/(?:Maximum Steps|최대 분석 단계|tool budget|도구 예산)/i.test(line)).join('\n').trim()
  return visible || '확보한 근거 안에서 분석을 마쳤습니다. 미확인 항목은 확정하지 않았습니다.'
}

/** Applied both to new replies and stored historical replies so later safety
 * improvements do not leave stale overclaims visible in the conversation. */
export function enforceGeneralEngineeringClaims(content: string): string {
  return userFacingAgentContent(content)
    .replace(/((?:Die|Sample)\s*[A-Za-z0-9-]+)\s*자체의\s*공정\s*편차\s*\(\s*SKEW[-\s]*([A-Z]+)\s*\)/gi, '$1에 공통된 미확인 요인')
    .replace(/((?:Die|Sample)\s*[A-Za-z0-9-]+)\s*자체의\s*공정\s*편차/gi, '$1에 공통된 미확인 요인')
    .replace(/공정\s*편차\s*\(\s*SKEW[-\s]*([A-Z]+)\s*\)/gi, 'SKEW $1 평가 corner 조건')
    .replace(/Die\s*공정\s*편차/gi, 'Die별 미확인 요인')
    .replace(/위치의\s*취약성/gi, '위치 조건과의 연관성')
    .replace(/기인성\s*불량으로\s*확정할\s*수\s*있/gi, '연관 가설을 지지할 수 있')
    .replace(/((?:Die|Sample)\s*[A-Za-z0-9-]+)\s*자체의\s*고정성\s*불량으로\s*판정할\s*수\s*있/gi, '$1에 공통된 미확인 요인 가설을 지지할 수 있')
}

export function enforceEvidenceBoundHistory(content: string, hasHistoricalEvidence: boolean): string {
  const visible = userFacingAgentContent(content)
  if (hasHistoricalEvidence) return visible
  const unsupportedHistory = /(?:과거|이전|누적|유사\s*(?:평가|사례)|LPDDR[45]\s*(?:이력|사례)|다른\s*프로젝트)/i
  return visible.split('\n')
    .map((line) => line.split(/(?<=[.!?。])\s+/u).filter((sentence) => !unsupportedHistory.test(sentence)).join(' '))
    .filter((line) => line.trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const hasHistoricalTool = (names: readonly string[]): boolean => names.some((name) => {
  const normalized = name.replace(/^sct_/, '')
  return normalized === 'project_history_get' || normalized === 'similar_case_search'
})

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const openCodeTraceKey = (trace: SctMcpToolTrace): string =>
  `${trace.name}\u0000${trace.summary}\u0000${[...trace.evidenceSourceIds].sort().join(',')}`

/** Deterministic output boundary. Prompt rules improve the answer, while this
 * guard prevents an unconfirmed folder purpose or internal identifiers from
 * being presented as an engineering fact when a model ignores those rules. */
export function enforceAgentScopeClaims(
  content: string,
  project: { evaluationNodes?: ProjectSnapshot['evaluationNodes'] } | null | undefined,
  evaluationScopeId?: string,
  sourceIds: readonly string[] = [],
): string {
  let visible = enforceGeneralEngineeringClaims(content)
  for (const sourceId of [...sourceIds].sort((left, right) => right.length - left.length)) {
    if (sourceId) visible = visible.replace(new RegExp(regexEscape(sourceId), 'g'), '선택 로그')
  }
  for (const name of Object.keys(LPDDR_AGENT_TOOL_DESCRIPTIONS)) {
    const presentation = openCodeToolPresentation(name)
    visible = visible.replace(new RegExp(`\\b(?:sct_)?${regexEscape(name)}\\b`, 'gi'), presentation.label)
  }
  visible = visible.replace(/특정\s*위치\s*(?:타겟|target)/gi, '기록된 위치 조건')
  const scopeId = safe(evaluationScopeId, 160)
  const scopedNodes = (project?.evaluationNodes ?? []).filter((node) => scopeId && node.evaluationScopeId === scopeId)
  const confirmed = [...scopedNodes].reverse().find((node) => node.reviewState === 'confirmed')
  if (!confirmed) {
    const proposal = [...scopedNodes].reverse()[0]
    const purpose = proposal
      ? `${proposal.name}${proposal.interpretation ? `. ${proposal.interpretation}` : ' · 엔지니어 확인 전입니다.'}`
      : '현재 폴더의 세부 목적은 아직 엔지니어 확인 전입니다.'
    visible = visible.replace(/^.*평가\s*목적.*:.*$/gmi, `- **평가 목적 후보**: ${purpose}`)
  }
  return visible
}

export function hasConfirmedWorkflowEvidence(results: readonly LpddrAgentToolResult[]): boolean {
  return results.some((result) => {
    if (result.name === 'engineer_workflow_memory_get') {
      return ((result.data as { confirmed?: unknown[] } | undefined)?.confirmed?.length ?? 0) > 0
    }
    if (result.name === 'engineer_workflow_apply') {
      return ((result.data as { rows?: Array<{ matched?: boolean; scopeMatch?: boolean }> } | undefined)?.rows ?? [])
        .some((row) => row.matched === true && row.scopeMatch !== false)
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

  async create(projectId: string, title?: string, evaluationScopeId?: string, requestedSourceIds?: string[]): Promise<NativeAgentSessionView> {
    const project = await this.deps.projects.get(safe(projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const scopeId = safe(evaluationScopeId, 160)
    const scopeSources = scopeId ? project.artifacts.filter((item) => item.rootId === scopeId) : project.artifacts
    if (scopeId && !scopeSources.length) throw new Error('평가 폴더를 프로젝트에서 찾을 수 없습니다.')
    const allowed = new Set(scopeSources.map((item) => item.sourceId))
    const requested = requestedSourceIds !== undefined
      ? [...new Set(requestedSourceIds.map((item) => safe(item, 160)).filter(Boolean))]
      : scopeSources.map((item) => item.sourceId)
    if (requested.length > 100 || requested.some((item) => !allowed.has(item))) throw new Error('평가 폴더 로그 범위가 올바르지 않습니다.')
    const backend = (await this.deps.opencode.available()) ? 'opencode' : 'internal'
    let session = await this.deps.store.create(project.id, safe(title, 160) || `${project.name} 분석`, backend, scopeId)
    const confirmedIntent = this.confirmedEvaluationIntent(project, scopeId)
    if (confirmedIntent) session = await this.deps.store.update(session.id, (draft) => { draft.evaluationIntent = confirmedIntent })
    if (requested.length) {
      const sourceIds = requested.slice(0, MAX_AGENT_SOURCE_SCOPE)
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
        const clarification = this.profileQuestion(filenames) ?? this.consoleQuestion(consoleScan) ?? await this.commandQuestion(project.id, filenames)
        const question = clarification ?? this.purposeQuestionFor(session)
        session = await this.deps.store.appendMessage(session.id, {
          role: 'assistant', content: this.onboardingQuestion(filenames, statuses, workflows, boot, consoleScan, Boolean(question), session.evaluationIntent),
          evidenceSourceIds: [...new Set([...filenames.evidenceSourceIds, ...statuses.evidenceSourceIds, ...workflows.evidenceSourceIds])]
        })
        if (question) session = await this.deps.store.update(session.id, (draft) => { draft.question = question })
      } catch {
        session = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `평가 로그 ${sourceIds.length}개가 연결되어 있습니다. 평가 목적을 적으면 조건과 Pass/Fail marker부터 확인하겠습니다.` })
      }
    } else {
      session = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: '프로젝트에 로그를 연결하면 파일명 조건, Pass/Fail marker, 과거 평가 이력을 함께 확인할 수 있습니다.' })
    }
    return this.public(session)
  }

  list(projectId: string, evaluationScopeId?: string): Promise<NativeAgentSessionSummary[]> { return this.deps.store.list(projectId, evaluationScopeId) }

  async get(sessionId: string): Promise<NativeAgentSessionView | null> {
    const session = await this.deps.store.get(sessionId)
    return session ? this.public(session) : null
  }

  async send(sessionId: string, content: string, requestedSourceIds?: string[], requestedContextKind?: NativeAgentContextKind): Promise<NativeAgentSessionView> {
    const session = await this.require(sessionId)
    if (session.status === 'queued' || session.status === 'running') throw new Error('현재 분석이 끝난 후 다시 보내 주세요.')
    const message = safe(content, 4_000)
    const turnContextKind = contextKind(requestedContextKind)
    if (!message) throw new Error('메시지를 입력해 주세요.')
    if (!hasMeaningfulAgentMessage(message)) throw new Error('질문이나 확인할 로그 조건을 입력해 주세요.')
    if (session.question?.kind === 'boot-profile') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message, ...(turnContextKind ? { contextKind: turnContextKind } : {}) })
      if (message === '미확인으로 유지' || message === '건너뛰기') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = this.purposeQuestionFor(session) })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `SoC profile은 미확인으로 두었습니다. ${this.purposeFollowup(session)}` })
        this.emit(next); return this.public(next)
      }
      const vendor = message.startsWith('Qualcomm') ? 'qualcomm' : message.startsWith('MediaTek') ? 'mediatek' : null
      if (!vendor) throw new Error('Qualcomm 또는 MediaTek profile을 선택해 주세요.')
      await this.deps.store.confirmProfileBinding({ projectId: session.projectId, sourceIds: session.question.sourceIds, vendor, profileId: vendor === 'qualcomm' ? 'qualcomm-default' : 'mediatek-default' })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = this.purposeQuestionFor(session) })
      next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `${vendor === 'qualcomm' ? 'Qualcomm · UEFI' : 'MediaTek · Post-PBL/LK'} profile로 저장했습니다. ${this.purposeFollowup(session)}` })
      this.emit(next); return this.public(next)
    }
    if (session.question?.kind === 'console-role') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message, ...(turnContextKind ? { contextKind: turnContextKind } : {}) })
      if (message === '건너뛰기' || message === '모름 · 저장 안 함') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = this.purposeQuestionFor(session) })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `이 줄은 분류하지 않았습니다. ${this.purposeFollowup(session)}` })
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
          const sources = session.evaluationScopeId
            ? project.artifacts.filter((item) => item.rootId === session.evaluationScopeId)
            : project.artifacts
          const scan = await this.deps.tools.execute(session.projectId, { name: 'console_transcript_scan' }, sources.slice(0, 100).map((item) => item.sourceId))
          following = this.consoleQuestion(scan)
        }
      }
      next = await this.deps.store.appendMessage(session.id, {
        role: 'assistant',
        content: rememberedRole === 'input'
          ? `입력 형식을 저장했습니다.${following ? ' 다른 형식 하나만 더 확인해 주세요.' : ` 다음 로그부터 명령만 수집합니다. ${this.purposeFollowup(session)}`}`
          : rememberedRole === 'output'
            ? `출력 형식으로 저장했습니다.${following ? ' 다른 형식 하나만 더 확인해 주세요.' : ` ${this.purposeFollowup(session)}`}`
            : `이번 줄만 입력 명령으로 확인했습니다. ${this.purposeFollowup(session)}`,
      })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = following ?? this.purposeQuestionFor(session) })
      this.emit(next); return this.public(next)
    }
    if (session.question?.kind === 'command-purpose') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message, ...(turnContextKind ? { contextKind: turnContextKind } : {}) })
      if (message === '건너뛰기' || message === '모름 · 저장 안 함') {
        next = await this.deps.store.update(session.id, (draft) => { draft.question = this.purposeQuestionFor(session) })
        next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `명령 목적은 저장하지 않았습니다. ${this.purposeFollowup(session)}` })
        this.emit(next); return this.public(next)
      }
      const knowledge = await this.deps.store.confirmCommandKnowledge({
        projectId: session.projectId, command: session.question.command, purpose: message,
        bootProfileId: session.question.bootProfileId, socModel: session.question.socModel,
      })
      next = await this.deps.store.update(session.id, (draft) => { draft.question = this.purposeQuestionFor(session) })
      next = await this.deps.store.appendMessage(session.id, { role: 'assistant', content: `${knowledge.command} 목적을 “${knowledge.purpose}”로 저장했습니다. ${this.purposeFollowup(session)}` })
      this.emit(next); return this.public(next)
    }
    if (session.question?.kind === 'evaluation-purpose') {
      let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message, ...(turnContextKind ? { contextKind: turnContextKind } : {}) })
      const unknown = message === '모름 · 나중에 확인'
      next = await this.deps.store.update(session.id, (draft) => {
        draft.question = undefined
        draft.evaluationIntent = unknown ? undefined : message
      })
      next = await this.deps.store.appendMessage(session.id, {
        role: 'assistant',
        content: unknown
          ? '평가 목적은 미확인으로 두었습니다. 로그 결과와 조건을 먼저 물어볼 수 있습니다.'
          : `평가 목적 후보로 “${message}”을 기억했습니다. 결과와 평가 이력 정리에도 사용합니다.`,
      })
      this.emit(next); return this.public(next)
    }
    const sourceIds = await this.authorize(session.projectId, requestedSourceIds, session.evaluationScopeId)
    const project = await this.deps.projects.get(session.projectId)
    let next = await this.deps.store.appendMessage(session.id, { role: 'user', content: message, ...(turnContextKind ? { contextKind: turnContextKind } : {}) })
    next = await this.deps.store.update(session.id, (draft) => {
      draft.status = 'queued'; draft.failure = undefined; draft.analysisViewProposal = undefined
      draft.lastRequest = { content: message, sourceIds, ...(turnContextKind ? { contextKind: turnContextKind } : {}) }
      draft.lastContextKind = turnContextKind ?? 'free_chat'
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
    const evaluationScopeId = safe(input.evaluationScopeId, 160)
    if (evaluationScopeId && input.sourceIds.some((sourceId) => project.artifacts.find((item) => item.sourceId === sourceId)?.rootId !== evaluationScopeId)) {
      throw new Error('검색 로그가 현재 평가 폴더를 벗어났습니다.')
    }
    await this.deps.store.recordSearch(input)
  }

  async completeEvaluation(input: NativeAgentCompleteEvaluationInput): Promise<NativeAgentCompleteEvaluationResult> {
    const project = await this.deps.projects.get(safe(input.projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const sourceId = safe(input.sourceId, 160)
    const source = project.artifacts.find((item) => item.sourceId === sourceId)
    if (!source) throw new Error('현재 로그가 프로젝트 범위에 없습니다.')
    const requestedScope = safe(input.evaluationScopeId, 160)
    if (requestedScope && requestedScope !== source.rootId) throw new Error('현재 로그가 선택한 평가 폴더에 없습니다.')
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
      evaluationScopeId: source.rootId,
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
          const streamedTraceKeys = new Set<string>()
          let streamedTraceWrites = Promise.resolve()
          const appendStreamedTrace = (trace: SctMcpToolTrace): void => {
            const key = openCodeTraceKey(trace)
            if (streamedTraceKeys.has(key)) return
            streamedTraceKeys.add(key)
            streamedTraceWrites = streamedTraceWrites.then(async () => {
              const tool = openCodeToolPresentation(trace.name)
              const current = await this.deps.store.update(session.id, (draft) => {
                draft.tools.push({
                  id: randomUUID(), name: tool.name, label: tool.label, state: 'completed',
                  startedAt: now(), completedAt: now(),
                  ...(trace.summary ? { summary: trace.summary } : {}),
                  ...(trace.evidenceSourceIds.length ? { evidenceSourceIds: trace.evidenceSourceIds } : {}),
                })
              })
              this.emit(current)
            })
          }
          const requiredToolNames = requiredOpenCodeTools(lastRequest.content)
          const response = await this.deps.opencode.send({
            externalSessionId: session.externalSessionId, projectId: session.projectId,
            sourceIds: lastRequest.sourceIds, title: session.title, content: lastRequest.content,
            requiredToolNames,
            onToolTrace: appendStreamedTrace,
          })
          await streamedTraceWrites
          const actualToolNames = response.toolTraces?.length
            ? response.toolTraces.map((trace) => trace.name)
            : response.toolNames
          const missingTools = missingRequiredOpenCodeTools(requiredToolNames, actualToolNames)
          if (missingTools.length) throw new Error(`OPENCODE_REQUIRED_TOOL_MISSING:${missingTools.join(',')}`)
          const parsedReply = extractAnalysisViewProposal(response.content)
          session = await this.deps.store.update(session.id, (draft) => {
            draft.externalSessionId = response.externalSessionId
            draft.analysisViewProposal = parsedReply.proposal ? { id: randomUUID(), ...parsedReply.proposal } : undefined
            const traces = response.toolTraces?.length
              ? response.toolTraces
              : response.toolNames.slice(0, 20).map((name) => ({ name, label: '', summary: '', evidenceSourceIds: [] }))
            for (const trace of traces.slice(0, 20)) {
              if (streamedTraceKeys.has(openCodeTraceKey(trace))) continue
              const tool = openCodeToolPresentation(trace.name)
              draft.tools.push({
                id: randomUUID(), name: tool.name, label: tool.label, state: 'completed', startedAt: now(), completedAt: now(),
                ...(trace.summary ? { summary: trace.summary } : {}),
                ...(trace.evidenceSourceIds.length ? { evidenceSourceIds: trace.evidenceSourceIds } : {}),
              })
            }
          })
          const project = await this.deps.projects.get(session.projectId)
          session = await this.deps.store.appendMessage(session.id, {
            role: 'assistant',
            content: enforceAgentScopeClaims(
              enforceEvidenceBoundHistory(parsedReply.content || response.content, hasHistoricalTool((response.toolTraces?.length ? response.toolTraces.map((trace) => trace.name) : response.toolNames))),
              project, session.evaluationScopeId, lastRequest.sourceIds,
            ),
          })
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
    const prompt = `${NATIVE_AGENT_SYSTEM_PROMPT}\n\n대화 기록:\n${conversation.slice(-12_000)}\n\n도구 실행 결과(JSON):\n${JSON.stringify(evidence).slice(0, 24_000)}\n\n${workflowInstruction}\n다른 평가 폴더에서 가져온 scopeMatch=false 절차는 재사용 후보일 뿐이며 현재 평가의 확정 절차나 확정 판정으로 표현하지 마십시오.\n현재 사용자 요청에 답하십시오. tool output에 없는 수치나 인과관계를 만들지 마십시오.`
    try {
      const completed = await this.deps.llm.complete(prompt, signal, () => undefined)
      const project = await this.deps.projects.get(session.projectId)
      const parsedReply = extractAnalysisViewProposal(completed.content)
      session = await this.deps.store.update(session.id, (draft) => {
        draft.analysisViewProposal = parsedReply.proposal ? { id: randomUUID(), ...parsedReply.proposal } : undefined
      })
      session = await this.deps.store.appendMessage(session.id, {
        role: 'assistant', content: enforceAgentScopeClaims(
          enforceEvidenceBoundHistory(enforceWorkflowProvenance(parsedReply.content || completed.content, confirmedWorkflow), hasHistoricalTool(results.map((result) => result.name))),
          project, session.evaluationScopeId, request.sourceIds,
        ),
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

  private async authorize(projectId: string, requested?: string[], evaluationScopeId?: string): Promise<string[]> {
    const project = await this.deps.projects.get(projectId)
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const scopeId = safe(evaluationScopeId, 160)
    const scoped = scopeId ? project.artifacts.filter((item) => item.rootId === scopeId) : project.artifacts
    const wanted = requested?.length ? [...new Set(requested.map((item) => safe(item, 160)).filter(Boolean))] : scoped.slice(0, MAX_AGENT_SOURCE_SCOPE).map((item) => item.sourceId)
    const allowed = new Set(scoped.map((item) => item.sourceId))
    if (wanted.length > 100 || wanted.some((item) => !allowed.has(item))) throw new Error('프로젝트 로그 범위가 올바르지 않습니다.')
    return wanted.slice(0, MAX_AGENT_SOURCE_SCOPE)
  }

  private async require(sessionId: string): Promise<StoredNativeAgentSession> {
    const session = await this.deps.store.get(safe(sessionId, 160))
    if (!session) throw new Error('에이전트 대화를 찾을 수 없습니다.')
    return session
  }

  private emit(session: StoredNativeAgentSession): void {
    const view = this.public(session); this.listeners.forEach((listener) => listener(view))
  }
  private public(session: StoredNativeAgentSession): NativeAgentSessionView {
    const view = this.deps.store.public(session)
    return {
      ...view,
      messages: view.messages.map((message, index) => {
        if (message.role !== 'assistant') return message
        const previous = [...view.messages.slice(0, index)].reverse().find((item) => item.role === 'user' || item.role === 'assistant')
        const from = previous ? Date.parse(previous.createdAt) : -Infinity
        const until = Date.parse(message.createdAt)
        const names = view.tools.filter((tool) => {
          const started = Date.parse(tool.startedAt)
          return Number.isFinite(started) && started >= from && started <= until
        }).map((tool) => tool.name)
        return {
          ...message,
          content: enforceGeneralEngineeringClaims(enforceEvidenceBoundHistory(message.content, hasHistoricalTool(names))),
        }
      }),
    }
  }
  private failure(error: unknown): string {
    const raw = error instanceof Error ? error.message : 'AGENT_FAILED'
    if (/timeout|429|LLM_REQUEST_TIMEOUT/i.test(raw)) return '사내 LLM 응답이 늦거나 사용량 제한에 도달했습니다.'
    if (/LLM_UNAVAILABLE/i.test(raw)) return '설정에서 LLM 주소와 모델을 연결해 주세요.'
    if (/OPENCODE/i.test(raw)) return 'OpenCode harness를 시작하지 못해 내장 분석으로 전환했습니다.'
    return safe(raw, 300) || '에이전트 분석을 완료하지 못했습니다.'
  }

  private onboardingQuestion(
    filenames: LpddrAgentToolResult,
    statuses: LpddrAgentToolResult,
    workflows: LpddrAgentToolResult,
    boot: LpddrAgentToolResult,
    consoleScan: LpddrAgentToolResult,
    hasClarification = false,
    evaluationIntent?: string,
  ): string {
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
    const next = hasClarification
      ? '아래 한 가지만 확인해 주세요.'
      : evaluationIntent ? `저장된 평가 목적: “${safe(evaluationIntent, 120)}”. 궁금한 내용을 입력해 주세요.`
      : leaders.length ? `${leaders.join(' · ')} 조건이 반복됩니다. 어떤 목적의 평가인가요?` : '이번 평가 목적을 짧게 적어주세요.'
    return `파일명, 콘솔 입력과 종료 marker를 확인했습니다.\n${filenames.summary}\n${boot.summary}\n${consoleScan.summary}\n${statuses.summary || '확정 상태 없음'}${remembered ? `\n저장된 분석 절차 ${remembered}개를 함께 확인합니다.` : ''}\n\n${next}`
  }

  private consoleQuestion(scan: LpddrAgentToolResult): NativeAgentSessionView['question'] | undefined {
    const row = (scan.data as { ambiguous?: Array<{ sourceId?: string; lineNumber?: number; promptSignature?: string; promptKind?: string; command?: string }> })?.ambiguous?.[0]
    if (!row?.sourceId || !row.promptSignature || !row.promptKind || !row.command || !Number.isSafeInteger(row.lineNumber)) return undefined
    return {
      id: `console-${randomUUID()}`, kind: 'console-role', sourceId: row.sourceId, lineNumber: row.lineNumber!,
      promptSignature: row.promptSignature, promptKind: row.promptKind, command: safe(row.command, 500),
      prompt: `“${safe(row.command, 120)}”은 엔지니어가 입력한 명령인가요?`,
      choices: ['입력 명령 · 형식 기억', '이번 줄만 입력', '장비 출력 · 형식 제외', '모름 · 저장 안 함'],
    }
  }

  private async commandQuestion(projectId: string, filenames: LpddrAgentToolResult): Promise<NativeAgentSessionView['question'] | undefined> {
    const known = await this.deps.store.commandKnowledge(projectId, 500)
    const keys = new Set(known.map((item) => `${item.command.toLowerCase()}:${item.bootProfileId ?? ''}:${item.socModel ?? ''}`))
    const rows = (filenames.data as { rows?: Array<{ commandSignatures?: string[]; dimensions?: { bootProfileId?: string; socModel?: string } }> })?.rows ?? []
    for (const row of rows) {
      for (const command of row.commandSignatures ?? []) {
        const key = `${command.toLowerCase()}:${row.dimensions?.bootProfileId ?? ''}:${row.dimensions?.socModel ?? ''}`
        if (keys.has(key) || isStandardCommandSignature(command) || /^unclassified:/i.test(command) || /^shell:(?:unknown|\[?\d)/i.test(command)) continue
        return {
          id: `command-${randomUUID()}`, kind: 'command-purpose', command,
          prompt: `${command} 명령이 처음 확인되었습니다. 어떤 목적으로 사용했나요?`,
          choices: ['부팅 단계 확인', 'Training 조건 설정', '불량 가속 조건 탐색', '개선 조건 검증', 'Screening', '직접 입력', '모름 · 저장 안 함'],
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

  private evaluationPurposeQuestion(): NativeAgentSessionView['question'] {
    return {
      id: `evaluation-purpose-${randomUUID()}`,
      kind: 'evaluation-purpose',
      prompt: '이번 폴더에서 무엇을 확인하려는 평가인가요?',
      choices: ['불량 재현', '불량 검출 강화', '개선 조건 확인', '개선 효과 검증', '불량 경향 파악', '부팅·Training 확인', '직접 입력', '모름 · 나중에 확인'],
    }
  }

  private purposeQuestionFor(session: Pick<StoredNativeAgentSession, 'evaluationIntent'>): NativeAgentSessionView['question'] | undefined {
    return session.evaluationIntent ? undefined : this.evaluationPurposeQuestion()
  }

  private purposeFollowup(session: Pick<StoredNativeAgentSession, 'evaluationIntent'>): string {
    return session.evaluationIntent
      ? `저장된 평가 목적은 “${safe(session.evaluationIntent, 120)}”입니다. 계속 사용합니다.`
      : '이번 평가 목적만 선택해 주세요.'
  }

  private confirmedEvaluationIntent(project: ProjectSnapshot, evaluationScopeId?: string): string {
    const scopeId = safe(evaluationScopeId, 160)
    if (!scopeId) return ''
    const node = [...(project.evaluationNodes ?? [])].reverse()
      .find((item) => item.evaluationScopeId === scopeId && item.reviewState === 'confirmed')
    return confirmedEvaluationLabel(node)
  }
}
