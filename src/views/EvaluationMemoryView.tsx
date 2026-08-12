import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, FileText, Folder, Pencil, Sparkles, X } from 'lucide-react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationPurpose, EvaluationRelationKind, EvaluationStatus, EvidenceRecord, FailureHypothesis, ProductProject } from '../domain/evaluation-memory'
import { flattenEvaluationMemory, inferEvaluationTrends } from '../domain/evaluation-memory'
import { evaluationEntryLabel, evaluationRelationLabel, relationForEvaluationPurpose } from '../domain/evaluation-relation'
import './evaluation-memory-view.css'

export interface AvailableEvaluationLog {
  /** Durable project source identity persisted in evidence records. */
  id: string
  /** Renderer file identity used only to navigate to the open log. */
  openId?: string
  rootId?: string
  folderName?: string
  name: string
  result?: string
  sample?: string
  temperatureC?: number
  mode?: string
  grid?: string
}

export interface EvaluationMemoryViewProps {
  memory: EvaluationMemory
  availableLogs: readonly AvailableEvaluationLog[]
  onChange: (nextMemory: EvaluationMemory) => void | Promise<void>
  onOpenLog: (id: string) => void
  onSelectLog?: (id: string) => void
  onAnalyzeEvaluation?: (request: EvaluationAnalysisRequest) => void
  selectedEvaluationScopeId?: string
  onNotify: (message: string) => void
}

export interface EvaluationAnalysisRequest {
  evaluationScopeId: string
  title: string
  sourceIds: string[]
  openId?: string
  intent?: string
}

export interface EvaluationFolderGroup {
  id: string
  label: string
  logs: AvailableEvaluationLog[]
  nodes: EvaluationNode[]
  evidence: EvidenceRecord[]
}

export interface EvaluationFolderFlowItem {
  group: EvaluationFolderGroup
  node?: EvaluationNode
  parentGroupId?: string
}

export interface EvaluationFolderBranch {
  id: string
  label: string
  items: EvaluationFolderFlowItem[]
  parentGroupId?: string
  kind: 'issue' | 'queue'
}

const purposeLabel: Record<EvaluationPurpose, string> = {
  screening: '불량 검출 강화', improvement: '개선 조건 확인', reproduction: '동일 불량 재현', characterization: '불량 경향 파악', verification: '개선 효과 검증', 'stage-verification': '부팅·Training 확인',
}
const statusLabel: Record<EvaluationStatus, string> = { pass: 'PASS', fail: 'FAIL', inconclusive: '미정', running: '진행 중' }
const dimensionFields: Array<[keyof EvaluationDimensions, string, 'text' | 'number']> = [
  ['skew', 'SKEW', 'text'], ['lot', 'Lot', 'text'], ['material', '자재', 'text'], ['die', 'Die', 'text'], ['sample', 'Sample', 'text'], ['socModel', 'SoC', 'text'], ['bootProfileId', 'Boot profile', 'text'], ['gridId', 'Grid', 'text'], ['bl', 'BL', 'text'], ['dq', 'DQ', 'text'], ['channel', 'Channel', 'text'], ['subChannel', 'Sub Channel', 'text'], ['chipSelect', 'CS', 'text'], ['rank', 'Rank', 'text'], ['bankGroup', 'Bank Group', 'text'], ['bank', 'Bank', 'text'], ['row', 'Row', 'text'], ['column', 'Column', 'text'], ['writeData', 'WR', 'text'], ['readData', 'RD', 'text'], ['pattern', 'Pattern', 'text'], ['frequencyMHz', '주파수 (MHz)', 'number'], ['temperatureC', '°C', 'number'], ['temperatureCorner', '온도 조건', 'text'], ['vdd', 'VDD (V)', 'number'], ['vddCorner', 'VDD 조건', 'text'], ['conditionCorner', '4-Corner', 'text'], ['timingSkewPs', 'Timing SKEW (ps)', 'number'], ['testMode', 'Mode', 'text'],
]

