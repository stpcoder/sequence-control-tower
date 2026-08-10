import { describe, expect, it } from 'vitest'
import { aggregateRecordTrends, projectLogRecords, type LogResultRecord } from '../../src/state/logRecords'

function record(id: string, mode: string, result: LogResultRecord['result']): LogResultRecord {
  return {
    id,
    fileName: `${id}.log`,
    folder: 'logs',
    relativePath: `${id}.log`,
    sample: { value: 'S1', state: 'candidate' },
    temperature: { value: '25', state: 'candidate' },
    mode: { value: mode, state: 'candidate' },
    grid: { value: 'G1', state: 'candidate' },
    result,
    resultSource: 'engineer',
    stageResults: [],
    review: 'confirmed',
    evidenceCount: 0,
    selectedEvidenceCount: 0,
  }
}

describe('log records metadata fallback', () => {
  it('keeps grid missing when only sample appears in content', () => {
    const [record] = projectLogRecords([{
      id: 'sample-only',
      name: 'capture.log',
      relativePath: 'capture.log',
      text: 'sample: SMP-001\nresult: PASS',
    }])

    expect(record.sample).toEqual({ value: 'SMP-001', state: 'candidate' })
    expect(record.grid).toEqual({ value: null, state: 'missing' })
  })
})

describe('deterministic aggregate trends', () => {
  it('returns no trend for no data or weak samples', () => {
    expect(aggregateRecordTrends([])).toEqual({ total: 0, trends: [] })
    expect(aggregateRecordTrends([record('1', 'DIAG', 'DIAG_FAIL')])).toEqual({ total: 1, trends: [] })
  })

  it('reports a clear fail concentration with count and percentage', () => {
    const rows = [
      record('1', 'DIAG', 'DIAG_FAIL'),
      record('2', 'DIAG', 'TEST_FAIL'),
      record('3', 'DIAG', 'DIAG_FAIL'),
      record('4', 'DIAG', 'PASS'),
      record('5', 'DIAG', 'DIAG_FAIL'),
      record('6', 'TEST', 'PASS'),
      record('7', 'TEST', 'PASS'),
      record('8', 'TEST', 'PASS'),
      record('9', 'TEST', 'PASS'),
      record('10', 'TEST', 'PASS'),
    ]
    expect(aggregateRecordTrends(rows).trends).toContainEqual(expect.objectContaining({
      dimension: 'mode', value: 'DIAG', outcome: 'fail', count: 4, total: 5, percentage: 0.8,
    }))
  })

  it('responds to the current filtered scope', () => {
    const rows = [
      record('1', 'DIAG', 'DIAG_FAIL'), record('2', 'DIAG', 'DIAG_FAIL'), record('3', 'DIAG', 'DIAG_FAIL'),
      record('4', 'DIAG', 'DIAG_FAIL'), record('5', 'DIAG', 'PASS'),
      record('6', 'TEST', 'PASS'), record('7', 'TEST', 'PASS'), record('8', 'TEST', 'PASS'),
      record('9', 'TEST', 'PASS'), record('10', 'TEST', 'PASS'),
    ]
    const filtered = rows.filter((row) => row.mode.value === 'DIAG')
    expect(aggregateRecordTrends(filtered)).toEqual({ total: 5, trends: [] })
  })
})
