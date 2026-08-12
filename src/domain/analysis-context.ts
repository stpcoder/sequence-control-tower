import type { LogResultRecord, PivotAggregation, PivotDimension } from '../state/logRecords'

export interface AgentAnalysisContextRequest {
  title: string
  prompt: string
  fileIds: string[]
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

const resultCounts = (rows: readonly LogResultRecord[]): string => {
  const counts = new Map<string, number>()
  rows.forEach((row) => counts.set(row.result, (counts.get(row.result) ?? 0) + 1))
  return [...counts.entries()].map(([result, count]) => `${result} ${count}`).join(', ') || '없음'
}

const dimensionLabel = (dimension: PivotDimension): string => ({
  sample: 'Sample', temperature: '온도', mode: 'Test Mode', grid: 'Grid', skew: 'SKEW', frequencyMHz: '주파수', temperatureCorner: '온도 조건', vdd: 'VDD', vddCorner: 'VDD 조건', conditionCorner: '4-Corner', pattern: 'Pattern', material: '자재', lot: 'Lot', die: 'Die', socModel: '실장기 SoC', dq: 'DQ', bl: 'BL', channel: 'Channel', subChannel: 'Sub Channel', chipSelect: 'CS', rank: 'Rank', bankGroup: 'Bank Group', bank: 'Bank', row: 'Row', column: 'Column', writeData: 'WR', readData: 'RD', timingSkewPs: 'Timing SKEW', result: '판정 결과', review: '검토 상태', folder: '평가 폴더', run: '반복 번호',
})[dimension]

const aggregationLabel = (aggregation: PivotAggregation): string => ({
  count: '로그 파일 수', sample_count: 'Sample 수', grid_count: 'Grid 수', pass_count: 'PASS 로그', fail_count: 'FAIL 로그', fail_rate: 'FAIL률', evidence_count: '판정 신호 수',
})[aggregation]

export function searchAgentContext(input: SearchAnalysisContextInput): AgentAnalysisContextRequest {
  const mode = input.regex ? '정규식' : '일반 검색'
  const options = [input.caseSensitive ? '대소문자 구분' : '', input.wholeWord ? '단어 단위' : ''].filter(Boolean).join(', ') || '기본 옵션'
  return {
    title: `검색 해석 · ${input.query.slice(0, 32)}`,
    fileIds: [...new Set(input.fileIds)].slice(0, 100),
    prompt: `엔지니어가 ${input.scopeLabel}에서 ${mode} “${input.query}”을 실행했고 ${input.matchCount.toLocaleString('ko-KR')}회 일치했습니다. 검색 옵션은 ${options}입니다. 이 검색이 현재 평가의 어떤 단계·명령·Pass/Fail 판정에 쓰이는지 로그 근거와 저장된 검색 절차를 함께 확인해 주세요. 반복해서 쓸 조건이면 어떤 검색 순서로 확정할지 제안하고, 현재 폴더에만 맞는 조건이면 재사용 범위를 분명히 해 주세요.`,
  }
}

export function resultRowsAgentContext(rows: readonly LogResultRecord[]): AgentAnalysisContextRequest {
  const folders = [...new Set(rows.map((row) => row.folder))]
  return {
    title: rows.length === 1 ? '선택 로그 분석' : `선택 결과 ${rows.length}개 비교`,
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
  const rows = [...input.rows]
  const rowCondition = input.rowAxes.map((axis, index) => `${dimensionLabel(axis)}=${input.rowValues[index] ?? '미확인'}`)
  const columnCondition = input.columnAxes.map((axis, index) => `${dimensionLabel(axis)}=${input.columnValues[index] ?? '미확인'}`)
  const conditions = [...rowCondition, ...columnCondition].join(', ') || '전체 범위'
  return {
    title: `표 선택 해석 · ${conditions.slice(0, 42)}`,
    fileIds: [...new Set(rows.map((row) => row.id))].slice(0, 100),
    prompt: `결과 정리 표에서 “${conditions}” 셀을 선택했습니다. 표시 값은 ${aggregationLabel(input.aggregation)} ${input.displayValue}, 연결 로그는 ${rows.length.toLocaleString('ko-KR')}개이며 판정은 ${resultCounts(rows)}입니다. 선택 셀의 불량 집중 여부를 분모와 함께 검토하고, 온도·VDD·주파수·SKEW·Sample·DQ·BL·Channel·Sub Channel·Bank·Pattern 중 실제 근거가 있는 차원만 설명해 주세요. 인과관계는 확정하지 말고 비교가 필요한 대조 조건과 다음 평가를 제안해 주세요.`,
  }
}
