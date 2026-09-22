import { useAgentDraft, agentDraftKey, agentDraftRevision, acknowledgeAgentDraft, transferNewAgentDraft } from '../state/agentDrafts'
import { captureNativeEvaluationBasis, nativeEvaluationProposalState } from '../domain/agent-evaluation-basis'
import { AsyncActionGate } from '../state/asyncActionGate'
import { agentRuleSummary, prepareAgentRuleSave, isAgentRuleProposalSaved } from '../domain/agent-rule-proposal'
import { readViewDraft, writeViewDraft, useViewScopeGuard } from '../state/viewDrafts'
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
  NativeAgentContextKind,
  NativeAgentEvaluationStage,
  NativeAgentAnalysisViewProposal,
  NativeAgentEvaluationProposal,
  NativeAgentSessionSummary,
  NativeAgentSessionView,
  ProjectEvaluationReport,
  ProjectSnapshot,
} from '../../electron/shared/contracts'
import type { WorkbenchFile } from '../views/WorkbenchView'
import type { LogResultRecord } from '../state/logRecords'
import { resolveProjectSource } from '../state/sourceIdentity'
import { projectSnapshotToEvaluationMemory } from '../state/evaluationMemory'
import { relationForEvaluationPurpose, suggestEvaluationRelation, type EvaluationRelationSuggestion } from '../domain/evaluation-relation'
import { AgentMarkdown } from './AgentMarkdown'
import { llmFailureDisplay } from '../domain/llm-error'
import { hasMeaningfulAgentMessage } from '../domain/agent-message'
import { analysisContextLabel } from '../domain/agent-analysis-view'
import { ANALYSIS_DATA_BASIS_LABELS, ANALYSIS_VISUALIZATION_LABELS } from '../domain/analysis-view'
import { boundedAgentContextIds } from '../domain/analysis-context'
import type { AppPage } from '../state/appNavigation'
import { AGENT_EVALUATION_STAGE_LABELS } from '../domain/agent-evaluation-stage'
import { createEvaluationReportDraft, evaluationReportInterpretation } from '../domain/evaluation-report'

