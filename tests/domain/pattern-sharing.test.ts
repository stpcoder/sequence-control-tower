import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPivotGrid,
  projectLogRecords,
  serializeLogRecordsCsv,
  serializePivotGridCsv,
} from '../../src/state/logRecords'
import {
  analysisExportColumns,
  nextPivotMarking,
  pivotColumnHeaderRows,
  pivotRowHeaderSpan,
} from '../../src/views/PatternsView'

const corpus = resolve(process.cwd(), 'tests/fixtures/long-soc')

describe('long SoC result sharing', () => {
  it('supports Spotfire-style replace and additive cell marking', () => {
    expect([...nextPivotMarking(new Set(['a']), 'b', false)]).toEqual(['b'])
    expect([...nextPivotMarking(new Set(['a']), 'b', true)]).toEqual(['a', 'b'])
    expect([...nextPivotMarking(new Set(['a', 'b']), 'a', true)]).toEqual(['b'])
    expect(nextPivotMarking(new Set(['a']), 'a', false).size).toBe(0)
  })

  it('turns long logs into a three-level DRAM cross table and tidy Spotfire rows', async () => {
    const names = (await readdir(corpus)).filter((name) => name.endsWith('.log')).sort()
    const files = await Promise.all(names.map(async (name) => ({ id: name, name, text: await readFile(resolve(corpus, name), 'utf8') })))
    const records = projectLogRecords(files)
    const rowAxes = ['frequencyMHz', 'vdd', 'pattern'] as const
    const columnAxes = ['channel', 'subChannel', 'dq'] as const
    const grid = buildPivotGrid(records, {
      rows: rowAxes,
      columns: columnAxes,
      aggregation: 'fail_rate',
      filters: { query: '', result: 'all', review: 'all' },
    })

    expect(records).toHaveLength(6)
    expect(grid.total).toBe(66.7)
    expect(grid.rows.every((row) => row.values.length === 3)).toBe(true)
    expect(grid.columns.every((column) => column.values.length === 3)).toBe(true)
    expect(pivotColumnHeaderRows(grid.columns, 3)).toHaveLength(3)
    expect(pivotRowHeaderSpan(grid.rows, 0, 0)).toBeGreaterThan(0)

    const columns = analysisExportColumns(records, [...rowAxes, ...columnAxes])
    expect(columns).toEqual(expect.arrayContaining([
      'filename', 'folder', 'frequency_mhz', 'vdd', 'pattern', 'channel', 'sub_channel', 'dq', 'result', 'stage_results',
    ]))
    expect(columns).toContain('grid_value')
    expect(serializeLogRecordsCsv(records, columns).split('\r\n')).toHaveLength(7)
    expect(serializePivotGridCsv(grid, ['주파수 (MHz)', 'VDD (V)', 'Pattern'])).toContain('"주파수 (MHz)","VDD (V)","Pattern"')
  })
})
