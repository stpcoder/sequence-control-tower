import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationPurpose, EvaluationStatus, EvidenceRecord, FailureHypothesis, ProductProject } from '../domain/evaluation-memory'
import { flattenEvaluationMemory, inferEvaluationTrends } from '../domain/evaluation-memory'
import { EvaluationLineage } from '../components/EvaluationLineage'
import './evaluation-memory-view.css'

export interface AvailableEvaluationLog {
  /** Durable project source identity persisted in evidence records. */
  id: string
  /** Renderer file identity used only to navigate to the open log. */
  openId?: string
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
  onNotify: (message: string) => void
}

const dimensionFields: Array<[keyof EvaluationDimensions, string, 'text' | 'number']> = [
  ['skew', 'SKEW', 'text'], ['lot', 'Lot', 'text'], ['material', '자재', 'text'], ['die', 'Die', 'text'], ['sample', 'Sample', 'text'], ['socModel', 'SoC', 'text'], ['bootProfileId', 'Boot profile', 'text'], ['bl', 'BL', 'text'], ['dq', 'DQ', 'text'], ['channel', 'Channel', 'text'], ['subChannel', 'Sub Channel', 'text'], ['rank', 'Rank', 'text'], ['bankGroup', 'Bank Group', 'text'], ['bank', 'Bank', 'text'], ['row', 'Row', 'text'], ['column', 'Column', 'text'], ['pattern', 'Pattern', 'text'], ['frequencyMHz', '주파수 (MHz)', 'number'], ['temperatureC', '°C', 'number'], ['vdd', 'VDD (V)', 'number'], ['timingSkewPs', 'Timing SKEW (ps)', 'number'], ['testMode', 'Mode', 'text'],
]

const emptyDimensions = (): EvaluationDimensions => ({})
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`
const trendDimensionLabel = (dimension: string) => ({ skew: 'SKEW', timingSkewPs: 'Timing skew', vdd: 'VDD', bl: 'BL', dq: 'DQ', frequencyMHz: '주파수', socModel: 'SoC', channel: 'Channel', subChannel: 'Sub Channel', rank: 'Rank', bank: 'Bank', bankGroup: 'Bank Group', row: 'Row', column: 'Column', pattern: 'Pattern', temperatureC: '온도' }[dimension] ?? dimension)

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

export function addEvaluationWithEvidence(memory: EvaluationMemory, input: { name: string; purpose?: EvaluationPurpose; hypothesisId?: string; parentId?: string; branchId?: string; status: EvaluationStatus; dimensions: EvaluationDimensions; logIds: readonly string[]; origin: AssessmentOrigin }): EvaluationMemory {
  const node: EvaluationNode = { id: id('eval'), projectId: memory.project.id, name: input.name, purpose: input.purpose, hypothesisId: input.hypothesisId || undefined, parentId: input.parentId || undefined, branchId: input.branchId || undefined, status: input.status, dimensions: input.dimensions }
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

function csvCell(value: unknown) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
export function evaluationMemoryCsv(memory: EvaluationMemory): string {
  const evidenceById = new Map(memory.evidence.map((record) => [record.id, record]))
  const header = ['projectId', 'projectName', 'product', 'projectSkew', 'customer', 'targetDevice', 'densityGb', 'nominalVoltage', 'program', 'phase', 'hypothesisId', 'hypothesisTitle', 'hypothesisOrigin', 'nodeId', 'parentNodeId', 'branchId', 'nodeName', 'nodePurpose', 'nodeStatus', 'sequenceSignature', 'attemptNo', 'retestOf', 'evidenceId', 'occurredAt', 'status', 'result', 'logRef', 'sourceIds', 'note', 'evidenceOrigin', 'skew', 'lot', 'material', 'die', 'sample', 'socVendor', 'socModel', 'bootProfileId', 'bl', 'dq', 'channel', 'subChannel', 'rank', 'bankGroup', 'bank', 'row', 'column', 'pattern', 'frequencyMHz', 'temperatureC', 'vdd', 'timingSkewPs', 'testMode']
  const rows = flattenEvaluationMemory(memory).map((row) => {
    const sourceIds = evidenceById.get(row.evidenceId)?.sourceIds?.join('|') ?? ''
    return [...header].map((key) => csvCell(key === 'sourceIds' ? sourceIds : row[key as keyof typeof row])).join(',')
  })
  return [header.join(','), ...rows].join('\n')
}

export function buildEvaluationContextMarkdown(memory: EvaluationMemory): string {
  const trends = inferEvaluationTrends(memory).slice(0, 5)
  const nodeById = new Map(memory.nodes.map((node) => [node.id, node]))
  const failureEvidence = memory.evidence.filter((record) => record.status === 'fail')
  const projectContext = [
    memory.project.product && `Product: ${memory.project.product}`,
    memory.project.skew && `SKEW: ${memory.project.skew}`,
    memory.project.customer && `Customer: ${memory.project.customer}`,
    memory.project.targetDevice && `Target device: ${memory.project.targetDevice}`,
    memory.project.densityGb !== undefined && `Density: ${memory.project.densityGb}Gb`,
    memory.project.nominalVoltage !== undefined && `Nominal voltage: ${memory.project.nominalVoltage}V`,
    memory.project.program && `Program: ${memory.project.program}`,
    memory.project.phase && `Phase: ${memory.project.phase}`,
  ].filter(Boolean)
  const lines = [`# ${memory.project.name} evaluation context`, `- ${projectContext.join(' · ') || 'Project context: —'}`, `- ${memory.nodes.length} evaluations · ${memory.evidence.length} evidence records · ${failureEvidence.length} failures`, '', '## Dominant failure signals']
  lines.push(...(trends.length ? trends.map((trend) => `- ${trend.dimension}=${trend.value}: ${trend.failureCount}/${trend.evidenceCount} fail (${Math.round(trend.failureRate * 100)}%), ${trend.origin}`) : ['- No repeatable failure signal yet.']))
  lines.push('', '## Evaluation lineage')
  lines.push(...memory.nodes.map((node) => `- ${node.id} ${node.name} [${node.purpose ?? 'unclassified'}] ${node.status ?? 'inconclusive'}${node.parentId ? ` ← ${node.parentId}` : ''}${node.hypothesisId ? ` · hypothesis ${node.hypothesisId}` : ''}`))
  lines.push('', '## Failure evidence')
  lines.push(...failureEvidence.slice(0, 12).map((record) => `- ${nodeById.get(record.evaluationNodeId)?.name ?? record.evaluationNodeId}: ${record.sourceIds?.join(', ') || record.logRef || record.id}${record.note ? ` — ${record.note}` : ''}`))
  return lines.join('\n')
}

