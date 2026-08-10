import { useEffect, useMemo, useState } from 'react'
import { Check, FileText, Folder } from 'lucide-react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationPurpose, EvaluationStatus, EvidenceRecord, FailureHypothesis, ProductProject } from '../domain/evaluation-memory'
import { flattenEvaluationMemory, inferEvaluationTrends } from '../domain/evaluation-memory'
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
  onNotify: (message: string) => void
}

export interface EvaluationFolderGroup {
  id: string
  label: string
  logs: AvailableEvaluationLog[]
  nodes: EvaluationNode[]
  evidence: EvidenceRecord[]
}

const purposeLabel: Record<EvaluationPurpose, string> = {
  screening: '불량 검출 강화', improvement: '개선 조건 확인', reproduction: '동일 불량 재현', characterization: '불량 경향 파악', verification: '개선 효과 검증',
}
const statusLabel: Record<EvaluationStatus, string> = { pass: 'PASS', fail: 'FAIL', inconclusive: '미정', running: '진행 중' }
const dimensionFields: Array<[keyof EvaluationDimensions, string, 'text' | 'number']> = [
  ['skew', 'SKEW', 'text'], ['lot', 'Lot', 'text'], ['material', '자재', 'text'], ['die', 'Die', 'text'], ['sample', 'Sample', 'text'], ['socModel', 'SoC', 'text'], ['bootProfileId', 'Boot profile', 'text'], ['bl', 'BL', 'text'], ['dq', 'DQ', 'text'], ['channel', 'Channel', 'text'], ['subChannel', 'Sub Channel', 'text'], ['rank', 'Rank', 'text'], ['bankGroup', 'Bank Group', 'text'], ['bank', 'Bank', 'text'], ['row', 'Row', 'text'], ['column', 'Column', 'text'], ['pattern', 'Pattern', 'text'], ['frequencyMHz', '주파수 (MHz)', 'number'], ['temperatureC', '°C', 'number'], ['vdd', 'VDD (V)', 'number'], ['timingSkewPs', 'Timing SKEW (ps)', 'number'], ['testMode', 'Mode', 'text'],
]

