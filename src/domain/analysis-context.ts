import type { LogResultRecord, PivotAggregation, PivotDimension } from '../state/logRecords'
import { ANALYSIS_DATA_BASIS_LABELS, ANALYSIS_VISUALIZATION_LABELS, type AnalysisDataBasis, type AnalysisVisualization } from './analysis-view'
import type { NativeAgentContextKind } from '../../electron/shared/contracts'

export interface AgentAnalysisContextRequest {
  title: string
  prompt: string
  fileIds: string[]
  contextKind: NativeAgentContextKind
}

export interface SearchAnalysisContextInput {
  query: string
  scopeLabel: string
  matchCount: number
  fileIds: readonly string[]
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

export interface PivotAnalysisSelection {
  rowValues: readonly string[]
  columnValues: readonly string[]
  displayValue: string
}

const resultCounts = (rows: readonly LogResultRecord[]): string => {
  const counts = new Map<string, number>()
  rows.forEach((row) => counts.set(row.result, (counts.get(row.result) ?? 0) + 1))
  return [...counts.entries()].map(([result, count]) => `${result} ${count}`).join(', ') || '없음'
}

const dimensionLabel = (dimension: PivotDimension): string => ({
  sample: 'Sample', temperature: '온도', mode: 'Test Mode', grid: 'Grid', skew: 'SKEW', frequencyMHz: '주파수', temperatureCorner: '온도 조건', vdd: 'VDD', vddCorner: 'VDD 조건', conditionCorner: '4-Corner', pattern: 'Pattern', material: '자재', lot: 'Lot', die: 'Die', socModel: '실장기 SoC', dq: 'DQ', bl: 'BL', channel: 'Channel', subChannel: 'Sub Channel', chipSelect: 'CS', rank: 'Rank', bankGroup: 'Bank Group', bank: 'Bank', row: 'Row', column: 'Column', writeData: 'WR', readData: 'RD', timingSkewPs: 'Timing SKEW', result: '판정 결과', review: '검토 상태', folder: '평가 폴더', run: '반복 번호',
})[dimension]

const aggregationLabel = (aggregation: PivotAggregation): string => ({
  count: '로그 파일 수', sample_count: 'Sample 수', grid_count: 'Grid 수', pass_count: 'PASS 횟수', fail_count: 'FAIL 횟수', pass_fail: '판정 결과', fail_rate: '불량률', evidence_count: '판정 신호 수',
  fail_event_count: 'Fail 주소 이벤트 수', fail_source_count: 'Fail 주소 포함 로그 수', fail_event_share: 'Fail 주소 이벤트 비율',
})[aggregation]

export function searchAgentContext(input: SearchAnalysisContextInput): AgentAnalysisContextRequest {
  const mode = input.regex ? '정규식' : '일반 검색'
  const options = [input.caseSensitive ? '대소문자 구분' : '', input.wholeWord ? '단어 단위' : ''].filter(Boolean).join(', ') || '기본 옵션'
  return {
    title: `검색 해석 · ${input.query.slice(0, 32)}`,
    contextKind: 'log_search',
    fileIds: [...new Set(input.fileIds)].slice(0, 100),
    prompt: `엔지니어가 ${input.scopeLabel}에서 ${mode} “${input.query}”을 실행했고 ${input.matchCount.toLocaleString('ko-KR')}회 일치했습니다. 검색 옵션은 ${options}입니다. 이 검색이 현재 평가의 어떤 단계·명령·Pass/Fail 판정에 쓰이는지 로그 근거와 저장된 검색 절차를 함께 확인해 주세요. 반복해서 쓸 조건이면 어떤 검색 순서로 확정할지 제안하고, 현재 폴더에만 맞는 조건이면 재사용 범위를 분명히 해 주세요.`,
  }
}

export function resultRowsAgentContext(rows: readonly LogResultRecord[]): AgentAnalysisContextRequest {
  const folders = [...new Set(rows.map((row) => row.folder))]
  return {
    title: rows.length === 1 ? '선택 로그 분석' : `선택 결과 ${rows.length}개 비교`,
    contextKind: folders.length > 1 ? 'project_compare' : 'results',
    fileIds: [...new Set(rows.map((row) => row.id))].slice(0, 100),
    prompt: `결과 화면에서 선택한 로그 ${rows.length.toLocaleString('ko-KR')}개를 분석해 주세요. 평가 폴더 ${folders.length.toLocaleString('ko-KR')}개, 현재 판정은 ${resultCounts(rows)}입니다. 파일명 조건과 로컬 Pass/Fail·Training Fail·Halt·Reboot 판정을 우선 확인하고, 온도·VDD·주파수·SKEW·Sample·DQ·BL·Channel·Sub Channel·Bank·Pattern별 집중 경향을 분모와 함께 비교해 주세요. 서로 다른 평가 폴더는 하나의 평가로 합치지 말고 폴더별 차이와 프로젝트 이력상의 관계를 구분해 주세요.`,
  }
}

export function pivotSelectionAgentContext(input: {
  rows: readonly LogResultRecord[]
  rowAxes: readonly PivotDimension[]
  columnAxes: readonly PivotDimension[]
  rowValues: readonly string[]
  columnValues: readonly string[]
  aggregation: PivotAggregation
  displayValue: string
}): AgentAnalysisContextRequest {
  return pivotSelectionsAgentContext({
    rows: input.rows,
    rowAxes: input.rowAxes,
    columnAxes: input.columnAxes,
    aggregation: input.aggregation,
    selections: [{ rowValues: input.rowValues, columnValues: input.columnValues, displayValue: input.displayValue }],
  })
}

const pivotConditionText = (
  rowAxes: readonly PivotDimension[],
  columnAxes: readonly PivotDimension[],
  selection: PivotAnalysisSelection,
): string => {
  const rowCondition = rowAxes.map((axis, index) => `${dimensionLabel(axis)}=${selection.rowValues[index] ?? '미확인'}`)
  const columnCondition = columnAxes.map((axis, index) => `${dimensionLabel(axis)}=${selection.columnValues[index] ?? '미확인'}`)
  return [...rowCondition, ...columnCondition].join(', ') || '전체 범위'
}

/** Builds one evidence-bounded comparison from Spotfire-style marked pivot cells. */
export function pivotSelectionsAgentContext(input: {
  rows: readonly LogResultRecord[]
  rowAxes: readonly PivotDimension[]
  columnAxes: readonly PivotDimension[]
  aggregation: PivotAggregation
  selections: readonly PivotAnalysisSelection[]
}): AgentAnalysisContextRequest {
  const rows = [...input.rows]
  const selections = input.selections.slice(0, 12)
  const summaries = selections.map((selection, index) => {
    const condition = pivotConditionText(input.rowAxes, input.columnAxes, selection)
    return `${index + 1}. ${condition} · ${aggregationLabel(input.aggregation)} ${selection.displayValue}`
  })
  const firstCondition = selections[0]
    ? pivotConditionText(input.rowAxes, input.columnAxes, selections[0])
    : '선택 조건 없음'
  const selectionText = selections.length > 1
    ? `선택한 조건 ${selections.length.toLocaleString('ko-KR')}개를 비교해 주세요.\n${summaries.join('\n')}`
    : `“${firstCondition}” 셀을 선택했습니다. 표시 값은 ${aggregationLabel(input.aggregation)} ${selections[0]?.displayValue ?? '미확인'}입니다.`
  return {
    title: selections.length > 1 ? `표 조건 ${selections.length}개 비교` : `표 선택 해석 · ${firstCondition.slice(0, 42)}`,
    contextKind: 'analysis_view',
    fileIds: [...new Set(rows.map((row) => row.id))].slice(0, 100),
    prompt: `결과 정리 표에서 ${selectionText} 연결 로그는 중복을 제외해 ${rows.length.toLocaleString('ko-KR')}개이며 판정은 ${resultCounts(rows)}입니다. 선택 조건 사이의 차이와 불량 집중 여부를 분모와 함께 검토하고, 온도·VDD·주파수·SKEW·Sample·DQ·BL·Channel·Sub Channel·Bank·Pattern 중 실제 근거가 있는 차원만 설명해 주세요. 서로 다른 평가 폴더는 합치지 말고, 인과관계는 확정하지 말고 비교가 필요한 대조 조건과 다음 평가를 제안해 주세요.`,
  }
}

/** Gives the native Agent the exact renderer state. The Agent still recomputes
 * numeric claims with its local tools rather than trusting the visible chart. */
export function analysisViewAgentContext(input: {
  rows: readonly LogResultRecord[]
  rowAxes: readonly PivotDimension[]
  columnAxes: readonly PivotDimension[]
  aggregation: PivotAggregation
  visualization: AnalysisVisualization
  dataBasis: AnalysisDataBasis
  selected: readonly PivotAnalysisSelection[]
}): AgentAnalysisContextRequest {
  const axes = [
    input.rowAxes.length ? `왼쪽 축 ${input.rowAxes.map(dimensionLabel).join(' → ')}` : '왼쪽 축 전체',
    input.columnAxes.length ? `상단 축 ${input.columnAxes.map(dimensionLabel).join(' → ')}` : '상단 축 전체',
  ].join(', ')
  const selected = input.selected.slice(0, 12).map((item, index) =>
    `${index + 1}. ${pivotConditionText(input.rowAxes, input.columnAxes, item)} · ${item.displayValue}`,
  )
  return {
    title: selected.length ? `선택 조건 ${selected.length}개 분석` : '현재 분석 보기 점검',
    contextKind: 'analysis_view',
    fileIds: [...new Set(input.rows.map((row) => row.id))].slice(0, 100),
    prompt: `[SCT_ANALYSIS_VIEW_CONTEXT]\n${JSON.stringify({ dataBasis: input.dataBasis, visualization: input.visualization, rowAxes: input.rowAxes, columnAxes: input.columnAxes, aggregation: input.aggregation })}\n결과 정리에서 ${ANALYSIS_DATA_BASIS_LABELS[input.dataBasis]} 기준의 ${ANALYSIS_VISUALIZATION_LABELS[input.visualization]}를 보고 있습니다. ${axes}, 값 ${aggregationLabel(input.aggregation)}입니다.${selected.length ? `\n선택 조건:\n${selected.join('\n')}` : ''}\n현재 범위의 로그 ${input.rows.length.toLocaleString('ko-KR')}개를 로컬 도구로 다시 확인해 주세요. 현재 평가 폴더의 목적과 저장된 검색 절차를 먼저 읽고, 평가 결과 기준이면 Pass/Fail 분모를, Fail 주소 기준이면 failure_trends_get의 event 수와 포함 로그 수를 각각 재계산해 주세요. 온도·VDD·주파수·SKEW·Sample·DQ·BL·Channel·Sub Channel·Bank·Pattern 중 실제 근거가 있는 경향만 설명하고, 반대 조건과 미확인 값을 구분해 다음 분석 축을 하나 제안해 주세요. 화면의 집계 숫자만 복사하지 말고 근거 로그로 검증해 주세요.`,
  }
}
