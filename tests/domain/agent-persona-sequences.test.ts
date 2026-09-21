import { describe, expect, it } from 'vitest'
import { analysisViewAgentContext, resultRowsAgentContext, searchAgentContext } from '../../src/domain/analysis-context'
import { extractAnalysisViewProposal } from '../../src/domain/agent-analysis-view'
import type { LogResultRecord } from '../../src/state/logRecords'

const record = (id: string, folder: string, result: LogResultRecord['result'], dimensions: NonNullable<LogResultRecord['dimensions']>): LogResultRecord => ({
  id, evaluationScopeId: folder, fileName: `${id}.log`, folder, relativePath: `${folder}/${id}.log`,
  sample: { value: 'SMP-01', state: 'candidate' }, temperature: { value: String(dimensions.temperatureC ?? 25), state: 'candidate' },
  vdd: { value: String(dimensions.vdd ?? 1.0), state: 'candidate' },
  grid: { value: 'G1', state: 'candidate' }, dimensions,
  result, resultSource: 'candidate', stageResults: [], review: 'needs_review', evidenceCount: 2, selectedEvidenceCount: 2,
})

describe('DRAM engineer Agent interaction personas', () => {
  it('reproduction engineer moves from Ctrl-F evidence to the same-folder result without promoting raw searches', () => {
    const searches = ['UEFI', '@FAIL', '@PASS'].map((query) => searchAgentContext({
      query, scopeLabel: '현재 폴더', matchCount: query === '@PASS' ? 0 : 4, fileIds: ['rt-1'], regex: false, caseSensitive: false, wholeWord: false,
    }))
    const results = resultRowsAgentContext([record('rt-1', '02-RT', 'TEST_FAIL', { skew: 'SS', sample: 'SMP-01', testMode: 'VPERI' })])
    expect(searches.every((request) => request.contextKind === 'log_search')).toBe(true)
    expect(results.contextKind).toBe('results')
  })

  it('acceleration engineer gets denominator-aware Temp, VDD and frequency analysis', () => {
    const rows = [
      record('cold-low', '03-acceleration', 'TEST_FAIL', { skew: 'SS', temperatureC: -10, vdd: 1.255, frequencyMHz: 9600 }),
      record('hot-high', '03-acceleration', 'PASS', { skew: 'SS', temperatureC: 85, vdd: 1.315, frequencyMHz: 8533 }),
    ]
    const context = analysisViewAgentContext({ rows, rowAxes: ['frequencyMHz'], columnAxes: ['temperatureCorner', 'vddCorner'], aggregation: 'fail_rate', visualization: 'heatmap', dataBasis: 'evaluation', selected: [] })
    expect(context.contextKind).toBe('analysis_view')
  })

  it('side-effect engineer receives a typed address-event view instead of filename metadata counts', () => {
    const parsed = extractAnalysisViewProposal('새 DQ 위치를 분리해서 확인합니다.\n<sct-analysis-view>{"dataBasis":"failure_address","rowAxes":["dq"],"columnAxes":["bl"],"aggregation":"fail_event_count","visualization":"heatmap","rationale":"개선 전후 DQ·BL signature 비교"}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({ dataBasis: 'failure_address', aggregation: 'fail_event_count', visualization: 'heatmap' })
  })

  it('project lead comparison stays project-scoped when selected results span evaluation folders', () => {
    const context = resultRowsAgentContext([
      record('screen', '01-screen', 'TEST_FAIL', { skew: 'SS', dq: 9 }),
      record('improve', '04-improvement', 'PASS', { skew: 'SS', dq: 9, vdd: 1.315 }),
    ])
    expect(context.contextKind).toBe('project_compare')
    expect(context.prompt).toContain('하나의 평가로 합치지 말고')
  })

  it('frequency split engineer receives an editable evaluation-grain view', () => {
    const parsed = extractAnalysisViewProposal('주파수별 악화 여부를 비교합니다.\n<sct-analysis-view>{"dataBasis":"evaluation","rowAxes":["frequencyMHz"],"columnAxes":["skew"],"aggregation":"fail_rate","visualization":"heatmap","rationale":"같은 Sample에서 주파수별 판정 분모를 비교합니다."}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({
      dataBasis: 'evaluation', rowAxes: ['frequencyMHz'], columnAxes: ['skew'], aggregation: 'fail_rate',
    })
  })

  it('screening engineer keeps SKEW and Sample coverage separate from log file count', () => {
    const parsed = extractAnalysisViewProposal('SKEW별 판정을 확인합니다.\n<sct-analysis-view>{"dataBasis":"evaluation","rowAxes":["skew","sample"],"columnAxes":["mode"],"aggregation":"pass_fail","visualization":"cross_table","rationale":"SS, SF, FS, FF, TT별 Sample 판정을 비교합니다."}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({
      dataBasis: 'evaluation', rowAxes: ['skew', 'sample'], aggregation: 'pass_fail', visualization: 'cross_table',
    })
    expect(parsed.content).not.toContain('파일 수')
  })

})
