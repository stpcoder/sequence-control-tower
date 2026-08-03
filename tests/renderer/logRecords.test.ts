import { describe, expect, it } from 'vitest'
import {
  filterLogRecords,
  patternMatrix,
  projectLogRecords,
  serializeLogRecordsTsv,
  sortLogRecords,
} from '../../src/state/logRecords'
import type { WorkbenchFile } from '../../src/views/WorkbenchView'

const files: WorkbenchFile[] = [
  {
    id: 'pass',
    name: 'LOT12_S01_85C_DIAG.log',
    origin: 'customer-a / 85C',
    relativePath: 'LOT12/SAMPLE_01/LOT12_S01_85C_DIAG.log',
    text: 'mode: DIAG inserted\n@PASS DIAG_COMPLETE\nnormal_end: true',
    decision: 'PASS',
  },
  {
    id: 'halt',
    name: 'LOT12_S03_85C_DIAG.log',
    origin: 'customer-a / 85C',
    relativePath: 'LOT12/SAMPLE_03/LOT12_S03_85C_DIAG.log',
    text: 'stressapp: start\nhidag: start\nwatchdog: heartbeat delayed\npmic: timeout',
  },
  {
    id: 'training',
    name: 'LOT12_S07_105C_DIAG.log',
    origin: 'customer-a / 105C',
    text: 'hidag: start\ntraining: lane1 timeout\nTRAINING_FAIL lane=1\n@FAIL',
  },
]

describe('renderer log result projection', () => {
  it('keeps one source log per row and marks filename metadata as unconfirmed candidates', () => {
    const rows = projectLogRecords(files)

    expect(rows).toHaveLength(files.length)
    expect(rows[0]).toMatchObject({
      id: 'pass',
      sample: { value: '01', state: 'candidate' },
      temperature: { value: '85', state: 'candidate' },
      mode: { value: 'DIAG', state: 'candidate' },
      result: 'PASS',
      resultSource: 'engineer',
      review: 'confirmed',
    })
  })

  it('keeps local result inference as a reviewable candidate', () => {
    const byId = new Map(projectLogRecords(files).map((row) => [row.id, row]))

    expect(byId.get('halt')).toMatchObject({ result: 'SYSTEM_HALT', resultSource: 'candidate', review: 'needs_review' })
    expect(byId.get('training')).toMatchObject({ result: 'TRAINING_FAIL', resultSource: 'candidate', review: 'needs_review' })
  })

  it('fails visibly for malformed filenames instead of inventing metadata', () => {
    const [row] = projectLogRecords([{ id: 'bad', name: 'broken.txt', text: '@PASS' }])

    expect(row.sample).toEqual({ value: null, state: 'malformed' })
    expect(row.temperature).toEqual({ value: null, state: 'malformed' })
    expect(row.mode).toEqual({ value: null, state: 'malformed' })
    expect(row.review).toBe('needs_review')
  })

  it('applies search, status, and review filters cumulatively and sorts without mutating input', () => {
    const rows = projectLogRecords(files)
    const filtered = filterLogRecords(rows, { query: '85c', result: 'SYSTEM_HALT', review: 'needs_review' })
    const sorted = sortLogRecords(rows, 'temperature', 'desc')

    expect(filtered.map((row) => row.id)).toEqual(['halt'])
    expect(sorted.map((row) => row.temperature.value)).toEqual(['105', '85', '85'])
    expect(rows.map((row) => row.id)).toEqual(['pass', 'halt', 'training'])
  })

  it('builds a condition-by-result pivot from the same rows', () => {
    const matrix = patternMatrix(projectLogRecords(files), 'temperature')

    expect(matrix).toEqual([
      { value: '85', total: 2, counts: { PASS: 1, SYSTEM_HALT: 1 } },
      { value: '105', total: 1, counts: { TRAINING_FAIL: 1 } },
    ])
  })

  it('exports safe spreadsheet text and preserves the visible row count', () => {
    const rows = projectLogRecords([{ ...files[0], id: 'formula', name: '=cmd.log' }])
    const tsv = serializeLogRecordsTsv(rows)

    expect(tsv.split('\r\n')).toHaveLength(2)
    expect(tsv).toContain("'=cmd.log")
  })
})
