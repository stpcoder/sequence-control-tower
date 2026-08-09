import { useEffect, useMemo, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationPurpose, EvaluationStatus, EvidenceRecord, FailureHypothesis, ProductProject } from '../domain/evaluation-memory'
import { flattenEvaluationMemory, inferEvaluationTrends } from '../domain/evaluation-memory'
import { EvaluationLineage, displayEvaluationPurpose, evaluationPurposeLabel } from '../components/EvaluationLineage'
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
  onAskAgent?: (message: string) => void
}

const dimensionFields: Array<[keyof EvaluationDimensions, string, 'text' | 'number']> = [
  ['sku', 'SKU', 'text'], ['lot', 'Lot', 'text'], ['material', '자재', 'text'], ['die', 'Die', 'text'], ['sample', 'Sample', 'text'], ['socModel', 'SoC', 'text'], ['bootProfileId', 'Boot profile', 'text'], ['bl', 'BL', 'text'], ['dq', 'DQ', 'text'], ['channel', 'Channel', 'text'], ['bank', 'Bank', 'text'], ['bankGroup', 'Bank group', 'text'], ['pattern', 'Pattern', 'text'], ['frequencyMHz', 'MHz', 'number'], ['temperatureC', '°C', 'number'], ['vdd', 'VDD (V)', 'number'], ['skewPs', 'SKEW (ps)', 'number'], ['testMode', 'Mode', 'text'],
]

const emptyDimensions = (): EvaluationDimensions => ({})
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`}`
const trendDimensionLabel = (dimension: string) => ({ sku: 'SKU', skewPs: 'SKEW', vdd: 'VDD', bl: 'BL', dq: 'DQ', frequencyMHz: 'MHz', socModel: 'SoC', channel: 'Channel', bank: 'Bank', bankGroup: 'Bank group', pattern: 'Pattern', temperatureC: '온도' }[dimension] ?? dimension)

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
  const header = ['projectId', 'projectName', 'product', 'projectSku', 'customer', 'targetDevice', 'densityGb', 'nominalVoltage', 'program', 'phase', 'hypothesisId', 'hypothesisTitle', 'hypothesisOrigin', 'nodeId', 'parentNodeId', 'branchId', 'nodeName', 'nodePurpose', 'nodeStatus', 'sequenceSignature', 'attemptNo', 'retestOf', 'evidenceId', 'occurredAt', 'status', 'result', 'logRef', 'sourceIds', 'note', 'evidenceOrigin', 'sku', 'lot', 'material', 'die', 'sample', 'socVendor', 'socModel', 'bootProfileId', 'bl', 'dq', 'channel', 'bank', 'bankGroup', 'pattern', 'frequencyMHz', 'temperatureC', 'vdd', 'skewPs', 'testMode']
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
    memory.project.sku && `SKU: ${memory.project.sku}`,
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

