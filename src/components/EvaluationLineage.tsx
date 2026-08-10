import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationPurpose, EvaluationStatus } from '../domain/evaluation-memory'
import './evaluation-lineage.css'

type EvaluationLineageConfidence = 'confirmed' | 'proposed'

interface DisplayNode {
  node: EvaluationNode
  purpose?: EvaluationPurpose
  purposeInferred: boolean
  lane: string
  state: EvaluationStatus
  confidence: EvaluationLineageConfidence
  hypothesisTitle?: string
  parentName?: string
  origin: AssessmentOrigin
  evidenceCount: number
  failureCount: number
  failureRate?: number
  dominantDq?: string
  dominantPattern?: string
  dominantCondition?: string
}

export interface EvaluationLineageProps {
  /** The domain memory model; this component never mutates it. */
  memory: EvaluationMemory
  selectedNodeId?: string | null
  onSelectNode?: (node: EvaluationNode) => void
  className?: string
  emptyMessage?: string
  ariaLabel?: string
}

const stateLabel: Record<EvaluationStatus, string> = {
  pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE', running: 'RUNNING',
}
export const evaluationPurposeLabel: Record<EvaluationPurpose, string> = {
  screening: '불량 검출 강화', improvement: '개선 조건 확인', reproduction: '동일 불량 재현', characterization: '불량 경향 파악', verification: '개선 효과 검증',
}
export const evaluationPurposeDescription: Record<EvaluationPurpose, string> = {
  screening: '불량을 더 빠르게 검출할 조건을 찾는 평가',
  improvement: '조건 변경으로 불량이 줄어드는지 확인하는 평가',
  reproduction: '같은 Sample과 Sequence에서 불량이 다시 발생하는지 확인하는 평가',
  characterization: '온도·전압·주파수·DRAM 위치별 불량 집중을 비교하는 평가',
  verification: '선택한 개선 조건을 반복해 효과를 확정하는 평가',
}

/** Gives old saved evaluations a visible candidate purpose without rewriting them. */
export function displayEvaluationPurpose(node: Pick<EvaluationNode, 'name' | 'purpose'>): { purpose?: EvaluationPurpose; inferred: boolean } {
  if (node.purpose) return { purpose: node.purpose, inferred: false }
  const name = node.name.toLocaleLowerCase('ko-KR')
  if (/가속|스크린|screen/.test(name)) return { purpose: 'screening', inferred: true }
  if (/개선.*검증|효과.*확인|verify/.test(name)) return { purpose: 'verification', inferred: true }
  if (/개선|완화|마진/.test(name)) return { purpose: 'improvement', inferred: true }
  if (/\brt\d*\b|재현|retest|retry/.test(name)) return { purpose: 'reproduction', inferred: true }
  if (/경향|특성|분포|character|retention/.test(name)) return { purpose: 'characterization', inferred: true }
  return { inferred: false }
}

function toneFor(state: EvaluationStatus): 'pass' | 'fail' | 'warning' | 'active' {
  if (state === 'pass') return 'pass'
  if (state === 'fail') return 'fail'
  if (state === 'running') return 'active'
  return 'warning'
}

function value(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value)
}

export function evaluationInterpretation(input: Pick<DisplayNode, 'evidenceCount' | 'failureCount' | 'failureRate' | 'dominantCondition' | 'dominantPattern' | 'dominantDq'>): string {
  if (!input.evidenceCount) return '연결된 로그가 없어 아직 불량 경향을 해석할 수 없습니다.'
  if (!input.failureCount) return '연결된 로그에서는 실패가 확인되지 않았습니다.'
  const conditions = [
    input.dominantCondition,
    input.dominantPattern ? `${input.dominantPattern} 패턴` : undefined,
    input.dominantDq ? `DQ ${input.dominantDq}` : undefined,
  ].filter(Boolean)
  if (!conditions.length) return '실패 로그는 있으나 반복되는 온도·전압·패턴·DQ 조건은 아직 분명하지 않습니다.'
  const subject = conditions.join(' · ')
  if (input.failureRate === 1) return `${subject}에서 확인된 로그가 모두 실패했습니다.`
  if ((input.failureRate ?? 0) >= 0.6) return `${subject}에서 실패가 반복적으로 집중됩니다.`
  return `${subject}에서 일부 실패가 확인됩니다.`
}

