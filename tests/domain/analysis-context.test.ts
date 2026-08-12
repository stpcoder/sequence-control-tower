import { describe, expect, it } from 'vitest'
import { pivotSelectionAgentContext, resultRowsAgentContext, searchAgentContext } from '../../src/domain/analysis-context'
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
    expect(request.prompt).toContain('현재 평가')
    expect(request.prompt).toContain('12회 일치')
    expect(request.prompt).toContain('검색 순서로 확정할지 제안')
    expect(request.prompt).toContain('재사용 범위')
  })

  it('keeps selected result folders separate and asks for denominators', () => {
    const request = resultRowsAgentContext([row('a', 'screen', 'TEST_FAIL'), row('b', 'improve', 'PASS')])
    expect(request.fileIds).toEqual(['a', 'b'])
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
    expect(request.prompt).toContain('FAIL률 100%')
    expect(request.prompt).toContain('인과관계는 확정하지 말고')
  })
})
