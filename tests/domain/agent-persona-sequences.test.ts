import { describe, expect, it } from 'vitest'
import { analysisViewAgentContext, resultRowsAgentContext, searchAgentContext } from '../../src/domain/analysis-context'
import { extractAnalysisViewProposal } from '../../src/domain/agent-analysis-view'
import { planLpddrTools } from '../../electron/main/native-agent-service'
import type { LogResultRecord } from '../../src/state/logRecords'

const record = (id: string, folder: string, result: LogResultRecord['result'], dimensions: NonNullable<LogResultRecord['dimensions']>): LogResultRecord => ({
  id, fileName: `${id}.log`, folder, relativePath: `${folder}/${id}.log`,
  sample: { value: 'SMP-01', state: 'candidate' }, temperature: { value: String(dimensions.temperatureC ?? 25), state: 'candidate' },
  mode: { value: String(dimensions.testMode ?? 'VPERI'), state: 'candidate' }, grid: { value: 'G1', state: 'candidate' }, dimensions,
  result, resultSource: 'candidate', stageResults: [], review: 'needs_review', evidenceCount: 2, selectedEvidenceCount: 2,
})

describe('DRAM engineer Agent interaction personas', () => {
  it('reproduction engineer moves from Ctrl-F evidence to the same-folder result without promoting raw searches', () => {
    const searches = ['UEFI', '@FAIL', '@PASS'].map((query) => searchAgentContext({
      query, scopeLabel: '현재 평가', matchCount: query === '@PASS' ? 0 : 4, fileIds: ['rt-1'], regex: false, caseSensitive: false, wholeWord: false,
    }))
    const results = resultRowsAgentContext([record('rt-1', '02-RT', 'TEST_FAIL', { skew: 'SS', sample: 'SMP-01', testMode: 'VPERI' })])
    expect(searches.every((request) => request.contextKind === 'log_search')).toBe(true)
    expect(results.contextKind).toBe('results')
    expect(planLpddrTools('같은 Sample과 Sequence의 RT에서 저장된 Ctrl-F 순서로 재현 여부를 확인해줘').map((call) => call.name))
      .toEqual(expect.arrayContaining(['engineer_workflow_memory_get', 'engineer_workflow_apply', 'pass_fail_scan']))
  })

  it('acceleration engineer gets denominator-aware Temp, VDD and frequency analysis', () => {
    const rows = [
      record('cold-low', '03-acceleration', 'TEST_FAIL', { skew: 'SS', temperatureC: -10, vdd: 1.255, frequencyMHz: 9600 }),
      record('hot-high', '03-acceleration', 'PASS', { skew: 'SS', temperatureC: 85, vdd: 1.315, frequencyMHz: 8533 }),
    ]
    const context = analysisViewAgentContext({ rows, rowAxes: ['frequencyMHz'], columnAxes: ['temperatureCorner', 'vddCorner'], aggregation: 'fail_rate', visualization: 'heatmap', dataBasis: 'evaluation', selected: [] })
    expect(context.contextKind).toBe('analysis_view')
    expect(planLpddrTools(context.prompt).map((call) => call.name)).toEqual(expect.arrayContaining(['project_context_get', 'failure_trends_get']))
  })

  it('side-effect engineer receives a typed address-event view instead of filename metadata counts', () => {
    const parsed = extractAnalysisViewProposal('새 DQ 위치를 분리해서 확인합니다.\n<sct-analysis-view>{"dataBasis":"failure_address","rowAxes":["dq"],"columnAxes":["bl"],"aggregation":"fail_event_count","visualization":"heatmap","rationale":"개선 전후 DQ·BL signature 비교"}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({ dataBasis: 'failure_address', aggregation: 'fail_event_count', visualization: 'heatmap' })
    expect(planLpddrTools('TM 개선 전 DQ0/1/2가 사라지고 DQ5/6 side effect가 생겼는지 Fail address를 비교해줘').map((call) => call.name))
      .toContain('failure_trends_get')
  })

  it('project lead comparison stays project-scoped when selected results span evaluation folders', () => {
    const context = resultRowsAgentContext([
      record('screen', '01-screen', 'TEST_FAIL', { skew: 'SS', dq: 9 }),
      record('improve', '04-improvement', 'PASS', { skew: 'SS', dq: 9, vdd: 1.315 }),
    ])
    expect(context.contextKind).toBe('project_compare')
    expect(context.prompt).toContain('하나의 평가로 합치지 말고')
    expect(planLpddrTools('재현 평가와 개선 평가를 같은 불량 이력에서 비교하고 다음 평가를 제안해줘').map((call) => call.name))
      .toEqual(expect.arrayContaining(['project_context_get', 'project_history_get', 'evaluation_relation_suggest']))
  })
})
