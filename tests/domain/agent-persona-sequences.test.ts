import { describe, expect, it } from 'vitest'
import { analysisViewAgentContext, resultRowsAgentContext, searchAgentContext } from '../../src/domain/analysis-context'
import { extractAnalysisViewProposal } from '../../src/domain/agent-analysis-view'
import { planLpddrTools } from '../../electron/main/native-agent-service'
import type { LogResultRecord } from '../../src/state/logRecords'

const record = (id: string, folder: string, result: LogResultRecord['result'], dimensions: NonNullable<LogResultRecord['dimensions']>): LogResultRecord => ({
  id, fileName: `${id}.log`, folder, relativePath: `${folder}/${id}.log`,
  sample: { value: 'SMP-01', state: 'candidate' }, temperature: { value: String(dimensions.temperatureC ?? 25), state: 'candidate' },
  vdd: { value: String(dimensions.vdd ?? 1.0), state: 'candidate' },
  grid: { value: 'G1', state: 'candidate' }, dimensions,
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

  it('QC bring-up engineer checks Training before UEFI without treating UEFI as the only boot profile', () => {
    const names = planLpddrTools('SM-8975 QC 보드에서 Training FAIL이 UEFI 도달 전에 발생했는지 PASS/FAIL 근거로 확인해줘')
      .map((call) => call.name)
    expect(names).toEqual(expect.arrayContaining([
      'soc_boot_profile_scan', 'engineer_workflow_memory_get', 'pass_fail_scan',
    ]))
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('MTK bring-up engineer follows LK and LK2 before OS and distinguishes reboot from test fail', () => {
    const names = planLpddrTools('MTK-24D 로그의 LK, LK2, OS 부팅 순서와 console 명령을 확인하고 SYSTEM_REBOOT인지 TEST_FAIL인지 판정해줘')
      .map((call) => call.name)
    expect(names).toEqual(expect.arrayContaining([
      'soc_boot_profile_scan', 'console_transcript_scan', 'pass_fail_scan',
    ]))
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('four-corner engineer gets Grid, denominator and condition tools together', () => {
    const names = planLpddrTools('같은 Sample의 4-Corner HH, CH, HL, CL Grid에서 온도와 VDD별 불량률을 비교해줘')
      .map((call) => call.name)
    expect(names).toEqual(expect.arrayContaining([
      'filename_dimensions_scan', 'evaluation_grid_scan', 'pass_fail_scan', 'failure_trends_get',
    ]))
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('frequency split engineer receives an editable evaluation-grain view', () => {
    const parsed = extractAnalysisViewProposal('주파수별 악화 여부를 비교합니다.\n<sct-analysis-view>{"dataBasis":"evaluation","rowAxes":["frequencyMHz"],"columnAxes":["skew"],"aggregation":"fail_rate","visualization":"heatmap","rationale":"같은 Sample에서 주파수별 판정 분모를 비교합니다."}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({
      dataBasis: 'evaluation', rowAxes: ['frequencyMHz'], columnAxes: ['skew'], aggregation: 'fail_rate',
    })
    expect(planLpddrTools('8533MHz와 9600MHz에서 같은 Sample의 불량률을 비교해줘').map((call) => call.name))
      .toContain('failure_trends_get')
  })

  it('screening engineer keeps SKEW and Sample coverage separate from log file count', () => {
    const parsed = extractAnalysisViewProposal('SKEW별 판정을 확인합니다.\n<sct-analysis-view>{"dataBasis":"evaluation","rowAxes":["skew","sample"],"columnAxes":["mode"],"aggregation":"pass_fail","visualization":"cross_table","rationale":"SS, SF, FS, FF, TT별 Sample 판정을 비교합니다."}</sct-analysis-view>')
    expect(parsed.proposal).toMatchObject({
      dataBasis: 'evaluation', rowAxes: ['skew', 'sample'], aggregation: 'pass_fail', visualization: 'cross_table',
    })
    expect(parsed.content).not.toContain('파일 수')
  })

  it('long-log halt engineer searches bounded markers and keeps an uncertain result fail-closed', () => {
    const names = planLpddrTools('장문 로그에서 "stressapp start"를 찾고 @PASS나 @FAIL 없이 watchdog reboot가 발생한 경우 SYSTEM_HALT인지 확인해줘')
      .map((call) => call.name)
    expect(names).toEqual(expect.arrayContaining(['pass_fail_scan', 'log_search']))
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('workflow owner can compare a confirmed Ctrl-F procedure without forcing it onto another folder', () => {
    const names = planLpddrTools('다른 평가 폴더에서 확정한 Ctrl-F 분석 절차를 이 폴더에 호환 적용하고 맞지 않으면 수정해줘')
      .map((call) => call.name)
    expect(names).toEqual(expect.arrayContaining(['engineer_workflow_memory_get', 'engineer_workflow_apply']))
    expect(names.length).toBeLessThanOrEqual(8)
  })
})
