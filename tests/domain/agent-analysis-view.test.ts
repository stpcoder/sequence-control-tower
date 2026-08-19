import { describe, expect, it } from 'vitest'
import { analysisContextLabel, extractAnalysisViewProposal, normalizeAnalysisViewProposal } from '../../src/domain/agent-analysis-view'

describe('Agent Results Summary proposals', () => {
  it('extracts a validated DRAM view without showing its machine tag in chat', () => {
    const parsed = extractAnalysisViewProposal(`DQ9와 BL0 집중을 먼저 비교하는 것이 좋습니다.\n<sct-analysis-view>{"dataBasis":"failure_address","rowAxes":["dq"],"columnAxes":["bl"],"aggregation":"fail_event_count","visualization":"heatmap","failOnly":true,"rationale":"DQ와 BL Fail address 집중 확인"}</sct-analysis-view>`)
    expect(parsed.content).toBe('DQ9와 BL0 집중을 먼저 비교하는 것이 좋습니다.')
    expect(parsed.proposal).toEqual({
      dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_event_count',
      visualization: 'heatmap', failOnly: true, rationale: 'DQ와 BL Fail address 집중 확인',
    })
  })

  it('fails closed for mixed grains, unsupported charts, and duplicate axes', () => {
    expect(normalizeAnalysisViewProposal({ dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_rate', visualization: 'heatmap' })).toBeNull()
    expect(normalizeAnalysisViewProposal({ dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_event_count', visualization: 'line' })).toBeNull()
    expect(normalizeAnalysisViewProposal({ dataBasis: 'evaluation', rowAxes: ['skew', 'skew'], columnAxes: ['skew', 'vdd'], aggregation: 'fail_rate', visualization: 'cross_table' }))
      .toMatchObject({ rowAxes: ['skew'], columnAxes: ['vdd'] })
  })

  it('uses short familiar labels for menu context', () => {
    expect(analysisContextLabel('log_search')).toBe('로그 검색')
    expect(analysisContextLabel('analysis_view')).toBe('결과 정리')
    expect(analysisContextLabel('project_compare')).toBe('평가 비교')
  })
})