interface AgentPanelProps {
  activePage: AppPage
  open: boolean
  onClose: () => void
  onOpen: () => void
  project: ProjectSnapshot | null
  selectedFile?: WorkbenchFile
  selectedEvaluationRootId?: string
  evaluationSnapshot: EvaluationProjectSnapshot | null
  records: readonly LogResultRecord[]
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
  evaluationStage: NativeAgentEvaluationStage
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

export function evaluationOutcomeLabel(outcome: EvaluationAgentPublicOutcome | NativeAgentEvaluationProposal['outcome']): string {
  if (outcome === 'EXCLUDED') return '제외'
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

const NATIVE_FAILURE_OUTCOMES = new Set(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])

export function exactFolderOutcome(records: readonly LogResultRecord[]): NativeAgentEvaluationProposal['outcome'] {
  if (!records.length || records.some((record) => record.result === 'UNKNOWN')) return 'UNKNOWN'
  const outcomes = new Set(records.filter((record) => record.result !== 'EXCLUDED').map((record) => record.result))
  return outcomes.size === 1 ? [...outcomes][0] : 'UNKNOWN'
}

export function nativeEvaluationReport(
  proposal: NativeAgentEvaluationProposal,
  records: readonly LogResultRecord[],
  title: string,
): ProjectEvaluationReport {
  const evidenceSourceIds = records.map((record) => record.id)
  const report = createEvaluationReportDraft({
    title,
    purpose: proposal.purpose,
    purposeText: proposal.draft.purpose,
    interpretation: proposal.draft.interpretation || proposal.rationale,
    changedConditions: proposal.draft.changedConditions,
    fixedConditions: proposal.draft.fixedConditions,
    evidenceSourceIds,
    sources: records.map((record) => ({ id: record.id, name: record.fileName, result: record.result, dimensions: record.dimensions })),
  })
  report.interpretation = {
    ...report.interpretation,
    text: proposal.draft.interpretation || proposal.rationale,
    findings: proposal.draft.findings,
    counterEvidence: proposal.draft.counterEvidence,
    caveats: proposal.draft.caveats,
    state: 'engineer-confirmed',
  }
  report.trends = {
    ...report.trends,
    text: proposal.draft.trends || '확인된 조건 경향이 없습니다.',
    state: 'engineer-confirmed',
  }
  report.nextPlan = {
    ...report.nextPlan,
    text: proposal.draft.nextPlan || '다음 평가 조건을 확인해야 합니다.',
    ...(proposal.draft.nextObjective ? { objective: proposal.draft.nextObjective } : {}),
    ...(proposal.draft.changedVariable ? { changedVariable: proposal.draft.changedVariable } : {}),
    levels: proposal.draft.levels,
    heldConditions: proposal.draft.heldConditions,
    samples: proposal.draft.samples,
    ...(proposal.draft.repeats ? { repeats: proposal.draft.repeats } : {}),
    successCriteria: proposal.draft.successCriteria,
    state: 'engineer-confirmed',
  }
  report.purpose = { ...report.purpose, state: 'engineer-confirmed' }
  return report
}

function EvaluationReportPreview({ report, fallback }: { report?: ProjectEvaluationReport; fallback: string }) {
  const sections = report ? [
    ['평가 목적', report.purpose.text],
    ['평가 결과', report.results.summary],
    ['결과 해석', report.interpretation.text],
    ['불량 경향', report.trends.text],
    ['다음 평가', report.nextPlan.text],
  ] : [['평가 해석', fallback]]
  return <ol className="agent-evaluation-report">{sections.map(([label, text], index) => <li key={label}><span>{index + 1}</span><div><strong>{label}</strong><p>{text}</p></div></li>)}</ol>
}

export function acceptNativeSession(current: NativeAgentSessionView | null, next: NativeAgentSessionView): NativeAgentSessionView {
  if (current?.id !== next.id) return next
  return (next.revision ?? 0) < (current.revision ?? 0) || ((next.revision ?? 0) === (current.revision ?? 0) && next.updatedAt < current.updatedAt) ? current : next
}

export function mergeNativeSessionSummaries(current: readonly NativeAgentSessionSummary[], incoming: readonly NativeAgentSessionSummary[]): NativeAgentSessionSummary[] {
  const sessions = new Map(current.map((session) => [session.id, session]))
  for (const session of incoming) {
    const previous = sessions.get(session.id)
    if (!previous || (session.revision ?? 0) > (previous.revision ?? 0)
      || ((session.revision ?? 0) === (previous.revision ?? 0) && session.updatedAt >= previous.updatedAt)) sessions.set(session.id, session)
  }
  return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function evaluationDimensionSummary(dimensions: EvaluationAgentSessionView['dimensions']): string[] {
  const values: Array<[string, unknown]> = [
    ['Skew', dimensions.skew], ['Sample', dimensions.sample ?? dimensions.material], ['Die', dimensions.die], ['Grid', dimensions.gridId],
    ['실장기 채널', dimensions.equipmentChannel], ['ECC', dimensions.eccMode], ['평가 제목', dimensions.customCondition], ['평가 Step', dimensions.evaluationStep],
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
  sample: 'Sample', skew: 'Skew', temperature: '온도', temperatureCorner: '온도 조건', vdd: 'VDD', vddCorner: 'VDD 조건',
  conditionCorner: '4-Corner', frequencyMHz: '주파수', testMode: 'Test Mode', pattern: 'Pattern', dq: 'DQ', bl: 'BL',
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
  const llmFailure = llmFailureDisplay(error)
  if (llmFailure) return llmFailure
  if (raw.includes('AGENT_SOURCE_SCOPE_LIMIT')) return '한 평가 폴더에 연결할 수 있는 로그 10,000개를 넘었습니다. 로그를 제외하지 않고 분석을 중단했습니다.'
  if (raw.includes('REVISION_CONFLICT')) return '분석 결과가 바뀌었습니다. 최신 결과를 확인해 주세요.'
  if (raw.includes('찾을 수 없습니다')) return '프로젝트 또는 실행을 찾을 수 없습니다.'
  if (raw.includes('입력인지 출력인지 선택')) return '먼저 위 질문에 답해 주세요.'
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

export function AgentPanel({ activePage, open, onClose, onOpen, project, selectedFile, selectedEvaluationRootId, evaluationSnapshot, records, onSnapshotSaved, onProjectUpdated, evaluationLaunchRequest, nativeLaunchRequest, onOpenSource, onApplyAnalysisViewProposal }: AgentPanelProps) {
  const [run, setRun] = useState<AgentRun | null>(null)
  const [evaluationStarting, setEvaluationStarting] = useState(false)
  const [nativeSessions, setNativeSessions] = useState<NativeAgentSessionSummary[]>([])
  const [nativeSession, setNativeSession] = useState<NativeAgentSessionView | null>(null)
  const nativeSessionRef = useRef(nativeSession)
  const updateNativeSession = (next: NativeAgentSessionView) => {
    const accepted = acceptNativeSession(nativeSessionRef.current, next)
    nativeSessionRef.current = accepted
    setNativeSession(accepted)
  }
  const [nativeHistoryOpen, setNativeHistoryOpen] = useState(false)
  const [nativeSessionsLoading, setNativeSessionsLoading] = useState(false)
  const [mentionedSourceIds, setMentionedSourceIds] = useState<string[]>([])
  const [nativeContextSourceIds, setNativeContextSourceIds] = useState<string[]>([])
  const [appliedAnalysisViewId, setAppliedAnalysisViewId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const [savedRuleProposalId, setSavedRuleProposalId] = useState('')
  const nativeAction = useRef(new AsyncActionGate())
  const [stopping, setStopping] = useState(false)
  const stoppingAction = useRef<symbol | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const handledEvaluationLaunch = useRef<string | null>(null)
  const handledNativeLaunch = useRef<string | null>(null)
  const activeRunId = useRef<string | null>(null)
  const projectRef = useRef<ProjectSnapshot | null>(project)
  projectRef.current = project
  const recordsRef = useRef(records)
  recordsRef.current = records
  const evaluationSources = agentEvaluationSources(project, selectedFile, selectedEvaluationRootId)
  const evaluationScopeId = evaluationSources[0]?.rootId
  const evaluationScopeLabel = project?.folders.find((folder) => folder.rootId === evaluationScopeId)?.displayLabel
  const agentHeaderScope = [project?.name, evaluationScopeLabel].filter(Boolean).join(' · ')
  const projectKey = project?.id ?? 'no-project'
  const projectScopeKey = `${agentProjectScopeKey(project)}\u0000evaluation:${evaluationScopeId ?? 'none'}`
  const draftScope = { projectId: projectKey, evaluationScopeId, sessionId: nativeSession?.projectId === projectKey && nativeSession.evaluationScopeId === evaluationScopeId ? nativeSession.id : undefined }
  const { draft: input, setDraft: setInput, storage: draftStorage, acknowledge: acknowledgeDraft } = useAgentDraft(draftScope)
  const draftController = useRef({ key: agentDraftKey(draftScope), acknowledge: acknowledgeDraft })
  draftController.current = { key: agentDraftKey(draftScope), acknowledge: acknowledgeDraft }
  const captureScope = useViewScopeGuard(projectScopeKey)
  const selectedSessionRef = useRef<string | null>(null)
  const sendingRef = useRef<symbol | null>(null)
  const projectKeyRef = useRef(projectKey)
  projectKeyRef.current = projectKey
  const projectScopeKeyRef = useRef(projectScopeKey)
  projectScopeKeyRef.current = projectScopeKey

  useEffect(() => {
    // React replays mount effects in StrictMode; restore guards on every setup.
    projectKeyRef.current = projectKey
    projectScopeKeyRef.current = projectScopeKey
    return () => { projectKeyRef.current = 'unmounted'; projectScopeKeyRef.current = 'unmounted' }
  }, [])

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
    setNativeSessions([])
    nativeSessionRef.current = null
    setNativeSession(null)
    setNativeHistoryOpen(false)
    setNativeSessionsLoading(false)
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setMentionedSourceIds([])
    setNativeContextSourceIds([])
    setAppliedAnalysisViewId('')
  }, [projectKey])

  useEffect(() => {
    activeRunId.current = null
    setRun(null)
    nativeSessionRef.current = null
    setNativeSession(null)
    setNativeSessions([])
    setNativeHistoryOpen(false)
    setNativeSessionsLoading(false)
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setMentionedSourceIds([])
    setNativeContextSourceIds([])
    selectedSessionRef.current = null
    sendingRef.current = null
    nativeAction.current.reset()
    stoppingAction.current = null
    setStopping(false)
    setAppliedAnalysisViewId('')
  }, [projectScopeKey])

  useEffect(() => {
    setMentionedSourceIds([])
    setSavedMessage('')
  }, [nativeSession?.id])

  useEffect(() => {
    if (nativeSession?.analysisViewProposal?.id !== appliedAnalysisViewId) setAppliedAnalysisViewId('')
  }, [nativeSession?.analysisViewProposal?.id])

  useEffect(() => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || !open) {
      setNativeSessionsLoading(false)
      return undefined
    }
    let active = true
    setNativeSessionsLoading(true)
    void api.list({ projectId: project.id, ...(evaluationScopeId ? { evaluationScopeId } : {}) }).then(async (sessions) => {
      if (!active || projectScopeKeyRef.current !== projectScopeKey) return
      setNativeSessions((current) => mergeNativeSessionSummaries(current, sessions))
      if (nativeAction.current.pending) return
      const rememberedId = selectedSessionRef.current ?? readViewDraft<string | null>(`agent-session:${projectScopeKey}`, null)
      const first = evaluationScopeId || !project.artifacts.length ? (selectedSessionRef.current ? sessions.find((item) => item.id === selectedSessionRef.current) : sessions.find((item) => item.id === rememberedId) ?? sessions[0]) : undefined
      if (first) {
        selectedSessionRef.current = first.id
        const detail = await api.get({ sessionId: first.id })
        if (active && detail && selectedSessionRef.current === first.id && projectScopeKeyRef.current === projectScopeKey) updateNativeSession(detail)
      }
    }).catch((reason) => { if (active) setError(boundedError(reason)) })
      .finally(() => { if (active && projectScopeKeyRef.current === projectScopeKey) setNativeSessionsLoading(false) })
    const unsubscribe = api.onUpdate((next) => {
      if (!active || next.projectId !== projectKeyRef.current || (evaluationScopeId !== undefined && next.evaluationScopeId !== evaluationScopeId)) return
      setNativeSessions((current) => {
        const { messages: _messages, tools: _tools, ...summary } = next
        return mergeNativeSessionSummaries(current, [summary])
      })
      if (selectedSessionRef.current === next.id) {
        updateNativeSession(next)
      }
    })
    return () => { active = false; unsubscribe() }
  }, [open, projectScopeKey])

  useEffect(() => {
    if (!nativeSession || nativeSession.projectId !== projectKey || nativeSession.evaluationScopeId !== evaluationScopeId) return
    writeViewDraft(`agent-session:${projectScopeKey}`, nativeSession.id)
    if (!nativeAction.current.pending && !sendingRef.current && !['queued', 'running'].includes(nativeSession.status)) setBusy(false)
  }, [nativeSession?.id, nativeSession?.revision, nativeSession?.status, projectScopeKey])

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

  const createNativeSession = async (request?: Pick<NativeAgentLaunchRequest, 'title' | 'sourceIds' | 'evaluationScopeId'>, owner?: symbol) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || (busy && !owner)) return null
    const token = owner ?? nativeAction.current.begin()
    if (!token || !nativeAction.current.owns(token)) return null
    const scopeIsActive = captureScope()
    const requestedScopeId = request ? request.evaluationScopeId : evaluationScopeId
    followLatestRef.current = true
    setBusy(true); setError(''); setSavedMessage(''); setNativeHistoryOpen(false)
    try {
      const requestedSourceIds = request?.sourceIds?.length
        ? boundedAgentContextIds(request.sourceIds)
        : boundedAgentContextIds(evaluationSources.map((source) => source.sourceId))
      const next = await api.create({
        projectId: project.id,
        ...(request?.title ? { title: request.title } : {}),
        ...(requestedScopeId ? { evaluationScopeId: requestedScopeId } : {}),
        sourceIds: requestedSourceIds,
      })
      if (!scopeIsActive()) return null
      transferNewAgentDraft({ projectId: project.id, evaluationScopeId: next.evaluationScopeId, sessionId: next.id })
      selectedSessionRef.current = next.id
      updateNativeSession(next)
      setNativeContextSourceIds(request ? requestedSourceIds : [])
      setNativeSessions((current) => [{ ...next }, ...current.filter((item) => item.id !== next.id)])
      return next
    } catch (reason) { if (scopeIsActive()) setError(boundedError(reason)); return null }
    finally { if (!owner) nativeAction.current.finish(token); if (!owner && scopeIsActive()) setBusy(false) }
  }

  const openNativeSession = async (sessionId: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || busy) return
    const token = nativeAction.current.begin()
    if (!token) return
    followLatestRef.current = true
    setBusy(true); setError(''); setNativeHistoryOpen(false)
    const scopeIsActive = captureScope()
    try {
      const next = await api.get({ sessionId })
      if (!next) throw new Error('대화를 찾을 수 없습니다. 기존 대화는 유지됩니다.')
      if (scopeIsActive()) {
        selectedSessionRef.current = sessionId
        updateNativeSession(next)
        setNativeContextSourceIds([])
      }
    }
    catch (reason) { if (scopeIsActive()) setError(boundedError(reason)) }
    finally { nativeAction.current.finish(token); if (scopeIsActive()) setBusy(false) }
  }

  const sendNativeText = async (content: string, targetSession?: NativeAgentSessionView, sourceOverride?: readonly string[], turnContextKind: NativeAgentContextKind = 'free_chat', turnEvaluationStage?: NativeAgentEvaluationStage, owner?: symbol) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || (busy && !owner) || sendingRef.current) return
    if (!hasMeaningfulAgentMessage(content)) { setError('질문이나 확인할 로그 조건을 입력해 주세요.'); return }
    const token = owner ?? nativeAction.current.begin()
    if (!token || !nativeAction.current.owns(token)) return
    const scopeIsActive = captureScope()
    sendingRef.current = token
    let target = targetSession ?? nativeSession
    if (!target) target = await createNativeSession(undefined, token)
    if (!target || !scopeIsActive()) {
      if (!owner) nativeAction.current.finish(token)
      if (scopeIsActive()) { sendingRef.current = null; setBusy(false) }
      return
    }
    followLatestRef.current = true
    setBusy(true); setError(''); setNativeHistoryOpen(false)
    try {
      const sourceIds = sourceOverride?.length
        ? boundedAgentContextIds(sourceOverride)
        : mentionedSourceIds.length
          ? mentionedSourceIds
          : nativeContextSourceIds.length
            ? nativeContextSourceIds
            : boundedAgentContextIds(evaluationSources.map((source) => source.sourceId))
      const submittedScope = { projectId: project.id, evaluationScopeId: target.evaluationScopeId, sessionId: target.id }
      const submittedDraftRevision = agentDraftRevision(submittedScope)
      const next = await api.send({ sessionId: target.id, content: content.trim(), sourceIds: target.question?.kind === 'agent' && !sourceOverride?.length && !mentionedSourceIds.length ? undefined : sourceIds.length ? sourceIds : undefined, contextKind: turnContextKind, evaluationStage: turnEvaluationStage, evaluationBasis: captureNativeEvaluationBasis(project, evaluationSnapshot, target.evaluationScopeId ?? evaluationScopeId, records), ...(target.question?.kind === 'agent' ? { questionId: target.question.id } : {}) })
      if (draftController.current.key === agentDraftKey(submittedScope)) draftController.current.acknowledge(content, submittedDraftRevision)
      else acknowledgeAgentDraft(submittedScope, content, undefined, submittedDraftRevision)
      if (scopeIsActive() && selectedSessionRef.current === target.id) {
        updateNativeSession(next)
        setBusy(Boolean(stoppingAction.current) || ['queued', 'running'].includes(acceptNativeSession(nativeSessionRef.current, next).status))
        setMentionedSourceIds([])
      }
    }
    catch (reason) { if (scopeIsActive()) { setError(boundedError(reason)); setBusy(Boolean(stoppingAction.current)) } }
    finally { if (!owner) nativeAction.current.finish(token); if (scopeIsActive() && sendingRef.current === token) sendingRef.current = null }
  }

  const retryNative = async () => {
    if (!nativeSession || busy || !window.sequenceIntelligence?.nativeAgent) return
    const token = nativeAction.current.begin()
    if (!token) return
    sendingRef.current = token
    setBusy(true); setError('')
    const scopeIsActive = captureScope()
    try {
      const next = await window.sequenceIntelligence.nativeAgent.retry({ sessionId: nativeSession.id })
      if (scopeIsActive() && selectedSessionRef.current === nativeSession.id) {
        updateNativeSession(next)
        setBusy(Boolean(stoppingAction.current) || ['queued', 'running'].includes(acceptNativeSession(nativeSessionRef.current, next).status))
      }
    }
    catch (reason) { if (scopeIsActive()) { setError(boundedError(reason)); setBusy(Boolean(stoppingAction.current)) } }
    finally { nativeAction.current.finish(token); if (scopeIsActive() && sendingRef.current === token) sendingRef.current = null }
  }

  const cancelNative = async () => {
    if (!nativeSession || !window.sequenceIntelligence?.nativeAgent) return
    if (stoppingAction.current || (nativeAction.current.pending && !sendingRef.current)) return
    const interruptedSend = sendingRef.current
    const token = nativeAction.current.replace()
    stoppingAction.current = token
    const scopeIsActive = captureScope()
    setStopping(true); setBusy(true); setError('')
    try {
      const next = await window.sequenceIntelligence.nativeAgent.cancel({ sessionId: nativeSession.id })
      if (scopeIsActive()) updateNativeSession(next)
    }
    catch (reason) { if (scopeIsActive()) setError(boundedError(reason)) }
    finally {
      nativeAction.current.finish(token)
      if (stoppingAction.current === token) stoppingAction.current = null
      if (scopeIsActive()) {
        if (sendingRef.current === interruptedSend) sendingRef.current = null
        setBusy(false); setStopping(false)
      }
    }
  }

  const startProjectTrend = async (sourceIds?: readonly string[], requestedScopeId = evaluationScopeId, requestedIntent?: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy) return
    const scopeIsActive = captureScope()
    const token = nativeAction.current.begin()
    if (!token) return
    setBusy(true)
    setEvaluationStarting(true); setError(''); setSavedMessage('')
    try {
      const scopedSourceIds = sourceIds?.length ? [...sourceIds] : evaluationSources.map((source) => source.sourceId)
      if (!scopedSourceIds.length) throw new Error('분석할 평가 폴더의 로그를 먼저 선택해 주세요.')
      const existingNode = [...(project.evaluationNodes ?? [])].reverse().find((node) => node.evaluationScopeId === requestedScopeId)
      const evaluationIntent = evaluationIntentForAgent(requestedIntent, existingNode, nativeSession, requestedScopeId)
      let target = nativeSession && nativeSession.evaluationScopeId === requestedScopeId && nativeSession.status === 'idle'
        ? nativeSession
        : null
      if (!target) {
        const sessions = await api.list({ projectId: project.id, ...(requestedScopeId ? { evaluationScopeId: requestedScopeId } : {}) })
        const reusable = sessions.find((session) => session.status === 'idle')
        if (reusable) target = await api.get({ sessionId: reusable.id })
      }
      if (!scopeIsActive()) return
      if (!target) target = await createNativeSession({ title: '평가 요약', sourceIds: scopedSourceIds, evaluationScopeId: requestedScopeId }, token)
      if (!target || !scopeIsActive()) return
      selectedSessionRef.current = target.id
      updateNativeSession(target!)
      setNativeContextSourceIds(scopedSourceIds)
      const intentContext = evaluationIntent ? `\n현재 폴더에 저장된 목적 참고: ${evaluationIntent}` : ''
      await sendNativeText(`현재 폴더를 평가 목적, 평가 결과, 결과 해석, 불량 경향, 다음 평가의 다섯 단계로 정리해줘.${intentContext}\n판정 수치는 현재 폴더 전체의 로컬 집계를 사용하고, 목적이나 이력 연결이 결론을 바꿀 만큼 애매할 때만 관찰 근거가 들어간 질문을 한 번 해줘.\n[SCT_EVALUATION_REPORT_CONTEXT]`, target, scopedSourceIds, 'evaluation_history', 'interpretation', token)
    } catch (reason) { if (scopeIsActive()) setError(boundedError(reason)) } finally { nativeAction.current.finish(token); if (scopeIsActive()) { setEvaluationStarting(false); setBusy(Boolean(stoppingAction.current) || ['queued', 'running'].includes(nativeSessionRef.current?.status ?? '')) } }
  }

  useEffect(() => {
    if (!open || !evaluationLaunchRequest || !project || busy || handledEvaluationLaunch.current === evaluationLaunchRequest.id) return
    handledEvaluationLaunch.current = evaluationLaunchRequest.id
    void startProjectTrend(evaluationLaunchRequest.sourceIds, evaluationLaunchRequest.evaluationScopeId, evaluationLaunchRequest.intent)
  }, [busy, evaluationLaunchRequest?.id, open, project?.id])

  useEffect(() => {
    if (!open || !nativeLaunchRequest || !project || busy || handledNativeLaunch.current === nativeLaunchRequest.id) return
    const token = nativeAction.current.begin()
    if (!token) return
    handledNativeLaunch.current = nativeLaunchRequest.id
    setBusy(true)
    const scopeIsActive = captureScope()
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
      if (!scopeIsActive()) return
      if (!target) target = await createNativeSession(nativeLaunchRequest, token)
      if (!target || !scopeIsActive()) return
      selectedSessionRef.current = target.id
      updateNativeSession(target!)
      setNativeContextSourceIds(nativeLaunchRequest.sourceIds)
      await sendNativeText(nativeLaunchRequest.prompt, target, nativeLaunchRequest.sourceIds, nativeLaunchRequest.contextKind, nativeLaunchRequest.evaluationStage, token)
    })().catch((reason) => { if (scopeIsActive()) setError(boundedError(reason)) })
      .finally(() => { nativeAction.current.finish(token); if (scopeIsActive()) setBusy(Boolean(stoppingAction.current) || ['queued', 'running'].includes(nativeSessionRef.current?.status ?? '')) })
  }, [busy, nativeLaunchRequest?.id, open, project?.id])

  const saveNativeRuleProposal = async () => {
    const proposal = nativeSession?.ruleProposal
    const api = window.sequenceIntelligence?.evaluations
    if (!project || !proposal || !api || busy) return
    const scopeIsActive = captureScope()
    const token = nativeAction.current.begin()
    if (!token) return
    setBusy(true); setError('')
    try {
      const snapshot = await api.getSnapshot({ projectId: project.id })
      const input = prepareAgentRuleSave(snapshot, proposal, project.id)
      const saved = await api.saveRecipe(input)
      if (!scopeIsActive()) return
      onSnapshotSaved(saved.snapshot)
      setSavedRuleProposalId(proposal.id)
      setSavedMessage('규칙을 저장했습니다. 적용된 폴더는 로그 화면에서 재평가하세요.')
    } catch (reason) { if (scopeIsActive()) setError(boundedError(reason)) }
    finally { nativeAction.current.finish(token); if (scopeIsActive()) setBusy(false) }
  }

  const saveNativeEvaluationProposal = async () => {
    const proposal = nativeSession?.evaluationProposal
    const scopeId = nativeSession?.evaluationScopeId ?? evaluationScopeId
    if (!proposal || !nativeSession || !project || !scopeId || busy || !window.sequenceIntelligence?.projects || !window.sequenceIntelligence.evaluations) return
    const scopedRecords = records.filter((record) => record.evaluationScopeId === scopeId)
    if (nativeEvaluationProposalState(project, nativeSession.id, proposal, captureNativeEvaluationBasis(project, evaluationSnapshot, scopeId, scopedRecords)) !== 'ready') { setError('저장했거나 평가 기준이 변경된 초안입니다. 대화에서 요약을 다시 요청해 주세요.'); return }
    if (!scopedRecords.length) { setError('현재 폴더의 결과가 없습니다.'); return }
    const token = nativeAction.current.begin()
    if (!token) return
    const scopeIsActive = captureScope()
    setBusy(true); setError('')
    try {
      const [freshProject, freshEvaluation] = await Promise.all([
        window.sequenceIntelligence.projects.get({ projectId: project.id }),
        window.sequenceIntelligence.evaluations.getSnapshot({ projectId: project.id }),
      ])
      if (!scopeIsActive()) return
      if (!freshProject || nativeEvaluationProposalState(freshProject, nativeSession.id, proposal, captureNativeEvaluationBasis(freshProject, freshEvaluation, scopeId, recordsRef.current)) !== 'ready') {
        if (freshProject) onProjectUpdated(freshProject)
        onSnapshotSaved(freshEvaluation)
        throw new Error('평가 기준이나 이력이 변경되었습니다. 대화에서 요약을 다시 요청해 주세요.')
      }
      const title = proposal.draft.purpose.trim().slice(0, 120) || evaluationScopeLabel || '평가 요약'
      const outcome = exactFolderOutcome(scopedRecords)
      const status = outcome === 'PASS' ? 'pass' as const : NATIVE_FAILURE_OUTCOMES.has(outcome) ? 'fail' as const : 'inconclusive' as const
      const report = nativeEvaluationReport({ ...proposal, outcome }, scopedRecords, title)
      const prefix = evaluationAgentRecordPrefix(project.id, `native-${nativeSession.id}`)
      const sourceIds = scopedRecords.map((record) => record.id)
      const payload: EvaluationAgentMemoryPayloadView = {
        hypothesis: {
          id: `${prefix}-h`, projectId: project.id, title,
          description: proposal.rationale, origin: 'ai-proposed', evaluationNodeIds: [`${prefix}-n`],
        },
        node: {
          id: `${prefix}-n`, projectId: project.id, hypothesisId: `${prefix}-h`, name: title,
          ...(proposal.purpose ? { purpose: proposal.purpose } : {}),
          dimensions: proposal.dimensions, status, evaluationScopeId: scopeId,
          interpretation: evaluationReportInterpretation(report), report,
          authorship: 'agent', reviewState: 'confirmed',
          agentProposal: { sessionId: nativeSession.id, proposalId: proposal.id, basis: proposal.basis! },
        },
        evidence: [{
          id: `${prefix}-e`, projectId: project.id, evaluationNodeId: `${prefix}-n`, status,
          result: outcome, dimensions: proposal.dimensions, sourceIds,
          summary: report.results.summary, origin: 'ai-proposed',
        }],
      }
      const persist = (target: ProjectSnapshot) => {
        const suggestion = suggestEvaluationRelation(projectSnapshotToEvaluationMemory(target), {
          evaluationScopeId: scopeId, name: title, purpose: proposal.purpose, status,
          dimensions: proposal.dimensions, interpretation: proposal.rationale,
        })
        const related = applyEvaluationAgentRelation(target, payload, suggestion)
        const merged = mergeEvaluationAgentMemory(target, related)
        return window.sequenceIntelligence!.projects.save({
          projectId: target.id, expectedRevision: target.revision, expectedEvaluationRevision: proposal.basis!.evaluationRevision,
          failureHypotheses: merged.failureHypotheses,
          evaluationNodes: merged.evaluationNodes,
          evidenceRecords: merged.evidenceRecords,
        })
      }
      // A revision conflict requires a fresh review, never reapply an old payload.
      const saved = await persist(freshProject)
      if (!scopeIsActive()) return
      onProjectUpdated(saved)
      setSavedMessage('평가 요약을 이력에 저장했습니다.')
    } catch (reason) { if (scopeIsActive()) setError(reason instanceof Error && /REVISION_CONFLICT|최신 revision/.test(reason.message) ? '저장 중 평가 기준이나 이력이 변경되었습니다. 현재 내용을 확인한 뒤 요약을 다시 요청해 주세요.' : boundedError(reason)) } finally { nativeAction.current.finish(token); if (scopeIsActive()) setBusy(false) }
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
      if (projectKeyRef.current !== projectKey) return
      if (saved.saved && 'snapshot' in saved.saved) onSnapshotSaved(saved.saved.snapshot)
      setRun(saved.run); setBusy(false)
    } catch (reason) { setBusy(false); setError(boundedError(reason)) }
  }

  const dismiss = () => { activeRunId.current = null; setRun(null); setBusy(false); setError(''); setSavedMessage('') }
  const canStart = Boolean(project && window.sequenceIntelligence?.agent && selectedFile?.artifactId)
  const confirmable = Boolean(run?.candidate?.kind === 'result' && buildAgentDecisionInput(project, selectedFile, evaluationSnapshot, run.candidate.result))
  const pending = Boolean(run && isAgentRunPending(run))

  const folderScopeRequired = Boolean(project?.artifacts.length && !evaluationScopeId && !nativeContextSourceIds.length)
  const currentNativeTools = nativeSession ? toolsForCurrentAgentRun(nativeSession) : []
  const evaluationReviewActive = evaluationStarting
  const scope = project ? 'project' as const : 'current' as const
  const slashMatch = /(^|\s)\/([^\s/]*)$/.exec(input)
  const composerSources = nativeContextSourceIds.length && project
    ? project.artifacts.filter((artifact) => nativeContextSourceIds.includes(artifact.sourceId))
    : evaluationSources
  const fileMentions = slashMatch && project ? composerSources.filter((artifact) => {
    const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath
    return name.toLocaleLowerCase().includes(slashMatch[2].toLocaleLowerCase())
  }).slice(0, 6) : []
  const ruleProposalSaved = nativeSession?.ruleProposal ? savedRuleProposalId === nativeSession.ruleProposal.id || isAgentRuleProposalSaved(evaluationSnapshot, nativeSession.ruleProposal) : false
  const proposedRuleBefore = nativeSession?.ruleProposal ? evaluationSnapshot?.recipes.find((recipe) => recipe.recipeId === nativeSession.ruleProposal!.recipeId && recipe.revision === nativeSession.ruleProposal!.baseRevision) : undefined
  const nativeProposalRecords = useMemo(() => nativeSession?.evaluationScopeId
    ? records.filter((record) => record.evaluationScopeId === nativeSession.evaluationScopeId)
    : [], [nativeSession?.evaluationScopeId, records])
  const currentProposalBasis = useMemo(() => project
    ? captureNativeEvaluationBasis(project, evaluationSnapshot, nativeSession?.evaluationScopeId, nativeProposalRecords)
    : undefined, [project, evaluationSnapshot, nativeSession?.evaluationScopeId, nativeProposalRecords])
  const nativeProposalState = project && nativeSession?.evaluationProposal
    ? nativeEvaluationProposalState(project, nativeSession.id, nativeSession.evaluationProposal, currentProposalBasis)
    : 'stale'
  const savedProposalNode = project?.evaluationNodes?.find((node) => node.agentProposal?.sessionId === nativeSession?.id && node.agentProposal?.proposalId === nativeSession?.evaluationProposal?.id)
  const nativeProposalReportView = useMemo(() => nativeProposalState === 'saved' ? savedProposalNode?.report
    : nativeProposalState === 'ready' && nativeSession?.evaluationProposal
      ? nativeEvaluationReport(nativeSession.evaluationProposal, nativeProposalRecords, nativeSession.evaluationProposal.draft.purpose || evaluationScopeLabel || '평가 요약')
      : undefined, [nativeProposalState, savedProposalNode, nativeSession?.evaluationProposal, nativeProposalRecords, evaluationScopeLabel])
  const chooseFileMention = (sourceId: string) => {
    if (!slashMatch) return
    setInput(`${input.slice(0, slashMatch.index)}${slashMatch[1]}${input.slice(slashMatch.index + slashMatch[0].length)}`)
    setMentionedSourceIds((current) => [...new Set([...current, sourceId])])
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }
  if (!open) return <button className="agent-fab" onClick={onOpen}><Sparkles size={17} /><span>Agent에게 묻기</span></button>

  return <aside className="agent-panel" aria-label="Agent">
    <div className="agent-panel-head">
      <div><strong>Agent</strong>{agentHeaderScope ? <span title={agentHeaderScope}>{agentHeaderScope}</span> : null}</div>
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
            <div className={`native-agent-message ${message.role}`} aria-label={message.role === 'user' ? '내 메시지' : message.role === 'assistant' ? 'Agent 응답' : '기록'}>{message.role === 'user' && (message.evaluationStage || (message.contextKind && message.contextKind !== 'free_chat')) ? <small className="native-agent-context-label">{[message.contextKind && message.contextKind !== 'free_chat' ? analysisContextLabel(message.contextKind) : '', message.evaluationStage ? AGENT_EVALUATION_STAGE_LABELS[message.evaluationStage] : ''].filter(Boolean).join(' · ')}</small> : null}{message.role === 'assistant' ? <AgentMarkdown>{message.content}</AgentMarkdown> : <p>{message.content}</p>}</div>
            {(message.role === 'assistant' || message.role === 'user') && onOpenSource && message.evidenceSourceIds?.length ? <div className="native-agent-evidence-links" aria-label={message.role === 'user' ? '지정한 로그' : '응답 근거 로그'}>{[...new Set(message.evidenceSourceIds)].slice(0, 3).map((sourceId) => { const source = project?.artifacts.find((item) => item.sourceId === sourceId); const name = source?.relativePath.split(/[\\/]/).at(-1) ?? '근거 로그'; return <button type="button" key={sourceId} title={source?.relativePath ?? name} onClick={() => onOpenSource(sourceId)}><FileText size={12} />{name}</button> })}{message.evidenceSourceIds.length > 3 ? <span>+{message.evidenceSourceIds.length - 3}</span> : null}</div> : null}
          </div>
        })}
        {nativeSession.question?.kind === 'agent' ? <section className="native-agent-question" aria-label="Agent 질문">
          {nativeSession.question.choices.length ? <div className="quick-answers">{nativeSession.question.choices.map((choice) => <button type="button" key={choice} disabled={busy} onClick={() => void sendNativeText(choice)}>{choice}</button>)}</div> : null}
          <small>{nativeSession.question.choices.length ? '선택하거나 아래에 직접 답변하세요.' : '아래에 답변을 입력하세요.'}</small>
        </section> : null}
        {nativeSession.ruleProposal ? <section className="native-rule-proposal" aria-label="규칙 수정안">
          <strong>{nativeSession.ruleProposal.name}</strong>
          <p>{nativeSession.ruleProposal.rationale}</p>
          <details open><summary>변경 전</summary>{proposedRuleBefore ? <ul>{proposedRuleBefore.rules.map((rule) => <li key={rule.id}>{agentRuleSummary(rule)}</li>)}</ul> : <p>기존 규칙을 다시 불러와야 합니다.</p>}</details>
          <details open><summary>변경 후</summary><ul>{nativeSession.ruleProposal.rules.map((rule) => <li key={rule.id}>{agentRuleSummary(rule)}</li>)}</ul></details>
          <small>이 규칙을 사용하는 폴더 전체에 반영되며, 판정은 재평가 후 갱신됩니다.</small>
          <button type="button" onClick={() => void saveNativeRuleProposal()} disabled={busy || Boolean(nativeSession.question) || !proposedRuleBefore || ruleProposalSaved}>{ruleProposalSaved ? '저장됨 · 재평가 필요' : '규칙 수정 저장'}</button>
        </section> : null}
        {nativeSession.analysisViewProposal ? <section className="native-analysis-proposal" aria-label="Agent 추천 보기">
          <div><strong>추천 보기</strong><span>{ANALYSIS_DATA_BASIS_LABELS[nativeSession.analysisViewProposal.dataBasis]} · {ANALYSIS_VISUALIZATION_LABELS[nativeSession.analysisViewProposal.visualization]}</span></div>
          <p>왼쪽 {analysisProposalAxes(nativeSession.analysisViewProposal.rowAxes)} · 상단 {analysisProposalAxes(nativeSession.analysisViewProposal.columnAxes)}</p>
          {nativeSession.analysisViewProposal.rationale ? <small>{nativeSession.analysisViewProposal.rationale}</small> : null}
          <button type="button" disabled={!onApplyAnalysisViewProposal || appliedAnalysisViewId === nativeSession.analysisViewProposal.id} onClick={() => { onApplyAnalysisViewProposal?.(nativeSession.analysisViewProposal!); setAppliedAnalysisViewId(nativeSession.analysisViewProposal!.id) }}>{appliedAnalysisViewId === nativeSession.analysisViewProposal.id ? '적용됨' : '보기에 적용'}</button>
        </section> : null}
        {nativeSession.evaluationProposal ? <section className="agent-evaluation-proposal native-evaluation-proposal" aria-label="Agent 평가 요약">
          <div><strong>{nativeProposalState === 'stale' ? '재검토 필요' : nativeProposalState === 'saved' ? '저장된 평가' : evaluationOutcomeLabel(exactFolderOutcome(nativeProposalRecords))}</strong><span>평가 요약</span></div>
          <EvaluationReportPreview report={nativeProposalReportView} fallback={nativeSession.evaluationProposal.rationale} />
          {nativeProposalState === 'stale' ? <small role="status">평가 기준이 변경되었거나 확인할 수 없습니다. 대화에서 요약을 다시 요청해 주세요.</small> : null}
          <div className="agent-review-actions"><button type="button" onClick={() => void saveNativeEvaluationProposal()} disabled={busy || Boolean(nativeSession.question) || nativeProposalState !== 'ready'}><Check size={14} />{nativeProposalState === 'saved' ? '저장됨' : '평가 이력에 저장'}</button></div>
        </section> : null}
        {nativeSession.status === 'running' && currentNativeTools.length ? <div className="native-agent-running-tools" role="status" aria-label="Agent 근거 확인 상태">{currentNativeTools.map((tool) => <div key={tool.id}><Check size={12} /><span>{tool.label}</span>{tool.summary ? <small>{tool.summary}</small> : null}</div>)}</div> : null}
      </> : null}
      {scope === 'project' && evaluationStarting ? <section className="agent-evaluation-review" aria-label="결과와 평가 이력 준비 중"><div className="agent-evaluation-progress"><LoaderCircle size={13} className="wb-spin" /><span>평가 폴더를 확인하는 중</span></div></section> : null}
      {scope === 'project' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {savedMessage ? <div className="agent-saved" role="status">{savedMessage}</div> : null}
    </div>
    {scope === 'current' && pending ? <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{stageText(run!)}</span><button onClick={() => void cancel()}>취소</button></div> : null}
    {scope === 'project' && nativeSession && nativeSession.status !== 'idle' && nativeSession.status !== 'waiting_question' ? nativeSession.status === 'paused' || nativeSession.status === 'failed' ? <div className="agent-stage retry-only" role="alert"><span>{stopping ? '분석을 중지하는 중…' : nativeSession.failure ? boundedError(new Error(nativeSession.failure)) : nativeSession.status === 'paused' ? '분석이 중지되었습니다. 이어서 진행할 수 있습니다.' : '분석을 완료하지 못했습니다. 다시 시도하세요.'}</span><button onClick={() => void retryNative()} disabled={busy}><RotateCcw size={15} />재시도</button></div> : <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{nativeSession.status === 'queued' ? '대기 중' : '분석 중'}</span><button onClick={() => void cancelNative()} disabled={stopping}>{stopping ? '중지 중…' : '중지'}</button></div> : null}
    {scope === 'current' ? <form className="agent-composer" onSubmit={send}>
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="짧은 메시지 입력" rows={2} disabled={!run || busy} />
      <div><span /><button type="submit" aria-label="메시지 보내기" disabled={!run || busy || !input.trim()}><ArrowUp size={15} /></button></div>
    </form> : evaluationReviewActive ? null : <form className="agent-composer native" onSubmit={(event) => { event.preventDefault(); void sendNativeText(input) }}>
      {fileMentions.length ? <div className="agent-file-mentions" role="listbox" aria-label="파일 지정">{fileMentions.map((artifact) => { const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath; return <button type="button" role="option" key={artifact.sourceId} onClick={() => chooseFileMention(artifact.sourceId)}><span>{name}</span><small>{artifact.relativePath}</small></button> })}</div> : null}
      {mentionedSourceIds.length ? <div className="agent-selected-files" aria-label="지정한 파일">{mentionedSourceIds.flatMap((sourceId) => { const artifact = composerSources.find((item) => item.sourceId === sourceId); if (!artifact) return []; const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath; return [<span key={sourceId} title={artifact.relativePath}><FileText size={12} /><b>{name}</b><button type="button" onClick={() => setMentionedSourceIds((current) => current.filter((item) => item !== sourceId))} aria-label={`${name} 지정 해제`}><X size={12} /></button></span>] })}</div> : null}
      <textarea ref={composerRef} value={input} onChange={(event) => { setInput(event.target.value); if (error && hasMeaningfulAgentMessage(event.target.value)) setError('') }} placeholder={folderScopeRequired ? '분석할 폴더의 로그를 선택하세요' : nativeSession?.question?.kind === 'agent' ? '답변 입력 · 선택지 외의 답변도 가능합니다' : '질문 입력 · / 로 파일 지정'} rows={2} disabled={!project || folderScopeRequired || nativeSessionsLoading || busy || nativeSession?.status === 'queued' || nativeSession?.status === 'running'} />
      <div className="agent-composer-footer"><span className="native-agent-controls"><button type="button" onClick={() => setNativeHistoryOpen((value) => !value)} aria-expanded={nativeHistoryOpen} aria-label="대화 기록" title="대화 기록" disabled={nativeSessionsLoading}><History size={17} /></button><button type="button" onClick={() => void createNativeSession()} disabled={!project || nativeSessionsLoading || busy || folderScopeRequired} aria-label="새 대화" title="새 대화"><Plus size={17} /></button></span><button type="submit" aria-label="Agent에 메시지 보내기" disabled={!project || folderScopeRequired || nativeSessionsLoading || busy || nativeSession?.status === 'queued' || nativeSession?.status === 'running' || !hasMeaningfulAgentMessage(input)}><ArrowUp size={18} /></button></div>
      {!draftStorage.durable && input ? <small role="status">입력한 질문을 임시로 보관 중입니다. 앱을 종료하면 복원되지 않을 수 있습니다.</small> : null}
      {nativeHistoryOpen ? <div className="native-agent-history">{nativeSessions.map((item) => <button type="button" key={item.id} className={item.id === nativeSession?.id ? 'active' : ''} onClick={() => void openNativeSession(item.id)} disabled={busy}><strong>{item.title}</strong><span>{new Date(item.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></button>)}{!nativeSessions.length ? <p>저장된 대화가 없습니다.</p> : null}</div> : null}
    </form>}
  </aside>
}
