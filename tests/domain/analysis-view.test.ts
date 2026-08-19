import { describe, expect, it } from 'vitest'
import { analysisChartModel, analysisHeatmapData, normalizedVisualization } from '../../src/domain/analysis-view'
import { buildPivotGrid, type LogResultRecord } from '../../src/state/logRecords'

const row = (id: string, sample: string, temperature: string, result: LogResultRecord['result']): LogResultRecord => ({
  id, fileName: `${id}.log`, folder: 'evaluation-a', relativePath: `${id}.log`,
  sample: { value: sample, state: 'approved' }, temperature: { value: temperature, state: 'approved' },
  mode: { value: 'VPERI', state: 'approved' }, grid: { value: 'G1', state: 'approved' },
  result, resultSource: 'engineer', stageResults: [], review: 'confirmed', evidenceCount: 1, selectedEvidenceCount: 1,
})

describe('shared analysis canvas model', () => {
  const rows = [row('a', 'S1', '25', 'PASS'), row('b', 'S1', '85', 'TEST_FAIL'), row('c', 'S2', '85', 'PASS')]
  const grid = buildPivotGrid(rows, { rows: ['sample'], columns: ['temperature'], aggregation: 'pass_fail', filters: { query: '', result: 'all', review: 'all' } })

  it('keeps the exact pivot cell and source identity when the renderer changes', () => {
    const model = analysisChartModel(grid)
    const heatmap = analysisHeatmapData(grid)
    expect(model.categories).toEqual(['S1', 'S2'])
    expect(model.series.map((series) => series.name)).toEqual(['25', '85'])
    expect(model.series[1].values[0]).toMatchObject({ name: 'S1', passCount: 0, failCount: 1, sourceIds: ['b'] })
    expect(heatmap.find((cell) => cell.sourceIds.includes('b'))?.cellKeys).toEqual(model.series[1].values[0].cellKeys)
  })

  it('falls back safely when a saved visualization is unknown or incompatible', () => {
    expect(normalizedVisualization('heatmap', 'fail_count')).toBe('heatmap')
    expect(normalizedVisualization('stacked_bar', 'fail_rate')).toBe('cross_table')
    expect(normalizedVisualization('invented-chart', 'count')).toBe('cross_table')
  })
})