export function EvaluationMemoryView({ memory, availableLogs, onChange, onOpenLog, onNotify, onAskAgent }: EvaluationMemoryViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(memory.nodes[0]?.id)
  const [hypothesis, setHypothesis] = useState({ title: '', description: '', origin: 'ai-proposed' as AssessmentOrigin })
  const [evaluation, setEvaluation] = useState({ name: '', purpose: 'characterization' as EvaluationPurpose, hypothesisId: '', parentId: '', branchId: '', status: 'inconclusive' as EvaluationStatus, origin: 'ai-proposed' as AssessmentOrigin, dimensions: emptyDimensions(), logIds: [] as string[] })
  const [projectDraft, setProjectDraft] = useState<ProductProject>(memory.project)
  const [agentRequest, setAgentRequest] = useState('')
  const [saving, setSaving] = useState(false)
  const trends = useMemo(() => inferEvaluationTrends(memory).slice(0, 6), [memory])
  const purposeCounts = useMemo(() => Object.entries(evaluationPurposeLabel).map(([purpose, label]) => ({ purpose: purpose as EvaluationPurpose, label, count: memory.nodes.filter((node) => displayEvaluationPurpose(node).purpose === purpose).length })).filter((item) => item.count), [memory.nodes])
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
  const updateProjectDraft = (key: 'product' | 'sku' | 'customer' | 'targetDevice' | 'densityGb' | 'nominalVoltage', raw: string) => setProjectDraft((current) => ({ ...current, [key]: raw === '' ? undefined : key === 'densityGb' || key === 'nominalVoltage' ? Number(raw) : raw }))
  const saveProjectConditions = async () => { await save(withProjectConditions(memory, projectDraft)) }

  const askAgent = () => {
    const request = agentRequest.trim()
    if (!request) return onNotify('정리할 평가 내용을 입력하세요.')
    if (!onAskAgent) return onNotify('Agent를 사용할 수 없습니다.')
    onAskAgent(`다음 평가 내용을 분석해 평가 이력으로 정리해줘. 먼저 평가 목적을 불량 검출 강화, 개선 조건 확인, 동일 불량 재현, 불량 경향 파악, 개선 효과 검증 중 하나로 분류해줘. SKU, 온도, VDD, SKEW, 자재, Die, Sample, SoC, 부팅 단계, Pattern, DQ, BL, Channel과 단계별 Pass/Fail 근거를 확인하고 불확실한 핵심 항목만 질문해줘.\n\n${request}`)
  }

  return <div className="evaluation-memory-view">
    <header className="evaluation-memory-view__header"><h1>평가 이력</h1><div className="evaluation-memory-view__actions"><button onClick={() => downloadCsv(evaluationMemoryCsv(memory))}>CSV</button><button onClick={() => void copyContext()}>AI 맥락</button></div></header>
    <details className="evaluation-memory-view__project-context"><summary>조건</summary><div><label>제품<input value={projectDraft.product ?? ''} onChange={(event) => updateProjectDraft('product', event.target.value)} /></label><label>SKU<input value={projectDraft.sku ?? ''} onChange={(event) => updateProjectDraft('sku', event.target.value)} placeholder="예: SS · 16Gb · x16" /></label><label>고객<input value={projectDraft.customer ?? ''} onChange={(event) => updateProjectDraft('customer', event.target.value)} /></label><label>대상 장치<input value={projectDraft.targetDevice ?? ''} onChange={(event) => updateProjectDraft('targetDevice', event.target.value)} /></label><label>밀도 (Gb)<input type="number" value={projectDraft.densityGb ?? ''} onChange={(event) => updateProjectDraft('densityGb', event.target.value)} /></label><label>정격 전압 (V)<input type="number" value={projectDraft.nominalVoltage ?? ''} onChange={(event) => updateProjectDraft('nominalVoltage', event.target.value)} /></label><button type="button" disabled={saving} onClick={() => void saveProjectConditions()}>{saving ? '저장 중…' : '저장'}</button></div></details>
    <div className="evaluation-memory-view__layout">
      <main>{purposeCounts.length ? <div className="evaluation-memory-view__purposes"><span>평가 목적</span>{purposeCounts.map((item) => <b key={item.purpose}>{item.label} <em>{item.count}</em></b>)}</div> : null}<EvaluationLineage memory={memory} selectedNodeId={selectedNodeId} onSelectNode={(node) => setSelectedNodeId(node.id)} />
        {trends.length ? <section className="evaluation-memory-view__signals"><div className="evaluation-memory-view__section-label">조건별 실패 집중</div>{trends.map((trend) => <div className="evaluation-memory-view__trend" key={`${trend.dimension}-${trend.value}`}><b>{trendDimensionLabel(trend.dimension)} = {trend.value}</b><span>{trend.failureCount}/{trend.evidenceCount} FAIL · {Math.round(trend.failureRate * 100)}%</span><em>{trend.origin === 'engineer-confirmed' ? '확정' : '제안'}</em></div>)}</section> : null}
      </main>
      <aside className="evaluation-memory-view__editor">
        <div className="evaluation-memory-view__section-label">Agent로 정리</div>
        <div className="evaluation-memory-view__agent-composer"><textarea className="evaluation-memory-view__agent-input" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} placeholder="예: 85°C, VDD 1.295V에서 DQ9 불량 개선 조건을 확인했습니다." rows={3} /><button type="button" onClick={askAgent} aria-label="Agent에게 정리 요청" title="Agent에게 정리 요청"><ArrowUp size={17} /></button></div>
        <details className="evaluation-memory-view__manual">
          <summary>직접 입력</summary>
          <div className="evaluation-memory-view__section-label">가설</div><input disabled={saving} value={hypothesis.title} onChange={(event) => setHypothesis({ ...hypothesis, title: event.target.value })} placeholder="가설 이름" /><textarea disabled={saving} value={hypothesis.description} onChange={(event) => setHypothesis({ ...hypothesis, description: event.target.value })} placeholder="근거 메모" /><label className="evaluation-memory-view__origin"><select disabled={saving} value={hypothesis.origin} onChange={(event) => setHypothesis({ ...hypothesis, origin: event.target.value as AssessmentOrigin })}><option value="ai-proposed">AI 제안</option><option value="engineer-confirmed">엔지니어 확인</option></select><button disabled={saving} onClick={() => void addHypothesis()}>{saving ? '저장 중…' : '추가'}</button></label>
          <div className="evaluation-memory-view__section-label">평가</div><input value={evaluation.name} onChange={(event) => setEvaluation({ ...evaluation, name: event.target.value })} placeholder="평가 이름" /><select value={evaluation.purpose} onChange={(event) => setEvaluation({ ...evaluation, purpose: event.target.value as EvaluationPurpose })}><option value="screening">불량 검출 강화</option><option value="improvement">개선 조건 확인</option><option value="reproduction">동일 불량 재현</option><option value="characterization">불량 경향 파악</option><option value="verification">개선 효과 검증</option></select><div className="evaluation-memory-view__pair"><select value={evaluation.hypothesisId} onChange={(event) => setEvaluation({ ...evaluation, hypothesisId: event.target.value })}><option value="">가설 없음</option>{memory.hypotheses.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select value={evaluation.parentId} onChange={(event) => setEvaluation({ ...evaluation, parentId: event.target.value })}><option value="">이전 평가 없음</option>{memory.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="evaluation-memory-view__pair"><input value={evaluation.branchId} onChange={(event) => setEvaluation({ ...evaluation, branchId: event.target.value })} placeholder="관련 평가 묶음" /><select value={evaluation.status} onChange={(event) => setEvaluation({ ...evaluation, status: event.target.value as EvaluationStatus })}><option value="inconclusive">판정 보류</option><option value="pass">통과</option><option value="fail">불량</option><option value="running">진행 중</option></select></div>
          <div className="evaluation-memory-view__dimensions">{dimensionFields.map(([key, label, kind]) => <label key={key}>{label}<input type={kind} value={evaluation.dimensions[key] ?? ''} onChange={(event) => updateDimension(key, event.target.value, kind)} /></label>)}</div>
          <div className="evaluation-memory-view__logs"><span>로그 근거 연결</span>{availableLogs.length ? availableLogs.map((log) => <label key={log.id}><input disabled={saving} type="checkbox" checked={evaluation.logIds.includes(log.id)} onChange={(event) => setEvaluation({ ...evaluation, logIds: event.target.checked ? [...evaluation.logIds, log.id] : evaluation.logIds.filter((item) => item !== log.id) })} />{log.name}<small>{log.result || [log.sample, log.temperatureC && `${log.temperatureC}°C`, log.mode, log.grid].filter(Boolean).join(' · ')}</small><button type="button" onClick={() => onOpenLog(openIdForEvidenceLog(log.id, availableLogs))}>열기</button></label>) : <p>연결 가능한 로그가 없습니다. 로그 탭에서 가져오세요.</p>}</div><label className="evaluation-memory-view__origin"><select disabled={saving} value={evaluation.origin} onChange={(event) => setEvaluation({ ...evaluation, origin: event.target.value as AssessmentOrigin })}><option value="ai-proposed">AI 제안</option><option value="engineer-confirmed">엔지니어 확인</option></select><button disabled={saving} className="is-primary" onClick={() => void addEvaluation()}>{saving ? '저장 중…' : '평가 추가'}</button></label>
        </details>
        {selectedNode && selectedLogIds.length ? <div className="evaluation-memory-view__selected"><b>{selectedNode.name}</b><div className="evaluation-memory-view__selected-logs">{selectedLogIds.map((logId) => { const log = availableLogs.find((item) => item.id === logId); return <button key={logId} type="button" onClick={() => onOpenLog(openIdForEvidenceLog(logId, availableLogs))}>{log?.name ?? logId}</button> })}</div></div> : null}
      </aside>
    </div>
  </div>
}
