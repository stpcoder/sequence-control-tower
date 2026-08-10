import { describe, expect, it, vi } from 'vitest'
import type { EngineerWorkflowMemoryView } from '../shared/contracts'
import { extractLpddrFilenameDimensions, LpddrAgentToolService, sourceEngineeringContext } from './lpddr-agent-tools'

const project = {
  id: 'p', name: 'LPDDR6 Xiaomi', artifacts: [
    { sourceId: 's1', artifactId: 'a'.repeat(64), rootId: 'r', relativePath: 'LPDDR6_SKEW-SS_TSKEW-12PS_LOT-A1_MAT-WAF12_SMP-01_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_SCH1_RK0_BG2_BANK5_ROW0x2A_COL0x14_FAIL.log' },
    { sourceId: 's2', artifactId: 'b'.repeat(64), rootId: 'r', relativePath: 'LPDDR6_SKEW-FF_LOT-B4_MAT-WAF27_SMP-11_T-20_VDD1p275_F8533_TM-BOOT_PAT-TRAIN_DQ20_BL32_CH1.log' }
  ], failureHypotheses: [], evaluationNodes: [], evidenceRecords: [], lpddrDevelopmentContext: {}, folders: [], equipmentProfiles: [], templatePins: [], exportPresets: [], revision: 0, archived: false, createdAt: '', updatedAt: '', schemaVersion: 2 as const
}