const emptyDimensions = (): EvaluationDimensions => ({})
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`
const trendDimensionLabel = (dimension: string) => ({ skew: 'SKEW', timingSkewPs: 'Timing SKEW', vdd: 'VDD', bl: 'BL', dq: 'DQ', frequencyMHz: '주파수', socModel: 'SoC', channel: 'Channel', subChannel: 'Sub Channel', rank: 'Rank', bank: 'Bank', bankGroup: 'Bank Group', row: 'Row', column: 'Column', pattern: 'Pattern', temperatureC: '온도' }[dimension] ?? dimension)

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

export function addEvaluationWithEvidence(memory: EvaluationMemory, input: { name: string; purpose?: EvaluationPurpose; hypothesisId?: string; parentId?: string; branchId?: string; evaluationScopeId?: string; interpretation?: string; status: EvaluationStatus; dimensions: EvaluationDimensions; logIds: readonly string[]; origin: AssessmentOrigin }): EvaluationMemory {
  const node: EvaluationNode = {
    id: id('eval'), projectId: memory.project.id, name: input.name, purpose: input.purpose,
    hypothesisId: input.hypothesisId || undefined, parentId: input.parentId || undefined, branchId: input.branchId || undefined,
    evaluationScopeId: input.evaluationScopeId || undefined, interpretation: input.interpretation?.trim() || undefined,
    authorship: input.origin === 'engineer-confirmed' ? 'engineer' : 'agent', reviewState: input.origin === 'engineer-confirmed' ? 'confirmed' : 'proposed',
    status: input.status, dimensions: input.dimensions,
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

function csvCell(value: unknown) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
export function evaluationMemoryCsv(memory: EvaluationMemory): string {
  const evidenceById = new Map(memory.evidence.map((record) => [record.id, record]))
  const header = ['projectId', 'projectName', 'product', 'projectSkew', 'customer', 'targetDevice', 'densityGb', 'nominalVoltage', 'program', 'phase', 'hypothesisId', 'hypothesisTitle', 'hypothesisOrigin', 'nodeId', 'parentNodeId', 'branchId', 'evaluationScopeId', 'nodeName', 'nodePurpose', 'nodeStatus', 'interpretation', 'authorship', 'reviewState', 'sequenceSignature', 'attemptNo', 'retestOf', 'evidenceId', 'occurredAt', 'status', 'result', 'logRef', 'sourceIds', 'note', 'evidenceOrigin', 'skew', 'lot', 'material', 'die', 'sample', 'socVendor', 'socModel', 'bootProfileId', 'bl', 'dq', 'channel', 'subChannel', 'rank', 'bankGroup', 'bank', 'row', 'column', 'pattern', 'frequencyMHz', 'temperatureC', 'vdd', 'timingSkewPs', 'testMode']
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
  lines.push('', '## Evaluation lineage')
  lines.push(...memory.nodes.map((node) => `- ${node.id} ${node.name} [${node.purpose ?? 'unclassified'}] ${node.status ?? 'inconclusive'}${node.parentId ? ` ← ${node.parentId}` : ''}${node.interpretation ? ` — ${node.interpretation}` : ''}`))
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

function folderInterpretation(group: EvaluationFolderGroup, trends: ReturnType<typeof inferEvaluationTrends>): string {
  const saved = [...group.nodes].reverse().find((node) => node.interpretation?.trim())?.interpretation
  if (saved) return saved
  if (!group.evidence.length) return '저장된 분석이 없습니다. Agent로 로그를 분석하거나 직접 정리할 수 있습니다.'
  const failures = group.evidence.filter((record) => record.status === 'fail').length
  if (!failures) return `연결된 로그 ${group.evidence.length}개에서는 실패가 확인되지 않았습니다.`
  if (!trends.length) return `${group.evidence.length}개 로그 중 ${failures}개가 실패했지만 반복되는 조건은 아직 분명하지 않습니다.`
  return `${group.evidence.length}개 로그 중 ${failures}개가 실패했습니다. ${trends.slice(0, 2).map(trendInterpretation).join(', ')} 조건을 우선 확인해야 합니다.`
}

export function EvaluationMemoryView({ memory, availableLogs, onChange, onOpenLog, onSelectLog, onNotify }: EvaluationMemoryViewProps) {
  const groups = useMemo(() => groupEvaluationFolders(memory, availableLogs), [availableLogs, memory])
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(groups[0]?.id)
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0]
  const latestNode = selectedGroup?.nodes.at(-1)
  const selectedEvidenceIds = new Set(selectedGroup?.evidence.map((record) => record.id) ?? [])
  const selectedMemory = useMemo(() => ({ ...memory, evidence: memory.evidence.filter((record) => selectedEvidenceIds.has(record.id)) }), [memory, selectedEvidenceIds])
  const trends = useMemo(() => inferEvaluationTrends(selectedMemory), [selectedMemory])
  const [projectDraft, setProjectDraft] = useState<ProductProject>(memory.project)
  const [saving, setSaving] = useState(false)
  const [review, setReview] = useState({ purpose: 'characterization' as EvaluationPurpose, status: 'inconclusive' as EvaluationStatus, parentId: '', interpretation: '' })

  useEffect(() => { setProjectDraft(memory.project) }, [memory.project])
  useEffect(() => { if (!groups.some((group) => group.id === selectedGroupId)) setSelectedGroupId(groups[0]?.id) }, [groups, selectedGroupId])
  useEffect(() => {
    const externalParent = latestNode?.parentId && !selectedGroup?.nodes.some((node) => node.id === latestNode.parentId) ? latestNode.parentId : ''
    setReview({ purpose: latestNode?.purpose ?? 'characterization', status: latestNode?.status ?? 'inconclusive', parentId: externalParent, interpretation: latestNode?.interpretation ?? '' })
  }, [latestNode?.id, selectedGroup?.id])

  const save = async (next: EvaluationMemory) => { setSaving(true); try { await onChange(next); return true } catch { onNotify('저장하지 못했습니다. 내용을 확인한 뒤 다시 시도하세요.'); return false } finally { setSaving(false) } }
  const selectGroup = (group: EvaluationFolderGroup) => {
    setSelectedGroupId(group.id)
    const first = group.logs[0]
    if (first) onSelectLog?.(first.openId ?? first.id)
  }
  const updateProjectDraft = (key: 'product' | 'skew' | 'customer' | 'targetDevice' | 'densityGb' | 'nominalVoltage', raw: string) => setProjectDraft((current) => ({ ...current, [key]: raw === '' ? undefined : key === 'densityGb' || key === 'nominalVoltage' ? Number(raw) : raw }))

  const saveReview = async () => {
    if (!selectedGroup) return
    if (!review.interpretation.trim()) return onNotify('평가 해설을 입력하세요.')
    let next: EvaluationMemory
    if (latestNode) {
      next = { ...memory, nodes: memory.nodes.map((node) => node.id === latestNode.id ? { ...node, evaluationScopeId: selectedGroup.id.startsWith('legacy:') ? node.evaluationScopeId : selectedGroup.id, purpose: review.purpose, status: review.status, parentId: review.parentId || node.parentId, interpretation: review.interpretation.trim(), authorship: node.authorship ?? 'engineer', reviewState: 'confirmed' } : node) }
    } else {
      const nodeId = id('eval')
      const node: EvaluationNode = { id: nodeId, projectId: memory.project.id, evaluationScopeId: selectedGroup.id === 'unscoped' ? undefined : selectedGroup.id, name: selectedGroup.label, purpose: review.purpose, status: review.status, parentId: review.parentId || undefined, dimensions: {}, interpretation: review.interpretation.trim(), authorship: 'engineer', reviewState: 'confirmed' }
      const evidence: EvidenceRecord[] = selectedGroup.logs.map((log) => ({ id: id('evidence'), projectId: memory.project.id, evaluationNodeId: nodeId, status: logStatus(log.result), result: log.result, sourceIds: [log.id], origin: 'engineer-confirmed' }))
      next = { ...memory, nodes: [...memory.nodes, node], evidence: [...memory.evidence, ...evidence] }
    }
    if (await save(next)) onNotify('평가 해설을 저장했습니다.')
  }
  const copyContext = async () => { try { await navigator.clipboard.writeText(buildEvaluationContextMarkdown(memory)); onNotify('AI 맥락을 클립보드에 복사했습니다.') } catch { onNotify('클립보드를 사용할 수 없습니다.') } }
  return <div className="data-view evaluation-memory-view">
    <header className="data-view-header evaluation-memory-view__header"><div><h1>평가 이력</h1></div><div className="data-actions evaluation-memory-view__actions"><button onClick={() => downloadCsv(evaluationMemoryCsv(memory))}>CSV</button><button onClick={() => void copyContext()}>AI 맥락</button></div></header>
    <details className="evaluation-memory-view__project-context"><summary>제품 조건</summary><div><label>제품<input value={projectDraft.product ?? ''} onChange={(event) => updateProjectDraft('product', event.target.value)} /></label><label>SKEW<input value={projectDraft.skew ?? ''} onChange={(event) => updateProjectDraft('skew', event.target.value)} /></label><label>고객<input value={projectDraft.customer ?? ''} onChange={(event) => updateProjectDraft('customer', event.target.value)} /></label><label>대상 장치<input value={projectDraft.targetDevice ?? ''} onChange={(event) => updateProjectDraft('targetDevice', event.target.value)} /></label><label>밀도 (Gb)<input type="number" value={projectDraft.densityGb ?? ''} onChange={(event) => updateProjectDraft('densityGb', event.target.value)} /></label><label>정격 전압 (V)<input type="number" value={projectDraft.nominalVoltage ?? ''} onChange={(event) => updateProjectDraft('nominalVoltage', event.target.value)} /></label><button type="button" disabled={saving} onClick={() => void save(withProjectConditions(memory, projectDraft))}>저장</button></div></details>
    <div className="evaluation-memory-view__workspace">
      <aside className="evaluation-memory-view__folders">
        <header><strong>평가 폴더</strong><span>{groups.length}</span></header>
        <div>{groups.length ? groups.map((group) => { const state = folderStatus(group); return <button type="button" className={group.id === selectedGroup?.id ? 'is-selected' : ''} onClick={() => selectGroup(group)} key={group.id}><i className={`is-${state}`} /><span><b>{group.label}</b><small>{group.logs.length}개 로그</small></span><em>{statusLabel[state]}</em></button> }) : <p>연결된 평가 폴더가 없습니다.</p>}</div>
      </aside>

      <main className="evaluation-memory-view__detail">
        {selectedGroup ? <>
          <header><div><Folder size={17} /><h2>{selectedGroup.label}</h2></div><span>{selectedGroup.logs.length}개 로그</span></header>
          <section className="evaluation-memory-view__interpretation">
            <div className="evaluation-memory-view__section-head"><strong>평가 해석</strong><span>{provenance(latestNode)}</span></div>
            <p>{folderInterpretation(selectedGroup, trends)}</p>
            {latestNode?.purpose ? <small>{purposeLabel[latestNode.purpose]}</small> : null}
          </section>
          <section className="evaluation-memory-view__trends">
            <div className="evaluation-memory-view__section-head"><strong>조건별 경향</strong><span>{trends.length}</span></div>
            {trends.length ? trends.slice(0, 6).map((trend) => <div key={`${trend.dimension}-${trend.value}`}><span>{trendDimensionLabel(trend.dimension)}</span><b>{trend.value}</b><em>{trend.failureCount}/{trend.evidenceCount} 실패</em></div>) : <p>비교할 PASS/FAIL 조건이 아직 없습니다.</p>}
            {trends.length > 6 ? <details><summary>나머지 {trends.length - 6}개</summary>{trends.slice(6).map((trend) => <div key={`${trend.dimension}-${trend.value}`}><span>{trendDimensionLabel(trend.dimension)}</span><b>{trend.value}</b><em>{trend.failureCount}/{trend.evidenceCount} 실패</em></div>)}</details> : null}
          </section>
          <section className="evaluation-memory-view__runs">
            <div className="evaluation-memory-view__section-head"><strong>이 평가의 기록</strong><span>{selectedGroup.nodes.length}</span></div>
            {selectedGroup.nodes.length ? selectedGroup.nodes.map((node) => { const parent = memory.nodes.find((item) => item.id === node.parentId); return <div className="evaluation-memory-view__run" key={node.id}><i className={`is-${node.status ?? 'inconclusive'}`} /><div><b>{node.name}</b><span>{node.purpose ? purposeLabel[node.purpose] : '목적 미정'}{parent ? ` · ${parent.name} 이후` : ''}</span></div><em>{statusLabel[node.status ?? 'inconclusive']}</em></div> }) : <p>저장된 분석 기록이 없습니다.</p>}
          </section>
          <section className="evaluation-memory-view__logs">
            <div className="evaluation-memory-view__section-head"><strong>이 평가의 로그</strong><span>{selectedGroup.logs.length}</span></div>
            <div>{selectedGroup.logs.map((log) => <button type="button" onClick={() => onOpenLog(log.openId ?? log.id)} key={log.id}><FileText size={13} /><span>{log.name}</span><em>{log.result ?? '미정'}</em></button>)}</div>
          </section>
        </> : <div className="evaluation-memory-view__empty"><Folder size={20} /><p>평가 폴더를 연결하세요.</p></div>}
      </main>

      <aside className="evaluation-memory-view__review">
        <header><div><strong>선택 평가 수정</strong><span>{selectedGroup?.label ?? '평가를 선택하세요'}</span></div></header>
        {selectedGroup ? <>
          <label><span>평가 목적</span><select value={review.purpose} onChange={(event) => setReview({ ...review, purpose: event.target.value as EvaluationPurpose })}>{Object.entries(purposeLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span>최종 결과</span><select value={review.status} onChange={(event) => setReview({ ...review, status: event.target.value as EvaluationStatus })}><option value="inconclusive">미정</option><option value="pass">PASS</option><option value="fail">FAIL</option><option value="running">진행 중</option></select></label>
          <label><span>연결할 이전 평가</span><select value={review.parentId} onChange={(event) => setReview({ ...review, parentId: event.target.value })}><option value="">연결하지 않음</option>{memory.nodes.filter((node) => !selectedGroup.nodes.some((current) => current.id === node.id)).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>
          <label className="evaluation-memory-view__narrative"><span>평가 해석</span><textarea value={review.interpretation} onChange={(event) => setReview({ ...review, interpretation: event.target.value })} placeholder="실패가 집중된 조건, 비교 결과, 다음 확인 항목" /></label>
          <button className="evaluation-memory-view__save is-primary" disabled={saving} onClick={() => void saveReview()}><Check size={14} />{saving ? '저장 중…' : '평가 저장'}</button>
        </> : <p>평가를 선택하세요.</p>}
      </aside>
    </div>
  </div>
}
