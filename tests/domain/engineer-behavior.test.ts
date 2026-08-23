import { describe, expect, it } from 'vitest'
import { buildEngineerWorkflowCandidate, classifyEngineerSearchStage, compactIncrementalSearchEvents, compactIncrementalWorkflowChecks, engineerWorkflowSimilarity } from '../../src/domain/engineer-behavior'

describe('engineer behavior workflow', () => {
  it('keeps the engineer search order and models a zero-match check as absence', () => {
    const candidate = buildEngineerWorkflowCandidate([
      { query: 'UEFI', mode: 'literal', caseSensitive: false, matchCount: 1, activeMatchCount: 1, occurredAt: '2026-08-09T01:00:00Z' },
      { query: 'TRAINING_FAIL', mode: 'literal', caseSensitive: false, matchCount: 0, activeMatchCount: 0, occurredAt: '2026-08-09T01:01:00Z' },
      { query: '@PASS', mode: 'literal', caseSensitive: true, matchCount: 1, activeMatchCount: 1, occurredAt: '2026-08-09T01:02:00Z' },
    ], 'PASS')
    expect(candidate?.stages).toEqual(['uefi', 'training', 'memory-test'])
    expect(candidate?.checks.map((item) => [item.query, item.expected, item.order])).toEqual([
      ['UEFI', 'present', 1], ['TRAINING_FAIL', 'absent', 2], ['@PASS', 'present', 3],
    ])
    expect(candidate?.suggestions).toContain('Training 안정성 확인')
  })

  it('does not treat one ordinary Ctrl-F as a learned workflow', () => {
    expect(buildEngineerWorkflowCandidate([
      { query: '@FAIL', mode: 'literal', caseSensitive: false, matchCount: 0, occurredAt: '2026-08-09T01:00:00Z' },
    ], 'PASS')).toBeNull()
  })

  it('keeps only the submitted term from legacy incremental live-search drafts', () => {
    const compacted = compactIncrementalSearchEvents([
      { query: 'A', mode: 'literal', caseSensitive: false, matchCount: 10, occurredAt: '2026-08-09T01:00:00.000Z' },
      { query: 'AB', mode: 'literal', caseSensitive: false, matchCount: 5, occurredAt: '2026-08-09T01:00:00.400Z' },
      { query: 'ABCDEF', mode: 'literal', caseSensitive: false, matchCount: 1, occurredAt: '2026-08-09T01:00:01.000Z' },
      { query: '@PASS', mode: 'literal', caseSensitive: false, matchCount: 1, occurredAt: '2026-08-09T01:00:20.000Z' },
    ])
    expect(compacted.map((item) => item.query)).toEqual(['ABCDEF', '@PASS'])
    expect(buildEngineerWorkflowCandidate(compacted, 'PASS')?.checks.map((item) => item.query)).toEqual(['ABCDEF', '@PASS'])
    expect(compactIncrementalWorkflowChecks([
      { query: 'A', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 10, stage: 'unknown', order: 1 },
      { query: 'AB', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 5, stage: 'unknown', order: 2 },
      { query: 'ABCDEF', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 1, stage: 'unknown', order: 3 },
      { query: '@PASS', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 1, stage: 'memory-test', order: 4 },
    ]).map((item) => [item.query, item.order])).toEqual([['ABCDEF', 1], ['@PASS', 2]])
  })

  it('recognizes Qualcomm-style evaluation stages and scores similar procedures', () => {
    expect(classifyEngineerSearchStage('ExitBootServices')).toBe('exit-boot')
    expect(classifyEngineerSearchStage('WATCHDOG_RESET')).toBe('reboot')
    expect(classifyEngineerSearchStage('Post-PBL ready')).toBe('post-pbl')
    expect(classifyEngineerSearchStage('LK2 enter')).toBe('lk2')
    expect(classifyEngineerSearchStage('RT-2')).toBe('unknown')
    const first = buildEngineerWorkflowCandidate([
      { query: 'stressapp start', mode: 'literal', caseSensitive: false, matchCount: 1, occurredAt: '1' },
      { query: '@PASS', mode: 'literal', caseSensitive: false, matchCount: 1, occurredAt: '2' },
    ], 'PASS')!
    const second = buildEngineerWorkflowCandidate([
      { query: 'stressapp start', mode: 'literal', caseSensitive: false, matchCount: 1, occurredAt: '1' },
      { query: '@PASS', mode: 'literal', caseSensitive: false, matchCount: 0, occurredAt: '2' },
    ], 'SYSTEM_HALT')!
    expect(engineerWorkflowSimilarity(first, second)).toBeGreaterThan(0.3)
  })
})
