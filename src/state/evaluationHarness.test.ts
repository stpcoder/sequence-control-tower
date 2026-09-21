import { describe, expect, it } from 'vitest'
import type { EngineerWorkflowMemoryView, ProjectExportPreset } from '../../electron/shared/contracts'
import {
  evaluationHarnessesFromPreset,
  evaluationHarnessForScope,
  evaluationHarnessPreset,
  evaluationHarnessWithColumns,
  evaluationHarnessWithLayout,
  harnessFromEngineerWorkflow,
  upsertEvaluationHarness,
} from './evaluationHarness'

const memory: EngineerWorkflowMemoryView = {
  id: 'memory-1', projectId: 'project-1', name: '고온 Margin 판정', purpose: '고온 Margin 판정', evaluationScopeId: 'scope-hot',
  stages: ['memory-test'],
  checks: [
    { query: '@FAIL', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 3, stage: 'memory-test', order: 1 },
    { query: 'BK=', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 3, stage: 'memory-test', order: 2 },
  ],
  result: 'TEST_FAIL', sourceIds: ['source-1'], evidenceLines: [10, 11], dimensions: { temperatureC: 85, testMode: 'MARGIN-A' },
  confirmedCount: 2, appliedCount: 7, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
}

describe('evaluation harness', () => {
  it('converts engineer behavior into an executable context, checks, judgment, and output contract', () => {
    const harness = harnessFromEngineerWorkflow(memory)
    expect(harness.id).toBe('scope:scope-hot')
    expect(harness.rules).toHaveLength(1)
    expect(harness.rules[0].when.dimensions).toMatchObject({ temperatureC: 85, testMode: 'MARGIN-A' })
    expect(harness.rules[0].look.map((item) => item.query)).toEqual(['@FAIL', 'BK='])
    expect(harness.rules[0].judge).toEqual({ result: 'TEST_FAIL', policy: 'ordered-all', exception: 'send-to-review' })
    expect(harness.output.columns).toContain('filename')
  })

  it('keeps multiple result rules inside one folder harness', () => {
    const first = harnessFromEngineerWorkflow(memory)
    const passMemory: EngineerWorkflowMemoryView = {
      ...memory,
      id: 'memory-pass', name: 'Hdiag Pass', purpose: 'Hdiag Pass', result: 'PASS',
      checks: [{ query: '@PASS', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 1, stage: 'memory-test', order: 1 }],
    }
    const combined = harnessFromEngineerWorkflow(passMemory, first)
    expect(combined.rules.map((rule) => rule.judge.result).sort()).toEqual(['PASS', 'TEST_FAIL'])
    expect(evaluationHarnessForScope(upsertEvaluationHarness([first], combined), 'scope-hot')?.rules).toHaveLength(2)
  })

  it('round trips a collection and applies evaluation-specific display and export contracts', () => {
    const base = harnessFromEngineerWorkflow(memory)
    const configured = evaluationHarnessWithColumns(evaluationHarnessWithLayout(base, {
      rowAxes: ['bank'], columnAxes: ['temperature'], aggregation: 'fail_rate', visualization: 'heatmap', dataBasis: 'evaluation',
      resultFilter: 'all', folderFilter: 'all', failOnly: true, unknownMetadataOnly: false,
    }, '2026-08-03T00:00:00.000Z'), ['filename', 'result', 'bank'], '2026-08-03T00:00:00.000Z')
    const preset = evaluationHarnessPreset(upsertEvaluationHarness([], configured)) as ProjectExportPreset
    const restored = evaluationHarnessesFromPreset(preset)
    expect(evaluationHarnessForScope(restored, 'scope-hot')?.output.layout).toMatchObject({ rowAxes: ['bank'], visualization: 'heatmap', failOnly: true })
    expect(evaluationHarnessForScope(restored, 'different-evaluation')).toBeUndefined()
    expect(evaluationHarnessForScope(restored)).toBeUndefined()
    expect(restored[0].output.columns).toEqual(['filename', 'result', 'bank'])
  })
})
