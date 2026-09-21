import { describe, expect, it } from 'vitest'
import { buildEvaluationResultSection, createEvaluationReportDraft, normalizeEvaluationReportOutcome } from '../../src/domain/evaluation-report'

describe('evaluation report', () => {
  it('normalizes engineering result aliases without guessing unknown states', () => {
    expect(normalizeEvaluationReportOutcome('Hdiag Fail')).toBe('DIAG_FAIL')
    expect(normalizeEvaluationReportOutcome('system reboot')).toBe('SYSTEM_REBOOT')
    expect(normalizeEvaluationReportOutcome('training fail')).toBe('TRAINING_FAIL')
    expect(normalizeEvaluationReportOutcome('not decided')).toBe('UNKNOWN')
  })

  it('computes the exact full-folder result section independently from Agent prose', () => {
    const result = buildEvaluationResultSection([
      { id: 'p1', result: 'PASS' },
      { id: 'p2', result: 'PASS' },
      { id: 'f1', result: 'DIAG_FAIL' },
      { id: 'u1' },
      { id: 'x1', result: 'EXCLUDED' },
    ])
    expect(result).toMatchObject({
      total: 5, definitive: 3, unknown: 1, excluded: 1, coverage: 'partial', state: 'computed',
      byOutcome: { PASS: 2, DIAG_FAIL: 1, UNKNOWN: 1, EXCLUDED: 1 },
    })
    expect(result.summary).toBe('PASS 2개 · DIAG_FAIL 1개 · UNKNOWN 1개 · EXCLUDED 1개')
  })

  it('creates one versioned five-part report per evaluation folder', () => {
    const report = createEvaluationReportDraft({
      title: 'Cold VDD 평가', purpose: 'characterization', purposeText: 'Cold와 LVDD 경향 확인',
      interpretation: 'Cold LVDD에서만 FAIL이 확인되었습니다.',
      sources: [{ id: 'a', result: 'PASS' }, { id: 'b', result: 'TEST_FAIL' }],
      changedConditions: ['온도', 'VDD'], fixedConditions: ['Sample', 'Sequence'], createdAt: '2026-08-30T00:00:00.000Z',
    })
    expect(report.schemaVersion).toBe(1)
    expect(report.purpose).toMatchObject({ text: 'Cold와 LVDD 경향 확인', category: 'characterization', state: 'agent-proposed' })
    expect(report.results).toMatchObject({ total: 2, byOutcome: { PASS: 1, TEST_FAIL: 1 }, state: 'computed' })
    expect(report.interpretation.text).toContain('Cold LVDD')
    expect(report.trends).toBeDefined()
    expect(report.nextPlan).toBeDefined()
  })
})
