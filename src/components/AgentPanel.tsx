import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, FileText, History, LoaderCircle, Plus, RotateCcw, Sparkles, Wrench, X } from 'lucide-react'
import type {
  AgentRun,
  EvaluationProjectSnapshot,
  EvaluationResultLabel,
  EvaluationAgentPublicOutcome,
  EvaluationSaveDecisionInput,
  EvaluationAgentMemoryPayloadView,
  EvaluationAgentSessionView,
  NativeAgentBackendStatusView,
  NativeAgentContextKind,
  NativeAgentAnalysisViewProposal,
  NativeAgentSessionSummary,
  NativeAgentSessionView,
  ProjectSnapshot,
} from '../../electron/shared/contracts'
import type { WorkbenchFile } from '../views/WorkbenchView'
import { resolveProjectSource } from '../state/sourceIdentity'
import { projectSnapshotToEvaluationMemory } from '../state/evaluationMemory'
import { evaluationRelationLabel, relationForEvaluationPurpose, suggestEvaluationRelation, type EvaluationRelationSuggestion } from '../domain/evaluation-relation'
import { AgentMarkdown } from './AgentMarkdown'
import { hasMeaningfulAgentMessage } from '../domain/agent-message'
import { analysisContextLabel } from '../domain/agent-analysis-view'
import { ANALYSIS_DATA_BASIS_LABELS, ANALYSIS_VISUALIZATION_LABELS } from '../domain/analysis-view'
import { MAX_AGENT_CONTEXT_SOURCES } from '../domain/analysis-context'

interface AgentPanelProps {
  open: boolean
  onClose: () => void
  onOpen: () => void
  project: ProjectSnapshot | null
  selectedFile?: WorkbenchFile
  selectedEvaluationRootId?: string
  evaluationSnapshot: EvaluationProjectSnapshot | null
  onSnapshotSaved: (snapshot: EvaluationProjectSnapshot) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
  evaluationLaunchRequest?: EvaluationAgentLaunchRequest | null
  nativeLaunchRequest?: NativeAgentLaunchRequest | null
  onOpenSource?: (sourceId: string) => void
  onApplyAnalysisViewProposal?: (proposal: NativeAgentAnalysisViewProposal) => void
}

export interface EvaluationAgentLaunchRequest {
  id: string
  evaluationScopeId: string
  title: string
  sourceIds: string[]
  intent?: string
}

export interface NativeAgentLaunchRequest {
  id: string
  title: string
  prompt: string
  sourceIds: string[]
  evaluationScopeId?: string
  contextKind: NativeAgentContextKind
}

export function mergeEvaluationAgentMemory(project: ProjectSnapshot, payload: EvaluationAgentMemoryPayloadView): ProjectSnapshot {
  const confirmed = 'engineer-confirmed' as const
  const upsert = <T extends { id: string }>(existing: readonly T[], additions: readonly T[]): T[] => {
    const byId = new Map(existing.map((item) => [item.id, item]))
    additions.forEach((item) => byId.set(item.id, { ...byId.get(item.id), ...item }))
    return [...byId.values()]
  }
  const evidence = payload.evidence.map((item) => {
    const previous = (project.evidenceRecords ?? []).find((record) => record.id === item.id)
    return {
      ...item,
      sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...item.sourceIds])],
      note: item.summary ?? previous?.note,
      origin: confirmed,
    }
  })
  return {
    ...project,
    failureHypotheses: payload.node.hypothesisId
      ? upsert(project.failureHypotheses ?? [], [{ ...payload.hypothesis, id: payload.node.hypothesisId, origin: confirmed }])
      : [...(project.failureHypotheses ?? [])],
    evaluationNodes: upsert(project.evaluationNodes ?? [], [payload.node]),
    evidenceRecords: upsert(project.evidenceRecords ?? [], evidence)
  }
}

export type EvaluationRelationChoice = 'suggested' | 'existing-issue' | 'new-issue' | 'pending'

function evaluationStatusForRelation(outcome: EvaluationAgentPublicOutcome) {
  if (outcome === 'PASS') return 'pass' as const
  if (['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'].includes(outcome)) return 'fail' as const
  return 'inconclusive' as const
}

export function agentEvaluationRelationSuggestion(
  project: ProjectSnapshot,
  run: EvaluationAgentSessionView,
  evaluationScopeId?: string,
): EvaluationRelationSuggestion | null {
  if (!run.proposal) return null
  return suggestEvaluationRelation(projectSnapshotToEvaluationMemory(project), {
    evaluationScopeId,
    name: evaluationProposalTitle(run.proposal, run.evaluationIntent),
    purpose: run.proposal.purpose,
    status: evaluationStatusForRelation(run.proposal.outcome),
    dimensions: run.proposal.dimensions,
    interpretation: run.proposal.rationale,
  })
}

export function resolveEvaluationRelationChoice(
  suggestion: EvaluationRelationSuggestion,
  choice: EvaluationRelationChoice,
  purpose?: NonNullable<EvaluationAgentSessionView['proposal']>['purpose'],
): EvaluationRelationSuggestion {
  if (choice === 'suggested') return suggestion
  if (choice === 'existing-issue' && suggestion.candidateHypothesisId && suggestion.candidateNodeId) {
    return {
      ...suggestion,
      classification: 'existing-issue',
      hypothesisId: suggestion.candidateHypothesisId,
      parentNodeId: suggestion.candidateNodeId,
      relation: relationForEvaluationPurpose(purpose),
      confidence: Math.min(suggestion.confidence, .7),
      reason: '엔지니어가 선택한 기존 불량 이슈에 연결합니다.',
    }
  }
  if (choice === 'new-issue') return { ...suggestion, classification: 'new-issue', relation: 'baseline', hypothesisId: undefined, parentNodeId: undefined, existingNodeId: undefined, confidence: 1, reason: '엔지니어가 별도 불량 이슈로 확인했습니다.' }
  return { ...suggestion, classification: 'pending', relation: undefined, hypothesisId: undefined, parentNodeId: undefined, existingNodeId: undefined, confidence: 1, reason: '관계가 불확실해 분류 대기에 저장합니다.' }
}

/** Applies the confirmed issue/relation choice without allowing the LLM to
 * create an unbounded branch. A repeated analysis of the same folder updates
 * the existing node and evidence target instead of duplicating history. */
export function applyEvaluationAgentRelation(
  project: ProjectSnapshot,
  payload: EvaluationAgentMemoryPayloadView,
  suggestion: EvaluationRelationSuggestion,
): EvaluationAgentMemoryPayloadView {
  const existingNode = suggestion.existingNodeId ? project.evaluationNodes?.find((node) => node.id === suggestion.existingNodeId) : undefined
  const nodeId = existingNode?.id ?? payload.node.id
  if (suggestion.classification === 'pending') {
    return {
      ...payload,
      node: { ...payload.node, id: nodeId, hypothesisId: undefined, parentId: undefined, branchId: undefined, relation: undefined, relationConfidence: undefined, relationReason: suggestion.reason },
      evidence: payload.evidence.map((item) => ({ ...item, evaluationNodeId: nodeId })),
    }
  }

  const hypothesisId = suggestion.hypothesisId ?? payload.hypothesis.id
  const existingHypothesis = project.failureHypotheses?.find((item) => item.id === hypothesisId)
  const hypothesis = {
    ...payload.hypothesis,
    ...existingHypothesis,
    id: hypothesisId,
    projectId: project.id,
    title: existingHypothesis?.title ?? suggestion.suggestedIssueTitle,
    evaluationNodeIds: [...new Set([...(existingHypothesis?.evaluationNodeIds ?? []), nodeId])],
  }
  const parent = suggestion.parentNodeId ? project.evaluationNodes?.find((node) => node.id === suggestion.parentNodeId) : undefined
  const relation = suggestion.relation ?? (suggestion.classification === 'new-issue' ? 'baseline' : relationForEvaluationPurpose(payload.node.purpose))
  const branchId = relation === 'side-effect'
    ? `issue:${hypothesisId}:side:${nodeId}`
    : parent?.branchId ?? `issue:${hypothesisId}:main`
  const node = {
    ...existingNode,
    ...payload.node,
    id: nodeId,
    hypothesisId,
    parentId: suggestion.classification === 'new-issue' ? undefined : suggestion.parentNodeId,
    branchId,
    dimensions: { ...(existingNode?.dimensions ?? {}), ...payload.node.dimensions },
    relation,
    relationConfidence: suggestion.confidence,
    relationReason: suggestion.reason,
    ...(relation === 'retest' && suggestion.parentNodeId ? { retestOf: suggestion.parentNodeId } : {}),
  }
  return { ...payload, hypothesis, node, evidence: payload.evidence.map((item) => ({ ...item, evaluationNodeId: nodeId })) }
}