const emptyDimensions = (): EvaluationDimensions => ({})
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`
const trendDimensionLabel = (dimension: string) => ({ skew: 'SKEW', timingSkewPs: 'Timing SKEW', vdd: 'VDD', vddCorner: 'VDD 조건', conditionCorner: '4-Corner', bl: 'BL', dq: 'DQ', frequencyMHz: '주파수', socModel: 'SoC', bootProfileId: 'Boot profile', gridId: 'Grid', channel: 'Channel', subChannel: 'Sub Channel', chipSelect: 'CS', rank: 'Rank', bank: 'Bank', bankGroup: 'Bank Group', row: 'Row', column: 'Column', writeData: 'WR', readData: 'RD', pattern: 'Pattern', temperatureC: '온도', temperatureCorner: '온도 조건', die: 'Die', sample: 'Sample', lot: 'Lot', material: '자재', testMode: 'Mode' }[dimension] ?? dimension)

export function evaluationLogResultLabel(result?: string): string {
  const value = result?.trim()
  return !value || value.toUpperCase() === 'UNKNOWN' ? '미정' : value
}

export function trendInterpretation(trend: ReturnType<typeof inferEvaluationTrends>[number]): string {
  const condition = `${trendDimensionLabel(trend.dimension)} ${trend.value}`
  const ratio = `${trend.failureCount}/${trend.evidenceCount} 실패`
  if (trend.failureRate === 1) return `${condition} · ${ratio}`
  if (trend.failureRate >= 0.6) return `${condition} · ${ratio} · 집중`
  return `${condition} · ${ratio}`
}

export function addFailureHypothesis(memory: EvaluationMemory, draft: Pick<FailureHypothesis, 'title' | 'description' | 'origin'>): EvaluationMemory {
  const hypothesis: FailureHypothesis = { id: id('hyp'), projectId: memory.project.id, ...draft }
  return { ...memory, hypotheses: [...memory.hypotheses, hypothesis] }
}

export function addEvaluationWithEvidence(memory: EvaluationMemory, input: { name: string; purpose?: EvaluationPurpose; hypothesisId?: string; parentId?: string; branchId?: string; evaluationScopeId?: string; interpretation?: string; status: EvaluationStatus; dimensions: EvaluationDimensions; logIds: readonly string[]; origin: AssessmentOrigin; relation?: EvaluationRelationKind }): EvaluationMemory {
  const node: EvaluationNode = {
    id: id('eval'), projectId: memory.project.id, name: input.name, purpose: input.purpose,
    hypothesisId: input.hypothesisId || undefined, parentId: input.parentId || undefined, branchId: input.branchId || undefined,
    evaluationScopeId: input.evaluationScopeId || undefined, interpretation: input.interpretation?.trim() || undefined,
    authorship: input.origin === 'engineer-confirmed' ? 'engineer' : 'agent', reviewState: input.origin === 'engineer-confirmed' ? 'confirmed' : 'proposed',
    status: input.status, dimensions: input.dimensions, relation: input.relation,
  }
  const evidence: EvidenceRecord[] = input.logIds.map((logRef) => ({ id: id('evidence'), projectId: memory.project.id, evaluationNodeId: node.id, status: input.status, sourceIds: [logRef], logRef, origin: input.origin }))
  return { ...memory, nodes: [...memory.nodes, node], evidence: [...memory.evidence, ...evidence] }
}

/** Applies one locally edited project-condition draft in a single save payload. */
export function withProjectConditions(memory: EvaluationMemory, project: ProductProject): EvaluationMemory {
  return { ...memory, project: { ...project, id: memory.project.id, name: memory.project.name } }
}

export function linkedEvidenceLogIds(memory: EvaluationMemory, nodeId: string): string[] {
  return memory.evidence.filter((record) => record.evaluationNodeId === nodeId).flatMap((record) => record.sourceIds?.length ? record.sourceIds : record.logRef ? [record.logRef] : [])
}

export function openIdForEvidenceLog(logId: string, logs: readonly AvailableEvaluationLog[]): string {
  const log = logs.find((item) => item.id === logId)
  return log?.openId ?? logId
}

function logStatus(result?: string): EvaluationStatus {
  const value = result?.toUpperCase() ?? ''
  if (value === 'PASS' || value.endsWith('_PASS')) return 'pass'
  if (/FAIL|HALT|REBOOT/.test(value)) return 'fail'
  if (/RUNNING/.test(value)) return 'running'
  return 'inconclusive'
}

/** Groups persisted nodes and logs by the attached root that represents one evaluation. */
export function groupEvaluationFolders(memory: EvaluationMemory, logs: readonly AvailableEvaluationLog[]): EvaluationFolderGroup[] {
  const groups = new Map<string, EvaluationFolderGroup>()
  const logById = new Map(logs.map((log) => [log.id, log]))
  const ensure = (groupId: string, label: string) => {
    const current = groups.get(groupId) ?? { id: groupId, label, logs: [], nodes: [], evidence: [] }
    groups.set(groupId, current)
    return current
  }
  logs.forEach((log) => {
    const groupId = log.rootId ?? 'unscoped'
    ensure(groupId, log.folderName ?? (groupId === 'unscoped' ? '연결 로그' : groupId)).logs.push(log)
  })
  memory.nodes.forEach((node) => {
    const nodeEvidence = memory.evidence.filter((record) => record.evaluationNodeId === node.id)
    const evidenceRoots = [...new Set(nodeEvidence.flatMap((record) => record.sourceIds ?? (record.logRef ? [record.logRef] : [])).map((sourceId) => logById.get(sourceId)?.rootId).filter((value): value is string => Boolean(value)))]
    const groupId = node.evaluationScopeId ?? (evidenceRoots.length === 1 ? evidenceRoots[0] : nodeEvidence.some((record) => (record.sourceIds ?? []).some((sourceId) => logById.has(sourceId))) ? 'unscoped' : `legacy:${node.id}`)
    const group = ensure(groupId, logs.find((log) => log.rootId === groupId)?.folderName ?? node.name)
    group.nodes.push(node)
    group.evidence.push(...nodeEvidence)
  })
  return [...groups.values()].filter((group) => group.logs.length || group.nodes.length)
}

/** Orders folder-scoped evaluations while preserving explicit previous-evaluation links. */
export function evaluationFolderFlow(memory: EvaluationMemory, groups: readonly EvaluationFolderGroup[]): EvaluationFolderFlowItem[] {
  const projectNodeIds = new Set(memory.nodes.filter((node) => node.projectId === memory.project.id).map((node) => node.id))
  const groupByNodeId = new Map(groups.flatMap((group) => group.nodes.filter((node) => projectNodeIds.has(node.id)).map((node) => [node.id, group.id] as const)))
  const items = groups.map((group) => {
    const node = group.nodes.at(-1)
    const linkedParent = [...group.nodes].reverse().map((item) => {
      if (!item.parentId) return undefined
      const parent = memory.nodes.find((candidate) => candidate.id === item.parentId)
      // Old data sometimes linked unrelated issue tracks by time. Preserve a
      // cross-issue edge only when it was explicitly classified as side effect.
      if (parent?.hypothesisId && item.hypothesisId && parent.hypothesisId !== item.hypothesisId && item.relation !== 'side-effect') return undefined
      return groupByNodeId.get(item.parentId)
    }).find((parentId) => parentId && parentId !== group.id)
    const parentGroupId = linkedParent
    return { group, node, ...(parentGroupId ? { parentGroupId } : {}) }
  })
  const children = new Map<string, EvaluationFolderFlowItem[]>()
  items.forEach((item) => {
    if (!item.parentGroupId) return
    children.set(item.parentGroupId, [...(children.get(item.parentGroupId) ?? []), item])
  })
  const ordered: EvaluationFolderFlowItem[] = []
  const visited = new Set<string>()
  const visit = (item: EvaluationFolderFlowItem) => {
    if (visited.has(item.group.id)) return
    visited.add(item.group.id)
    ordered.push(item)
    ;(children.get(item.group.id) ?? []).forEach(visit)
  }
  items.filter((item) => !item.parentGroupId || !items.some((candidate) => candidate.group.id === item.parentGroupId)).forEach(visit)
  items.forEach(visit)
  return ordered
}

/** Groups folder-level evaluation nodes by failure issue. Purpose changes stay
 * in one issue lane; folders without a confirmed issue share one review queue. */
export function evaluationFolderBranches(memory: EvaluationMemory, flow: readonly EvaluationFolderFlowItem[]): EvaluationFolderBranch[] {
  const branches = new Map<string, EvaluationFolderBranch>()
  const hypothesisById = new Map(memory.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]))
  const branchByGroup = new Map(flow.map((item) => [item.group.id, item.node?.hypothesisId?.trim() || 'classification-queue']))
  flow.forEach((item) => {
    const branchId = branchByGroup.get(item.group.id)!
    const hypothesis = hypothesisById.get(branchId)
    const kind = hypothesis ? 'issue' as const : 'queue' as const
    const current = branches.get(branchId) ?? { id: branchId, label: hypothesis?.title ?? '분류 대기', items: [], kind }
    current.items.push(item)
    branches.set(branchId, current)
  })
  return [...branches.values()].map((branch) => {
    const parentGroupId = branch.items
      .map((item) => item.parentGroupId)
      .find((groupId) => groupId && branchByGroup.get(groupId) !== branch.id)
    return { ...branch, ...(parentGroupId ? { parentGroupId } : {}) }
  }).sort((left, right) => Number(left.kind === 'queue') - Number(right.kind === 'queue'))
}

export function evaluationBranchSummary(branch: EvaluationFolderBranch): string {
  if (branch.kind === 'queue') return `${branch.items.length}개 평가 · 확인 필요`
  const states = branch.items.map((item) => statusLabel[folderStatus(item.group)])
  const visible = states.length <= 4 ? states : [states[0], states[1], '…', states.at(-1)!]
  return `${branch.items.length}개 평가 · ${visible.join(' → ')}`
}

function csvCell(value: unknown) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
export function evaluationMemoryCsv(memory: EvaluationMemory): string {
  const evidenceById = new Map(memory.evidence.map((record) => [record.id, record]))
  const header = ['projectId', 'projectName', 'product', 'projectSkew', 'customer', 'targetDevice', 'densityGb', 'nominalVoltage', 'program', 'phase', 'hypothesisId', 'hypothesisTitle', 'hypothesisOrigin', 'nodeId', 'parentNodeId', 'branchId', 'evaluationScopeId', 'nodeName', 'nodePurpose', 'nodeStatus', 'interpretation', 'authorship', 'reviewState', 'sequenceSignature', 'attemptNo', 'retestOf', 'relation', 'relationConfidence', 'relationReason', 'evidenceId', 'occurredAt', 'status', 'result', 'logRef', 'sourceIds', 'note', 'evidenceOrigin', 'skew', 'lot', 'material', 'die', 'sample', 'socVendor', 'socModel', 'bootProfileId', 'gridId', 'bl', 'dq', 'channel', 'subChannel', 'chipSelect', 'rank', 'bankGroup', 'bank', 'row', 'column', 'writeData', 'readData', 'pattern', 'frequencyMHz', 'temperatureC', 'temperatureCorner', 'vdd', 'vddCorner', 'conditionCorner', 'timingSkewPs', 'testMode']
  const rows = flattenEvaluationMemory(memory).map((row) => header.map((key) => csvCell(key === 'sourceIds' ? evidenceById.get(row.evidenceId)?.sourceIds?.join('|') ?? '' : row[key as keyof typeof row])).join(','))
  return [header.join(','), ...rows].join('\n')
}

export function buildEvaluationContextMarkdown(memory: EvaluationMemory): string {
  const trends = inferEvaluationTrends(memory).slice(0, 5)
  const nodeById = new Map(memory.nodes.map((node) => [node.id, node]))
  const failureEvidence = memory.evidence.filter((record) => record.status === 'fail')
  const projectContext = [memory.project.product && `Product: ${memory.project.product}`, memory.project.skew && `SKEW: ${memory.project.skew}`, memory.project.customer && `Customer: ${memory.project.customer}`, memory.project.targetDevice && `Target device: ${memory.project.targetDevice}`, memory.project.densityGb !== undefined && `Density: ${memory.project.densityGb}Gb`, memory.project.nominalVoltage !== undefined && `Nominal voltage: ${memory.project.nominalVoltage}V`, memory.project.program && `Program: ${memory.project.program}`, memory.project.phase && `Phase: ${memory.project.phase}`].filter(Boolean)
  const lines = [`# ${memory.project.name} evaluation context`, `- ${projectContext.join(' · ') || 'Project context: —'}`, `- ${memory.nodes.length} evaluations · ${memory.evidence.length} evidence records · ${failureEvidence.length} failures`, '', '## Dominant failure signals']
  lines.push(...(trends.length ? trends.map((trend) => `- ${trend.dimension}=${trend.value}: ${trend.failureCount}/${trend.evidenceCount} fail (${Math.round(trend.failureRate * 100)}%), ${trend.origin}`) : ['- No repeatable failure signal yet.']))
  lines.push('', '## Failure issues')
  lines.push(...(memory.hypotheses.length ? memory.hypotheses.map((hypothesis) => `- ${hypothesis.id}: ${hypothesis.title} (${hypothesis.origin})`) : ['- No confirmed failure issue yet.']))
  lines.push('', '## Evaluation relations')
  lines.push(...memory.nodes.map((node) => `- ${node.id} ${node.name} [${node.relation ?? (node.parentId ? relationForEvaluationPurpose(node.purpose) : 'baseline')}] ${node.status ?? 'inconclusive'}${node.hypothesisId ? ` · issue=${node.hypothesisId}` : ' · classification=pending'}${node.parentId ? ` ← ${node.parentId}` : ''}${node.interpretation ? ` — ${node.interpretation}` : ''}`))
  lines.push('', '## Failure evidence')
  lines.push(...failureEvidence.slice(0, 12).map((record) => `- ${nodeById.get(record.evaluationNodeId)?.name ?? record.evaluationNodeId}: ${record.sourceIds?.join(', ') || record.logRef || record.id}${record.note ? ` — ${record.note}` : ''}`))
  return lines.join('\n')
}

