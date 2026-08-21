import type {
  NativeAgentAnalysisViewProposal,
  NativeAgentContextKind,
} from '../../electron/shared/contracts'

const DIMENSIONS = new Set([
  'sample', 'temperature', 'temperatureCorner', 'mode', 'skew', 'frequencyMHz', 'vdd', 'vddCorner', 'conditionCorner', 'pattern',
  'lot', 'material', 'die', 'socModel', 'equipmentChannel', 'eccMode', 'customCondition', 'evaluationStep', 'dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bankGroup', 'bank', 'row', 'column',
  'writeData', 'readData', 'timingSkewPs', 'grid', 'result', 'review', 'folder', 'run',
])
const EVALUATION_AGGREGATIONS = new Set(['sample_count', 'grid_count', 'pass_count', 'fail_count', 'pass_fail', 'fail_rate'])
const ADDRESS_AGGREGATIONS = new Set(['fail_event_count', 'fail_source_count', 'fail_event_share'])
const VISUALIZATIONS = new Set(['cross_table', 'heatmap', 'bar', 'bar_horizontal', 'stacked_bar', 'stacked_percent', 'line', 'combo'])
const CONTEXT_LABELS: Record<NativeAgentContextKind, string> = {
  free_chat: '대화',
  log_search: '로그 검색',
  results: '결과',
  analysis_view: '결과 정리',
  evaluation_history: '평가 이력',
  project_compare: '평가 비교',
}

export const analysisContextLabel = (kind?: NativeAgentContextKind): string => kind ? CONTEXT_LABELS[kind] : ''

const axes = (value: unknown): NativeAgentAnalysisViewProposal['rowAxes'] => {
  if (!Array.isArray(value)) return []
  const used = new Set<string>()
  return value.map((item) => item === 'material' ? 'sample' : item).filter((item): item is NativeAgentAnalysisViewProposal['rowAxes'][number] => {
    if (typeof item !== 'string' || !DIMENSIONS.has(item) || used.has(item)) return false
    used.add(item)
    return true
  }).slice(0, 3)
}

/** Validate the model-authored view proposal before it reaches renderer state.
 * Invalid or mixed-grain proposals are ignored rather than partially applied. */
export function normalizeAnalysisViewProposal(value: unknown): Omit<NativeAgentAnalysisViewProposal, 'id'> | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const dataBasis = source.dataBasis === 'failure_address' ? 'failure_address' : source.dataBasis === 'evaluation' ? 'evaluation' : null
  if (!dataBasis || typeof source.aggregation !== 'string' || typeof source.visualization !== 'string') return null
  const aggregations = dataBasis === 'failure_address' ? ADDRESS_AGGREGATIONS : EVALUATION_AGGREGATIONS
  if (!aggregations.has(source.aggregation) || !VISUALIZATIONS.has(source.visualization)) return null
  if (dataBasis === 'failure_address' && !['cross_table', 'heatmap', 'bar', 'bar_horizontal'].includes(source.visualization)) return null
  if (['stacked_bar', 'stacked_percent', 'combo'].includes(source.visualization) && source.aggregation !== 'pass_fail') return null
  if (source.visualization === 'line' && source.aggregation === 'pass_fail') return null
  const rowAxes = axes(source.rowAxes)
  const columnAxes = axes(source.columnAxes).filter((item) => !rowAxes.includes(item))
  if (!rowAxes.length && !columnAxes.length) return null
  const rationale = typeof source.rationale === 'string'
    ? source.rationale.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
    : ''
  return {
    dataBasis,
    rowAxes,
    columnAxes,
    aggregation: source.aggregation as NativeAgentAnalysisViewProposal['aggregation'],
    visualization: source.visualization as NativeAgentAnalysisViewProposal['visualization'],
    ...(source.failOnly === true ? { failOnly: true } : {}),
    ...(rationale ? { rationale } : {}),
  }
}

const PROPOSAL_PATTERN = /<sct-analysis-view>([\s\S]*?)<\/sct-analysis-view>/i

export function extractAnalysisViewProposal(content: string): {
  content: string
  proposal: Omit<NativeAgentAnalysisViewProposal, 'id'> | null
} {
  const match = PROPOSAL_PATTERN.exec(content)
  if (!match) return { content: content.trim(), proposal: null }
  let parsed: unknown
  try { parsed = JSON.parse(match[1].trim()) } catch { parsed = null }
  return {
    content: content.replace(PROPOSAL_PATTERN, '').trim(),
    proposal: normalizeAnalysisViewProposal(parsed),
  }
}