export function evaluationProposalTitle(proposal: EvaluationAgentSessionView['proposal'], evaluationIntent?: string): string {
  if (!proposal) return '평가 경향'
  const confirmedIntent = evaluationIntent?.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (confirmedIntent) return confirmedIntent
  const d = proposal.dimensions
  const lead = [d.testMode, d.pattern, d.dq !== undefined ? `DQ${d.dq}` : '', d.channel !== undefined ? `CH${d.channel}` : '', d.subChannel !== undefined ? `SCH${d.subChannel}` : '', d.bank !== undefined ? `BANK${d.bank}` : ''].filter(Boolean).slice(0, 2)
  return `${lead.join(' · ') || evaluationOutcomeLabel(proposal.outcome)} 경향`
}

export function evaluationOutcomeLabel(outcome: EvaluationAgentPublicOutcome): string {
  return outcome === 'UNKNOWN' || outcome === 'INCOMPLETE' ? '미정' : outcome
}

export function isEvaluationProposalSaved(run: EvaluationAgentSessionView | null | undefined, savedRunId: string): boolean {
  return Boolean(run?.id && run.status === 'completed' && run.id === savedRunId)
}

export function evaluationAgentRecordPrefix(projectId: string, sessionId: string): string {
  return `ea-${projectId}-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
}

export function evaluationIntentForAgent(
  requestedIntent: string | undefined,
  existing: NonNullable<ProjectSnapshot['evaluationNodes']>[number] | undefined,
  nativeSession: NativeAgentSessionView | null,
  evaluationScopeId: string | undefined,
): string {
  const existingName = existing?.name.trim() ?? ''
  const genericExistingName = /^(?:agent proposal|screening|improvement|reproduction|characterization|verification|stage-verification)$/i.test(existingName)
  const confirmedExisting = existing?.reviewState === 'confirmed'
    ? ((!genericExistingName && existingName) || (existing?.purpose ? agentEvaluationPurposeLabel(existing.purpose) : '') || existingName)
    : ''
  return requestedIntent?.trim()
    || confirmedExisting
    || (nativeSession && nativeSession.evaluationScopeId === evaluationScopeId ? nativeSession.evaluationIntent?.trim() ?? '' : '')
}

export function shouldRestoreEvaluationReview(project: ProjectSnapshot, session: EvaluationAgentSessionView): boolean {
  // Older builds could persist a completed session without a review proposal.
  // Do not revive that dead-end UI; the next explicit analysis starts a fresh run.
  if (session.status === 'failed') return false
  if (session.status === 'completed' && !session.proposal) return false
  const savedNodeId = `${evaluationAgentRecordPrefix(project.id, session.id)}-n`
  if (session.status === 'completed' && project.evaluationNodes?.some((node) => node.id === savedNodeId)) return false
  return true
}

export function agentEvaluationPurposeLabel(purpose: NonNullable<NonNullable<EvaluationAgentSessionView['proposal']>['purpose']>): string {
  return {
    screening: '불량 검출 강화', improvement: '개선 조건 확인', reproduction: '동일 불량 재현',
    characterization: '불량 경향 파악', verification: '개선 효과 검증', 'stage-verification': '부팅·Training 확인',
  }[purpose]
}

export function proposalDecisionResult(outcome: EvaluationAgentPublicOutcome): EvaluationResultLabel | null {
  if (!outcome || outcome === 'UNKNOWN') return null
  return outcome
}

export function proposalSourceDecisions(proposal: NonNullable<EvaluationAgentSessionView['proposal']>): Array<{ sourceId: string; outcome: EvaluationAgentPublicOutcome; evidenceIds: string[] }> {
  if (proposal.sourceAssessments?.length) return proposal.sourceAssessments
  if (proposal.sourceIds.length === 1) return [{ sourceId: proposal.sourceIds[0], outcome: proposal.outcome, evidenceIds: proposal.evidenceIds }]
  return []
}

export function shouldShowNativeAgentSuggestions(session: NativeAgentSessionView): boolean {
  if (session.status !== 'idle' || session.question) return false
  // Profile, console and command confirmations are onboarding, not ordinary
  // chat. Keep the primary project actions reachable after those answers.
  return session.messages.filter((message) => message.role === 'user').length <= 3
}

export function evaluationDimensionSummary(dimensions: EvaluationAgentSessionView['dimensions']): string[] {
  const values: Array<[string, unknown]> = [
    ['SKEW', dimensions.skew], ['자재 (Sample)', dimensions.sample ?? dimensions.material], ['Die', dimensions.die], ['Grid', dimensions.gridId],
    ['실장기 채널', dimensions.equipmentChannel], ['ECC', dimensions.eccMode], ['사용자 조건', dimensions.customCondition], ['평가 Step', dimensions.evaluationStep],
    ['CH', dimensions.channel], ['Sub CH', dimensions.subChannel], ['CS', dimensions.chipSelect], ['Rank', dimensions.rank],
    ['BG', dimensions.bankGroup], ['Bank', dimensions.bank], ['Row', dimensions.row], ['Column', dimensions.column],
    ['DQ', dimensions.dq], ['BL', dimensions.bl], ['WR', dimensions.writeData], ['RD', dimensions.readData], ['Pattern', dimensions.pattern],
    ['온도 조건', dimensions.temperatureCorner], ['VDD 조건', dimensions.vddCorner], ['4-Corner', dimensions.conditionCorner],
    ['온도', dimensions.temperatureC === undefined ? undefined : `${dimensions.temperatureC}°C`],
    ['VDD', dimensions.vdd === undefined ? undefined : `${dimensions.vdd}V`],
    ['주파수', dimensions.frequencyMHz === undefined ? undefined : `${dimensions.frequencyMHz}MHz`],
  ]
  return values.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => `${label} ${value}`)
}

export function agentProjectScopeKey(project: ProjectSnapshot | null): string {
  if (!project) return 'no-project'
  const sources = project.artifacts
    .map((source) => `${source.sourceId}:${source.artifactId}`)
    .sort()
    .join('|')
  return `${project.id}\u0000${sources}`
}

/** One connected root folder is one evaluation. A selected log fixes the
 * Agent to that folder; a single-folder project is safe without a selection. */
export function agentEvaluationSources(project: ProjectSnapshot | null, selectedFile?: WorkbenchFile, selectedEvaluationRootId?: string): ProjectSnapshot['artifacts'] {
  if (!project) return []
  if (selectedEvaluationRootId) return project.artifacts.filter((source) => source.rootId === selectedEvaluationRootId)
  const selected = selectedFile ? resolveProjectSource(project, selectedFile) : null
  if (selected) return project.artifacts.filter((source) => source.rootId === selected.rootId)
  const roots = [...new Set(project.artifacts.map((source) => source.rootId))]
  return roots.length === 1 ? project.artifacts.filter((source) => source.rootId === roots[0]) : []
}

/** Keep slow work only while both the project and its analysed log set match. */
export function shouldRetainAgentSession(previous: ProjectSnapshot | null, next: ProjectSnapshot | null): boolean {
  return agentProjectScopeKey(previous) === agentProjectScopeKey(next)
}

function isProjectRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))
}

export function toolsForAssistantMessage(
  message: NativeAgentSessionView['messages'][number],
  messages: readonly NativeAgentSessionView['messages'][number][],
  tools: readonly NativeAgentSessionView['tools'][number][],
) {
  if (message.role !== 'assistant') return []
  const messageIndex = messages.findIndex((item) => item.id === message.id)
  const previousMessage = messages.slice(0, messageIndex).reverse().find((item) => item.role === 'user' || item.role === 'assistant')
  const from = previousMessage ? Date.parse(previousMessage.createdAt) : -Infinity
  const until = Date.parse(message.createdAt)
  const evidence = new Set(message.evidenceSourceIds ?? [])
  return tools.filter((tool) => {
    const started = Date.parse(tool.startedAt)
    if (Number.isFinite(started)) return started >= from && started <= until
    return Boolean(evidence.size && tool.evidenceSourceIds?.some((id) => evidence.has(id)))
  })
}

/** OpenCode tools finish while the model is still composing its answer. Keep
 * those bounded summaries visible for the latest user turn so a slow provider
 * looks active without streaming raw log text into the renderer. */
export function toolsForCurrentAgentRun(session: NativeAgentSessionView): NativeAgentSessionView['tools'] {
  if (session.status !== 'queued' && session.status !== 'running') return []
  const lastUserAt = [...session.messages].reverse().find((item) => item.role === 'user')?.createdAt
  const from = lastUserAt ? Date.parse(lastUserAt) : -Infinity
  return session.tools.filter((tool) => {
    const started = Date.parse(tool.startedAt)
    return !Number.isFinite(from) || (Number.isFinite(started) && started >= from)
  }).slice(-6)
}

export function reusableNativeLaunchSessionId(
  current: NativeAgentSessionView | null,
  sessions: readonly NativeAgentSessionSummary[],
  request: Pick<NativeAgentLaunchRequest, 'evaluationScopeId'>,
): string | null {
  const sameScope = (session: NativeAgentSessionSummary) => (
    (session.evaluationScopeId ?? '') === (request.evaluationScopeId ?? '')
    && session.status !== 'queued'
    && session.status !== 'running'
  )
  if (current && sameScope(current)) return current.id
  return sessions.find(sameScope)?.id ?? null
}

const ANALYSIS_DIMENSION_LABELS: Partial<Record<NativeAgentAnalysisViewProposal['rowAxes'][number], string>> = {
  sample: '자재 (Sample)', skew: 'SKEW', temperature: '온도', temperatureCorner: '온도 조건', vdd: 'VDD', vddCorner: 'VDD 조건',
  conditionCorner: '4-Corner', frequencyMHz: '주파수', mode: 'Test Mode', pattern: 'Pattern', dq: 'DQ', bl: 'BL',
  channel: 'Channel', subChannel: 'Sub Channel', chipSelect: 'CS', rank: 'Rank', bankGroup: 'Bank Group', bank: 'Bank',
  row: 'Row', column: 'Column', grid: 'Grid', run: '반복 번호', folder: '평가 폴더', result: '판정 결과',
}
const analysisProposalAxes = (axes: readonly NativeAgentAnalysisViewProposal['rowAxes'][number][]): string => axes.map((axis) => ANALYSIS_DIMENSION_LABELS[axis] ?? axis).join(' → ') || '전체'

export function buildAgentDecisionInput(
  project: ProjectSnapshot | null,
  file: WorkbenchFile | undefined,
  snapshot: EvaluationProjectSnapshot | null,
  result: EvaluationResultLabel | undefined,
): EvaluationSaveDecisionInput | null {
  if (!project || !file?.artifactId || !snapshot || !isEvaluationResultLabel(result) || result === 'UNKNOWN') return null
  const source = resolveProjectSource(project, file)
  if (!source) return null
  return {
    projectId: project.id,
    expectedRevision: snapshot.revision,
    source: { sourceId: source.sourceId, artifactId: source.artifactId, sourceKey: file.sourceKey ?? file.id },
    result,
  }
}

export function shouldAcceptAgentRun(run: AgentRun, activeRunId: string | null, projectId: string | undefined): boolean {
  return Boolean(activeRunId && run.id === activeRunId && projectId && run.projectId === projectId)
}

const EVALUATION_RESULT_LABELS = new Set<EvaluationResultLabel>([
  'PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED',
])

function isEvaluationResultLabel(value: unknown): value is EvaluationResultLabel {
  return typeof value === 'string' && EVALUATION_RESULT_LABELS.has(value as EvaluationResultLabel)
}

export function isAgentRunPending(run: AgentRun): boolean {
  if (run.status === 'queued') return true
  if (run.status !== 'running' || run.stage === 'complete') return false
  return !run.question && !run.candidate && run.state !== 'HUMAN_CONFIRM'
}

export function isAgentThreadNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 72,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

function shouldClearSubmissionBusy(run: AgentRun): boolean {
  return Boolean(
    run.question ||
    run.candidate ||
    run.state === 'HUMAN_CONFIRM' ||
    run.stage === 'complete' ||
    run.status === 'failed' ||
    run.status === 'completed' ||
    run.status === 'cancelled',
  )
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  if (raw.includes('REVISION_CONFLICT')) return '분석 결과가 바뀌었습니다. 최신 결과를 확인해 주세요.'
  if (raw.includes('찾을 수 없습니다')) return '프로젝트 또는 실행을 찾을 수 없습니다.'
  if (raw.includes('입력인지 출력인지 선택')) return '먼저 위 질문에 답해 주세요.'
  if (raw.includes('LLM_') || raw.includes('provider failed') || raw.includes('timeout') || raw.includes('429')) return '분석 서버 응답이 늦거나 제한되었습니다.'
  if (raw.includes('Error invoking remote method')) return 'Agent 요청을 처리하지 못했습니다. 다시 시도해 주세요.'
  return raw ? `작업을 완료하지 못했습니다: ${raw.replace(/[\r\n]+/g, ' ').slice(0, 120)}` : '작업을 완료하지 못했습니다.'
}

function candidateText(run: AgentRun): string {
  const candidate = run.candidate
  if (!candidate) return ''
  if (candidate.kind === 'result') return candidate.result ? `판정 후보 · ${candidate.result}` : '판정 후보를 검토해 주세요.'
  if (candidate.kind === 'metadata' && candidate.field && candidate.value) return `메타데이터 후보 · ${candidate.field}: ${candidate.value}`
  return '저장할 수 없는 후보입니다. 검토만 가능합니다.'
}

function stageText(run: AgentRun): string {
  if (run.queueMessage) return run.queueMessage
  if (run.status === 'queued') return '대기 중'
  if (run.status === 'running') return run.stage === 'complete' ? '확인 대기 중' : '분석 중'
  if (run.status === 'cancelled') return '취소됨'
  return ''
}

export function AgentPanel({ open, onClose, onOpen, project, selectedFile, selectedEvaluationRootId, evaluationSnapshot, onSnapshotSaved, onProjectUpdated, evaluationLaunchRequest, nativeLaunchRequest, onOpenSource, onApplyAnalysisViewProposal }: AgentPanelProps) {
  const [run, setRun] = useState<AgentRun | null>(null)
  const [evaluationRun, setEvaluationRun] = useState<EvaluationAgentSessionView | null>(null)
  const [evaluationRunScopeId, setEvaluationRunScopeId] = useState<string | undefined>()
  const [evaluationStarting, setEvaluationStarting] = useState(false)
  const [nativeSessions, setNativeSessions] = useState<NativeAgentSessionSummary[]>([])
  const [nativeSession, setNativeSession] = useState<NativeAgentSessionView | null>(null)
  const [nativeBackend, setNativeBackend] = useState<NativeAgentBackendStatusView | null>(null)
  const [nativeHistoryOpen, setNativeHistoryOpen] = useState(false)
  const [nativeSessionsLoading, setNativeSessionsLoading] = useState(false)
  const [input, setInput] = useState('')
  const [evaluationAnswer, setEvaluationAnswer] = useState('')
  const [mentionedSourceIds, setMentionedSourceIds] = useState<string[]>([])
  const [nativeContextSourceIds, setNativeContextSourceIds] = useState<string[]>([])
  const [pendingNativeLaunch, setPendingNativeLaunch] = useState<{ sessionId: string; prompt: string; sourceIds: string[]; contextKind: NativeAgentContextKind } | null>(null)
  const [appliedAnalysisViewId, setAppliedAnalysisViewId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [savedEvaluationRunId, setSavedEvaluationRunId] = useState('')
  const [relationChoice, setRelationChoice] = useState<EvaluationRelationChoice>('suggested')
  const [relationEditorOpen, setRelationEditorOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const handledEvaluationLaunch = useRef<string | null>(null)
  const handledNativeLaunch = useRef<string | null>(null)
  const restoredEvaluationScope = useRef('')
  const activeRunId = useRef<string | null>(null)
  const projectRef = useRef<ProjectSnapshot | null>(project)
  projectRef.current = project
  const evaluationSources = agentEvaluationSources(project, selectedFile, selectedEvaluationRootId)
  const evaluationScopeId = evaluationSources[0]?.rootId
  const projectKey = project?.id ?? 'no-project'
  const projectScopeKey = `${agentProjectScopeKey(project)}\u0000evaluation:${evaluationScopeId ?? 'none'}`
  const projectKeyRef = useRef(projectKey)
  projectKeyRef.current = projectKey
  const projectScopeKeyRef = useRef(projectScopeKey)
  projectScopeKeyRef.current = projectScopeKey
  const relationSuggestion = useMemo(() => project && evaluationRun
    ? agentEvaluationRelationSuggestion(project, evaluationRun, evaluationRunScopeId)
    : null, [evaluationRun, evaluationRunScopeId, project])
  const resolvedRelation = useMemo(() => relationSuggestion
    ? resolveEvaluationRelationChoice(relationSuggestion, relationChoice, evaluationRun?.proposal?.purpose)
    : null, [evaluationRun?.proposal?.purpose, relationChoice, relationSuggestion])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api?.agent) return undefined
    return api.agent.onRunUpdate((next) => {
      if (!shouldAcceptAgentRun(next, activeRunId.current, project?.id) || projectKeyRef.current !== projectKey) return
      setRun(next)
      if (shouldClearSubmissionBusy(next)) setBusy(false)
    })
  }, [project?.id, projectKey])

  useEffect(() => {
    activeRunId.current = null
    setRun(null)
    setEvaluationRun(null)
    setEvaluationRunScopeId(undefined)
    setNativeSessions([])
    setNativeSession(null)
    setNativeBackend(null)
    setNativeHistoryOpen(false)
    setNativeSessionsLoading(false)
    setInput('')
    setEvaluationAnswer('')
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setSavedEvaluationRunId('')
    setRelationChoice('suggested')
    setRelationEditorOpen(false)
    setMentionedSourceIds([])
    setNativeContextSourceIds([])
    setPendingNativeLaunch(null)
    setAppliedAnalysisViewId('')
    restoredEvaluationScope.current = ''
  }, [projectKey])

  useEffect(() => {
    activeRunId.current = null
    setRun(null)
    setEvaluationRun(null)
    setEvaluationRunScopeId(undefined)
    setNativeSession(null)
    setNativeSessions([])
    setNativeHistoryOpen(false)
    setNativeSessionsLoading(false)
    setEvaluationAnswer('')
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setSavedEvaluationRunId('')
    setRelationChoice('suggested')
    setRelationEditorOpen(false)
    setMentionedSourceIds((current) => current.filter((sourceId) => project?.artifacts.some((source) => source.sourceId === sourceId)))
    setNativeContextSourceIds([])
    setPendingNativeLaunch(null)
    setAppliedAnalysisViewId('')
    restoredEvaluationScope.current = ''
  }, [projectScopeKey])

  useEffect(() => {
    setRelationChoice('suggested')
    setRelationEditorOpen(false)
  }, [evaluationRun?.id])

  useEffect(() => {
    if (nativeSession?.analysisViewProposal?.id !== appliedAnalysisViewId) setAppliedAnalysisViewId('')
  }, [nativeSession?.analysisViewProposal?.id])

  useEffect(() => {
    if (relationSuggestion?.classification === 'pending') setRelationEditorOpen(true)
  }, [relationSuggestion?.classification, relationSuggestion?.candidateNodeId])

  useEffect(() => {
    const api = window.sequenceIntelligence?.evaluationAgent
    if (!api || !open || !project || !evaluationScopeId || evaluationRun || evaluationStarting) return undefined
    const restoreKey = `${project.id}\u0000${evaluationScopeId}`
    if (restoredEvaluationScope.current === restoreKey) return undefined
    restoredEvaluationScope.current = restoreKey
    let active = true
    void api.restore({ projectId: project.id, evaluationScopeId }).then((session) => {
      if (!active || !session || projectScopeKeyRef.current !== projectScopeKey) return
      if (!shouldRestoreEvaluationReview(project, session)) return
      setEvaluationRunScopeId(evaluationScopeId)
      setEvaluationRun(session)
    }).catch(() => undefined)
    return () => { active = false }
  }, [evaluationRun, evaluationScopeId, evaluationStarting, open, project, projectScopeKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.evaluationAgent
    if (!api || !evaluationRun || evaluationRun.status !== 'running') return undefined
    let active = true
    let polling = false
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const next = await api.get(evaluationRun.id)
        if (active && next && projectScopeKeyRef.current === projectScopeKey) setEvaluationRun(next)
      } catch (reason) {
        if (active) setError(boundedError(reason))
      } finally { polling = false }
    }
    const timer = window.setInterval(() => { void poll() }, 750)
    void poll()
    return () => { active = false; window.clearInterval(timer) }
  }, [evaluationRun?.id, evaluationRun?.status, projectScopeKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || !open) {
      setNativeSessionsLoading(false)
      return undefined
    }
    let active = true
    setNativeSessionsLoading(true)
    void Promise.all([api.list({ projectId: project.id, ...(evaluationScopeId ? { evaluationScopeId } : {}) }), api.backendStatus()]).then(async ([sessions, backend]) => {
      if (!active || projectScopeKeyRef.current !== projectScopeKey) return
      setNativeSessions(sessions); setNativeBackend(backend)
      const first = evaluationScopeId || !project.artifacts.length ? sessions[0] : undefined
      if (first) {
        const detail = await api.get({ sessionId: first.id })
        if (active && detail && projectScopeKeyRef.current === projectScopeKey) setNativeSession(detail)
      }
    }).catch((reason) => { if (active) setError(boundedError(reason)) })
      .finally(() => { if (active && projectScopeKeyRef.current === projectScopeKey) setNativeSessionsLoading(false) })
    const unsubscribe = api.onUpdate((next) => {
      if (!active || next.projectId !== projectKeyRef.current || (evaluationScopeId !== undefined && next.evaluationScopeId !== evaluationScopeId)) return
      setNativeSessions((current) => {
        const { messages: _messages, tools: _tools, ...summary } = next
        return [summary, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
      setNativeSession((current) => !current || current.id === next.id ? next : current)
      if (next.status === 'idle' || next.status === 'paused' || next.status === 'failed') setBusy(false)
    })
    return () => { active = false; unsubscribe() }
  }, [open, projectScopeKey])

  useEffect(() => {
    if (!open || !followLatestRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current
      if (thread) thread.scrollTop = thread.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    open,
    nativeSession?.id,
    nativeSession?.updatedAt,
    nativeSession?.messages.length,
    nativeSession?.tools.length,
    evaluationRun?.status,
    evaluationRun?.question?.id,
    evaluationRun?.proposal?.outcome,
    run?.status,
    run?.question?.id,
  ])

  useEffect(() => {
    const toggle = () => {
      if (open) onClose()
      else { onOpen(); window.setTimeout(() => composerRef.current?.focus(), 0) }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j')) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      toggle()
    }
    const onCommand = (event: Event) => {
      if ((event as CustomEvent).detail === 'toggle-agent') toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('sequence-control-tower:command', onCommand)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('sequence-control-tower:command', onCommand)
    }
  }, [onClose, onOpen, open])

  const invoke = async (action: () => Promise<AgentRun>, clearInput = false) => {
    if (busy || !activeRunId.current) return
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (shouldAcceptAgentRun(next, activeRunId.current, project?.id) && projectKeyRef.current === projectKey) {
        setRun(next)
        if (shouldClearSubmissionBusy(next)) setBusy(false)
      }
    } catch (reason) {
      setBusy(false)
      setError(boundedError(reason))
    }
    if (clearInput) setInput('')
  }

  const start = async () => {
    const api = window.sequenceIntelligence
    if (!api?.agent || !project) return
    if (busy) return
    setBusy(true); setError(''); setRun(null)
    try {
      const source = selectedFile ? resolveProjectSource(project, selectedFile) : null
      if (!source) { setBusy(false); setError('선택한 파일의 프로젝트 source를 정확히 확인할 수 없습니다.'); return }
      const next = await api.agent.start({ projectId: project.id, artifactIds: [source.artifactId], sourceId: source.sourceId })
      if (projectKeyRef.current !== projectKey) return
      activeRunId.current = next.id
      setRun(next)
      if (shouldClearSubmissionBusy(next)) setBusy(false)
    } catch (reason) { setBusy(false); setError(boundedError(reason)) }
  }

  const createNativeSession = async (request?: Pick<NativeAgentLaunchRequest, 'title' | 'sourceIds' | 'evaluationScopeId'>) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy) return null
    const startedScope = projectScopeKey
    const requestedScopeId = request ? request.evaluationScopeId : evaluationScopeId
    const requestedSourceIds = request?.sourceIds?.length
      ? [...new Set(request.sourceIds)].slice(0, MAX_AGENT_CONTEXT_SOURCES)
      : evaluationSources.slice(0, MAX_AGENT_CONTEXT_SOURCES).map((source) => source.sourceId)
    followLatestRef.current = true
    setBusy(true); setError(''); setSavedMessage(''); setNativeHistoryOpen(false)
    try {
      const next = await api.create({
        projectId: project.id,
        ...(request?.title ? { title: request.title } : {}),
        ...(requestedScopeId ? { evaluationScopeId: requestedScopeId } : {}),
        sourceIds: requestedSourceIds,
      })
      if (projectScopeKeyRef.current !== startedScope) return null
      setNativeSession(next)
      setNativeContextSourceIds(request ? requestedSourceIds : [])
      setNativeSessions((current) => [{ ...next }, ...current.filter((item) => item.id !== next.id)])
      return next
    } catch (reason) { setError(boundedError(reason)); return null }
    finally { setBusy(false) }
  }

  const openNativeSession = async (sessionId: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || busy) return
    followLatestRef.current = true
    setBusy(true); setError(''); setNativeHistoryOpen(false)
    const startedScope = projectScopeKey
    try {
      const next = await api.get({ sessionId })
      if (next && projectScopeKeyRef.current === startedScope) { setNativeSession(next); setNativeContextSourceIds([]) }
    }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const sendNativeText = async (content: string, targetSession?: NativeAgentSessionView, sourceOverride?: readonly string[], turnContextKind: NativeAgentContextKind = 'free_chat') => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy) return
    if (!hasMeaningfulAgentMessage(content)) { setError('질문이나 확인할 로그 조건을 입력해 주세요.'); return }
    const startedScope = projectScopeKey
    let target = targetSession ?? nativeSession
    if (!target) target = await createNativeSession()
    if (!target) return
    followLatestRef.current = true
    setBusy(true); setError(''); setInput(''); setNativeHistoryOpen(false)
    try {
      const sourceIds = sourceOverride?.length
        ? [...new Set(sourceOverride)].slice(0, MAX_AGENT_CONTEXT_SOURCES)
        : mentionedSourceIds.length
          ? mentionedSourceIds
          : nativeContextSourceIds.length
            ? nativeContextSourceIds
            : evaluationSources.slice(0, MAX_AGENT_CONTEXT_SOURCES).map((source) => source.sourceId)
      const next = await api.send({ sessionId: target.id, content: content.trim(), sourceIds: sourceIds.length ? sourceIds : undefined, contextKind: turnContextKind })
      if (projectScopeKeyRef.current === startedScope) {
        setNativeSession(next)
        setMentionedSourceIds([])
      }
    }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const retryNative = async () => {
    if (!nativeSession || busy || !window.sequenceIntelligence?.nativeAgent) return
    setBusy(true); setError('')
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.nativeAgent.retry({ sessionId: nativeSession.id })
      if (projectScopeKeyRef.current === startedScope) setNativeSession(next)
    }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const cancelNative = async () => {
    if (!nativeSession || !window.sequenceIntelligence?.nativeAgent) return
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.nativeAgent.cancel({ sessionId: nativeSession.id })
      if (projectScopeKeyRef.current === startedScope) setNativeSession(next)
    }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const startProjectTrend = async (sourceIds?: readonly string[], requestedScopeId = evaluationScopeId, requestedIntent?: string) => {
    const api = window.sequenceIntelligence
    if (!api?.evaluationAgent || !project || busy) return
    setBusy(true); setEvaluationStarting(true); setError(''); setSavedMessage(''); setSavedEvaluationRunId(''); setEvaluationRun(null)
    try {
      const scopedSourceIds = sourceIds?.length ? [...sourceIds] : evaluationSources.map((source) => source.sourceId)
      if (!scopedSourceIds.length) throw new Error('분석할 평가 폴더의 로그를 먼저 선택해 주세요.')
      setEvaluationRunScopeId(requestedScopeId)
      const existing = [...(project.evaluationNodes ?? [])].reverse().find((node) => node.evaluationScopeId === requestedScopeId)
      const evaluationIntent = evaluationIntentForAgent(requestedIntent, existing, nativeSession, requestedScopeId)
      const next = await api.evaluationAgent.start({
        projectId: project.id, sourceIds: scopedSourceIds.slice(0, 32),
        ...(evaluationIntent ? { intent: evaluationIntent } : {}),
      })
      if (projectScopeKeyRef.current === projectScopeKey) setEvaluationRun(next)
    } catch (reason) { setError(boundedError(reason)) } finally { setBusy(false); setEvaluationStarting(false) }
  }

  useEffect(() => {
    if (!open || !evaluationLaunchRequest || !project || busy || handledEvaluationLaunch.current === evaluationLaunchRequest.id) return
    handledEvaluationLaunch.current = evaluationLaunchRequest.id
    void startProjectTrend(evaluationLaunchRequest.sourceIds, evaluationLaunchRequest.evaluationScopeId, evaluationLaunchRequest.intent)
  }, [busy, evaluationLaunchRequest?.id, open, project?.id])

  useEffect(() => {
    if (!open || !nativeLaunchRequest || !project || busy || handledNativeLaunch.current === nativeLaunchRequest.id) return
    handledNativeLaunch.current = nativeLaunchRequest.id
    setEvaluationRun(null)
    setEvaluationRunScopeId(undefined)
    void (async () => {
      const api = window.sequenceIntelligence?.nativeAgent
      if (!api) return
      let target: NativeAgentSessionView | null = null
      const currentId = reusableNativeLaunchSessionId(nativeSession, nativeSessions, nativeLaunchRequest)
      if (currentId) target = currentId === nativeSession?.id ? nativeSession : await api.get({ sessionId: currentId })
      if (!target) {
        const listed = await api.list({ projectId: project.id, ...(nativeLaunchRequest.evaluationScopeId ? { evaluationScopeId: nativeLaunchRequest.evaluationScopeId } : {}) })
        const reusableId = reusableNativeLaunchSessionId(null, listed, nativeLaunchRequest)
        if (reusableId) target = await api.get({ sessionId: reusableId })
      }
      if (!target) target = await createNativeSession(nativeLaunchRequest)
      if (!target) return
      setNativeSession(target)
      setNativeContextSourceIds(nativeLaunchRequest.sourceIds)
      if (target.question) {
        setPendingNativeLaunch({ sessionId: target.id, prompt: nativeLaunchRequest.prompt, sourceIds: nativeLaunchRequest.sourceIds, contextKind: nativeLaunchRequest.contextKind })
        return
      }
      await sendNativeText(nativeLaunchRequest.prompt, target, nativeLaunchRequest.sourceIds, nativeLaunchRequest.contextKind)
    })()
  }, [busy, nativeLaunchRequest?.id, open, project?.id])

  useEffect(() => {
    if (!pendingNativeLaunch || !nativeSession || nativeSession.id !== pendingNativeLaunch.sessionId || nativeSession.question || nativeSession.status !== 'idle' || busy) return
    const pending = pendingNativeLaunch
    setPendingNativeLaunch(null)
    void sendNativeText(pending.prompt, nativeSession, pending.sourceIds, pending.contextKind)
  }, [busy, nativeSession?.id, nativeSession?.question?.id, nativeSession?.status, pendingNativeLaunch?.sessionId])

  const resumeProjectTrend = async (input: { answer?: string; confirm?: 'accept' | 'reject' }) => {
    if (!evaluationRun || busy || !window.sequenceIntelligence?.evaluationAgent) return
    setBusy(true); setError('')
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, ...input })
      if (projectScopeKeyRef.current === startedScope) setEvaluationRun(next)
      setEvaluationAnswer('')
    }
    catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const saveProjectProposal = async () => {
    if (!evaluationRun?.proposal || (evaluationRun.status !== 'waiting_confirmation' && evaluationRun.status !== 'completed') || busy || !project || !window.sequenceIntelligence?.evaluationAgent || !window.sequenceIntelligence?.projects) return
    setBusy(true); setError('')
    try {
      const completed = evaluationRun.status === 'completed' ? evaluationRun : await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, confirm: 'accept' })
      setEvaluationRun(completed)
      const prefix = evaluationAgentRecordPrefix(project.id, evaluationRun.id)
      const payload = await window.sequenceIntelligence.evaluationAgent.memorySavePayload({ sessionId: evaluationRun.id, projectId: project.id, hypothesisId: `${prefix}-h`, nodeId: `${prefix}-n`, evidenceIdPrefix: `${prefix}-e` })
      if (!payload) throw new Error('저장할 제안이 없습니다.')
      // A slow LLM may complete after another same-project write. Always save
      // against the current prop/revision, not the revision that started it.
      const current = projectRef.current
      if (!current || current.id !== project.id) throw new Error('프로젝트가 변경되었습니다. 최신 프로젝트에서 다시 시도해 주세요.')
      const sourceDecisions = proposalSourceDecisions(evaluationRun.proposal)
        .flatMap((assessment) => {
          const result = proposalDecisionResult(assessment.outcome)
          return result ? [{ ...assessment, result }] : []
        })
      let nextEvaluation = evaluationSnapshot
      if (sourceDecisions.length && nextEvaluation && window.sequenceIntelligence.evaluations) {
        for (const assessment of sourceDecisions) {
          const source = current.artifacts.find((item) => item.sourceId === assessment.sourceId)
          if (!source) continue
          const saveDecision = (expectedRevision: number) => window.sequenceIntelligence!.evaluations.saveDecision({
              projectId: current.id,
              expectedRevision,
              source: { sourceId: source.sourceId, artifactId: source.artifactId, sourceKey: source.sourceId },
              result: assessment.result,
              evidenceRefs: evaluationRun.evidence
                .filter((item) => item.sourceId === assessment.sourceId && assessment.evidenceIds.includes(item.id))
                .flatMap((item) => item.lineNumbers)
                .map((lineNumber) => ({ artifactId: source.artifactId, lineNumber })),
            })
          let decision: Awaited<ReturnType<typeof saveDecision>>
          try {
            decision = await saveDecision(nextEvaluation.revision)
          } catch (reason) {
            if (!isProjectRevisionConflict(reason)) throw reason
            nextEvaluation = await window.sequenceIntelligence.evaluations.getSnapshot({ projectId: current.id })
            decision = await saveDecision(nextEvaluation.revision)
          }
          nextEvaluation = decision.snapshot
        }
        if (nextEvaluation !== evaluationSnapshot) onSnapshotSaved(nextEvaluation)
      }
      const title = evaluationProposalTitle(evaluationRun.proposal, evaluationRun.evaluationIntent)
      const namedPayloadBase: EvaluationAgentMemoryPayloadView = {
        ...payload,
        hypothesis: { ...payload.hypothesis, title },
        node: {
          ...payload.node,
          name: title,
          ...(evaluationRunScopeId ? { evaluationScopeId: evaluationRunScopeId } : {}),
          interpretation: evaluationRun.proposal.rationale,
          authorship: 'agent',
          reviewState: 'confirmed',
        },
      }
      const freshRelation = agentEvaluationRelationSuggestion(current, completed, evaluationRunScopeId)
      const namedPayload = freshRelation
        ? applyEvaluationAgentRelation(current, namedPayloadBase, resolveEvaluationRelationChoice(freshRelation, relationChoice, completed.proposal?.purpose))
        : namedPayloadBase
      const persist = (target: ProjectSnapshot) => {
        const merged = mergeEvaluationAgentMemory(target, namedPayload)
        return window.sequenceIntelligence!.projects.save({ projectId: target.id, expectedRevision: target.revision, failureHypotheses: merged.failureHypotheses, evaluationNodes: merged.evaluationNodes, evidenceRecords: merged.evidenceRecords })
      }
      let saved: ProjectSnapshot
      try {
        saved = await persist(current)
      } catch (reason) {
        if (!isProjectRevisionConflict(reason)) throw reason
        const refreshed = await window.sequenceIntelligence.projects.get({ projectId: current.id })
        if (!refreshed) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        saved = await persist(refreshed)
      }
      onProjectUpdated(saved)
      setSavedEvaluationRunId(evaluationRun.id)
      setSavedMessage(sourceDecisions.length ? '결과와 평가 이력에 저장됨' : '평가 이력에 저장됨')
    } catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const answer = (value: string) => {
    if (!run?.question) return
    void invoke(() => window.sequenceIntelligence!.agent.answer({ runId: run.id, questionId: run.question!.id, value }))
  }

  const send = (event: FormEvent) => {
    event.preventDefault()
    const value = input.trim()
    if (!value || !run) return
    void invoke(() => window.sequenceIntelligence!.agent.message({ runId: run.id, content: value }), true)
  }

  const cancel = async () => {
    if (!run || !isAgentRunPending(run)) return
    try {
      const next = await window.sequenceIntelligence?.agent.cancel({ runId: run.id })
      if (next) setRun(next)
    } catch (reason) { setError(boundedError(reason)) }
    activeRunId.current = null
    setBusy(false)
  }

  const confirm = async () => {
    if (!run || busy) return
    const result = run.candidate?.kind === 'result' ? run.candidate.result : undefined
    const decision = buildAgentDecisionInput(project, selectedFile, evaluationSnapshot, result)
    if (!decision || !window.sequenceIntelligence?.agent) return
    setBusy(true); setError('')
    try {
      const saved = await window.sequenceIntelligence.agent.confirm({ runId: run.id, kind: 'decision', expectedRevision: decision.expectedRevision, decision })
      if (saved.saved && 'snapshot' in saved.saved) onSnapshotSaved(saved.saved.snapshot)
      setRun(saved.run); setBusy(false)
    } catch (reason) { setBusy(false); setError(boundedError(reason)) }
  }

  const dismiss = () => { activeRunId.current = null; setRun(null); setEvaluationRun(null); setBusy(false); setError(''); setSavedMessage(''); setSavedEvaluationRunId('') }
  const canStart = Boolean(project && window.sequenceIntelligence?.agent && selectedFile?.artifactId)
  const confirmable = Boolean(run?.candidate?.kind === 'result' && buildAgentDecisionInput(project, selectedFile, evaluationSnapshot, run.candidate.result))
  const pending = Boolean(run && isAgentRunPending(run))

  const projectPending = evaluationRun?.status === 'running' || evaluationRun?.status === 'paused'
  const projectCanStart = Boolean(project && evaluationSources.length && window.sequenceIntelligence?.evaluationAgent)
  const folderScopeRequired = Boolean(project?.artifacts.length && !evaluationScopeId && !nativeContextSourceIds.length)
  const currentNativeTools = nativeSession ? toolsForCurrentAgentRun(nativeSession) : []
  const evaluationReviewActive = Boolean(evaluationStarting || evaluationRun)
  const evaluationProposalSaved = isEvaluationProposalSaved(evaluationRun, savedEvaluationRunId)
  const scope = project ? 'project' as const : 'current' as const
  const slashMatch = /(^|\s)\/([^\s/]*)$/.exec(input)
  const composerSources = nativeContextSourceIds.length && project
    ? project.artifacts.filter((artifact) => nativeContextSourceIds.includes(artifact.sourceId))
    : evaluationSources
  const fileMentions = slashMatch && project ? composerSources.filter((artifact) => {
    const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath
    return name.toLocaleLowerCase().includes(slashMatch[2].toLocaleLowerCase())
  }).slice(0, 6) : []
  const chooseFileMention = (sourceId: string) => {
    if (!slashMatch) return
    setInput(`${input.slice(0, slashMatch.index)}${slashMatch[1]}${input.slice(slashMatch.index + slashMatch[0].length)}`)
    setMentionedSourceIds((current) => [...new Set([...current, sourceId])])
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }
  if (!open) return <button className="agent-fab" onClick={onOpen}><Sparkles size={17} /><span>Agent에게 묻기</span></button>

  return <aside className="agent-panel" aria-label="Agent">
    <div className="agent-panel-head">
      <div><strong>Agent</strong>{project ? <span title={project.name}>{project.name}</span> : null}</div>
      <button className="icon-button small" onClick={onClose} aria-label="Agent 패널 닫기"><X size={15} /></button>
    </div>
    <div
      className="agent-thread"
      ref={threadRef}
      onScroll={(event) => {
        const target = event.currentTarget
        followLatestRef.current = isAgentThreadNearBottom(target.scrollTop, target.clientHeight, target.scrollHeight)
      }}
    >
      {scope === 'current' && !run ? <div className="agent-empty"><p>{project ? (selectedFile?.artifactId ? selectedFile.name : '로그를 선택하세요.') : '프로젝트를 선택하세요.'}</p><button className="agent-start" onClick={() => void start()} disabled={!canStart}>분석</button></div> : null}
      {scope === 'project' && nativeSessionsLoading && !nativeSession && !evaluationReviewActive ? <div className="agent-empty" role="status"><p className="agent-loading"><LoaderCircle className="wb-spin" size={14} />대화 불러오는 중</p></div> : null}
      {scope === 'project' && !nativeSessionsLoading && !nativeSession && !evaluationReviewActive ? <div className="agent-empty">{!project?.artifacts.length || !evaluationScopeId ? <p>{!project?.artifacts.length ? (project ? '로그를 연결하세요.' : '프로젝트를 선택하세요.') : '분석할 폴더의 로그를 선택하세요.'}</p> : null}<button className="agent-start" onClick={() => void createNativeSession()} disabled={!project || busy || Boolean(project.artifacts.length && !evaluationScopeId)}>새 대화</button></div> : null}
      {scope === 'current' && run?.question ? <><div className="agent-message question"><Sparkles size={13} /><p>{run.question.prompt}</p></div>{run.question.choices?.length ? <div className="quick-answers">{run.question.choices.map((choice) => <button key={choice} onClick={() => answer(choice)} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div> : null}</> : null}
      {scope === 'current' && run?.candidate ? <div className="agent-candidate"><span>후보 결과</span><strong>{candidateText(run)}</strong><small>{confirmable ? '확인 후 저장됩니다.' : '현재는 검토만 가능합니다.'}</small>{confirmable ? <div className="agent-review-actions"><button onClick={() => void confirm()} disabled={busy}><Check size={13} />확인하고 저장</button><button onClick={dismiss} disabled={busy}>거절</button></div> : <button onClick={dismiss}>닫기</button>}</div> : null}
      {scope === 'current' && run?.status === 'failed' ? <div className="agent-error" role="alert">{run.failureReason ? boundedError(new Error(run.failureReason)) : '분석에 실패했습니다.'}</div> : null}
      {scope === 'current' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {scope === 'project' && nativeSession ? <>
        {nativeSession.messages.map((message) => {
          const evidenceTools = toolsForAssistantMessage(message, nativeSession.messages, nativeSession.tools)
          return <div key={message.id} className="native-agent-turn">
            {message.role === 'assistant' && evidenceTools.length ? <details className="native-agent-tools"><summary><Wrench size={12} />확인 과정</summary>{evidenceTools.map((tool) => <div key={tool.id} className={tool.state}><span>{tool.label}</span><small>{tool.state === 'running' ? '확인 중' : tool.summary ?? tool.state}</small></div>)}</details> : null}
            <div className={`native-agent-message ${message.role}`} aria-label={message.role === 'user' ? '내 메시지' : message.role === 'assistant' ? 'Agent 응답' : '기록'}>{message.role === 'user' && message.contextKind && message.contextKind !== 'free_chat' ? <small className="native-agent-context-label">{analysisContextLabel(message.contextKind)}</small> : null}{message.role === 'assistant' ? <AgentMarkdown>{message.content}</AgentMarkdown> : <p>{message.content}</p>}</div>
            {message.role === 'assistant' && onOpenSource && message.evidenceSourceIds?.length ? <div className="native-agent-evidence-links" aria-label="응답 근거 로그">{[...new Set(message.evidenceSourceIds)].slice(0, 3).map((sourceId) => { const source = project?.artifacts.find((item) => item.sourceId === sourceId); const name = source?.relativePath.split(/[\\/]/).at(-1) ?? '근거 로그'; return <button type="button" key={sourceId} title={source?.relativePath ?? name} onClick={() => onOpenSource(sourceId)}><FileText size={12} />{name}</button> })}{message.evidenceSourceIds.length > 3 ? <span>+{message.evidenceSourceIds.length - 3}</span> : null}</div> : null}
          </div>
        })}
        {nativeSession.analysisViewProposal ? <section className="native-analysis-proposal" aria-label="Agent 추천 보기">
          <div><strong>추천 보기</strong><span>{ANALYSIS_DATA_BASIS_LABELS[nativeSession.analysisViewProposal.dataBasis]} · {ANALYSIS_VISUALIZATION_LABELS[nativeSession.analysisViewProposal.visualization]}</span></div>
          <p>왼쪽 {analysisProposalAxes(nativeSession.analysisViewProposal.rowAxes)} · 상단 {analysisProposalAxes(nativeSession.analysisViewProposal.columnAxes)}</p>
          {nativeSession.analysisViewProposal.rationale ? <small>{nativeSession.analysisViewProposal.rationale}</small> : null}
          <button type="button" disabled={!onApplyAnalysisViewProposal || appliedAnalysisViewId === nativeSession.analysisViewProposal.id} onClick={() => { onApplyAnalysisViewProposal?.(nativeSession.analysisViewProposal!); setAppliedAnalysisViewId(nativeSession.analysisViewProposal!.id) }}>{appliedAnalysisViewId === nativeSession.analysisViewProposal.id ? '적용됨' : '보기에 적용'}</button>
        </section> : null}
        {nativeSession.question ? <div className="native-agent-question"><AgentMarkdown>{nativeSession.question.prompt}</AgentMarkdown><div className="quick-answers">{nativeSession.question.choices.map((choice) => <button key={choice} onClick={() => { if (choice === '직접 입력') composerRef.current?.focus(); else void sendNativeText(choice) }} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div>{pendingNativeLaunch?.sessionId === nativeSession.id ? <small className="agent-pending-context">답변 후 선택한 범위를 분석합니다.</small> : null}</div> : null}
        {nativeSession.status === 'running' && currentNativeTools.length ? <div className="native-agent-running-tools" role="status" aria-label="Agent 근거 확인 상태">{currentNativeTools.map((tool) => <div key={tool.id}><Check size={12} /><span>{tool.label}</span>{tool.summary ? <small>{tool.summary}</small> : null}</div>)}</div> : null}
        {shouldShowNativeAgentSuggestions(nativeSession) ? <div className="native-agent-suggestions"><button onClick={() => void startProjectTrend()} disabled={!projectCanStart || busy}>결과와 평가 이력 정리</button><button onClick={() => void sendNativeText('온도와 VDD, DQ별 불량률과 집중 경향을 분모와 함께 비교해줘.')} disabled={busy}>조건별 불량 경향</button><button onClick={() => void sendNativeText('과거 LPDDR5와 LPDDR6 유사 불량을 찾아서 다음 평가를 제안해줘.')} disabled={busy}>과거 사례와 다음 평가</button></div> : null}
      </> : null}
      {scope === 'project' && evaluationStarting ? <section className="agent-evaluation-review" aria-label="결과와 평가 이력 준비 중"><div className="agent-evaluation-progress"><LoaderCircle size={13} className="wb-spin" /><span>평가 폴더를 확인하는 중</span></div></section> : null}
      {scope === 'project' && evaluationRun ? <section className="agent-evaluation-review" aria-label="결과와 평가 이력 검토">
        <div className="agent-evaluation-review-head"><div><strong>결과와 평가 이력</strong>{evaluationRun.analysisPolicy ? <span title={`${evaluationRun.analysisPolicy.id} · ${evaluationRun.analysisPolicy.version}`}>LPDDR 기준 적용</span> : null}</div><button type="button" onClick={() => setEvaluationRun(null)} aria-label="검토 닫기"><X size={14} /></button></div>
        {projectPending ? <div className="agent-evaluation-progress"><span>{evaluationRun.status === 'paused' ? boundedError(new Error(evaluationRun.failure ?? '분석을 이어갈 수 있습니다.')) : '분석 중'}</span>{evaluationRun.status === 'paused' ? <button type="button" onClick={() => void resumeProjectTrend({})} disabled={busy}><RotateCcw size={14} />다시 시도</button> : null}</div> : null}
        {evaluationRun.question ? <div className="agent-evaluation-question"><AgentMarkdown>{evaluationRun.question.prompt}</AgentMarkdown>{evaluationRun.question.choices?.length ? <div className="quick-answers">{evaluationRun.question.choices.map((choice) => <button type="button" key={choice} onClick={() => void resumeProjectTrend({ answer: choice })} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div> : null}<form onSubmit={(event) => { event.preventDefault(); if (evaluationAnswer.trim()) void resumeProjectTrend({ answer: evaluationAnswer.trim() }) }}><input value={evaluationAnswer} onChange={(event) => setEvaluationAnswer(event.target.value)} placeholder={evaluationRun.question.field === 'evaluationIntent' ? '평가 목적 직접 입력' : '확인할 값 입력'} /><button type="submit" disabled={busy || !evaluationAnswer.trim()}>확인</button></form></div> : null}
        {evaluationRun.proposal ? <div className="agent-evaluation-proposal"><div><strong>{evaluationOutcomeLabel(evaluationRun.proposal.outcome)}</strong>{evaluationRun.proposal.purpose ? <span>{agentEvaluationPurposeLabel(evaluationRun.proposal.purpose)}</span> : null}</div><p>{evaluationRun.proposal.rationale}</p>{evaluationDimensionSummary(evaluationRun.proposal.dimensions).length ? <ul>{evaluationDimensionSummary(evaluationRun.proposal.dimensions).map((item) => <li key={item}>{item}</li>)}</ul> : null}{resolvedRelation ? <div className="agent-evaluation-relation"><div><span>이력 연결</span><strong>{resolvedRelation.classification === 'pending' ? '분류 대기' : resolvedRelation.classification === 'new-issue' ? '새 불량 이슈' : `${resolvedRelation.candidateTitle ?? '기존 불량'} · ${evaluationRelationLabel(resolvedRelation.relation)}`}</strong><button type="button" onClick={() => setRelationEditorOpen((value) => !value)} aria-expanded={relationEditorOpen}>{relationEditorOpen ? '닫기' : '변경'}</button></div><small>{resolvedRelation.reason}</small>{relationEditorOpen ? <div className="agent-evaluation-relation-options" role="radiogroup" aria-label="평가 이력 연결 방식"><button type="button" role="radio" aria-checked={relationChoice === 'suggested'} className={relationChoice === 'suggested' ? 'is-selected' : ''} onClick={() => setRelationChoice('suggested')}><i />추천대로 적용</button>{relationSuggestion?.candidateHypothesisId ? <button type="button" role="radio" aria-checked={relationChoice === 'existing-issue'} className={relationChoice === 'existing-issue' ? 'is-selected' : ''} onClick={() => setRelationChoice('existing-issue')}><i />{relationSuggestion.candidateTitle ?? '기존 불량'}에 연결</button> : null}<button type="button" role="radio" aria-checked={relationChoice === 'new-issue'} className={relationChoice === 'new-issue' ? 'is-selected' : ''} onClick={() => setRelationChoice('new-issue')}><i />새 불량으로 분리</button><button type="button" role="radio" aria-checked={relationChoice === 'pending'} className={relationChoice === 'pending' ? 'is-selected' : ''} onClick={() => setRelationChoice('pending')}><i />나중에 분류</button></div> : null}</div> : null}<div className="agent-review-actions"><button type="button" onClick={() => void saveProjectProposal()} disabled={busy || evaluationProposalSaved}><Check size={14} />{evaluationProposalSaved ? '저장됨' : '결과·이력 저장'}</button>{evaluationRun.status === 'waiting_confirmation' ? <button type="button" onClick={() => void resumeProjectTrend({ confirm: 'reject' })} disabled={busy}>다시 분석</button> : null}</div></div> : null}
      </section> : null}
      {scope === 'project' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {savedMessage ? <div className="agent-saved" role="status">{savedMessage}</div> : null}
    </div>
    {scope === 'current' && pending ? <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{stageText(run!)}</span><button onClick={() => void cancel()}>취소</button></div> : null}
    {scope === 'project' && nativeSession && nativeSession.status !== 'idle' ? nativeSession.status === 'paused' || nativeSession.status === 'failed' ? <div className="agent-stage retry-only"><button onClick={() => void retryNative()} disabled={busy} aria-label="재시도" title="재시도"><RotateCcw size={15} /></button></div> : <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{nativeSession.status === 'queued' ? '대기 중' : '분석 중'}</span><button onClick={() => void cancelNative()}>중지</button></div> : null}
    {scope === 'current' ? <form className="agent-composer" onSubmit={send}>
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="짧은 메시지 입력" rows={2} disabled={!run || busy} />
      <div><span /><button type="submit" aria-label="메시지 보내기" disabled={!run || busy || !input.trim()}><ArrowUp size={15} /></button></div>
    </form> : evaluationReviewActive ? null : <form className="agent-composer native" onSubmit={(event) => { event.preventDefault(); void sendNativeText(input) }}>
      {fileMentions.length ? <div className="agent-file-mentions" role="listbox" aria-label="파일 지정">{fileMentions.map((artifact) => { const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath; return <button type="button" role="option" key={artifact.sourceId} onClick={() => chooseFileMention(artifact.sourceId)}><span>{name}</span><small>{artifact.relativePath}</small></button> })}</div> : null}
      {mentionedSourceIds.length ? <div className="agent-selected-files" aria-label="지정한 파일">{mentionedSourceIds.flatMap((sourceId) => { const artifact = composerSources.find((item) => item.sourceId === sourceId); if (!artifact) return []; const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath; return [<span key={sourceId} title={artifact.relativePath}><FileText size={12} /><b>{name}</b><button type="button" onClick={() => setMentionedSourceIds((current) => current.filter((item) => item !== sourceId))} aria-label={`${name} 지정 해제`}><X size={12} /></button></span>] })}</div> : null}
      <textarea ref={composerRef} value={input} onChange={(event) => { setInput(event.target.value); if (error && hasMeaningfulAgentMessage(event.target.value)) setError('') }} placeholder={folderScopeRequired ? '분석할 폴더의 로그를 선택하세요' : '질문 입력 · / 로 파일 지정'} rows={2} disabled={!project || folderScopeRequired || nativeSessionsLoading || busy || nativeSession?.status === 'queued' || nativeSession?.status === 'running'} />
      <div className="agent-composer-footer"><span className="native-agent-controls"><button type="button" onClick={() => setNativeHistoryOpen((value) => !value)} aria-expanded={nativeHistoryOpen} aria-label="대화 기록" title="대화 기록" disabled={nativeSessionsLoading}><History size={17} /></button><i className={`native-agent-backend ${nativeSession?.backend ?? nativeBackend?.active ?? 'internal'}`} title={(nativeSession?.backend ?? nativeBackend?.active) === 'opencode' ? 'OpenCode' : '내장'} /><button type="button" onClick={() => void createNativeSession()} disabled={!project || nativeSessionsLoading || busy || folderScopeRequired} aria-label="새 대화" title="새 대화"><Plus size={17} /></button></span><button type="submit" aria-label="Agent에 메시지 보내기" disabled={!project || folderScopeRequired || nativeSessionsLoading || busy || !hasMeaningfulAgentMessage(input)}><ArrowUp size={18} /></button></div>
      {nativeHistoryOpen ? <div className="native-agent-history">{nativeSessions.map((item) => <button type="button" key={item.id} className={item.id === nativeSession?.id ? 'active' : ''} onClick={() => void openNativeSession(item.id)} disabled={busy}><strong>{item.title}</strong><span>{new Date(item.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></button>)}{!nativeSessions.length ? <p>저장된 대화가 없습니다.</p> : null}</div> : null}
    </form>}
  </aside>
}