function downloadCsv(contents: string) {
  const anchor = document.createElement('a'); const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' })); anchor.href = url; anchor.download = 'evaluation-memory.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}

function folderStatus(group: EvaluationFolderGroup): EvaluationStatus {
  const latest = group.nodes.at(-1)?.status
  if (latest) return latest
  const statuses = group.logs.map((log) => logStatus(log.result))
  if (statuses.some((status) => status === 'fail')) return 'fail'
  if (statuses.length && statuses.every((status) => status === 'pass')) return 'pass'
  return 'inconclusive'
}

function provenance(node: EvaluationNode | undefined): string {
  if (!node) return '정리 전'
  if (node.authorship === 'agent') return node.reviewState === 'confirmed' ? 'AI 작성 · 엔지니어 확인' : 'AI 제안'
  if (node.authorship === 'automatic') return node.reviewState === 'confirmed' ? '자동 추출 · 엔지니어 확인' : '자동 추출'
  if (node.authorship === 'engineer') return '엔지니어 작성'
  return node.reviewState === 'confirmed' ? '엔지니어 확인' : '기존 기록'
}

export function evaluationAnalysisRequest(group: EvaluationFolderGroup, node?: EvaluationNode): EvaluationAnalysisRequest {
  const intent = node?.reviewState === 'confirmed' ? node.interpretation?.trim() || node.name.trim() : ''
  return {
    evaluationScopeId: group.id, title: group.label, sourceIds: group.logs.map((log) => log.id),
    ...(group.logs[0]?.openId ? { openId: group.logs[0].openId } : {}),
    ...(intent ? { intent } : {}),
  }
}