function downloadCsv(contents: string) {
  const anchor = document.createElement('a'); const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' })); anchor.href = url; anchor.download = 'evaluation-memory.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function EvaluationMemoryView({ memory, availableLogs, onChange, onOpenLog, onNotify }: EvaluationMemoryViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(memory.nodes[0]?.id)
  const [hypothesis, setHypothesis] = useState({ title: '', description: '', origin: 'ai-proposed' as AssessmentOrigin })
  const [evaluation, setEvaluation] = useState({ name: '', purpose: 'characterization' as EvaluationPurpose, hypothesisId: '', parentId: '', branchId: '', status: 'inconclusive' as EvaluationStatus, origin: 'ai-proposed' as AssessmentOrigin, dimensions: emptyDimensions(), logIds: [] as string[] })
  const [projectDraft, setProjectDraft] = useState<ProductProject>(memory.project)
  const [saving, setSaving] = useState(false)
  const [editorWidth, setEditorWidth] = useState(380)
  const layoutRef = useRef<HTMLDivElement>(null)
  const trends = useMemo(() => inferEvaluationTrends(memory), [memory])
  const primaryTrends = trends.slice(0, 6)
  const remainingTrends = trends.slice(6)
  const selectedNode = memory.nodes.find((node) => node.id === selectedNodeId)
  const selectedLogIds = selectedNode ? linkedEvidenceLogIds(memory, selectedNode.id) : []
  useEffect(() => { setProjectDraft(memory.project); setSelectedNodeId((current) => memory.nodes.some((node) => node.id === current) ? current : memory.nodes[0]?.id) }, [memory.project, memory.nodes])
  const updateDimension = (key: keyof EvaluationDimensions, raw: string, kind: 'text' | 'number') => setEvaluation((current) => ({ ...current, dimensions: { ...current.dimensions, [key]: raw === '' ? undefined : kind === 'number' ? Number(raw) : raw } }))
  const save = async (next: EvaluationMemory) => { setSaving(true); try { await onChange(next); return true } catch { onNotify('저장하지 못했습니다. 내용을 확인한 뒤 다시 시도하세요.'); return false } finally { setSaving(false) } }
  const addHypothesis = async () => { if (!hypothesis.title.trim()) return onNotify('불량 가설 이름을 입력하세요.'); if (await save(addFailureHypothesis(memory, { ...hypothesis, title: hypothesis.title.trim(), description: hypothesis.description.trim() || undefined }))) setHypothesis({ title: '', description: '', origin: 'ai-proposed' }) }
  const addEvaluation = async () => {
    if (!evaluation.name.trim()) return onNotify('평가 이름을 입력하세요.')
    const next = addEvaluationWithEvidence(memory, { ...evaluation, name: evaluation.name.trim() }); const added = next.nodes.at(-1)
    if (await save(next)) { setSelectedNodeId(added?.id); setEvaluation({ name: '', purpose: 'characterization', hypothesisId: '', parentId: '', branchId: '', status: 'inconclusive', origin: 'ai-proposed', dimensions: emptyDimensions(), logIds: [] }) }
  }
  const copyContext = async () => { const context = buildEvaluationContextMarkdown(memory); try { await navigator.clipboard.writeText(context); onNotify('AI 맥락을 클립보드에 복사했습니다.') } catch { onNotify('클립보드를 사용할 수 없습니다. AI 맥락 복사를 다시 시도하세요.') } }
  const updateProjectDraft = (key: 'product' | 'skew' | 'customer' | 'targetDevice' | 'densityGb' | 'nominalVoltage', raw: string) => setProjectDraft((current) => ({ ...current, [key]: raw === '' ? undefined : key === 'densityGb' || key === 'nominalVoltage' ? Number(raw) : raw }))
  const saveProjectConditions = async () => { await save(withProjectConditions(memory, projectDraft)) }

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const startX = event.clientX
    const startWidth = editorWidth
    const maxWidth = Math.max(360, Math.min(560, (layoutRef.current?.clientWidth ?? 960) - 440))
    const move = (pointerEvent: PointerEvent) => setEditorWidth(Math.min(maxWidth, Math.max(330, startWidth + startX - pointerEvent.clientX)))
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
  }

  return <div className="data-view evaluation-memory-view">
    <header className="data-view-header evaluation-memory-view__header"><div><h1>평가 이력</h1></div><div className="data-actions evaluation-memory-view__actions"><button onClick={() => downloadCsv(evaluationMemoryCsv(memory))}>CSV</button><button onClick={() => void copyContext()}>AI 맥락</button></div></header>
    <details className="evaluation-memory-view__project-context"><summary>조건</summary><div><label>제품<input value={projectDraft.product ?? ''} onChange={(event) => updateProjectDraft('product', event.target.value)} /></label><label>SKEW<input value={projectDraft.skew ?? ''} onChange={(event) => updateProjectDraft('skew', event.target.value)} placeholder="예: SS" /></label><label>고객<input value={projectDraft.customer ?? ''} onChange={(event) => updateProjectDraft('customer', event.target.value)} /></label><label>대상 장치<input value={projectDraft.targetDevice ?? ''} onChange={(event) => updateProjectDraft('targetDevice', event.target.value)} /></label><label>밀도 (Gb)<input type="number" value={projectDraft.densityGb ?? ''} onChange={(event) => updateProjectDraft('densityGb', event.target.value)} /></label><label>정격 전압 (V)<input type="number" value={projectDraft.nominalVoltage ?? ''} onChange={(event) => updateProjectDraft('nominalVoltage', event.target.value)} /></label><button type="button" disabled={saving} onClick={() => void saveProjectConditions()}>{saving ? '저장 중…' : '저장'}</button></div></details>
    <div className="evaluation-memory-view__layout" ref={layoutRef} style={{ '--evaluation-editor-width': `${editorWidth}px` } as React.CSSProperties}>
      <main><EvaluationLineage memory={memory} selectedNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} />
        {trends.length ? <section className="evaluation-memory-view__signals"><div className="evaluation-memory-view__section-label">로그 기반 경향</div>{primaryTrends.map((trend) => <div className="evaluation-memory-view__trend" key={`${trend.dimension}-${trend.value}`}><p>{trendInterpretation(trend)}</p></div>)}{remainingTrends.length ? <details className="evaluation-memory-view__more-trends"><summary>나머지 {remainingTrends.length}개</summary>{remainingTrends.map((trend) => <div className="evaluation-memory-view__trend" key={`${trend.dimension}-${trend.value}`}><p>{trendInterpretation(trend)}</p></div>)}</details> : null}</section> : null}
      </main>
      <div className="evaluation-memory-view__resizer" role="separator" aria-label="평가 이력 패널 너비 조절" aria-orientation="vertical" onPointerDown={beginResize} />
      <aside className="evaluation-memory-view__editor">
        <details className="evaluation-memory-view__manual">
          <summary>직접 입력</summary>
          <section className="evaluation-memory-view__manual-section"><div className="evaluation-memory-view__section-label">가설</div><label className="evaluation-memory-view__field"><span>이름</span><input disabled={saving} value={hypothesis.title} onChange={(event) => setHypothesis({ ...hypothesis, title: event.target.value })} placeholder="예: DQ9 VPERI 기인" /></label><label className="evaluation-memory-view__field"><span>메모</span><textarea disabled={saving} value={hypothesis.description} onChange={(event) => setHypothesis({ ...hypothesis, description: event.target.value })} placeholder="판단 근거" /></label><div className="evaluation-memory-view__form-action"><select aria-label="가설 작성자" disabled={saving} value={hypothesis.origin} onChange={(event) => setHypothesis({ ...hypothesis, origin: event.target.value as AssessmentOrigin })}><option value="ai-proposed">AI 제안</option><option value="engineer-confirmed">엔지니어 확인</option></select><button disabled={saving} onClick={() => void addHypothesis()}>{saving ? '저장 중…' : '가설 추가'}</button></div></section>
          <section className="evaluation-memory-view__manual-section"><div className="evaluation-memory-view__section-label">평가</div><label className="evaluation-memory-view__field"><span>이름</span><input value={evaluation.name} onChange={(event) => setEvaluation({ ...evaluation, name: event.target.value })} placeholder="평가 이름" /></label><label className="evaluation-memory-view__field"><span>목적</span><select value={evaluation.purpose} onChange={(event) => setEvaluation({ ...evaluation, purpose: event.target.value as EvaluationPurpose })}><option value="screening">불량 검출 강화</option><option value="improvement">개선 조건 확인</option><option value="reproduction">동일 불량 재현</option><option value="characterization">불량 경향 파악</option><option value="verification">개선 효과 검증</option></select></label><label className="evaluation-memory-view__field"><span>가설</span><select value={evaluation.hypothesisId} onChange={(event) => setEvaluation({ ...evaluation, hypothesisId: event.target.value })}><option value="">연결하지 않음</option>{memory.hypotheses.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="evaluation-memory-view__field"><span>이전 평가</span><select value={evaluation.parentId} onChange={(event) => setEvaluation({ ...evaluation, parentId: event.target.value })}><option value="">연결하지 않음</option>{memory.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="evaluation-memory-view__field"><span>평가 묶음</span><input value={evaluation.branchId} onChange={(event) => setEvaluation({ ...evaluation, branchId: event.target.value })} placeholder="예: VPERI 개선 조건" /></label><label className="evaluation-memory-view__field"><span>상태</span><select value={evaluation.status} onChange={(event) => setEvaluation({ ...evaluation, status: event.target.value as EvaluationStatus })}><option value="inconclusive">판정 보류</option><option value="pass">통과</option><option value="fail">불량</option><option value="running">진행 중</option></select></label>
          <details className="evaluation-memory-view__dimension-details"><summary>상세 조건</summary><div className="evaluation-memory-view__dimensions">{dimensionFields.map(([key, label, kind]) => <label className="evaluation-memory-view__field" key={key}><span>{label}</span><input type={kind} value={evaluation.dimensions[key] ?? ''} onChange={(event) => updateDimension(key, event.target.value, kind)} /></label>)}</div></details>
          <details className="evaluation-memory-view__logs"><summary>연결 로그 <span>{evaluation.logIds.length}/{availableLogs.length}</span></summary><div>{availableLogs.length ? availableLogs.map((log) => <label key={log.id}><input disabled={saving} type="checkbox" checked={evaluation.logIds.includes(log.id)} onChange={(event) => setEvaluation({ ...evaluation, logIds: event.target.checked ? [...evaluation.logIds, log.id] : evaluation.logIds.filter((item) => item !== log.id) })} />{log.name}<small>{log.result || [log.sample, log.temperatureC && `${log.temperatureC}°C`, log.mode, log.grid].filter(Boolean).join(' · ')}</small><button type="button" onClick={() => onOpenLog(openIdForEvidenceLog(log.id, availableLogs))}>열기</button></label>) : <p>연결 가능한 로그가 없습니다.</p>}</div></details><div className="evaluation-memory-view__form-action"><select aria-label="평가 작성자" disabled={saving} value={evaluation.origin} onChange={(event) => setEvaluation({ ...evaluation, origin: event.target.value as AssessmentOrigin })}><option value="ai-proposed">AI 제안</option><option value="engineer-confirmed">엔지니어 확인</option></select><button disabled={saving} className="is-primary" onClick={() => void addEvaluation()}>{saving ? '저장 중…' : '평가 추가'}</button></div></section>
        </details>
        {selectedNode && selectedLogIds.length ? <div className="evaluation-memory-view__selected"><span>선택한 평가</span><b>{selectedNode.name}</b><details className="evaluation-memory-view__selected-logs" open={selectedLogIds.length <= 6}><summary>연결 로그 {selectedLogIds.length}개</summary><div>{selectedLogIds.map((logId) => { const log = availableLogs.find((item) => item.id === logId); return <button key={logId} type="button" onClick={() => onOpenLog(openIdForEvidenceLog(logId, availableLogs))}>{log?.name ?? logId}</button> })}</div></details></div> : null}
      </aside>
    </div>
  </div>
}
