import type { JsonValue, ProjectExportPreset } from '../../electron/shared/contracts'
import type { ResultLabel } from '../domain/workbench'
import type { PivotAggregation, PivotDimension } from './logRecords'

export const PATTERN_LAYOUT_PRESET_ID = 'sequence-control-tower.patterns-layout.v1'
export const PATTERN_LAYOUT_PRESET_NAME = 'N×M 결과 요약 레이아웃'

export type PatternLayout = {
  rowAxes: [PivotDimension, PivotDimension | 'none']
  columnAxes: [PivotDimension, PivotDimension | 'none']
  aggregation: PivotAggregation
  resultFilter: ResultLabel | 'all'
  folderFilter: string
  failOnly: boolean
  unknownMetadataOnly: boolean
}

export const DEFAULT_PATTERN_LAYOUT: PatternLayout = {
  rowAxes: ['sample', 'none'], columnAxes: ['temperature', 'none'], aggregation: 'count',
  resultFilter: 'all', folderFilter: 'all', failOnly: false, unknownMetadataOnly: false,
}

const DIMENSIONS = new Set<PivotDimension>(['sample', 'temperature', 'mode', 'grid', 'result', 'review', 'folder', 'run'])
const AGGREGATIONS = new Set<PivotAggregation>(['count', 'fail_count', 'evidence_count'])
const RESULTS = new Set<ResultLabel>(['PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED'])

function dimension(value: unknown, fallback: PivotDimension | 'none'): PivotDimension | 'none' {
  return typeof value === 'string' && (value === 'none' || DIMENSIONS.has(value as PivotDimension)) ? value as PivotDimension | 'none' : fallback
}

function uniqueAxes(rows: PatternLayout['rowAxes'], columns: PatternLayout['columnAxes']): PatternLayout {
  const used = new Set<PivotDimension>()
  const groups = [rows, columns].map((group, groupIndex) => group.map((axis, axisIndex) => {
    if (axis === 'none' || used.has(axis)) return groupIndex === 0 && axisIndex === 0 ? 'sample' : 'none'
    used.add(axis); return axis
  }) as [PivotDimension, PivotDimension | 'none'])
  return { ...DEFAULT_PATTERN_LAYOUT, rowAxes: groups[0], columnAxes: groups[1] }
}

export function normalizePatternLayout(value: unknown): PatternLayout {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rows: PatternLayout['rowAxes'] = [dimension(Array.isArray(source.rowAxes) ? source.rowAxes[0] : undefined, 'sample') as PivotDimension, dimension(Array.isArray(source.rowAxes) ? source.rowAxes[1] : undefined, 'none')]
  const columns: PatternLayout['columnAxes'] = [dimension(Array.isArray(source.columnAxes) ? source.columnAxes[0] : undefined, 'temperature') as PivotDimension, dimension(Array.isArray(source.columnAxes) ? source.columnAxes[1] : undefined, 'none')]
  const normalized = uniqueAxes(rows, columns)
  return {
    ...normalized,
    aggregation: typeof source.aggregation === 'string' && AGGREGATIONS.has(source.aggregation as PivotAggregation) ? source.aggregation as PivotAggregation : DEFAULT_PATTERN_LAYOUT.aggregation,
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