/** Selecting an unreviewed evaluation is an explicit scope choice. Opening the
 * bounded intent question at that point is proactive without calling the LLM
 * or interrupting every ordinary log click. */
export function shouldProactivelyAnalyzeFolder(group: EvaluationFolderGroup): boolean {
  return group.logs.length > 0 && group.nodes.length === 0
}

function folderInterpretation(group: EvaluationFolderGroup, trends: ReturnType<typeof inferEvaluationTrends>): string {
  const saved = [...group.nodes].reverse().find((node) => node.interpretation?.trim())?.interpretation
  if (saved) return saved
  if (!group.evidence.length) return '저장된 분석이 없습니다. Agent로 로그를 분석하거나 직접 정리할 수 있습니다.'
  const failures = group.evidence.filter((record) => record.status === 'fail').length
  if (!failures) return `연결된 로그 ${group.evidence.length}개에서는 실패가 확인되지 않았습니다.`
  if (!trends.length) return `${group.evidence.length}개 로그 중 ${failures}개가 실패했지만 반복되는 조건은 아직 분명하지 않습니다.`
  return `${group.evidence.length}개 로그 중 ${failures}개가 실패했습니다. ${trends.slice(0, 2).map(trendInterpretation).join(', ')} 조건을 우선 확인해야 합니다.`
}