describe('LPDDR agent tools', () => {
  it('shows only known saved result/pivot layout fields to the Agent', async () => {
    const contextProject = { ...project, exportPresets: [
      { id: 'sequence-control-tower.results-export.v1', name: '결과 열', format: 'csv' as const, options: { columns: ['filename', 'result'], secret: 'do-not-send' }, createdAt: '', updatedAt: '' },
      { id: 'sequence-control-tower.patterns-layout.v1', name: '결과 축', format: 'json' as const, options: { rowAxes: ['sample'], columnAxes: ['temperature'], aggregation: 'count', secret: 'do-not-send' }, createdAt: '', updatedAt: '' },
    ] }
    const tools = new LpddrAgentToolService({
      artifacts: { inspectEvidence: vi.fn(), list: vi.fn(), search: vi.fn(), lineWindow: vi.fn() } as never,
      projects: { get: vi.fn(async () => contextProject), list: vi.fn(async () => [contextProject]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []) },
    })
    const result = await tools.execute('p', { name: 'project_context_get' })
    expect(result.data).toMatchObject({ savedLayouts: [
      { columns: ['filename', 'result'] },
      { rowAxes: ['sample'], columnAxes: ['temperature'], aggregation: 'count' },
    ] })
    expect(JSON.stringify(result.data)).not.toContain('do-not-send')
  })

  it('returns history only from the selected evaluation folder', async () => {
    const scopedProject = {
      ...project,
      artifacts: [project.artifacts[0], { ...project.artifacts[1], rootId: 'other-folder' }],
      failureHypotheses: [
        { id: 'h1', projectId: 'p', title: 'folder A', origin: 'engineer-confirmed' as const, evaluationNodeIds: ['n1'] },
        { id: 'h2', projectId: 'p', title: 'folder B', origin: 'engineer-confirmed' as const, evaluationNodeIds: ['n2'] },
      ],
      evaluationNodes: [
        { id: 'n1', projectId: 'p', hypothesisId: 'h1', name: 'A 평가', status: 'fail' as const, dimensions: {} },
        { id: 'n2', projectId: 'p', hypothesisId: 'h2', name: 'B 평가', status: 'pass' as const, dimensions: {} },
      ],
      evidenceRecords: [
        { id: 'e1', projectId: 'p', evaluationNodeId: 'n1', status: 'fail' as const, sourceIds: ['s1'] },
        { id: 'e2', projectId: 'p', evaluationNodeId: 'n2', status: 'pass' as const, sourceIds: ['s2'] },
      ],
    }
    const tools = new LpddrAgentToolService({
      artifacts: { inspectEvidence: vi.fn(), list: vi.fn(), search: vi.fn(), lineWindow: vi.fn() } as never,
      projects: { get: vi.fn(async () => scopedProject), list: vi.fn(async () => [scopedProject]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []) },
    })
    const result = await tools.execute('p', { name: 'project_history_get' }, ['s1'])
    expect(result.data).toMatchObject({ hypotheses: [{ id: 'h1' }], nodes: [{ id: 'n1' }], evidence: [{ id: 'e1' }] })
    expect(JSON.stringify(result.data)).not.toContain('folder B')
  })

  it('extracts LPDDR conditions without swallowing adjacent tokens', () => {
    expect(extractLpddrFilenameDimensions(project.artifacts[0].relativePath)).toMatchObject({
      skew: 'SS', timingSkewPs: 12, lot: 'A1', material: 'WAF12', sample: '01', temperatureC: 85,
      vdd: 1.295, frequencyMHz: 9600, testMode: 'VPERI', pattern: 'WR', dq: '9', bl: '16', channel: '0', subChannel: '1', rank: '0', bankGroup: '2', bank: '5', row: '0x2A', column: '0x14'
    })
    expect(extractLpddrFilenameDimensions(project.artifacts[1].relativePath).temperatureC).toBe(-20)
    expect(extractLpddrFilenameDimensions('LPDDR6_SM-8975_SKEW-SS_DIE03_SMP-01.log')).toMatchObject({
      socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', die: '03', sample: '01',
    })
    expect(sourceEngineeringContext('MTK-24D_SMP-01_RT2.log', { fingerprint: { structuralHash: 'same', commandCount: 1, commandSignatures: ['voltage-control:set_rail'] } } as never)).toMatchObject({
      sequenceSignature: 'seq:same', explicitRetest: true, filenameAttemptNo: 2, commandSignatures: ['voltage-control:set_rail'],
    })
    expect(extractLpddrFilenameDimensions('CUSTOM_BOARD_A_SMP-01.log', [{ alias: 'Board A', profileId: 'mediatek-default', vendor: 'mediatek', socModels: ['MTK-5D'], filenameAliases: ['CUSTOM_BOARD_A'], updatedAt: '' }])).toMatchObject({ socVendor: 'mediatek', socModel: 'MTK-5D', bootProfileId: 'mediatek-default' })
  })

  it('applies the MediaTek boot profile instead of UEFI stages', async () => {
    const mtkProject = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'LPDDR6_MTK-24D_SKEW-SS_DIE03_SMP-01.log' }] }
    const inspectEvidence = vi.fn(async (input: { specs: Array<{ id: string }> }) => ({ sources: [{
      sourceId: 's1', artifactId: project.artifacts[0].artifactId, fileName: 'mtk.log',
      evidence: input.specs.map((spec) => ({ specId: spec.id, occurrenceCount: /post-pbl|\-lk$|\-os$/.test(spec.id) ? 1 : 0, firstOccurrence: { lineNumber: spec.id.includes('post-pbl') ? 5 : spec.id.endsWith('-lk') ? 10 : 20 } })),
    }] }))
    const tools = new LpddrAgentToolService({
      artifacts: { inspectEvidence, list: vi.fn(async () => []), search: vi.fn(), lineWindow: vi.fn() } as never,
      projects: { get: vi.fn(async () => mtkProject), list: vi.fn(async () => [mtkProject]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []) },
    })
    const result = await tools.execute('p', { name: 'soc_boot_profile_scan' })
    const rows = (result.data as { rows: Array<{ bootProfileId: string; stages: Array<{ stage: string }> }> }).rows
    expect(rows[0].bootProfileId).toBe('mediatek-default')
    expect(rows[0].stages.map((item) => item.stage)).toEqual(expect.arrayContaining(['post-pbl', 'lk', 'os']))
    expect(rows[0].stages.map((item) => item.stage)).not.toContain('uefi')
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
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []) }
    })
    const result = await tools.execute('p', { name: 'pass_fail_scan' })
    expect(result.summary).toContain('TEST_FAIL 1')
    expect((result.data as { rows: Array<{ fastFail?: boolean }> }).rows[0].fastFail).toBe(true)
    expect(result.summary).toContain('SYSTEM_HALT 1')
    expect(inspectEvidence).toHaveBeenCalledTimes(1)
  })

  it('computes condition failure rates from definitive live-log denominators', async () => {
    const third = {
      sourceId: 's3', artifactId: 'c'.repeat(64), rootId: 'r',
      relativePath: 'LPDDR6_SKEW-SS_LOT-A2_MAT-WAF12_SMP-02_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_PASS.log'
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
        list: vi.fn(async () => trendProject.artifacts.map((source) => ({ id: source.artifactId, fingerprint: { structuralHash: source.sourceId, commandSignatures: source.sourceId === 's2' ? ['training:train'] : ['diagnostic:hdiag'] } }))), search: vi.fn(), lineWindow: vi.fn()
      } as never,
      projects: { get: vi.fn(async () => trendProject), list: vi.fn(async () => [trendProject]) } as never,
      agentStore: { searchHistory: vi.fn(async () => []), workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []) }
    })
    const result = await tools.execute('p', { name: 'failure_trends_get' })
    const data = result.data as { denominator: number; live: Array<{ dimension: string; value: string; failures: number; total: number; failureRate: number }> }
    expect(data.denominator).toBe(3)
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: '온도', value: '85', failures: 1, total: 2, failureRate: 0.5 }))
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: 'SKEW', value: 'SS' }))
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: 'Sub Channel', value: '1' }))
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: 'Timing SKEW (ps)', value: '12' }))
    expect(data.live.some((item) => item.dimension === 'sku')).toBe(false)
    expect(data.live).toContainEqual(expect.objectContaining({ dimension: 'command', value: 'diagnostic:hdiag', failures: 1, total: 2, failureRate: 0.5 }))
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
        attemptHistory: vi.fn(async () => []), commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []), consolePromptRules: vi.fn(async () => []),
      },
    })
    const result = await tools.execute('p', { name: 'engineer_workflow_apply' }, ['s1'])
    const rows = (result.data as { rows: Array<{ matched: boolean; orderMet: boolean; candidateResult: string }> }).rows
    expect(rows).toEqual([expect.objectContaining({ matched: true, orderMet: true, candidateResult: 'PASS' })])
    expect(result.summary).toContain('1개 중 1개')
  })

  it('separates prompt commands from output and applies the confirmed bare-prompt rule', async () => {
    const search = vi.fn(async () => ({
      query: '', mode: 'regex' as const, caseSensitive: false, totalMatchCount: 3, truncated: false, files: [],
      matches: [
        { artifactId: project.artifacts[0].artifactId, fileName: 'run.log', lineNumber: 10, columnStart: 1, columnEnd: 8, lineText: '[00:00:00] UEFI> set_rail VDD 1.295', lineTruncated: false, before: [], after: [] },
        { artifactId: project.artifacts[0].artifactId, fileName: 'run.log', lineNumber: 20, columnStart: 1, columnEnd: 8, lineText: '# sleep 20', lineTruncated: false, before: [], after: [] },
        { artifactId: project.artifacts[0].artifactId, fileName: 'run.log', lineNumber: 30, columnStart: 1, columnEnd: 8, lineText: 'INFO set_rail completed', lineTruncated: false, before: [], after: [] },
      ],
    }))
    const tools = new LpddrAgentToolService({
      artifacts: { search, inspectEvidence: vi.fn(), lineWindow: vi.fn(), list: vi.fn(async () => [{ id: project.artifacts[0].artifactId, fingerprint: { console: { inputCount: 1, ambiguousCount: 1, promptKinds: ['uefi', 'bare-root'], statusCounts: { 'at-fail': 1 } } } }]) } as never,
      projects: { get: vi.fn(async () => project), list: vi.fn(async () => [project]) } as never,
      agentStore: {
        searchHistory: vi.fn(async () => [{ projectId: 'p', sourceIds: ['s1'], query: 'sleep 20' }]),
        workflowMemories: vi.fn(async () => []), conversationHistory: vi.fn(async () => []), attemptHistory: vi.fn(async () => []),
        commandKnowledge: vi.fn(async () => []), profileBindings: vi.fn(async () => []),
        consolePromptRules: vi.fn(async () => [{ id: 'r', projectId: 'p', promptSignature: 'bare-root-hash', promptKind: 'bare-root', role: 'input', confirmedCount: 1, createdAt: '', updatedAt: '' }]),
      } as never,
    })
    const result = await tools.execute('p', { name: 'console_transcript_scan' }, ['s1'])
    const data = result.data as { commands: Array<{ command: string; searchedByEngineer: boolean }>; ambiguous: unknown[] }
    expect(data.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'set_rail VDD 1.295' }),
      expect.objectContaining({ command: 'sleep 20', searchedByEngineer: true }),
    ]))
    expect(data.ambiguous).toEqual([])
    expect(result.summary).toContain('상태 신호 1개')
  })
})