function resolvedDimensions(node: EvaluationNode, recordDimensions: Partial<EvaluationDimensions> | undefined, nodes: ReadonlyMap<string, EvaluationNode>): EvaluationDimensions {
  const chain: EvaluationNode[] = []
  const seen = new Set<string>()
  let current: EvaluationNode | undefined = node
  while (current && !seen.has(current.id)) { chain.push(current); seen.add(current.id); current = current.parentId ? nodes.get(current.parentId) : undefined }
  return Object.assign({}, ...chain.reverse().map((item) => item.dimensions), recordDimensions)
}

function mode(values: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>()
  values.forEach((item) => { if (item) counts.set(item, (counts.get(item) ?? 0) + 1) })
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
}

/**
 * A compact, controlled git-like view of evaluation history. It intentionally
 * uses display data instead of store snapshots so it can show confirmed and
 * proposed relationships side-by-side without inventing persistence semantics.
 */
export function EvaluationLineage({
  memory,
  selectedNodeId,
  onSelectNode,
  className = '',
  emptyMessage = '저장된 평가가 없습니다.',
  ariaLabel = '평가 이력',
}: EvaluationLineageProps) {
  const nodes = useMemo(() => {
    const nodeById = new Map(memory.nodes.map((node) => [node.id, node]))
    const hypothesisById = new Map(memory.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]))
    return memory.nodes.filter((node) => node.projectId === memory.project.id).map((node) => {
      const evidence = memory.evidence.filter((record) => record.evaluationNodeId === node.id)
      const hypothesis = node.hypothesisId ? hypothesisById.get(node.hypothesisId) : undefined
      const origin = hypothesis?.origin ?? (evidence.some((record) => record.origin === 'engineer-confirmed') ? 'engineer-confirmed' : 'ai-proposed')
      const failedEvidence = evidence.filter((record) => record.status === 'fail')
      const dimensions = failedEvidence.map((record) => resolvedDimensions(node, record.dimensions, nodeById))
      const failures = failedEvidence.length
      const latest = evidence.find((record) => record.status === 'running')?.status ?? node.status ?? evidence.at(-1)?.status ?? 'inconclusive'
      const displayedPurpose = displayEvaluationPurpose(node)
      return {
        node, purpose: displayedPurpose.purpose, purposeInferred: displayedPurpose.inferred, lane: node.branchId || 'main', state: latest, origin,
        confidence: origin === 'engineer-confirmed' ? 'confirmed' : 'proposed', hypothesisTitle: hypothesis?.title, parentName: node.parentId ? nodeById.get(node.parentId)?.name : undefined,
        evidenceCount: evidence.length, failureCount: failures, failureRate: evidence.length ? failures / evidence.length : undefined,
        dominantDq: mode(dimensions.map((item) => value(item.dq))), dominantPattern: mode(dimensions.map((item) => value(item.pattern))),
        dominantCondition: mode(dimensions.map((item) => {
          const parts = [item.temperatureC === undefined ? undefined : `${item.temperatureC}°C`, item.vdd === undefined ? undefined : `${item.vdd}V`, item.frequencyMHz === undefined ? undefined : `${item.frequencyMHz}MHz`].filter(Boolean)
          return parts.join(' · ') || undefined
        })),
      } satisfies DisplayNode
    })
  }, [memory])
  const lanes = useMemo(() => Array.from(new Set(nodes.map((node) => node.lane))), [nodes])
  const laneIndex = useMemo(() => new Map(lanes.map((lane, index) => [lane, index])), [lanes])
  const nodeIndex = useMemo(() => new Map(nodes.map((item, index) => [item.node.id, index])), [nodes])
  const selected = nodes.find((item) => item.node.id === selectedNodeId) ?? nodes[0]
  const nodeStride = 70
  const laneWidth = 196
  const graphHeight = Math.max(164, nodes.length * nodeStride + 34)
  const graphWidth = Math.max(1, lanes.length) * laneWidth

  if (!nodes.length) {
    return <section className={`evaluation-lineage ${className}`.trim()} aria-label={ariaLabel}><p className="evaluation-lineage__empty">{emptyMessage}<small>오른쪽에서 불량 가설 또는 첫 평가를 추가하세요.</small></p></section>
  }

  return (
    <section className={`evaluation-lineage ${className}`.trim()} aria-label={ariaLabel}>
      <div className="evaluation-lineage__body">
        <div className="evaluation-lineage__graph-wrap">
          <div className="evaluation-lineage__graph" style={{ '--lineage-height': `${graphHeight}px`, '--lineage-lanes': lanes.length } as CSSProperties}>
            <svg className="evaluation-lineage__wires" viewBox={`0 0 ${graphWidth} ${graphHeight}`} preserveAspectRatio="none" aria-hidden="true">
              {lanes.map((lane, index) => {
                const x = (index + 0.5) * laneWidth
                return <line key={lane} x1={x} x2={x} y1="0" y2={graphHeight} className="evaluation-lineage__lane-wire" />
              })}
              {nodes.flatMap((item, index) => (item.node.parentId ? [item.node.parentId] : []).flatMap((parentId) => {
                const parentIndex = nodeIndex.get(parentId)
                if (parentIndex === undefined) return []
                const parent = nodes[parentIndex]
                const x1 = ((laneIndex.get(parent.lane) ?? 0) + 0.5) * laneWidth
                const x2 = ((laneIndex.get(item.lane) ?? 0) + 0.5) * laneWidth
                const y1 = parentIndex * nodeStride + 32
                const y2 = index * nodeStride + 32
                const midY = y1 + (y2 - y1) / 2
                return <path key={`${item.node.id}-${parentId}`} d={`M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`} className={item.confidence === 'proposed' ? 'evaluation-lineage__edge evaluation-lineage__edge--proposed' : 'evaluation-lineage__edge'} />
              }))}
            </svg>
            <ol className="evaluation-lineage__nodes">
              {nodes.map((item, index) => {
                const lane = laneIndex.get(item.lane) ?? 0
                const active = item.node.id === selected?.node.id
                return (
                  <li key={item.node.id} style={{ '--node-x': `${((lane + 0.5) / lanes.length) * 100}%`, '--node-y': `${index * nodeStride + 32}px` } as CSSProperties}>
                    <button
                      type="button"
                      className={`evaluation-lineage__node evaluation-lineage__node--${toneFor(item.state)} evaluation-lineage__node--${item.confidence}${active ? ' is-selected' : ''}`}
                      aria-pressed={active}
                      aria-label={`${item.node.id}: ${item.node.name}, ${stateLabel[item.state]}`}
                      onClick={() => onSelectNode?.(item.node)}
                    >
                      <span className="evaluation-lineage__point"><i /></span>
                      <span className="evaluation-lineage__node-copy"><small>{item.purpose ? evaluationPurposeLabel[item.purpose] : '목적 확인 필요'}</small><b>{item.node.name}</b></span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>
        </div>

        {selected && <aside className="evaluation-lineage__summary" aria-live="polite">
          <div className="evaluation-lineage__summary-heading">
            <span className={`evaluation-lineage__state evaluation-lineage__state--${toneFor(selected.state)}`}>{stateLabel[selected.state]}</span>
            <span className={`evaluation-lineage__confidence evaluation-lineage__confidence--${selected.confidence}`}>{selected.confidence === 'confirmed' ? '확정됨' : 'AI 제안'}</span>
          </div>
          <strong>{selected.node.name}</strong>
          {selected.purpose ? <p className="evaluation-lineage__purpose"><small>평가 목적</small>{evaluationPurposeDescription[selected.purpose]}</p> : null}
          {selected.parentName ? <p className="evaluation-lineage__relation"><small>연결</small><span>{selected.parentName}</span><b aria-hidden="true">→</b><span>{selected.node.name}</span></p> : null}
          <p className="evaluation-lineage__interpretation">{evaluationInterpretation(selected)}</p>
          {selected.hypothesisTitle && <p className="evaluation-lineage__issue"><small>분석 가설</small>{selected.hypothesisTitle}</p>}
        </aside>}
      </div>
    </section>
  )
}
