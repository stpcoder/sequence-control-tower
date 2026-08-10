import { useEffect, useMemo, useState } from 'react'
import { FilterX } from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  buildPivotGrid,
  aggregateRecordTrends,
  filterLogRecords,
  isPivotSelectionValid,
  RESULT_LABEL_KO,
  type LogResultRecord,
  type LogRecordFilters,
  type PivotAggregation,
  type PivotDimension,
  type AggregateTrend,
  type PatternAxis,
} from '../state/logRecords'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import {
  DEFAULT_PATTERN_LAYOUT,
  PATTERN_LAYOUT_PRESET_ID,
  patternLayoutFromPreset,
  patternLayoutPreset,
  type PatternLayout,
} from '../state/patternLayout'

interface PatternsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
  project: ProjectSnapshot | null
  onProjectUpdated: (project: ProjectSnapshot) => void
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const DIMENSIONS: Array<{ value: PivotDimension; label: string }> = [
  { value: 'sample', label: 'Sample' },
  { value: 'temperature', label: '온도' },
  { value: 'mode', label: 'Mode' },
  { value: 'grid', label: 'Grid' },
  { value: 'result', label: '결과' },
  { value: 'review', label: '검토' },
  { value: 'folder', label: '폴더' },
  { value: 'run', label: 'Run' },
]

const DIMENSION_LABEL = Object.fromEntries(DIMENSIONS.map((item) => [item.value, item.label])) as Record<PivotDimension, string>
const AGGREGATIONS: Array<{ value: PivotAggregation; label: string }> = [
  { value: 'count', label: '로그 수' },
  { value: 'fail_count', label: 'Fail 수' },
  { value: 'evidence_count', label: 'Evidence 수' },
]
const FAIL_RESULTS: ReadonlySet<ResultLabel> = new Set(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
const RESULT_LIMIT = 150

const TREND_OUTCOME_LABEL: Record<AggregateTrend['outcome'], string> = {
  fail: 'Fail 3종',
  reboot: 'Reboot',
  halt: 'Halt',
  majority: '다수 결과',
}

export function isProjectRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))
}

function SelectControl({ label, value, onChange, children, testId }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode; testId?: string }) {
  return <label className="pattern-control" data-testid={testId}><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>
}

function dimensionOptions(selected: readonly PivotDimension[], current: PivotDimension) {
  return DIMENSIONS.filter((item) => item.value === current || !selected.includes(item.value))
}

