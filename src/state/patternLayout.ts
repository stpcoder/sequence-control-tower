import type { JsonValue, NativeAgentAnalysisViewProposal, ProjectExportPreset } from '../../electron/shared/contracts'
import type { ResultLabel } from '../domain/workbench'
import { isFailureAddressAggregation, type PivotAggregation, type PivotDimension } from './logRecords'
import { normalizedVisualization, type AnalysisDataBasis, type AnalysisVisualization } from '../domain/analysis-view'

export const PATTERN_LAYOUT_PRESET_ID = 'sequence-control-tower.patterns-layout.v1'
export const PATTERN_LAYOUT_PRESET_NAME = '결과 정리 표 구성'
export const MAX_PATTERN_AXES = 3

export type PatternLayout = {
  rowAxes: PivotDimension[]
  columnAxes: PivotDimension[]
  aggregation: PivotAggregation
  visualization: AnalysisVisualization
  dataBasis: AnalysisDataBasis
  resultFilter: ResultLabel | 'all'
  folderFilter: string
  failOnly: boolean
  unknownMetadataOnly: boolean
}

export const DEFAULT_PATTERN_LAYOUT: PatternLayout = {
  rowAxes: ['skew', 'sample'], columnAxes: ['temperature', 'vdd'], aggregation: 'pass_fail',
  visualization: 'cross_table',
  dataBasis: 'evaluation',
  resultFilter: 'all', folderFilter: 'all', failOnly: false, unknownMetadataOnly: false,
}

const DIMENSIONS = new Set<PivotDimension>([
  'sample', 'temperature', 'temperatureCorner', 'mode', 'skew', 'frequencyMHz', 'vdd', 'vddCorner', 'conditionCorner', 'pattern',
  'lot', 'material', 'die', 'socModel', 'equipmentChannel', 'eccMode', 'customCondition', 'evaluationStep',
  'dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bankGroup', 'bank', 'row', 'column', 'writeData', 'readData', 'timingSkewPs',
  'grid', 'result', 'review', 'folder', 'run',
])
const AGGREGATIONS = new Set<PivotAggregation>(['count', 'sample_count', 'grid_count', 'pass_count', 'fail_count', 'pass_fail', 'fail_rate', 'fail_event_count', 'fail_source_count', 'fail_event_share'])
const RESULTS = new Set<ResultLabel>(['PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED'])

function normalizedAxis(value: unknown, fallback: readonly PivotDimension[]): PivotDimension[] {
  if (!Array.isArray(value)) return [...fallback]
  return value
    .map((item) => item === 'material' ? 'sample' : item)
    .filter((item): item is PivotDimension => typeof item === 'string' && DIMENSIONS.has(item as PivotDimension))
    .slice(0, MAX_PATTERN_AXES)
}

function uniqueAxes(rows: PatternLayout['rowAxes'], columns: PatternLayout['columnAxes']): PatternLayout {
  const used = new Set<PivotDimension>()
  const groups = [rows, columns].map((group) => group.filter((axis) => {
    if (used.has(axis)) return false
    used.add(axis)
    return true
  }))
  return { ...DEFAULT_PATTERN_LAYOUT, rowAxes: groups[0], columnAxes: groups[1] }
}

export function normalizePatternLayout(value: unknown): PatternLayout {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rows = normalizedAxis(source.rowAxes, DEFAULT_PATTERN_LAYOUT.rowAxes)
  const columns = normalizedAxis(source.columnAxes, DEFAULT_PATTERN_LAYOUT.columnAxes)
  const normalized = uniqueAxes(rows, columns)
  const legacyFileCount = source.aggregation === 'evidence_count' || source.aggregation === 'count'
  const requestedAggregation = legacyFileCount
    ? 'pass_fail'
    : typeof source.aggregation === 'string' && AGGREGATIONS.has(source.aggregation as PivotAggregation) ? source.aggregation as PivotAggregation : DEFAULT_PATTERN_LAYOUT.aggregation
  const requestedBasis: AnalysisDataBasis = source.dataBasis === 'failure_address' || isFailureAddressAggregation(requestedAggregation) ? 'failure_address' : 'evaluation'
  const aggregation: PivotAggregation = requestedBasis === 'failure_address'
    ? isFailureAddressAggregation(requestedAggregation) ? requestedAggregation : 'fail_event_count'
    : isFailureAddressAggregation(requestedAggregation) ? 'pass_fail' : requestedAggregation
  return {
    ...normalized,
    aggregation,
    dataBasis: requestedBasis,
    visualization: legacyFileCount ? 'cross_table' : normalizedVisualization(source.visualization, aggregation),
    resultFilter: typeof source.resultFilter === 'string' && (source.resultFilter === 'all' || RESULTS.has(source.resultFilter as ResultLabel)) ? source.resultFilter as ResultLabel | 'all' : 'all',
    folderFilter: typeof source.folderFilter === 'string' && source.folderFilter.length <= 240 && !/[\u0000-\u001f\u007f\r\n]/.test(source.folderFilter) ? source.folderFilter : 'all',
    failOnly: source.failOnly === true,
    unknownMetadataOnly: source.unknownMetadataOnly === true,
  }
}

export function patternLayoutFromPreset(preset: ProjectExportPreset | undefined): PatternLayout {
  return normalizePatternLayout(preset?.options)
}

export function patternLayoutPreset(layout: PatternLayout, existing?: ProjectExportPreset): Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'> & { id?: string } {
  return {
    id: PATTERN_LAYOUT_PRESET_ID,
    name: PATTERN_LAYOUT_PRESET_NAME,
    format: 'json',
    options: normalizePatternLayout(layout) as unknown as Record<string, JsonValue>,
    ...(existing?.archived ? { archived: false } : {}),
  }
}

/** Apply an Agent suggestion as ordinary renderer state. Filters not named by
 * the proposal are preserved and persistence remains a separate user action. */
export function patternLayoutWithAgentProposal(current: PatternLayout, proposal: NativeAgentAnalysisViewProposal): PatternLayout {
  return normalizePatternLayout({
    ...current,
    rowAxes: proposal.rowAxes,
    columnAxes: proposal.columnAxes,
    aggregation: proposal.aggregation,
    visualization: proposal.visualization,
    dataBasis: proposal.dataBasis,
    ...(proposal.failOnly !== undefined ? { failOnly: proposal.failOnly } : {}),
  })
}
