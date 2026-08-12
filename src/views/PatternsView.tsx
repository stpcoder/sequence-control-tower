import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  ArrowLeftRight,
  ChevronDown,
  Clipboard,
  Download,
  FilterX,
  GripVertical,
  Plus,
  Save,
  Share2,
  Sparkles,
  X,
} from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  aggregateRecordTrends,
  buildPivotGrid,
  EXPORT_COLUMN_DEFINITIONS,
  exportCellValue,
  filterLogRecords,
  RESULT_LABEL_KO,
  serializeLogRecordsCsv,
  serializePivotGridCsv,
  serializePivotGridTsv,
  type AggregateTrend,
  type LogRecordExportColumn,
  type LogRecordFilters,
  type LogResultRecord,
  type PivotAggregation,
  type PivotCell,
  type PivotDimension,
  type PivotHeader,
} from '../state/logRecords'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import {
  DEFAULT_PATTERN_LAYOUT,
  MAX_PATTERN_AXES,
  PATTERN_LAYOUT_PRESET_ID,
  patternLayoutFromPreset,
  patternLayoutPreset,
  type PatternLayout,
} from '../state/patternLayout'
import { pivotSelectionsAgentContext, type AgentAnalysisContextRequest } from '../domain/analysis-context'

interface PatternsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
  project: ProjectSnapshot | null
  onProjectUpdated: (project: ProjectSnapshot) => void
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
  onAnalyzeContext?: (request: AgentAnalysisContextRequest) => void
}

const DIMENSIONS: Array<{ value: PivotDimension; label: string; group: string }> = [
  { value: 'sample', label: 'Sample', group: '자재' },
  { value: 'skew', label: 'SKEW', group: '자재' },
  { value: 'material', label: '자재명', group: '자재' },
  { value: 'lot', label: 'Lot', group: '자재' },
  { value: 'die', label: 'Die', group: '자재' },
  { value: 'temperature', label: '온도 (°C)', group: '평가 조건' },
  { value: 'temperatureCorner', label: '온도 조건', group: '평가 조건' },
  { value: 'vdd', label: 'VDD (V)', group: '평가 조건' },
  { value: 'vddCorner', label: 'VDD 조건', group: '평가 조건' },
  { value: 'conditionCorner', label: '4-Corner', group: '평가 조건' },
  { value: 'mode', label: 'Test Mode', group: '평가 조건' },
  { value: 'frequencyMHz', label: '주파수 (MHz)', group: '평가 조건' },
  { value: 'pattern', label: 'Pattern', group: '평가 조건' },
  { value: 'timingSkewPs', label: 'Timing SKEW (ps)', group: '평가 조건' },
  { value: 'socModel', label: '실장기 SoC', group: '실장기' },
  { value: 'dq', label: 'DQ', group: 'Fail 위치' },
  { value: 'bl', label: 'BL', group: 'Fail 위치' },
  { value: 'channel', label: 'Channel', group: 'Fail 위치' },
  { value: 'subChannel', label: 'Sub Channel', group: 'Fail 위치' },
  { value: 'chipSelect', label: 'CS', group: 'Fail 위치' },
  { value: 'rank', label: 'Rank', group: 'Fail 위치' },
  { value: 'bankGroup', label: 'Bank Group', group: 'Fail 위치' },
  { value: 'bank', label: 'Bank', group: 'Fail 위치' },
  { value: 'row', label: 'Row', group: 'Fail 위치' },
  { value: 'column', label: 'Column', group: 'Fail 위치' },
  { value: 'writeData', label: 'WR', group: 'Fail 위치' },
  { value: 'readData', label: 'RD', group: 'Fail 위치' },
  { value: 'grid', label: 'Grid', group: '결과·범위' },
  { value: 'result', label: '판정 결과', group: '결과·범위' },
  { value: 'review', label: '검토 상태', group: '결과·범위' },
  { value: 'folder', label: '평가 폴더', group: '결과·범위' },
  { value: 'run', label: '반복 번호', group: '결과·범위' },
]

