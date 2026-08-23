import type { PivotAggregation, PivotDimension, PivotGrid } from '../state/logRecords'

export type AnalysisVisualization =
  | 'cross_table'
  | 'heatmap'
  | 'bar'
  | 'bar_horizontal'
  | 'stacked_bar'
  | 'stacked_percent'
  | 'line'
  | 'combo'

export type AnalysisDataBasis = 'evaluation' | 'failure_address'

export const ANALYSIS_DATA_BASIS_LABELS: Record<AnalysisDataBasis, string> = {
  evaluation: '평가 결과',
  failure_address: 'Fail 주소',
}

export interface AnalysisViewPreset {
  id: string
  label: string
  basis: AnalysisDataBasis
  visualization: AnalysisVisualization
  rowAxes: PivotDimension[]
  columnAxes: PivotDimension[]
  aggregation: PivotAggregation
}

export const ANALYSIS_VISUALIZATION_LABELS: Record<AnalysisVisualization, string> = {
  cross_table: '교차표',
  heatmap: 'Heatmap',
  bar: '세로 막대',
  bar_horizontal: '가로 막대',
  stacked_bar: 'PASS/FAIL 구성',
  stacked_percent: 'PASS/FAIL 비율',
  line: '조건 변화',
  combo: '건수와 비율',
}

/** Compact, LPDDR-specific starting views. They are starting points, not
 * immutable templates: every axis and measure remains editable afterwards. */
export const ANALYSIS_VIEW_PRESETS: readonly AnalysisViewPreset[] = [
  { id: 'condition-overview', label: '조건별 판정', basis: 'evaluation', visualization: 'cross_table', rowAxes: ['skew', 'sample'], columnAxes: ['temperature', 'vdd'], aggregation: 'pass_fail' },
  { id: 'reproduction', label: '재현 비교', basis: 'evaluation', visualization: 'cross_table', rowAxes: ['skew', 'sample'], columnAxes: ['run'], aggregation: 'pass_fail' },
  { id: 'acceleration', label: '가속 조건', basis: 'evaluation', visualization: 'cross_table', rowAxes: ['frequencyMHz'], columnAxes: ['temperatureCorner', 'vddCorner'], aggregation: 'fail_rate' },
  { id: 'tm-comparison', label: 'TM 개선 비교', basis: 'evaluation', visualization: 'stacked_bar', rowAxes: ['testMode'], columnAxes: [], aggregation: 'pass_fail' },
  { id: 'corner-comparison', label: '4-Corner 비교', basis: 'evaluation', visualization: 'bar', rowAxes: ['conditionCorner'], columnAxes: ['skew'], aggregation: 'fail_rate' },
  { id: 'failure-dq-bl', label: 'DQ · BL 집중', basis: 'failure_address', visualization: 'heatmap', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_event_count' },
  { id: 'failure-bank-dq', label: 'Bank · DQ 집중', basis: 'failure_address', visualization: 'heatmap', rowAxes: ['bankGroup', 'bank'], columnAxes: ['dq'], aggregation: 'fail_event_count' },
] as const

export interface AnalysisChartDatum {
  name: string
  value: number
  cellKeys: string[]
  sourceIds: string[]
  passCount?: number
  failCount?: number
  definitiveCount?: number
  failureEventCount?: number
  failureSourceCount?: number
  topFailureSignature?: string
}

export interface AnalysisChartSeries {
  name: string
  values: AnalysisChartDatum[]
}

export interface AnalysisChartModel {
  categories: string[]
  series: AnalysisChartSeries[]
}

const cellKey = (grid: PivotGrid, rowIndex: number, columnIndex: number): string =>
  `${grid.rows[rowIndex].key}-${grid.columns[columnIndex].key}`

/** Converts the traceable pivot into the small shared model used by every
 * visualization. A chart datum always keeps the same source IDs and pivot keys
 * as the cross table, so changing visualization never loses marking. */
export function analysisChartModel(grid: PivotGrid): AnalysisChartModel {
  const rowsAsCategories = grid.rows.length > 1 || grid.columns.length <= 1
  if (rowsAsCategories) {
    return {
      categories: grid.rows.map((row) => row.label),
      series: grid.columns.map((column, columnIndex) => ({
        name: column.label,
        values: grid.rows.map((row, rowIndex) => {
          const cell = grid.cells[rowIndex][columnIndex]
          return {
            name: row.label,
            value: cell.value,
            cellKeys: [cellKey(grid, rowIndex, columnIndex)],
            sourceIds: [...cell.sourceIds],
            ...(cell.breakdown ?? {}),
            ...(cell.failureAddress ? { failureEventCount: cell.failureAddress.eventCount, failureSourceCount: cell.failureAddress.sourceCount, topFailureSignature: cell.failureAddress.topSignature } : {}),
          }
        }),
      })),
    }
  }
  return {
    categories: grid.columns.map((column) => column.label),
    series: [{
      name: grid.rows[0]?.label ?? '전체',
      values: grid.columns.map((column, columnIndex) => {
        const cell = grid.cells[0][columnIndex]
        return {
          name: column.label,
          value: cell.value,
          cellKeys: [cellKey(grid, 0, columnIndex)],
          sourceIds: [...cell.sourceIds],
          ...(cell.breakdown ?? {}),
          ...(cell.failureAddress ? { failureEventCount: cell.failureAddress.eventCount, failureSourceCount: cell.failureAddress.sourceCount, topFailureSignature: cell.failureAddress.topSignature } : {}),
        }
      }),
    }],
  }
}

export function analysisHeatmapData(grid: PivotGrid): AnalysisChartDatum[] {
  return grid.rows.flatMap((row, rowIndex) => grid.columns.map((column, columnIndex) => {
    const cell = grid.cells[rowIndex][columnIndex]
    return {
      name: `${row.label} · ${column.label}`,
      value: cell.value,
      cellKeys: [cellKey(grid, rowIndex, columnIndex)],
      sourceIds: [...cell.sourceIds],
      ...(cell.breakdown ?? {}),
      ...(cell.failureAddress ? { failureEventCount: cell.failureAddress.eventCount, failureSourceCount: cell.failureAddress.sourceCount, topFailureSignature: cell.failureAddress.topSignature } : {}),
    }
  }))
}

export function visualizationSupportsAggregation(
  visualization: AnalysisVisualization,
  aggregation: PivotAggregation,
): boolean {
  if (visualization === 'stacked_bar' || visualization === 'stacked_percent' || visualization === 'combo') return aggregation === 'pass_fail'
  if (visualization === 'line') return aggregation !== 'pass_fail'
  return true
}

export function normalizedVisualization(
  value: unknown,
  aggregation: PivotAggregation,
): AnalysisVisualization {
  const known = new Set<AnalysisVisualization>(Object.keys(ANALYSIS_VISUALIZATION_LABELS) as AnalysisVisualization[])
  const visualization = typeof value === 'string' && known.has(value as AnalysisVisualization)
    ? value as AnalysisVisualization
    : 'cross_table'
  return visualizationSupportsAggregation(visualization, aggregation) ? visualization : 'cross_table'
}
