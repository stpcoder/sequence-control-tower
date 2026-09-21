import { describe, expect, it } from 'vitest'
import { aggregateRecordTrends, evaluationScopeOptions, inferResultCandidate, projectLogRecords, recordsInEvaluationScope, resolveEvaluationScopeId, type LogResultRecord } from '../../src/state/logRecords'

function record(id: string, testMode: string, result: LogResultRecord['result']): LogResultRecord {
  return {
    id,
    evaluationScopeId: 'logs',
    fileName: `${id}.log`,
    folder: 'logs',
    relativePath: `${id}.log`,
    sample: { value: 'S1', state: 'candidate' },
    temperature: { value: '25', state: 'candidate' },
    vdd: { value: '1.0', state: 'candidate' },
    grid: { value: 'G1', state: 'candidate' },
    dimensions: { testMode },
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

  it('keeps Training Fail authoritative when recovery also emits reboot and FAIL markers', () => {
    expect(inferResultCandidate({
      id: 'training-recovery',
      name: 'training-recovery.log',
      text: 'TRAINING_FAIL\nWATCHDOG_RESET\nTERMINAL_RESULT=SYSTEM_REBOOT\n@FAIL',
    })).toMatchObject({ result: 'TRAINING_FAIL' })
  })
})

describe('evaluation folder boundary', () => {
  it('uses rootId rather than a visible folder label and never mixes the default scope', () => {
    const rows = projectLogRecords([
      { id: 'a', rootId: 'root-a', origin: 'logs', name: 'a.log', text: '@PASS' },
      { id: 'b', rootId: 'root-b', origin: 'logs', name: 'b.log', text: '@FAIL' },
    ])
    expect(rows.map((row) => row.evaluationScopeId)).toEqual(['root-a', 'root-b'])
    expect(evaluationScopeOptions(rows)).toHaveLength(2)
    expect(recordsInEvaluationScope(rows, 'root-a').map((row) => row.id)).toEqual(['a'])
  })

  it('uses the project evaluation folder id when the artifact root id differs', () => {
    const rows = projectLogRecords(
      [{ id: 'a', rootId: 'artifact-root-a', origin: 'folder-a', name: 'a.log', text: '@PASS' }],
      {}, {}, {}, {}, { a: 'project-root-a' },
    )

    expect(rows[0].evaluationScopeId).toBe('project-root-a')
    expect(recordsInEvaluationScope(rows, 'project-root-a').map((row) => row.id)).toEqual(['a'])
  })

  it('lets the current workbench folder replace a stale page-local folder selection', () => {
    const rows = [
      { ...record('a', 'DIAG', 'PASS'), evaluationScopeId: 'root-a', folder: 'folder-a' },
      { ...record('b', 'DIAG', 'PASS'), evaluationScopeId: 'root-b', folder: 'folder-b' },
    ]
    expect(resolveEvaluationScopeId(rows, 'root-b', 'root-a')).toBe('root-a')
    expect(recordsInEvaluationScope(rows, resolveEvaluationScopeId(rows, 'root-b', 'root-a')).map((row) => row.id)).toEqual(['a'])
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
      dimension: 'testMode', value: 'DIAG', outcome: 'fail', count: 4, total: 5, percentage: 0.8,
    }))
  })

  it('responds to the current filtered scope', () => {
    const rows = [
      record('1', 'DIAG', 'DIAG_FAIL'), record('2', 'DIAG', 'DIAG_FAIL'), record('3', 'DIAG', 'DIAG_FAIL'),
      record('4', 'DIAG', 'DIAG_FAIL'), record('5', 'DIAG', 'PASS'),
      record('6', 'TEST', 'PASS'), record('7', 'TEST', 'PASS'), record('8', 'TEST', 'PASS'),
      record('9', 'TEST', 'PASS'), record('10', 'TEST', 'PASS'),
    ]
    const filtered = rows.filter((row) => row.dimensions?.testMode === 'DIAG')
    expect(aggregateRecordTrends(filtered)).toEqual({ total: 5, trends: [] })
  })
})
