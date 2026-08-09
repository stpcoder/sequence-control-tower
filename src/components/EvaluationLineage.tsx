import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { AssessmentOrigin, EvaluationDimensions, EvaluationMemory, EvaluationNode, EvaluationStatus } from '../domain/evaluation-memory'
import './evaluation-lineage.css'

type EvaluationLineageConfidence = 'confirmed' | 'proposed'

interface DisplayNode {
  node: EvaluationNode
  lane: string
  state: EvaluationStatus
  confidence: EvaluationLineageConfidence
  hypothesisTitle?: string
  origin: AssessmentOrigin
  evidenceCount: number
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

function toneFor(state: EvaluationStatus): 'pass' | 'fail' | 'warning' | 'active' {
  if (state === 'pass') return 'pass'
  if (state === 'fail') return 'fail'
  if (state === 'running') return 'active'
  return 'warning'
}

function rateLabel(rate?: number): string {
  if (rate === undefined || rate === null) return '—'
  const normalized = rate <= 1 ? rate * 100 : rate
  return `${Math.round(normalized)}%`
}

function value(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value)
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
  emptyMessage = '표시할 평가 계보가 없습니다.',
  ariaLabel = '평가 계보',
}: EvaluationLineageProps) {
  const nodes = useMemo(() => {
    const nodeById = new Map(memory.nodes.map((node) => [node.id, node]))
    const hypothesisById = new Map(memory.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]))
    return memory.nodes.filter((node) => node.projectId === memory.project.id).map((node) => {
      const evidence = memory.evidence.filter((record) => record.evaluationNodeId === node.id)
      const hypothesis = node.hypothesisId ? hypothesisById.get(node.hypothesisId) : undefined
      const origin = hypothesis?.origin ?? (evidence.some((record) => record.origin === 'engineer-confirmed') ? 'engineer-confirmed' : 'ai-proposed')
      const dimensions = evidence.map((record) => resolvedDimensions(node, record.dimensions, nodeById))
      const failures = evidence.filter((record) => record.status === 'fail').length
      const latest = evidence.find((record) => record.status === 'running')?.status ?? node.status ?? evidence.at(-1)?.status ?? 'inconclusive'
      return {
        node, lane: node.branchId || 'main', state: latest, origin,
        confidence: origin === 'engineer-confirmed' ? 'confirmed' : 'proposed', hypothesisTitle: hypothesis?.title,
        evidenceCount: evidence.length, failureRate: evidence.length ? failures / evidence.length : undefined,
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
  const graphHeight = Math.max(136, nodes.length * 54 + 28)
  const graphWidth = Math.max(1, lanes.length) * 100

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
                const x = (index + 0.5) * 100
                return <line key={lane} x1={x} x2={x} y1="0" y2={graphHeight} className="evaluation-lineage__lane-wire" />
              })}
              {nodes.flatMap((item, index) => (item.node.parentId ? [item.node.parentId] : []).flatMap((parentId) => {
                const parentIndex = nodeIndex.get(parentId)
                if (parentIndex === undefined) return []
                const parent = nodes[parentIndex]
                const x1 = ((laneIndex.get(parent.lane) ?? 0) + 0.5) * 100
                const x2 = ((laneIndex.get(item.lane) ?? 0) + 0.5) * 100
                const y1 = parentIndex * 54 + 28
                const y2 = index * 54 + 28
                const midY = y1 + (y2 - y1) / 2
                return <path key={`${item.node.id}-${parentId}`} d={`M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`} className={item.confidence === 'proposed' ? 'evaluation-lineage__edge evaluation-lineage__edge--proposed' : 'evaluation-lineage__edge'} />
              }))}
            </svg>
            <ol className="evaluation-lineage__nodes">
              {nodes.map((item, index) => {
                const lane = laneIndex.get(item.lane) ?? 0
                const active = item.node.id === selected?.node.id
                return (
                  <li key={item.node.id} style={{ '--node-x': `${((lane + 0.5) / lanes.length) * 100}%`, '--node-y': `${index * 54 + 28}px` } as CSSProperties}>
                    <button
                      type="button"
                      className={`evaluation-lineage__node evaluation-lineage__node--${toneFor(item.state)} evaluation-lineage__node--${item.confidence}${active ? ' is-selected' : ''}`}
                      aria-pressed={active}
                      aria-label={`${item.node.id}: ${item.node.name}, ${stateLabel[item.state]}`}
                      onClick={() => onSelectNode?.(item.node)}
                    >
                      <span className="evaluation-lineage__point"><i /></span>
                      <span className="evaluation-lineage__node-copy"><b>{item.node.name}</b></span>
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
          <dl>
            <div><dt>근거</dt><dd>{selected.evidenceCount}건</dd></div>
            <div><dt>실패율</dt><dd>{rateLabel(selected.failureRate)}</dd></div>
            <div><dt>조건</dt><dd>{selected.dominantCondition || '—'}</dd></div>
            <div><dt>패턴</dt><dd>{selected.dominantPattern || '—'}</dd></div>
            <div><dt>주요 DQ</dt><dd>{selected.dominantDq || '—'}</dd></div>
          </dl>
          {selected.hypothesisTitle && <p className="evaluation-lineage__issue">{selected.hypothesisTitle}</p>}
        </aside>}
      </div>
    </section>
  )
}
