import { describe, expect, it } from 'vitest'
import { analysisViewAgentContext, pivotSelectionAgentContext, pivotSelectionsAgentContext, resultRowsAgentContext, searchAgentContext } from '../../src/domain/analysis-context'
import type { LogResultRecord } from '../../src/state/logRecords'

function row(id: string, folder: string, result: LogResultRecord['result']): LogResultRecord {
  return {
    id, fileName: `${id}.log`, folder, relativePath: `${folder}/${id}.log`,
    sample: { value: id, state: 'candidate' }, temperature: { value: '85', state: 'candidate' },
    mode: { value: 'VPERI', state: 'candidate' }, grid: { value: 'G1', state: 'candidate' },
    dimensions: { skew: 'SS', vdd: 1.295, frequencyMHz: 9600, dq: 9, channel: 0 },
    result, resultSource: 'engineer', stageResults: [], review: 'confirmed', evidenceCount: 2, selectedEvidenceCount: 2,
  }
}

describe('analysis selections handed to the native Agent', () => {
  it('preserves the engineer search operation without treating it as a confirmed rule', () => {
    const request = searchAgentContext({
      query: '@FAIL', scopeLabel: '현재 평가', matchCount: 12, fileIds: ['a', 'a', 'b'],
      regex: false, caseSensitive: true, wholeWord: false,
    })
    expect(request.fileIds).toEqual(['a', 'b'])
    expect(request.contextKind).toBe('log_search')
    expect(request.prompt).toContain('현재 평가')
    expect(request.prompt).toContain('12회 일치')
    expect(request.prompt).toContain('검색 순서로 확정할지 제안')
    expect(request.prompt).toContain('재사용 범위')
  })

  it('keeps selected result folders separate and asks for denominators', () => {
    const request = resultRowsAgentContext([row('a', 'screen', 'TEST_FAIL'), row('b', 'improve', 'PASS')])
    expect(request.fileIds).toEqual(['a', 'b'])
    expect(request.contextKind).toBe('project_compare')
    expect(request.prompt).toContain('평가 폴더 2개')
    expect(request.prompt).toContain('TEST_FAIL 1, PASS 1')
    expect(request.prompt).toContain('하나의 평가로 합치지 말고')
    expect(request.prompt).toContain('분모')
  })

  it('describes the exact marked pivot cell for evidence-bounded interpretation', () => {
    const request = pivotSelectionAgentContext({
      rows: [row('a', 'screen', 'TEST_FAIL')], rowAxes: ['skew', 'sample'], columnAxes: ['temperature', 'vdd'],
      rowValues: ['SS', 'a'], columnValues: ['85', '1.295'], aggregation: 'fail_rate', displayValue: '100%',
    })
    expect(request.prompt).toContain('SKEW=SS')
    expect(request.prompt).toContain('온도=85')
    expect(request.prompt).toContain('불량률 100%')
    expect(request.prompt).toContain('인과관계는 확정하지 말고')
  })

  it('compares multiple marked pivot cells without merging evaluation folders', () => {
    const request = pivotSelectionsAgentContext({
      rows: [row('a', 'screen', 'TEST_FAIL'), row('b', 'improve', 'PASS')],
      rowAxes: ['skew'], columnAxes: ['vdd'], aggregation: 'fail_rate',
      selections: [
        { rowValues: ['SS'], columnValues: ['1.295'], displayValue: '100%' },
        { rowValues: ['SS'], columnValues: ['1.315'], displayValue: '0%' },
      ],
    })
    expect(request.title).toBe('표 조건 2개 비교')
    expect(request.prompt).toContain('선택한 조건 2개')
    expect(request.prompt).toContain('VDD=1.295 · 불량률 100%')
    expect(request.prompt).toContain('VDD=1.315 · 불량률 0%')
    expect(request.prompt).toContain('서로 다른 평가 폴더는 합치지 말고')
  })

  it('hands the combined PASS and FAIL cell value to the Agent unchanged', () => {
    const request = pivotSelectionAgentContext({
      rows: [row('a', 'screen', 'PASS'), row('b', 'screen', 'TEST_FAIL')],
      rowAxes: ['skew'], columnAxes: ['vdd'], rowValues: ['SS'], columnValues: ['1.295'],
      aggregation: 'pass_fail', displayValue: 'PASS 1 · FAIL 1',
    })
    expect(request.prompt).toContain('판정 결과 PASS 1 · FAIL 1')
    expect(request.prompt).toContain('PASS 1, TEST_FAIL 1')
  })

  it('hands the active visualization and evidence scope to the native Agent', () => {
    const request = analysisViewAgentContext({
      rows: [row('a', 'screen', 'TEST_FAIL')], rowAxes: ['bank'], columnAxes: ['dq'],
      aggregation: 'fail_count', visualization: 'heatmap',
      dataBasis: 'evaluation',
      selected: [{ rowValues: ['5'], columnValues: ['9'], displayValue: '3' }],
    })
    expect(request.title).toBe('선택 조건 1개 분석')
    expect(request.contextKind).toBe('analysis_view')
    expect(request.prompt).toContain('[SCT_ANALYSIS_VIEW_CONTEXT]')
    expect(request.prompt).toContain('Heatmap')
    expect(request.prompt).toContain('Bank=5')
    expect(request.prompt).toContain('DQ=9')
    expect(request.prompt).toContain('로컬 도구로 다시 확인')
    expect(request.fileIds).toEqual(['a'])
  })
})