export function EvaluationMemoryView({ memory, availableLogs, onChange, onOpenLog, onSelectLog, onAnalyzeEvaluation, selectedEvaluationScopeId, onNotify }: EvaluationMemoryViewProps) {
  const groups = useMemo(() => groupEvaluationFolders(memory, availableLogs), [availableLogs, memory])
  const flow = useMemo(() => evaluationFolderFlow(memory, groups), [groups, memory])
  const branches = useMemo(() => evaluationFolderBranches(memory, flow), [flow, memory])
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(selectedEvaluationScopeId)
  const selectedGroup = groups.find((group) => group.id === selectedGroupId)
  const latestNode = selectedGroup?.nodes.at(-1)
  const selectedEvidenceIds = new Set(selectedGroup?.evidence.map((record) => record.id) ?? [])
  const selectedMemory = useMemo(() => ({ ...memory, evidence: memory.evidence.filter((record) => selectedEvidenceIds.has(record.id)) }), [memory, selectedEvidenceIds])
  const trends = useMemo(() => inferEvaluationTrends(selectedMemory), [selectedMemory])
  const previousEvaluationOptions = flow.filter((item) => item.group.id !== selectedGroup?.id && item.node)
  const [projectDraft, setProjectDraft] = useState<ProductProject>(memory.project)
  const [saving, setSaving] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const proactivelyOpened = useRef(new Set<string>())
  const lastExternalScope = useRef(selectedEvaluationScopeId)
  const [review, setReview] = useState({ purpose: 'characterization' as EvaluationPurpose, status: 'inconclusive' as EvaluationStatus, parentId: '', relation: 'condition-comparison' as EvaluationRelationKind, interpretation: '' })

  useEffect(() => { setProjectDraft(memory.project) }, [memory.project])
  useEffect(() => { proactivelyOpened.current.clear(); setSelectedGroupId(undefined); lastExternalScope.current = selectedEvaluationScopeId }, [memory.project.id])
  useEffect(() => {
    if (selectedEvaluationScopeId === lastExternalScope.current) return
    lastExternalScope.current = selectedEvaluationScopeId
    if (selectedEvaluationScopeId && groups.some((group) => group.id === selectedEvaluationScopeId)) setSelectedGroupId(selectedEvaluationScopeId)
  }, [groups, selectedEvaluationScopeId])
  useEffect(() => { if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) setSelectedGroupId(undefined) }, [groups, selectedGroupId])
  useEffect(() => {
    const externalParent = latestNode?.parentId && !selectedGroup?.nodes.some((node) => node.id === latestNode.parentId) ? latestNode.parentId : ''
    setReview({ purpose: latestNode?.purpose ?? 'characterization', status: latestNode?.status ?? 'inconclusive', parentId: externalParent, relation: latestNode?.relation ?? relationForEvaluationPurpose(latestNode?.purpose), interpretation: latestNode?.interpretation ?? '' })
    setManualOpen(false)
  }, [latestNode?.id, selectedGroup?.id])
  useEffect(() => {
    if (!selectedGroupId) return undefined
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedGroupId(undefined) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedGroupId])

  const save = async (next: EvaluationMemory) => { setSaving(true); try { await onChange(next); return true } catch { onNotify('저장하지 못했습니다. 내용을 확인한 뒤 다시 시도하세요.'); return false } finally { setSaving(false) } }
  const selectGroup = (group: EvaluationFolderGroup) => {
    if (selectedGroupId === group.id) { setSelectedGroupId(undefined); return }
    setSelectedGroupId(group.id)
    const first = group.logs[0]
    if (first) onSelectLog?.(first.openId ?? first.id)
    if (onAnalyzeEvaluation && shouldProactivelyAnalyzeFolder(group) && !proactivelyOpened.current.has(group.id)) {
      proactivelyOpened.current.add(group.id)
      onAnalyzeEvaluation(evaluationAnalysisRequest(group))
    }
  }
  const updateProjectDraft = (key: 'product' | 'skew' | 'customer' | 'targetDevice' | 'densityGb' | 'nominalVoltage', raw: string) => setProjectDraft((current) => ({ ...current, [key]: raw === '' ? undefined : key === 'densityGb' || key === 'nominalVoltage' ? Number(raw) : raw }))

  const saveReview = async () => {
    if (!selectedGroup) return
    if (!review.interpretation.trim()) return onNotify('평가 해설을 입력하세요.')
    const parent = review.parentId ? memory.nodes.find((node) => node.id === review.parentId) : undefined
    const targetHypothesisId = parent?.hypothesisId ?? latestNode?.hypothesisId ?? id('hyp')
    const targetHypothesis = memory.hypotheses.find((hypothesis) => hypothesis.id === targetHypothesisId)
    const relation = parent ? review.relation : 'baseline'
    const nodeId = latestNode?.id ?? id('eval')
    const branchId = relation === 'side-effect'
      ? `issue:${targetHypothesisId}:side:${nodeId}`
      : parent?.branchId ?? `issue:${targetHypothesisId}:main`
    const updateHypotheses = (nodeIds: readonly string[]) => {
      const cleaned = memory.hypotheses.map((hypothesis) => hypothesis.id === targetHypothesisId
        ? hypothesis
        : hypothesis.evaluationNodeIds?.includes(nodeId)
          ? { ...hypothesis, evaluationNodeIds: hypothesis.evaluationNodeIds.filter((value) => value !== nodeId) }
          : hypothesis)
      const nextTarget: FailureHypothesis = targetHypothesis
        ? { ...targetHypothesis, evaluationNodeIds: [...new Set([...(targetHypothesis.evaluationNodeIds ?? []), ...nodeIds])] }
        : { id: targetHypothesisId, projectId: memory.project.id, title: selectedGroup.label, description: review.interpretation.trim(), origin: 'engineer-confirmed', evaluationNodeIds: [...new Set(nodeIds)] }
      return [...cleaned.filter((hypothesis) => hypothesis.id !== targetHypothesisId), nextTarget]
    }
    let next: EvaluationMemory
    if (latestNode) {
      next = {
        ...memory,
        hypotheses: updateHypotheses([nodeId]),
        nodes: memory.nodes.map((node) => node.id === latestNode.id ? {
          ...node, hypothesisId: targetHypothesisId, evaluationScopeId: selectedGroup.id.startsWith('legacy:') ? node.evaluationScopeId : selectedGroup.id,
          purpose: review.purpose, status: review.status, parentId: parent?.id, branchId, relation,
          relationConfidence: 1, relationReason: parent ? '엔지니어가 이전 평가와의 관계를 직접 확인했습니다.' : '엔지니어가 새 불량 이슈의 시작으로 확인했습니다.',
          ...(relation === 'retest' && parent ? { retestOf: parent.id } : { retestOf: undefined }),
          interpretation: review.interpretation.trim(), authorship: node.authorship ?? 'engineer', reviewState: 'confirmed',
        } : node),
      }
    } else {
      const node: EvaluationNode = {
        id: nodeId, projectId: memory.project.id, hypothesisId: targetHypothesisId,
        evaluationScopeId: selectedGroup.id === 'unscoped' ? undefined : selectedGroup.id, name: selectedGroup.label,
        purpose: review.purpose, status: review.status, parentId: parent?.id, branchId, relation,
        relationConfidence: 1, relationReason: parent ? '엔지니어가 이전 평가와의 관계를 직접 확인했습니다.' : '엔지니어가 새 불량 이슈의 시작으로 확인했습니다.',
        ...(relation === 'retest' && parent ? { retestOf: parent.id } : {}),
        dimensions: {}, interpretation: review.interpretation.trim(), authorship: 'engineer', reviewState: 'confirmed',
      }
      const evidence: EvidenceRecord[] = selectedGroup.logs.map((log) => ({ id: id('evidence'), projectId: memory.project.id, evaluationNodeId: nodeId, status: logStatus(log.result), result: log.result, sourceIds: [log.id], origin: 'engineer-confirmed' }))
      next = { ...memory, hypotheses: updateHypotheses([...(parent && !parent.hypothesisId ? [parent.id] : []), nodeId]), nodes: [...memory.nodes.map((item) => parent && item.id === parent.id && !item.hypothesisId ? { ...item, hypothesisId: targetHypothesisId, branchId: item.branchId ?? `issue:${targetHypothesisId}:main`, relation: item.relation ?? 'baseline' as const } : item), node], evidence: [...memory.evidence, ...evidence] }
    }
    if (await save(next)) onNotify('평가 해설을 저장했습니다.')
  }
  return <div className={`data-view evaluation-memory-view ${selectedGroup ? 'is-detail-open' : 'is-overview'}`}>
    <header className="data-view-header evaluation-memory-view__header"><div><h1>평가 이력</h1></div><div className="data-actions evaluation-memory-view__actions"><button onClick={() => downloadCsv(evaluationMemoryCsv(memory))}><Download size={16} />CSV</button></div></header>
    <details className="evaluation-memory-view__project-context"><summary>프로젝트 조건</summary><div><label>제품<input value={projectDraft.product ?? ''} onChange={(event) => updateProjectDraft('product', event.target.value)} /></label><label>SKEW<input value={projectDraft.skew ?? ''} onChange={(event) => updateProjectDraft('skew', event.target.value)} /></label><label>고객<input value={projectDraft.customer ?? ''} onChange={(event) => updateProjectDraft('customer', event.target.value)} /></label><label>대상 장치<input value={projectDraft.targetDevice ?? ''} onChange={(event) => updateProjectDraft('targetDevice', event.target.value)} /></label><label>밀도 (Gb)<input type="number" value={projectDraft.densityGb ?? ''} onChange={(event) => updateProjectDraft('densityGb', event.target.value)} /></label><label>정격 전압 (V)<input type="number" value={projectDraft.nominalVoltage ?? ''} onChange={(event) => updateProjectDraft('nominalVoltage', event.target.value)} /></label><button type="button" disabled={saving} onClick={() => void save(withProjectConditions(memory, projectDraft))}>저장</button></div></details>
    <section className="evaluation-memory-view__flow" aria-label="불량 이슈별 평가 이력">
      <header><strong>불량 이슈별 평가 이력</strong><span>{branches.filter((branch) => branch.kind === 'issue').length}개 이슈{branches.some((branch) => branch.kind === 'queue') ? ' · 분류 대기 있음' : ''}</span></header>
      <div className="evaluation-memory-view__flow-branches">{branches.length ? branches.map((branch) => {
        const parent = flow.find((item) => item.group.id === branch.parentGroupId)
        return <div className={`evaluation-memory-view__flow-branch ${branch.kind === 'queue' ? 'is-unclassified' : ''}`} key={branch.id}>
          <div className="evaluation-memory-view__flow-label"><strong>{branch.label}</strong><small>{parent ? `${parent.group.label}에서 분리 · ${evaluationBranchSummary(branch)}` : evaluationBranchSummary(branch)}</small></div>
          <div className="evaluation-memory-view__flow-line">{branch.items.map((item) => {
            const state = folderStatus(item.group)
            const itemParent = flow.find((candidate) => candidate.group.id === item.parentGroupId)
            const relation = item.node?.relation ?? (item.parentGroupId ? relationForEvaluationPurpose(item.node?.purpose) : 'baseline')
            const entryLabel = branch.kind === 'queue' ? '분류 필요' : evaluationEntryLabel(item.node)
            const title = itemParent
              ? `${itemParent.group.label} 이후 ${evaluationRelationLabel(relation)}`
              : branch.kind === 'queue' ? '연결할 불량 이슈를 확인해야 합니다.'
                : item.node?.purpose === 'reproduction' ? '선행 평가가 아직 연결되지 않은 재현 평가입니다.'
                  : `${entryLabel} · 평가 상세 보기`
            return <div className={`evaluation-memory-view__flow-step ${item.parentGroupId ? 'is-linked' : ''}`} key={item.group.id}><button type="button" className={item.group.id === selectedGroup?.id ? 'is-selected' : ''} onClick={() => selectGroup(item.group)} title={title}><small>{entryLabel}</small><span className="evaluation-memory-view__flow-node"><i className={`is-${state}`} /></span><b>{item.group.label}</b><em>{statusLabel[state]}</em></button></div>
          })}</div>
        </div>
      }) : <p>평가 폴더를 연결하세요.</p>}</div>
    </section>
    {selectedGroup ? <div className="evaluation-memory-view__workspace" aria-label={`${selectedGroup.label} 상세`}>
      <main className="evaluation-memory-view__detail">
        <>
          <header><div><Folder size={17} /><h2>{selectedGroup.label}</h2></div><div className="evaluation-memory-view__detail-meta"><span>{evaluationEntryLabel(latestNode)}</span><button type="button" onClick={() => setSelectedGroupId(undefined)} aria-label="평가 상세 닫기" title="평가 상세 닫기"><X size={16} /></button></div></header>
          <section className="evaluation-memory-view__interpretation">
            <div className="evaluation-memory-view__section-head"><strong>평가 해석</strong><span>{provenance(latestNode)}</span></div>
            <p>{folderInterpretation(selectedGroup, trends)}</p>
            {latestNode?.purpose ? <small>{purposeLabel[latestNode.purpose]}</small> : null}
          </section>
          <section className="evaluation-memory-view__trends">
            <div className="evaluation-memory-view__section-head"><strong>조건별 FAIL 경향</strong></div>
            {trends.length ? trends.slice(0, 6).map((trend) => <div key={`${trend.dimension}-${trend.value}`}><span>{trendDimensionLabel(trend.dimension)}</span><b>{trend.value}</b><em>{trend.failureCount}/{trend.evidenceCount} 실패</em></div>) : <p>비교할 PASS/FAIL 조건이 아직 없습니다.</p>}
            {trends.length > 6 ? <details><summary>나머지 {trends.length - 6}개</summary>{trends.slice(6).map((trend) => <div key={`${trend.dimension}-${trend.value}`}><span>{trendDimensionLabel(trend.dimension)}</span><b>{trend.value}</b><em>{trend.failureCount}/{trend.evidenceCount} 실패</em></div>)}</details> : null}
          </section>
          <section className="evaluation-memory-view__logs">
            <div className="evaluation-memory-view__section-head"><strong>이 평가의 로그</strong><span>{selectedGroup.logs.length}개 파일</span></div>
            <div>{selectedGroup.logs.map((log) => <button type="button" onClick={() => onOpenLog(log.openId ?? log.id)} key={log.id}><FileText size={13} /><span>{log.name}</span><em>{evaluationLogResultLabel(log.result)}</em></button>)}</div>
          </section>
        </>
      </main>

      <aside className="evaluation-memory-view__review">
        <header><div><strong>평가 정리</strong><span>{selectedGroup?.label ?? '평가를 선택하세요'}</span></div></header>
        <>
          <div className="evaluation-memory-view__review-actions">
            <button className="evaluation-memory-view__agent" disabled={!onAnalyzeEvaluation || !selectedGroup.logs.length} onClick={() => onAnalyzeEvaluation?.(evaluationAnalysisRequest(selectedGroup, latestNode))}><Sparkles size={14} />{latestNode ? 'Agent로 다시 분석' : 'Agent로 분석'}</button>
            <button className="evaluation-memory-view__edit" type="button" aria-expanded={manualOpen} onClick={() => setManualOpen((value) => !value)}><Pencil size={14} />직접 수정</button>
          </div>
          {manualOpen ? <div className="evaluation-memory-view__manual">
            <label><span>평가 목적</span><select value={review.purpose} onChange={(event) => setReview({ ...review, purpose: event.target.value as EvaluationPurpose })}>{Object.entries(purposeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label><span>최종 결과</span><select value={review.status} onChange={(event) => setReview({ ...review, status: event.target.value as EvaluationStatus })}><option value="inconclusive">미정</option><option value="pass">PASS</option><option value="fail">FAIL</option><option value="running">진행 중</option></select></label>
            <label><span>연결할 이전 평가</span><select value={review.parentId} onChange={(event) => setReview({ ...review, parentId: event.target.value })}><option value="">연결하지 않음</option>{previousEvaluationOptions.map((item) => <option key={item.group.id} value={item.node!.id}>{item.group.label}</option>)}</select></label>
            {review.parentId ? <label><span>이전 평가와 관계</span><select value={review.relation} onChange={(event) => setReview({ ...review, relation: event.target.value as EvaluationRelationKind })}><option value="retest">동일 조건 RT</option><option value="condition-comparison">가속·조건 비교</option><option value="improvement">개선 조건</option><option value="verification">안정성 검증</option><option value="side-effect">Side effect 확인</option></select></label> : null}
            <label className="evaluation-memory-view__narrative"><span>평가 해석</span><textarea value={review.interpretation} onChange={(event) => setReview({ ...review, interpretation: event.target.value })} placeholder="실패가 집중된 조건, 비교 결과, 다음 확인 항목" /></label>
            <button className="evaluation-memory-view__save is-primary" disabled={saving} onClick={() => void saveReview()}><Check size={14} />{saving ? '저장 중…' : '평가 저장'}</button>
          </div> : null}
        </>
      </aside>
    </div> : null}
  </div>
}
