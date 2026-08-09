import { describe, expect, it, vi } from 'vitest'
import type { EngineerWorkflowMemoryView } from '../shared/contracts'
import { extractLpddrFilenameDimensions, LpddrAgentToolService } from './lpddr-agent-tools'

const project = {
  id: 'p', name: 'LPDDR6 Xiaomi', artifacts: [
    { sourceId: 's1', artifactId: 'a'.repeat(64), rootId: 'r', relativePath: 'LPDDR6_SKU-X6_LOT-A1_MAT-WAF12_SMP-01_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_FAIL.log' },
    { sourceId: 's2', artifactId: 'b'.repeat(64), rootId: 'r', relativePath: 'LPDDR6_SKU-X6_LOT-B4_MAT-WAF27_SMP-11_T-20_VDD1p275_F8533_TM-BOOT_PAT-TRAIN_DQ20_BL32_CH1.log' }
  ], failureHypotheses: [], evaluationNodes: [], evidenceRecords: [], lpddrDevelopmentContext: {}, folders: [], equipmentProfiles: [], templatePins: [], exportPresets: [], revision: 0, archived: false, createdAt: '', updatedAt: '', schemaVersion: 2 as const
}

describe('LPDDR agent tools', () => {
  it('extracts LPDDR conditions without swallowing adjacent tokens', () => {
    expect(extractLpddrFilenameDimensions(project.artifacts[0].relativePath)).toMatchObject({
      sku: 'X6', lot: 'A1', material: 'WAF12', sample: '01', temperatureC: 85,
      vdd: 1.295, frequencyMHz: 9600, testMode: 'VPERI', pattern: 'WR', dq: '9', bl: '16', channel: '0'
    })
    expect(extractLpddrFilenameDimensions(project.artifacts[1].relativePath).temperatureC).toBe(-20)
  })

  it('classifies marker precedence locally and returns the denominator', async () => {
    const inspectEvidence = vi.fn(async () => ({ sources: [
      { sourceId: 's1', artifactId: project.artifacts[0].artifactId, fileName: 'fail.log', evidence: [
        { specId: 'at-pass', occurrenceCount: 1 }, { specId: 'at-fail', occurrenceCount: 1 },
        { specId: 'fast-fail', occurrenceCount: 1 }, { specId: 'training-fail', occurrenceCount: 0 },
        { specId: 'reboot', occurrenceCount: 0 }, { specId: 'halt', occurrenceCount: 0 },
        { specId: 'stress-pass', occurrenceCount: 1 }, { specId: 'diag-start', occurrenceCount: 1 }, { specId: 'normal-end', occurrenceCount: 1 }
      ] },
      { sourceId: 's2', artifactId: project.artifacts[1].artifactId, fileName: 'halt.log', evidence: [
        { specId: 'at-pass', occurrenceCount: 0 }, { specId: 'at-fail', occurrenceCount: 0 },
        { specId: 'fast-fail', occurrenceCount: 0 }, { specId: 'training-fail', occurrenceCount: 0 },
        { specId: 'reboot', occurrenceCount: 0 }, { specId: 'halt', occurrenceCount: 0 },
        { specId: 'stress-pass', occurrenceCount: 1 }, { specId: 'diag-start', occurrenceCount: 1 }, { specId: 'normal-end', occurrenceCount: 0 }
      ] }
    ] }))
    const tools = new LpddrAgentToolService({
      artifacts: { inspectEvidence, list: vi.fn(), search: vi.fn(), lineWindow: vi.fn() } as never,
      projects: { get: vi.fn(async () => project), list: vi.fn(async () => [project]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []) }
    })
    const result = await tools.execute('p', { name: 'pass_fail_scan' })
    expect(result.summary).toContain('FAST_FAIL 1')
    expect(result.summary).toContain('SYSTEM_HALT 1')
    expect(inspectEvidence).toHaveBeenCalledTimes(1)
  })

  it('computes condition failure rates from definitive live-log denominators', async () => {
    const third = {
      sourceId: 's3', artifactId: 'c'.repeat(64), rootId: 'r',
      relativePath: 'LPDDR6_SKU-X6_LOT-A2_MAT-WAF12_SMP-02_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_PASS.log'
    }
    const trendProject = { ...project, artifacts: [...project.artifacts, third] }
    const evidence = (sourceId: string, status: 'pass' | 'fail') => ({
      sourceId,
      artifactId: trendProject.artifacts.find((item) => item.sourceId === sourceId)!.artifactId,
      fileName: `${sourceId}.log`,
      evidence: [
        { specId: 'at-pass', occurrenceCount: status === 'pass' ? 1 : 0 },
        { specId: 'at-fail', occurrenceCount: status === 'fail' ? 1 : 0 },
        { specId: 'fast-fail', occurrenceCount: 0 }, { specId: 'training-fail', occurrenceCount: 0 },
        { specId: 'reboot', occurrenceCount: 0 }, { specId: 'halt', occurrenceCount: 0 },
        { specId: 'stress-pass', occurrenceCount: 0 }, { specId: 'diag-start', occurrenceCount: 0 },
        { specId: 'normal-end', occurrenceCount: 1 }
      ]
    })
    const tools = new LpddrAgentToolService({
      artifacts: {
        inspectEvidence: vi.fn(async () => ({ sources: [evidence('s1', 'fail'), evidence('s2', 'pass'), evidence('s3', 'pass')] })),
        list: vi.fn(), search: vi.fn(), lineWindow: vi.fn()
      } as never,
      projects: { get: vi.fn(async () => trendProject), list: vi.fn(async () => [trendProject]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []) }
    })
    const result = await tools.execute('p', { name: 'failure_trends_get' })
    const data = result.data as { denominator: number; live: Array<{ dimension: string; value: string; failures: number; total: number; failureRate: number }> }
    expect(data.denominator).toBe(3)
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: 'temperatureC', value: '85', failures: 1, total: 2, failureRate: 0.5 }))
    expect(result.summary).toContain('1/2 fail (50.0%)')
  })

  it('applies a confirmed engineer procedure with absence and marker order locally', async () => {
    const inspectEvidence = vi.fn(async (input: { sources: Array<{ sourceId: string; artifactId: string }>; specs: Array<{ id: string; query: string }> }) => ({
      sources: input.sources.map((source) => ({
        ...source, fileName: 'run.log', evidence: input.specs.map((spec) => ({
          specId: spec.id,
          occurrenceCount: spec.query === 'TRAINING_FAIL' ? 0 : 1,
          ...(spec.query === 'UEFI' ? { firstOccurrence: { lineNumber: 10, columnStart: 1, columnEnd: 4, target: 'content', excerpt: 'UEFI', excerptTruncated: false } }
            : spec.query === '@PASS' ? { firstOccurrence: { lineNumber: 90, columnStart: 1, columnEnd: 5, target: 'content', excerpt: '@PASS', excerptTruncated: false } } : {}),
        })),
      })),
    }))
    const workflow: EngineerWorkflowMemoryView = {
      id: 'w1', projectId: 'p', name: '부팅 후 검사', purpose: '부팅 후 검사',
      stages: ['uefi', 'training', 'memory-test'],
      checks: [
        { query: 'UEFI', mode: 'literal' as const, caseSensitive: false, expected: 'present' as const, matchCount: 1, stage: 'uefi' as const, order: 1 },
        { query: 'TRAINING_FAIL', mode: 'literal' as const, caseSensitive: false, expected: 'absent' as const, matchCount: 0, stage: 'training' as const, order: 2 },
        { query: '@PASS', mode: 'literal' as const, caseSensitive: false, expected: 'present' as const, matchCount: 1, stage: 'memory-test' as const, order: 3 },
      ],
      result: 'PASS' as const, sourceIds: ['s1'], evidenceLines: [], dimensions: { temperatureC: 85 },
      confirmedCount: 1, appliedCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-02',
    }
    const tools = new LpddrAgentToolService({
      artifacts: { inspectEvidence, list: vi.fn(), search: vi.fn(), lineWindow: vi.fn() } as never,
      projects: { get: vi.fn(async () => project), list: vi.fn(async () => [project]) } as never,
      agentStore: {
        searchHistory: vi.fn(async () => []), conversationHistory: vi.fn(async () => []),
        workflowMemories: vi.fn(async () => [workflow]),
      },
    })
    const result = await tools.execute('p', { name: 'engineer_workflow_apply' }, ['s1'])
    const rows = (result.data as { rows: Array<{ matched: boolean; orderMet: boolean; candidateResult: string }> }).rows
    expect(rows).toEqual([expect.objectContaining({ matched: true, orderMet: true, candidateResult: 'PASS' })])
    expect(result.summary).toContain('1개 중 1개')
  })
})