export function PatternsView({ records, onOpenFile, project, onProjectUpdated, onNotify }: PatternsViewProps) {
  const [rowAxes, setRowAxes] = useState<PatternLayout['rowAxes']>(DEFAULT_PATTERN_LAYOUT.rowAxes)
  const [columnAxes, setColumnAxes] = useState<PatternLayout['columnAxes']>(DEFAULT_PATTERN_LAYOUT.columnAxes)
  const [aggregation, setAggregation] = useState<PivotAggregation>(DEFAULT_PATTERN_LAYOUT.aggregation)
  const [resultFilter, setResultFilter] = useState<ResultLabel | 'all'>(DEFAULT_PATTERN_LAYOUT.resultFilter)
  const [folderFilter, setFolderFilter] = useState(DEFAULT_PATTERN_LAYOUT.folderFilter)
  const [failOnly, setFailOnly] = useState(DEFAULT_PATTERN_LAYOUT.failOnly)
  const [unknownMetadataOnly, setUnknownMetadataOnly] = useState(DEFAULT_PATTERN_LAYOUT.unknownMetadataOnly)
  const [savingLayout, setSavingLayout] = useState(false)
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<string> | null>(null)
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null)

  useEffect(() => {
    const layout = patternLayoutFromPreset(project?.exportPresets.find((preset) => preset.id === PATTERN_LAYOUT_PRESET_ID && !preset.archived))
    setRowAxes(layout.rowAxes); setColumnAxes(layout.columnAxes); setAggregation(layout.aggregation)
    setResultFilter(layout.resultFilter); setFolderFilter(layout.folderFilter); setFailOnly(layout.failOnly); setUnknownMetadataOnly(layout.unknownMetadataOnly)
    setSelectedSourceIds(null); setSelectedCellKey(null)
  }, [project?.id])

  const saveLayout = async () => {
    if (!project || !window.sequenceIntelligence?.projects || savingLayout) return
    setSavingLayout(true)
    try {
      const api = window.sequenceIntelligence.projects
      const layout = { rowAxes, columnAxes, aggregation, resultFilter, folderFilter, failOnly, unknownMetadataOnly }
      const persist = (target: ProjectSnapshot) => api.saveExportPreset({
        projectId: target.id,
        expectedRevision: target.revision,
        preset: patternLayoutPreset(layout, target.exportPresets.find((preset) => preset.id === PATTERN_LAYOUT_PRESET_ID)),
      })
      let next: ProjectSnapshot
      try {
        next = await persist(project)
      } catch (error) {
        if (!isProjectRevisionConflict(error)) throw error
        const refreshed = await api.get({ projectId: project.id })
        if (!refreshed) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        next = await persist(refreshed)
      }
      onProjectUpdated(next)
      onNotify('결과 정리 구성을 저장했습니다.', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? `레이아웃을 저장하지 못했습니다: ${error.message}` : '레이아웃을 저장하지 못했습니다.', 'error')
    } finally { setSavingLayout(false) }
  }

  const folders = useMemo(() => [...new Set(records.map((row) => row.folder))].sort((a, b) => a.localeCompare(b, 'ko-KR')), [records])
  const resultChoices = useMemo(() => [...new Set(records.map((row) => row.result))], [records])
  const filters = useMemo<LogRecordFilters>(() => ({ query: '', result: resultFilter, review: 'all', folder: folderFilter }), [folderFilter, resultFilter])
  const scopedRecords = useMemo(() => {
    const filtered = filterLogRecords(records, filters)
    return filtered.filter((row) => {
      if (failOnly && !FAIL_RESULTS.has(row.result)) return false
      if (unknownMetadataOnly && ![row.sample, row.temperature, row.mode, row.grid].some((value) => value.value === null)) return false
      return true
    })
  }, [failOnly, filters, records, unknownMetadataOnly])
  const activeDimensions = [...rowAxes, ...columnAxes].filter((axis): axis is PivotDimension => axis !== 'none')
  const grid = useMemo(() => buildPivotGrid(scopedRecords, {
    rows: rowAxes.filter((axis): axis is PivotDimension => axis !== 'none'),
    columns: columnAxes.filter((axis): axis is PivotDimension => axis !== 'none'),
    aggregation,
    filters: { query: '', result: 'all', review: 'all' },
  }), [aggregation, columnAxes, rowAxes, scopedRecords])
  useEffect(() => {
    if (!isPivotSelectionValid(selectedCellKey, selectedSourceIds, grid, scopedRecords)) {
      setSelectedCellKey(null)
      setSelectedSourceIds(null)
    }
  }, [grid, scopedRecords, selectedCellKey, selectedSourceIds])
  const visibleRows = useMemo(() => {
    if (!selectedSourceIds) return scopedRecords
    return scopedRecords.filter((row) => selectedSourceIds.has(row.id))
  }, [scopedRecords, selectedSourceIds])
  const hasFilters = resultFilter !== 'all' || folderFilter !== 'all' || failOnly || unknownMetadataOnly
  const hasSelection = selectedCellKey !== null
  const trendSummary = useMemo(() => aggregateRecordTrends(scopedRecords), [scopedRecords])
  const selectedDimensions = [...rowAxes, ...columnAxes].filter((axis): axis is PivotDimension => axis !== 'none')
  const allSelectedMetadataUnknown = selectedDimensions.some((dimension) => ['sample', 'temperature', 'mode', 'grid', 'run'].includes(dimension)
    && scopedRecords.every((row) => dimension === 'run' ? !row.run : !row[dimension as PatternAxis].value))
  const allSelectedMetadataUnconfirmed = !allSelectedMetadataUnknown && selectedDimensions.some((dimension) => ['sample', 'temperature', 'mode', 'grid'].includes(dimension)
    && scopedRecords.every((row) => row[dimension as PatternAxis].state !== 'approved'))
  const clearSelection = () => {
    setSelectedSourceIds(null)
    setSelectedCellKey(null)
  }

  const setAxis = (group: 'rows' | 'columns', index: 0 | 1, rawValue: string) => {
    const value = rawValue as PivotDimension | 'none'
    const nextRows: [PivotDimension, PivotDimension | 'none'] = [...rowAxes]
    const nextColumns: [PivotDimension, PivotDimension | 'none'] = [...columnAxes]
    const target = group === 'rows' ? nextRows : nextColumns
    target[index] = value as never
    const all = [...nextRows, ...nextColumns]
    const duplicate = all.findIndex((item, itemIndex) => item !== 'none' && all.indexOf(item) !== itemIndex)
    if (duplicate !== undefined && duplicate >= 0) {
      const duplicateGroup = duplicate < 2 ? nextRows : nextColumns
      const duplicateIndex = duplicate % 2 as 0 | 1
      if (duplicateGroup[duplicateIndex] === value && duplicateIndex === 1) duplicateGroup[duplicateIndex] = 'none'
      else if (duplicateGroup[duplicateIndex] === value) duplicateGroup[duplicateIndex] = (DIMENSIONS.find((item) => !all.includes(item.value) && item.value !== value)?.value ?? (group === 'rows' ? 'temperature' : 'sample')) as PivotDimension
    }
    setRowAxes(nextRows)
    setColumnAxes(nextColumns)
    clearSelection()
  }

  const clearAll = () => {
    setResultFilter('all')
    setFolderFilter('all')
    setFailOnly(false)
    setUnknownMetadataOnly(false)
    setSelectedSourceIds(null)
    setSelectedCellKey(null)
  }

  return <div className="data-view patterns-view">
    <header className="data-view-header"><div><h1>결과 정리</h1></div><div className="pattern-toolbar"><button onClick={() => void saveLayout()} disabled={!project || savingLayout}>{savingLayout ? '저장 중…' : '구성 저장'}</button>{hasFilters || hasSelection ? <button onClick={clearAll}><FilterX size={15} />초기화</button> : null}</div></header>

    {!records.length ? <div className="data-empty pattern-empty"><strong>분석할 로그가 없습니다.</strong><span>로그 화면에서 폴더를 추가하면 피벗이 생성됩니다.</span></div> : !scopedRecords.length ? <div className="data-empty pattern-empty"><strong>현재 필터 결과가 없습니다.</strong><span>필터를 해제하거나 다른 조건을 선택하면 로그가 표시됩니다.</span></div> : <>
      {trendSummary.trends.length ? <section className="trend-summary" aria-label="집중 경향"><ul>{trendSummary.trends.map((trend) => <li key={`${trend.dimension}-${trend.value}-${trend.outcome}`}><b>{DIMENSION_LABEL[trend.dimension]}</b> {trend.value} · {trend.outcome === 'majority' && trend.result ? RESULT_LABEL_KO[trend.result] : TREND_OUTCOME_LABEL[trend.outcome]} {trend.count}/{trend.total} ({Math.round(trend.percentage * 100)}%)</li>)}</ul></section> : null}
      <section className="pattern-section pivot-section" aria-labelledby="pivot-heading">
        <div className="pattern-section-heading"><h2 id="pivot-heading">분석 표</h2><SelectControl label="값" value={aggregation} onChange={(value) => { setAggregation(value as PivotAggregation); clearSelection() }}>{AGGREGATIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</SelectControl></div>
        <div className="pattern-controls" aria-label="패턴 필터">
          <SelectControl label="결과" value={resultFilter} onChange={(value) => { setResultFilter(value as ResultLabel | 'all'); clearSelection() }}><option value="all">전체 결과</option>{resultChoices.map((result) => <option value={result} key={result}>{RESULT_LABEL_KO[result]}</option>)}</SelectControl>
          <SelectControl label="폴더" value={folderFilter} onChange={(value) => { setFolderFilter(value); clearSelection() }}><option value="all">전체 폴더</option>{folders.map((folder) => <option value={folder} key={folder}>{folder}</option>)}</SelectControl>
          <button className={`pattern-quick-filter ${failOnly ? 'active' : ''}`} aria-pressed={failOnly} onClick={() => { setFailOnly((value) => !value); clearSelection() }}>FAIL만</button>
          <button className={`pattern-quick-filter ${unknownMetadataOnly ? 'active' : ''}`} aria-pressed={unknownMetadataOnly} onClick={() => { setUnknownMetadataOnly((value) => !value); clearSelection() }}>미확인 조건만</button>
        </div>
        <div className="pattern-axis-controls">
          <div><span>세로</span><SelectControl label="1" value={rowAxes[0]} onChange={(value) => setAxis('rows', 0, value)}>{dimensionOptions(activeDimensions, rowAxes[0]).map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</SelectControl><SelectControl label="2" value={rowAxes[1]} onChange={(value) => setAxis('rows', 1, value)}><option value="none">사용 안 함</option>{dimensionOptions(activeDimensions, rowAxes[1] as PivotDimension).map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</SelectControl></div>
          <div><span>가로</span><SelectControl label="1" value={columnAxes[0]} onChange={(value) => setAxis('columns', 0, value)}>{dimensionOptions(activeDimensions, columnAxes[0]).map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</SelectControl><SelectControl label="2" value={columnAxes[1]} onChange={(value) => setAxis('columns', 1, value)}><option value="none">사용 안 함</option>{dimensionOptions(activeDimensions, columnAxes[1] as PivotDimension).map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</SelectControl></div>
        </div>
        {allSelectedMetadataUnknown ? <p className="pivot-guidance">선택한 축 값이 모두 미확인입니다. 다른 축을 선택하거나 결과 화면에서 값을 입력하세요.</p> : allSelectedMetadataUnconfirmed ? <p className="pivot-guidance is-preview">미승인 후보로 계산한 미리보기입니다. 결과 화면에서 값을 검토하면 확정 표로 바뀝니다.</p> : null}
        <div className="pivot-scroll"><table className="pivot-table"><thead><tr><th>{rowAxes.map((axis) => axis === 'none' ? null : DIMENSION_LABEL[axis]).filter(Boolean).join(' / ')}</th>{grid.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{grid.rows.map((row, rowIndex) => <tr key={row.key}><th scope="row">{row.label}</th>{grid.columns.map((column, columnIndex) => { const cell = grid.cells[rowIndex][columnIndex]; const cellKey = `${row.key}-${column.key}`; const active = selectedCellKey === cellKey; const selectable = cell.sourceIds.length > 0; const noSourcesLabel = '관련 로그가 없어 선택할 수 없는 셀'; return <td key={column.key}><button data-testid={`pivot-cell-${row.key}-${column.key}`} className={active ? 'active' : ''} disabled={!selectable} title={selectable ? undefined : noSourcesLabel} aria-label={selectable ? `${cell.value}개 로그 선택` : `${cell.value} ${noSourcesLabel}`} onClick={() => { setSelectedCellKey(active ? null : cellKey); setSelectedSourceIds(active ? null : new Set(cell.sourceIds)) }}>{cell.value}</button></td> })}</tr>)}</tbody></table></div>
      </section>

      <section className="pattern-section marked-rows" aria-labelledby="marked-heading">
        <div className="pattern-section-heading"><h2 id="marked-heading">{hasSelection ? '선택한 로그' : '원본 로그'}</h2></div>
        <div className="marked-table-scroll"><table><thead><tr><th>파일명</th><th>폴더</th><th>Sample</th><th>온도</th><th>결과</th><th>검토</th></tr></thead><tbody>{visibleRows.slice(0, RESULT_LIMIT).map((row) => <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}><td><button onClick={(event) => { event.stopPropagation(); onOpenFile(row.id) }}>{row.fileName}</button></td><td>{row.folder}</td><td>{row.sample.value ?? '미확인'}</td><td>{row.temperature.value ?? '미확인'}</td><td><span className={`result-label result-${row.result.toLowerCase()}`}>{RESULT_LABEL_KO[row.result]}</span></td><td>{row.review === 'confirmed' ? '확정' : '검토 필요'}</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </div>
}