const DIMENSION_LABEL = Object.fromEntries(DIMENSIONS.map((item) => [item.value, item.label])) as Record<PivotDimension, string>
const DIMENSION_EXPORT_COLUMN: Record<PivotDimension, LogRecordExportColumn> = {
  sample: 'sample_value', temperature: 'temperature_value', mode: 'mode_value', grid: 'grid_value',
  skew: 'skew', frequencyMHz: 'frequency_mhz', temperatureCorner: 'temperature_corner', vdd: 'vdd', vddCorner: 'vdd_corner', conditionCorner: 'condition_corner', pattern: 'pattern', material: 'material', lot: 'lot', die: 'die', socModel: 'soc_model',
  dq: 'dq', bl: 'bl', channel: 'channel', subChannel: 'sub_channel', chipSelect: 'chip_select', rank: 'rank', bankGroup: 'bank_group', bank: 'bank', row: 'row', column: 'column', writeData: 'write_data', readData: 'read_data', timingSkewPs: 'timing_skew_ps',
  result: 'result', review: 'review', folder: 'folder', run: 'run',
}
const AGGREGATIONS: Array<{ value: PivotAggregation; label: string }> = [
  { value: 'pass_fail', label: 'PASS / FAIL' },
  { value: 'fail_rate', label: 'FAIL률' },
  { value: 'count', label: '로그 수' },
  { value: 'sample_count', label: 'Sample 수' },
  { value: 'grid_count', label: 'Grid 수' },
  { value: 'pass_count', label: 'PASS 로그' },
  { value: 'fail_count', label: 'FAIL 로그' },
]
const PRIMARY_AGGREGATIONS = new Set<PivotAggregation>(['pass_fail', 'fail_rate', 'count'])
const primaryAggregations = AGGREGATIONS.filter((item) => PRIMARY_AGGREGATIONS.has(item.value))
const secondaryAggregations = AGGREGATIONS.filter((item) => !PRIMARY_AGGREGATIONS.has(item.value))
const FAIL_RESULTS: ReadonlySet<ResultLabel> = new Set(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
const RESULT_LIMIT = 150

const TREND_OUTCOME_LABEL: Record<AggregateTrend['outcome'], string> = {
  fail: 'Fail 3종', reboot: 'Reboot', halt: 'Halt', majority: '다수 결과',
}

type AxisGroup = 'rows' | 'columns'
type DraggedAxis = { group: AxisGroup; index: number }
type MarkedPivotCell = {
  key: string
  row: PivotHeader
  column: PivotHeader
  value: number
  sourceIds: readonly string[]
  breakdown?: PivotCell['breakdown']
}

export type PivotColumnGroup = { key: string; label: string; span: number }

/** Groups adjacent multi-level column labels so the table reads like an Excel cross table. */
export function pivotColumnHeaderRows(columns: readonly PivotHeader[], depth: number): PivotColumnGroup[][] {
  return Array.from({ length: depth }, (_, level) => {
    const groups: PivotColumnGroup[] = []
    for (const column of columns) {
      const prefix = column.values.slice(0, level + 1)
      const key = JSON.stringify(prefix)
      const previous = groups.at(-1)
      if (previous?.key === key) previous.span += 1
      else groups.push({ key, label: column.values[level] ?? '미확인', span: 1 })
    }
    return groups
  })
}

export function pivotRowHeaderSpan(rows: readonly PivotHeader[], rowIndex: number, level: number): number {
  const prefix = JSON.stringify(rows[rowIndex]?.values.slice(0, level + 1) ?? [])
  if (rowIndex > 0 && JSON.stringify(rows[rowIndex - 1]?.values.slice(0, level + 1) ?? []) === prefix) return 0
  let span = 1
  while (rowIndex + span < rows.length && JSON.stringify(rows[rowIndex + span].values.slice(0, level + 1)) === prefix) span += 1
  return span
}

/** A plain click replaces the marking; Ctrl/Cmd/Shift click adds or removes one cell. */
export function nextPivotMarking(current: ReadonlySet<string>, key: string, additive: boolean): Set<string> {
  if (!additive) return current.size === 1 && current.has(key) ? new Set() : new Set([key])
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Produces a tidy, non-empty column set for Spotfire or downstream spreadsheet analysis. */
export function analysisExportColumns(rows: readonly LogResultRecord[], axes: readonly PivotDimension[]): LogRecordExportColumn[] {
  const required = new Set<LogRecordExportColumn>(['filename', 'folder', 'result', ...axes.map((axis) => DIMENSION_EXPORT_COLUMN[axis])])
  const preferred: LogRecordExportColumn[] = [
    'filename', 'folder', 'run',
    ...axes.map((axis) => DIMENSION_EXPORT_COLUMN[axis]),
    ...EXPORT_COLUMN_DEFINITIONS.filter((column) => column.section === 'condition').map((column) => column.key),
    'result', 'stage_results', 'review', 'evidence_count',
  ]
  return [...new Set(preferred)].filter((column) => required.has(column) || rows.some((row) => exportCellValue(row, column).trim() !== ''))
}

function safeExportName(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return normalized.slice(0, 80) || 'sequence-control-tower'
}

function downloadText(contents: string, fileName: string, type = 'text/csv;charset=utf-8') {
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(new Blob([contents], { type }))
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function copyText(contents: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(contents)
      return
    }
  } catch { /* Electron can deny Clipboard API when a window loses focus. */ }
  const textarea = document.createElement('textarea')
  textarea.value = contents
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('클립보드에 복사하지 못했습니다.')
}

function formatPivotValue(value: number, aggregation: PivotAggregation, breakdown?: PivotCell['breakdown']): string {
  if (aggregation === 'pass_fail') return `P ${breakdown?.passCount ?? 0} · F ${breakdown?.failCount ?? 0}`
  if (aggregation === 'fail_rate') return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`
  return value.toLocaleString('ko-KR')
}

export function evaluationMetricSummary(aggregation: PivotAggregation, rows: readonly LogResultRecord[]): string {
  const pass = rows.filter((row) => row.result === 'PASS').length
  const fail = rows.filter((row) => FAIL_RESULTS.has(row.result)).length
  const decided = pass + fail
  const samples = new Set(rows.flatMap((row) => {
    const value = row.sample.value ?? row.dimensions?.sample
    return value === undefined || value === null || String(value).trim() === '' ? [] : [String(value).trim()]
  })).size
  const gridKeys = new Set(rows.flatMap((row) => {
    const grid = row.grid.value ?? row.dimensions?.gridId
    const sample = row.sample.value ?? row.dimensions?.sample ?? ''
    return grid === undefined || grid === null || String(grid).trim() === ''
      ? []
      : [JSON.stringify([row.folder, sample, String(grid).trim(), row.run ?? ''])]
  }))
  const gridUnknown = rows.filter((row) => {
    const value = row.grid.value ?? row.dimensions?.gridId
    return value === undefined || value === null || String(value).trim() === ''
  }).length
  if (aggregation === 'sample_count') return `중복을 제외한 Sample ${samples.toLocaleString()}개`
  if (aggregation === 'grid_count') return `확인된 Grid ${gridKeys.size.toLocaleString()}개${gridUnknown ? ` · Grid 미확인 로그 ${gridUnknown.toLocaleString()}개 제외` : ''}`
  if (aggregation === 'pass_count') return `PASS로 판정된 로그 파일 ${pass.toLocaleString()}개`
  if (aggregation === 'fail_count') return `FAIL·Training Fail·Halt·Reboot로 판정된 로그 파일 ${fail.toLocaleString()}개`
  if (aggregation === 'pass_fail') return `PASS ${pass.toLocaleString()}회 / FAIL ${fail.toLocaleString()}회 · 판정 완료 ${decided.toLocaleString()}회`
  if (aggregation === 'fail_rate') return `FAIL ${fail.toLocaleString()}회 / 판정 완료 ${decided.toLocaleString()}회 · 미확인 결과는 제외`
  if (aggregation === 'evidence_count') return '판정에 사용한 marker 줄 수'
  return `현재 범위의 로그 파일 ${rows.length.toLocaleString()}개`
}

function SelectControl({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <label className="pattern-control"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select></label>
}

function DimensionPicker({ selected, disabled, onPick }: { selected: readonly PivotDimension[]; disabled: boolean; onPick: (dimension: PivotDimension) => void }) {
  const groups = [...new Set(DIMENSIONS.map((item) => item.group))]
  return <details className="pattern-field-picker">
    <summary aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault() }}><Plus size={14} />항목</summary>
    <div className="pattern-field-menu">
      {groups.map((group) => <section key={group}><strong>{group}</strong><div>{DIMENSIONS.filter((item) => item.group === group).map((item) => <button type="button" key={item.value} disabled={selected.includes(item.value)} onClick={(event) => { onPick(item.value); event.currentTarget.closest('details')?.removeAttribute('open') }}>{item.label}</button>)}</div></section>)}
    </div>
  </details>
}

function AxisWell({ group, label, axes, selected, dragged, onDrag, onDrop, onRemove, onAdd, onKeyMove }: {
  group: AxisGroup
  label: string
  axes: readonly PivotDimension[]
  selected: readonly PivotDimension[]
  dragged: DraggedAxis | null
  onDrag: (value: DraggedAxis | null) => void
  onDrop: (from: DraggedAxis, toGroup: AxisGroup, toIndex: number) => void
  onRemove: (index: number) => void
  onAdd: (dimension: PivotDimension) => void
  onKeyMove: (group: AxisGroup, index: number, event: ReactKeyboardEvent<HTMLDivElement>) => void
}) {
  const drop = (event: ReactDragEvent, index: number) => {
    event.preventDefault()
    event.stopPropagation()
    if (dragged) onDrop(dragged, group, index)
    onDrag(null)
  }
  return <div className="pattern-axis-well" role="group" aria-label={`${label} 항목`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, axes.length)}>
    <span className="pattern-axis-label">{label}</span>
    <div className="pattern-axis-fields" role="list">
      {axes.map((axis, index) => <div
        className="pattern-axis-chip"
        draggable
        role="listitem"
        tabIndex={0}
        title="끌어서 순서나 방향 변경 · Alt+방향키 지원"
        aria-label={`${DIMENSION_LABEL[axis]}. 끌어서 순서나 방향 변경`}
        key={axis}
        onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDrag({ group, index }) }}
        onDragEnd={() => onDrag(null)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => drop(event, index)}
        onKeyDown={(event) => onKeyMove(group, index, event)}
      ><GripVertical size={13} aria-hidden="true" /><span>{DIMENSION_LABEL[axis]}</span><button type="button" onClick={() => onRemove(index)} aria-label={`${DIMENSION_LABEL[axis]} 제거`}><X size={13} /></button></div>)}
      {!axes.length ? <span className="pattern-axis-empty">전체</span> : null}
      <DimensionPicker selected={selected} disabled={axes.length >= MAX_PATTERN_AXES} onPick={onAdd} />
    </div>
  </div>
}

export function isProjectRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))
}

export function PatternsView({ records, onOpenFile, project, onProjectUpdated, onNotify, onAnalyzeContext }: PatternsViewProps) {
  const [rowAxes, setRowAxes] = useState<PatternLayout['rowAxes']>(DEFAULT_PATTERN_LAYOUT.rowAxes)
  const [columnAxes, setColumnAxes] = useState<PatternLayout['columnAxes']>(DEFAULT_PATTERN_LAYOUT.columnAxes)
  const [aggregation, setAggregation] = useState<PivotAggregation>(DEFAULT_PATTERN_LAYOUT.aggregation)
  const [resultFilter, setResultFilter] = useState<ResultLabel | 'all'>(DEFAULT_PATTERN_LAYOUT.resultFilter)
  const [folderFilter, setFolderFilter] = useState(DEFAULT_PATTERN_LAYOUT.folderFilter)
  const [failOnly, setFailOnly] = useState(DEFAULT_PATTERN_LAYOUT.failOnly)
  const [unknownMetadataOnly, setUnknownMetadataOnly] = useState(DEFAULT_PATTERN_LAYOUT.unknownMetadataOnly)
  const [savingLayout, setSavingLayout] = useState(false)
  const [markedCellKeys, setMarkedCellKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [draggedAxis, setDraggedAxis] = useState<DraggedAxis | null>(null)

  useEffect(() => {
    const layout = patternLayoutFromPreset(project?.exportPresets.find((preset) => preset.id === PATTERN_LAYOUT_PRESET_ID && !preset.archived))
    setRowAxes(layout.rowAxes); setColumnAxes(layout.columnAxes); setAggregation(layout.aggregation)
    setResultFilter(layout.resultFilter); setFolderFilter(layout.folderFilter); setFailOnly(layout.failOnly); setUnknownMetadataOnly(layout.unknownMetadataOnly)
    setMarkedCellKeys(new Set())
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
      try { next = await persist(project) }
      catch (error) {
        if (!isProjectRevisionConflict(error)) throw error
        const refreshed = await api.get({ projectId: project.id })
        if (!refreshed) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        next = await persist(refreshed)
      }
      onProjectUpdated(next)
      onNotify('표 구성을 저장했습니다.', 'success')
    } catch (error) {
      onNotify(error instanceof Error ? `구성을 저장하지 못했습니다: ${error.message}` : '구성을 저장하지 못했습니다.', 'error')
    } finally { setSavingLayout(false) }
  }

  const folders = useMemo(() => [...new Set(records.map((row) => row.folder))].sort((a, b) => a.localeCompare(b, 'ko-KR')), [records])
  const resultChoices = useMemo(() => [...new Set(records.map((row) => row.result))], [records])
  const filters = useMemo<LogRecordFilters>(() => ({ query: '', result: resultFilter, review: 'all', folder: folderFilter }), [folderFilter, resultFilter])
  const scopedRecords = useMemo(() => filterLogRecords(records, filters).filter((row) => {
    if (failOnly && !FAIL_RESULTS.has(row.result)) return false
    if (unknownMetadataOnly && ![row.sample, row.temperature, row.mode, row.grid].some((value) => value.value === null)) return false
    return true
  }), [failOnly, filters, records, unknownMetadataOnly])
  const activeDimensions = [...rowAxes, ...columnAxes]
  const pivotConfig = useMemo(() => ({ aggregation, filters: { query: '', result: 'all' as const, review: 'all' as const } }), [aggregation])
  const grid = useMemo(() => buildPivotGrid(scopedRecords, { rows: rowAxes, columns: columnAxes, ...pivotConfig }), [columnAxes, pivotConfig, rowAxes, scopedRecords])
  const rowTotals = useMemo(() => buildPivotGrid(scopedRecords, { rows: rowAxes, columns: [], ...pivotConfig }), [pivotConfig, rowAxes, scopedRecords])
  const columnTotals = useMemo(() => buildPivotGrid(scopedRecords, { rows: [], columns: columnAxes, ...pivotConfig }), [columnAxes, pivotConfig, scopedRecords])
  const rowTotalByKey = useMemo(() => new Map(rowTotals.rows.map((row, index) => [row.key, rowTotals.cells[index]?.[0]])), [rowTotals])
  const columnTotalByKey = useMemo(() => new Map(columnTotals.columns.map((column, index) => [column.key, columnTotals.cells[0]?.[index]])), [columnTotals])
  const columnHeaderRows = useMemo(() => pivotColumnHeaderRows(grid.columns, columnAxes.length), [columnAxes.length, grid.columns])
  const maxCellValue = useMemo(() => Math.max(0, ...grid.cells.flat().map((cell) => cell.value)), [grid.cells])

  const pivotCells = useMemo<MarkedPivotCell[]>(() => grid.rows.flatMap((row, rowIndex) => grid.columns.map((column, columnIndex) => ({
    key: `${row.key}-${column.key}`,
    row,
    column,
    value: grid.cells[rowIndex][columnIndex].value,
    sourceIds: grid.cells[rowIndex][columnIndex].sourceIds,
    breakdown: grid.cells[rowIndex][columnIndex].breakdown,
  }))), [grid])
  const markedCells = useMemo(() => pivotCells.filter((cell) => markedCellKeys.has(cell.key) && cell.sourceIds.length), [markedCellKeys, pivotCells])
  const markedSourceIds = useMemo(() => new Set(markedCells.flatMap((cell) => cell.sourceIds)), [markedCells])
  useEffect(() => {
    const available = new Set(pivotCells.filter((cell) => cell.sourceIds.length).map((cell) => cell.key))
    setMarkedCellKeys((current) => {
      const next = new Set([...current].filter((key) => available.has(key)))
      return next.size === current.size ? current : next
    })
  }, [pivotCells])

  const visibleRows = useMemo(() => markedCells.length ? scopedRecords.filter((row) => markedSourceIds.has(row.id)) : scopedRecords, [markedCells.length, markedSourceIds, scopedRecords])
  const hasFilters = resultFilter !== 'all' || folderFilter !== 'all' || failOnly || unknownMetadataOnly
  const hasSelection = markedCells.length > 0
  const trendSummary = useMemo(() => aggregateRecordTrends(scopedRecords), [scopedRecords])
  const allSelectedMetadataUnknown = activeDimensions.some((dimension) => scopedRecords.every((row) => {
    if (dimension === 'run') return !row.run
    if (dimension === 'sample' || dimension === 'temperature' || dimension === 'mode' || dimension === 'grid') return !row[dimension].value
    if (dimension === 'result' || dimension === 'review' || dimension === 'folder') return false
    const value = row.dimensions?.[dimension]
    return value === undefined || value === null || value === ''
  }))
  const clearSelection = () => setMarkedCellKeys(new Set())

  const setAxes = (nextRows: PivotDimension[], nextColumns: PivotDimension[]) => {
    setRowAxes(nextRows); setColumnAxes(nextColumns); clearSelection()
  }
  const removeAxis = (group: AxisGroup, index: number) => {
    const nextRows = [...rowAxes], nextColumns = [...columnAxes]
    ;(group === 'rows' ? nextRows : nextColumns).splice(index, 1)
    setAxes(nextRows, nextColumns)
  }
  const addAxis = (group: AxisGroup, dimension: PivotDimension) => {
    if (activeDimensions.includes(dimension)) return
    const nextRows = [...rowAxes], nextColumns = [...columnAxes]
    const target = group === 'rows' ? nextRows : nextColumns
    if (target.length >= MAX_PATTERN_AXES) return
    target.push(dimension)
    setAxes(nextRows, nextColumns)
  }
  const moveAxis = (from: DraggedAxis, toGroup: AxisGroup, toIndex: number) => {
    const nextRows = [...rowAxes], nextColumns = [...columnAxes]
    const source = from.group === 'rows' ? nextRows : nextColumns
    const target = toGroup === 'rows' ? nextRows : nextColumns
    if (from.group !== toGroup && target.length >= MAX_PATTERN_AXES) return
    const [axis] = source.splice(from.index, 1)
    if (!axis) return
    let insertion = Math.max(0, Math.min(toIndex, target.length))
    if (source === target && from.index < toIndex) insertion -= 1
    target.splice(insertion, 0, axis)
    setAxes(nextRows, nextColumns)
  }
  const keyboardMoveAxis = (group: AxisGroup, index: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!event.altKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      const target = (group === 'rows' ? rowAxes : columnAxes)
      const nextIndex = Math.max(0, Math.min(target.length - 1, index + direction))
      if (nextIndex === index) return
      const nextRows = [...rowAxes], nextColumns = [...columnAxes]
      const axes = group === 'rows' ? nextRows : nextColumns
      ;[axes[index], axes[nextIndex]] = [axes[nextIndex], axes[index]]
      setAxes(nextRows, nextColumns)
    } else if ((event.key === 'ArrowUp' && group === 'columns') || (event.key === 'ArrowDown' && group === 'rows')) {
      event.preventDefault()
      moveAxis({ group, index }, group === 'rows' ? 'columns' : 'rows', group === 'rows' ? columnAxes.length : rowAxes.length)
    }
  }

  const clearAll = () => {
    setResultFilter('all'); setFolderFilter('all'); setFailOnly(false); setUnknownMetadataOnly(false); clearSelection()
  }
  const rowLabels = rowAxes.length ? rowAxes.map((axis) => DIMENSION_LABEL[axis]) : ['전체']
  const secondaryAggregation = secondaryAggregations.find((item) => item.value === aggregation)
  const pivotExportOptions = aggregation === 'pass_fail' ? {
    rowTotals: grid.rows.map((row) => { const cell = rowTotalByKey.get(row.key); return formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown) }),
    columnTotals: grid.columns.map((column) => { const cell = columnTotalByKey.get(column.key); return formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown) }),
    grandTotal: formatPivotValue(grid.total, aggregation, grid.breakdown),
    formatCell: (cell: PivotCell) => formatPivotValue(cell.value, aggregation, cell.breakdown),
  } : {
    rowTotals: grid.rows.map((row) => rowTotalByKey.get(row.key)?.value ?? 0),
    columnTotals: grid.columns.map((column) => columnTotalByKey.get(column.key)?.value ?? 0),
    grandTotal: grid.total,
    formatValue: (value: number) => aggregation === 'fail_rate' ? formatPivotValue(value, aggregation) : value,
  }
  const projectFileName = safeExportName(project?.name ?? 'sequence-control-tower')
  const closeShareMenu = (target: HTMLElement) => target.closest('details')?.removeAttribute('open')
  const copyPivot = async (target: HTMLElement) => {
    try {
      await copyText(serializePivotGridTsv(grid, rowLabels, pivotExportOptions))
      closeShareMenu(target)
      onNotify('현재 표를 복사했습니다. Excel이나 메신저에 붙여넣을 수 있습니다.', 'success')
    } catch (error) { onNotify(error instanceof Error ? error.message : '표를 복사하지 못했습니다.', 'error') }
  }
  const downloadPivot = (target: HTMLElement) => {
    downloadText(serializePivotGridCsv(grid, rowLabels, pivotExportOptions), `${projectFileName}-analysis-table.csv`)
    closeShareMenu(target)
    onNotify('현재 표를 CSV로 저장했습니다.', 'success')
  }
  const downloadRaw = (target: HTMLElement) => {
    const columns = analysisExportColumns(scopedRecords, activeDimensions)
    downloadText(serializeLogRecordsCsv(scopedRecords, columns), `${projectFileName}-spotfire-data.csv`)
    closeShareMenu(target)
    onNotify(`${scopedRecords.length.toLocaleString()}개 로그를 분석용 CSV로 저장했습니다.`, 'success')
  }
  const downloadSelected = (target: HTMLElement) => {
    const columns = analysisExportColumns(visibleRows, activeDimensions)
    downloadText(serializeLogRecordsCsv(visibleRows, columns), `${projectFileName}-selected-data.csv`)
    closeShareMenu(target)
    onNotify(`${visibleRows.length.toLocaleString()}개 선택 로그를 CSV로 저장했습니다.`, 'success')
  }
  const analyzeSelection = () => {
    if (!onAnalyzeContext || !markedCells.length) return
    onAnalyzeContext(pivotSelectionsAgentContext({
      rows: visibleRows,
      rowAxes,
      columnAxes,
      aggregation,
      selections: markedCells.map((cell) => ({
        rowValues: cell.row.values,
        columnValues: cell.column.values,
        displayValue: formatPivotValue(cell.value, aggregation, cell.breakdown),
      })),
    }))
  }

  return <div className="data-view patterns-view">
    <header className="data-view-header"><div><h1>결과 정리</h1></div><div className="data-actions pattern-toolbar">
      <details className="pattern-share"><summary><Share2 size={16} />공유<ChevronDown size={14} /></summary><div className="pattern-share-menu">
        <div className="pattern-share-summary"><strong>{rowLabels.join(' · ')} × {columnAxes.length ? columnAxes.map((axis) => DIMENSION_LABEL[axis]).join(' · ') : '전체'}</strong><span>{AGGREGATIONS.find((item) => item.value === aggregation)?.label}</span></div>
        <button type="button" onClick={(event) => void copyPivot(event.currentTarget)}><Clipboard size={16} /><span><b>표 복사</b><small>Excel·메신저에 붙여넣기</small></span></button>
        <button type="button" onClick={(event) => downloadPivot(event.currentTarget)}><Download size={16} /><span><b>현재 표 CSV</b><small>화면의 가로·세로 구성</small></span></button>
        {hasSelection ? <button type="button" onClick={(event) => downloadSelected(event.currentTarget)}><Download size={16} /><span><b>선택 로그 CSV</b><small>선택한 셀의 원본 행</small></span></button> : null}
        <button type="button" onClick={(event) => downloadRaw(event.currentTarget)}><Download size={16} /><span><b>분석용 원본 CSV</b><small>Spotfire용 · 로그 1개당 1행</small></span></button>
      </div></details>
      <button onClick={() => void saveLayout()} disabled={!project || savingLayout}><Save size={16} />{savingLayout ? '저장 중…' : '구성 저장'}</button>
      {hasFilters || hasSelection ? <button onClick={clearAll}><FilterX size={15} />초기화</button> : null}
    </div></header>

    {!records.length ? <div className="data-empty pattern-empty"><strong>분석할 로그가 없습니다.</strong><span>로그 화면에서 폴더를 추가하세요.</span></div> : !scopedRecords.length ? <div className="data-empty pattern-empty"><strong>조건에 맞는 로그가 없습니다.</strong><span>필터를 초기화해 보세요.</span></div> : <>
      {trendSummary.trends.length ? <section className="trend-summary" aria-label="집중 경향"><ul>{trendSummary.trends.map((trend) => <li key={`${trend.dimension}-${trend.value}-${trend.outcome}`}><b>{DIMENSION_LABEL[trend.dimension]}</b> {trend.value} · {trend.outcome === 'majority' && trend.result ? RESULT_LABEL_KO[trend.result] : TREND_OUTCOME_LABEL[trend.outcome]} {trend.count}/{trend.total} ({Math.round(trend.percentage * 100)}%)</li>)}</ul></section> : null}
      <section className="pattern-section pivot-section" aria-labelledby="pivot-heading">
        <div className="pattern-section-heading"><h2 id="pivot-heading">분석 표</h2><div className="pattern-metrics" aria-label="표에 표시할 값">
          {primaryAggregations.map((item) => <button type="button" role="radio" aria-checked={aggregation === item.value} className={aggregation === item.value ? 'active' : ''} key={item.value} onClick={() => { setAggregation(item.value); clearSelection() }}>{item.label}</button>)}
          <details className="pattern-metric-more"><summary className={secondaryAggregation ? 'active' : ''}>{secondaryAggregation?.label ?? '기타'}<ChevronDown size={13} /></summary><div className="pattern-metric-menu" role="radiogroup" aria-label="다른 집계 방식">
            {secondaryAggregations.map((item) => <button type="button" role="radio" aria-checked={aggregation === item.value} className={aggregation === item.value ? 'active' : ''} key={item.value} onClick={(event) => { setAggregation(item.value); clearSelection(); event.currentTarget.closest('details')?.removeAttribute('open') }}>{item.label}</button>)}
          </div></details>
        </div></div>
        <p className="pattern-metric-note">{evaluationMetricSummary(aggregation, scopedRecords)}</p>
        <div className="pattern-controls" aria-label="표 필터">
          <SelectControl label="평가" value={folderFilter} onChange={(value) => { setFolderFilter(value); clearSelection() }}><option value="all">전체 평가</option>{folders.map((folder) => <option value={folder} key={folder}>{folder}</option>)}</SelectControl>
          <SelectControl label="결과" value={resultFilter} onChange={(value) => { setResultFilter(value as ResultLabel | 'all'); clearSelection() }}><option value="all">전체 결과</option>{resultChoices.map((result) => <option value={result} key={result}>{RESULT_LABEL_KO[result]}</option>)}</SelectControl>
          <button className={`pattern-quick-filter ${failOnly ? 'active' : ''}`} aria-pressed={failOnly} onClick={() => { setFailOnly((value) => !value); clearSelection() }}>FAIL만</button>
          <button className={`pattern-quick-filter ${unknownMetadataOnly ? 'active' : ''}`} aria-pressed={unknownMetadataOnly} onClick={() => { setUnknownMetadataOnly((value) => !value); clearSelection() }}>미확인 조건만</button>
        </div>
        <div className="pattern-axis-builder">
          <AxisWell group="rows" label="세로" axes={rowAxes} selected={activeDimensions} dragged={draggedAxis} onDrag={setDraggedAxis} onDrop={moveAxis} onRemove={(index) => removeAxis('rows', index)} onAdd={(dimension) => addAxis('rows', dimension)} onKeyMove={keyboardMoveAxis} />
          <button type="button" className="pattern-swap-axes" onClick={() => setAxes([...columnAxes], [...rowAxes])} title="가로와 세로 바꾸기"><ArrowLeftRight size={15} />축 바꾸기</button>
          <AxisWell group="columns" label="가로" axes={columnAxes} selected={activeDimensions} dragged={draggedAxis} onDrag={setDraggedAxis} onDrop={moveAxis} onRemove={(index) => removeAxis('columns', index)} onAdd={(dimension) => addAxis('columns', dimension)} onKeyMove={keyboardMoveAxis} />
        </div>
        {allSelectedMetadataUnknown ? <p className="pivot-guidance">선택한 항목의 값이 모두 미확인입니다. 다른 항목을 선택하거나 결과 화면에서 값을 입력하세요.</p> : null}
        <div className="pivot-scroll"><table className={`pivot-table metric-${aggregation}`} style={{ minWidth: Math.max(720, (rowAxes.length || 1) * 118 + grid.columns.length * 82 + 90) }}>
          <thead>{columnHeaderRows.length ? columnHeaderRows.map((groups, level) => <tr key={level}>{level === 0 ? (rowAxes.length ? rowAxes.map((axis) => <th className="pivot-row-axis" rowSpan={columnHeaderRows.length} key={axis}>{DIMENSION_LABEL[axis]}</th>) : <th className="pivot-row-axis" rowSpan={columnHeaderRows.length}>전체</th>) : null}{groups.map((group) => <th colSpan={group.span} key={group.key}>{group.label}</th>)}{level === 0 ? <th className="pivot-total" rowSpan={columnHeaderRows.length}>합계</th> : null}</tr>) : <tr>{rowAxes.length ? rowAxes.map((axis) => <th className="pivot-row-axis" key={axis}>{DIMENSION_LABEL[axis]}</th>) : <th className="pivot-row-axis">전체</th>}<th>전체</th><th className="pivot-total">합계</th></tr>}</thead>
          <tbody>{grid.rows.map((row, rowIndex) => <tr key={row.key}>{rowAxes.length ? rowAxes.map((axis, level) => { const span = pivotRowHeaderSpan(grid.rows, rowIndex, level); return span ? <th className="pivot-row-value" scope="row" rowSpan={span} key={axis}>{row.values[level] ?? '미확인'}</th> : null }) : <th className="pivot-row-value" scope="row">전체</th>}{grid.columns.map((column, columnIndex) => {
            const cell = grid.cells[rowIndex][columnIndex]
            const cellKey = `${row.key}-${column.key}`
            const active = markedCellKeys.has(cellKey)
            const selectable = cell.sourceIds.length > 0
            const display = formatPivotValue(cell.value, aggregation, cell.breakdown)
            const intensity = aggregation === 'pass_fail'
              ? cell.breakdown?.definitiveCount ? Math.max(.05, cell.breakdown.failCount / cell.breakdown.definitiveCount) : 0
              : maxCellValue ? Math.max(.05, cell.value / maxCellValue) : 0
            return <td key={column.key}><button data-testid={`pivot-cell-${row.key}-${column.key}`} className={active ? 'active' : ''} style={{ '--pivot-intensity': intensity } as CSSProperties} disabled={!selectable} aria-pressed={active} title={selectable ? `${cell.sourceIds.length.toLocaleString()}개 로그 · Ctrl/⌘ 클릭으로 조건 추가` : '관련 로그 없음'} aria-label={selectable ? `${display}, 관련 로그 ${cell.sourceIds.length}개${active ? ', 선택됨' : ''}` : `${display}, 관련 로그 없음`} onClick={(event) => setMarkedCellKeys((current) => nextPivotMarking(current, cellKey, event.ctrlKey || event.metaKey || event.shiftKey))}>{display}</button></td>
          })}<td className="pivot-total">{formatPivotValue(rowTotalByKey.get(row.key)?.value ?? 0, aggregation, rowTotalByKey.get(row.key)?.breakdown)}</td></tr>)}</tbody>
          <tfoot><tr><th className="pivot-total-label" colSpan={rowAxes.length || 1}>합계</th>{grid.columns.map((column) => <td className="pivot-total" key={column.key}>{formatPivotValue(columnTotalByKey.get(column.key)?.value ?? 0, aggregation, columnTotalByKey.get(column.key)?.breakdown)}</td>)}<td className="pivot-total pivot-grand-total">{formatPivotValue(grid.total, aggregation, grid.breakdown)}</td></tr></tfoot>
        </table></div>
      </section>

      <section className="pattern-section marked-rows" aria-labelledby="marked-heading">
        <div className="pattern-section-heading"><h2 id="marked-heading">{hasSelection ? markedCells.length > 1 ? `선택한 조건 ${markedCells.length.toLocaleString()}개 · 로그 ${visibleRows.length.toLocaleString()}개` : `선택한 로그 ${visibleRows.length.toLocaleString()}개` : '원본 로그'}</h2>{hasSelection ? <div className="pattern-selection-actions">{onAnalyzeContext ? <button type="button" onClick={analyzeSelection}><Sparkles size={15} />{markedCells.length > 1 ? 'Agent로 비교' : 'Agent로 해석'}</button> : null}<button type="button" onClick={clearSelection}><X size={15} />선택 해제</button></div> : null}</div>
        <div className="marked-table-scroll"><table><thead><tr><th>파일명</th><th>평가 폴더</th><th>Sample</th><th>온도</th><th>결과</th><th>확인 상태</th></tr></thead><tbody>{visibleRows.slice(0, RESULT_LIMIT).map((row) => <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}><td><button onClick={(event) => { event.stopPropagation(); onOpenFile(row.id) }}>{row.fileName}</button></td><td>{row.folder}</td><td>{row.sample.value ?? '미확인'}</td><td>{row.temperature.value ?? '미확인'}</td><td><span className={`result-label result-${row.result.toLowerCase()}`}>{RESULT_LABEL_KO[row.result]}</span></td><td>{row.review === 'confirmed' ? '확정' : '검토 필요'}</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </div>
}
