import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  ArrowLeftRight,
  ChartBar,
  ChartBarStacked,
  ChartColumn,
  ChartLine,
  ChartNoAxesCombined,
  ChevronDown,
  Clipboard,
  Download,
  FilterX,
  Grid3X3,
  GripVertical,
  Plus,
  Save,
  Share2,
  Sparkles,
  Table2,
  X,
} from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  buildPivotGrid,
  EXPORT_COLUMN_DEFINITIONS,
  exportCellValue,
  filterLogRecords,
  RESULT_LABEL_KO,
  serializeLogRecordsCsv,
  serializeFailureAddressEventsCsv,
  serializePivotGridCsv,
  serializePivotGridTsv,
  summarizeFailureAddressEvents,
  isFailureAddressAggregation,
  type LogRecordExportColumn,
  type LogRecordFilters,
  type LogResultRecord,
  type PivotAggregation,
  type PivotCell,
  type PivotDimension,
  type PivotHeader,
} from '../state/logRecords'
import type { NativeAgentAnalysisViewProposal, ProjectSnapshot } from '../../electron/shared/contracts'
import {
  DEFAULT_PATTERN_LAYOUT,
  MAX_PATTERN_AXES,
  PATTERN_LAYOUT_PRESET_ID,
  patternLayoutFromPreset,
  patternLayoutPreset,
  patternLayoutWithAgentProposal,
  type PatternLayout,
} from '../state/patternLayout'
import { analysisViewAgentContext, type AgentAnalysisContextRequest } from '../domain/analysis-context'
import {
  ANALYSIS_DATA_BASIS_LABELS,
  ANALYSIS_VIEW_PRESETS,
  ANALYSIS_VISUALIZATION_LABELS,
  type AnalysisDataBasis,
  type AnalysisViewPreset,
  type AnalysisVisualization,
} from '../domain/analysis-view'

const AnalysisChart = lazy(async () => ({
  default: (await import('../components/AnalysisChart')).AnalysisChart,
}))

interface PatternsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
  project: ProjectSnapshot | null
  onProjectUpdated: (project: ProjectSnapshot) => void
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
  onAnalyzeContext?: (request: AgentAnalysisContextRequest) => void
  agentViewRequest?: NativeAgentAnalysisViewProposal | null
  onAgentViewRequestConsumed?: () => void
}

const DIMENSIONS: Array<{ value: PivotDimension; label: string; group: string }> = [
  { value: 'sample', label: '자재 (Sample)', group: '자재' },
  { value: 'skew', label: 'SKEW', group: '자재' },
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
  { value: 'equipmentChannel', label: '실장기 채널', group: '실장기' },
  { value: 'eccMode', label: 'ECC', group: '평가 조건' },
  { value: 'customCondition', label: '사용자 조건', group: '평가 조건' },
  { value: 'evaluationStep', label: '평가 Step', group: '평가 조건' },
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
const FAILURE_ADDRESS_DIMENSIONS = new Set<PivotDimension>(['dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bankGroup', 'bank', 'row', 'column', 'writeData', 'readData'])
const DIMENSION_EXPORT_COLUMN: Record<PivotDimension, LogRecordExportColumn> = {
  sample: 'sample_value', temperature: 'temperature_value', mode: 'mode_value', grid: 'grid_value',
  skew: 'skew', frequencyMHz: 'frequency_mhz', temperatureCorner: 'temperature_corner', vdd: 'vdd', vddCorner: 'vdd_corner', conditionCorner: 'condition_corner', pattern: 'pattern', material: 'material', lot: 'lot', die: 'die', socModel: 'soc_model', equipmentChannel: 'equipment_channel', eccMode: 'ecc_mode', customCondition: 'custom_condition', evaluationStep: 'evaluation_step',
  dq: 'dq', bl: 'bl', channel: 'channel', subChannel: 'sub_channel', chipSelect: 'chip_select', rank: 'rank', bankGroup: 'bank_group', bank: 'bank', row: 'row', column: 'column', writeData: 'write_data', readData: 'read_data', timingSkewPs: 'timing_skew_ps',
  result: 'result', review: 'review', folder: 'folder', run: 'run',
}
const AGGREGATIONS: Array<{ value: PivotAggregation; label: string }> = [
  { value: 'pass_fail', label: '판정 결과' },
  { value: 'fail_count', label: 'FAIL 횟수' },
  { value: 'fail_rate', label: '불량률' },
  { value: 'sample_count', label: 'Sample 수' },
  { value: 'grid_count', label: 'Grid 수' },
  { value: 'pass_count', label: 'PASS 횟수' },
  { value: 'fail_event_count', label: '이벤트 수' },
  { value: 'fail_source_count', label: '포함 로그 수' },
  { value: 'fail_event_share', label: '이벤트 비율' },
]
const EVALUATION_PRIMARY = new Set<PivotAggregation>(['pass_fail', 'fail_count', 'fail_rate'])
const ADDRESS_PRIMARY = new Set<PivotAggregation>(['fail_event_count', 'fail_source_count', 'fail_event_share'])
const FAIL_RESULTS: ReadonlySet<ResultLabel> = new Set(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
const RESULT_LIMIT = 150

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

const VISUALIZATION_ICONS: Record<AnalysisVisualization, typeof Table2> = {
  cross_table: Table2,
  heatmap: Grid3X3,
  bar: ChartColumn,
  bar_horizontal: ChartBar,
  stacked_bar: ChartBarStacked,
  stacked_percent: ChartBarStacked,
  line: ChartLine,
  combo: ChartNoAxesCombined,
}

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

function formatPivotValue(value: number, aggregation: PivotAggregation, breakdown?: PivotCell['breakdown'], failureAddress?: PivotCell['failureAddress']): string {
  if (aggregation === 'pass_fail') {
    const pass = breakdown?.passCount ?? 0
    const fail = breakdown?.failCount ?? 0
    if (!pass && !fail) return '미확인'
    if (!fail) return pass === 1 ? 'PASS' : `PASS ${pass.toLocaleString('ko-KR')}`
    if (!pass) return `${fail === 1 ? 'FAIL' : `FAIL ${fail.toLocaleString('ko-KR')}`}${breakdown?.topFailureSignature ? ` · ${breakdown.topFailureSignature}` : ''}`
    return `PASS ${pass.toLocaleString('ko-KR')} · FAIL ${fail.toLocaleString('ko-KR')}`
  }
  if (aggregation === 'fail_rate') return `${breakdown?.failCount ?? 0}/${breakdown?.definitiveCount ?? 0} · ${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`
  if (aggregation === 'fail_count') return `FAIL ${value.toLocaleString('ko-KR')}`
  if (aggregation === 'pass_count') return `PASS ${value.toLocaleString('ko-KR')}`
  if (aggregation === 'fail_event_count') return `${value.toLocaleString('ko-KR')}회${failureAddress?.topSignature ? ` · ${failureAddress.topSignature}` : ''}`
  if (aggregation === 'fail_source_count') return `${value.toLocaleString('ko-KR')}개 로그`
  if (aggregation === 'fail_event_share') return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`
  return value.toLocaleString('ko-KR')
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

export function PatternsView({ records, onOpenFile, project, onProjectUpdated, onNotify, onAnalyzeContext, agentViewRequest, onAgentViewRequestConsumed }: PatternsViewProps) {
  const [rowAxes, setRowAxes] = useState<PatternLayout['rowAxes']>(DEFAULT_PATTERN_LAYOUT.rowAxes)
  const [columnAxes, setColumnAxes] = useState<PatternLayout['columnAxes']>(DEFAULT_PATTERN_LAYOUT.columnAxes)
  const [aggregation, setAggregation] = useState<PivotAggregation>(DEFAULT_PATTERN_LAYOUT.aggregation)
  const [visualization, setVisualization] = useState<AnalysisVisualization>(DEFAULT_PATTERN_LAYOUT.visualization)
  const [dataBasis, setDataBasis] = useState<AnalysisDataBasis>(DEFAULT_PATTERN_LAYOUT.dataBasis)
  const [resultFilter, setResultFilter] = useState<ResultLabel | 'all'>(DEFAULT_PATTERN_LAYOUT.resultFilter)
  const [folderFilter, setFolderFilter] = useState(DEFAULT_PATTERN_LAYOUT.folderFilter)
  const [failOnly, setFailOnly] = useState(DEFAULT_PATTERN_LAYOUT.failOnly)
  const [unknownMetadataOnly, setUnknownMetadataOnly] = useState(DEFAULT_PATTERN_LAYOUT.unknownMetadataOnly)
  const [savingLayout, setSavingLayout] = useState(false)
  const [markedCellKeys, setMarkedCellKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [draggedAxis, setDraggedAxis] = useState<DraggedAxis | null>(null)
  const [rawDetailsOpen, setRawDetailsOpen] = useState(false)
  const [agentPreview, setAgentPreview] = useState<{ id: string; previous: PatternLayout; proposal: NativeAgentAnalysisViewProposal } | null>(null)
  const chartExportRef = useRef<(() => string | null) | null>(null)

  useEffect(() => {
    const layout = patternLayoutFromPreset(project?.exportPresets.find((preset) => preset.id === PATTERN_LAYOUT_PRESET_ID && !preset.archived))
    setRowAxes(layout.rowAxes); setColumnAxes(layout.columnAxes); setAggregation(layout.aggregation); setVisualization(layout.visualization); setDataBasis(layout.dataBasis)
    setResultFilter(layout.resultFilter); setFolderFilter(layout.folderFilter); setFailOnly(layout.failOnly); setUnknownMetadataOnly(layout.unknownMetadataOnly)
    setMarkedCellKeys(new Set())
    setAgentPreview(null)
  }, [project?.id])

  useEffect(() => {
    if (!agentViewRequest || agentPreview?.id === agentViewRequest.id) return
    setAgentPreview({
      id: agentViewRequest.id,
      previous: { rowAxes, columnAxes, aggregation, visualization, dataBasis, resultFilter, folderFilter, failOnly, unknownMetadataOnly },
      proposal: agentViewRequest,
    })
    const next = patternLayoutWithAgentProposal({ rowAxes, columnAxes, aggregation, visualization, dataBasis, resultFilter, folderFilter, failOnly, unknownMetadataOnly }, agentViewRequest)
    setRowAxes(next.rowAxes); setColumnAxes(next.columnAxes); setAggregation(next.aggregation); setVisualization(next.visualization); setDataBasis(next.dataBasis)
    setResultFilter(next.resultFilter); setFolderFilter(next.folderFilter); setFailOnly(next.failOnly); setUnknownMetadataOnly(next.unknownMetadataOnly)
    setMarkedCellKeys(new Set())
    onAgentViewRequestConsumed?.()
  }, [agentViewRequest?.id])

  const saveLayout = async () => {
    if (!project || !window.sequenceIntelligence?.projects || savingLayout) return
    setSavingLayout(true)
    try {
      const api = window.sequenceIntelligence.projects
      const layout = { rowAxes, columnAxes, aggregation, visualization, dataBasis, resultFilter, folderFilter, failOnly, unknownMetadataOnly }
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
      setAgentPreview(null)
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
  const primaryAggregationSet = dataBasis === 'failure_address' ? ADDRESS_PRIMARY : EVALUATION_PRIMARY
  const primaryAggregations = AGGREGATIONS.filter((item) => primaryAggregationSet.has(item.value))
  const secondaryAggregations = AGGREGATIONS.filter((item) => !primaryAggregationSet.has(item.value) && (dataBasis === 'failure_address' ? isFailureAddressAggregation(item.value) : !isFailureAddressAggregation(item.value)))
  const pivotConfig = useMemo(() => ({ aggregation, filters: { query: '', result: 'all' as const, review: 'all' as const } }), [aggregation])
  const grid = useMemo(() => buildPivotGrid(scopedRecords, { rows: rowAxes, columns: columnAxes, ...pivotConfig }), [columnAxes, pivotConfig, rowAxes, scopedRecords])
  const passFailGrid = useMemo(() => buildPivotGrid(scopedRecords, {
    rows: rowAxes,
    columns: columnAxes,
    aggregation: 'pass_fail',
    filters: { query: '', result: 'all', review: 'all' },
  }), [columnAxes, rowAxes, scopedRecords])
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
  const visibleFailureAddresses = useMemo(() => summarizeFailureAddressEvents(visibleRows), [visibleRows])
  const hasFilters = resultFilter !== 'all' || folderFilter !== 'all' || failOnly || unknownMetadataOnly
  const hasSelection = markedCells.length > 0
  const unknownActiveDimensions = activeDimensions.filter((dimension) => scopedRecords.every((row) => {
    if (dimension === 'run') return !row.run
    if (dataBasis === 'failure_address' && FAILURE_ADDRESS_DIMENSIONS.has(dimension)) {
      return !(row.failureAddressEvents ?? []).some((event) => {
        const value = event.fields[dimension as keyof typeof event.fields]
        return value !== undefined && value !== null && value !== ''
      })
    }
    if (dimension === 'sample' || dimension === 'temperature' || dimension === 'mode' || dimension === 'grid') return !row[dimension].value
    if (dimension === 'result' || dimension === 'review' || dimension === 'folder') return false
    const value = row.dimensions?.[dimension]
    return value === undefined || value === null || value === ''
  }))
  const clearSelection = () => setMarkedCellKeys(new Set())
  const undoAgentPreview = () => {
    if (!agentPreview) return
    const previous = agentPreview.previous
    setRowAxes(previous.rowAxes); setColumnAxes(previous.columnAxes); setAggregation(previous.aggregation); setVisualization(previous.visualization); setDataBasis(previous.dataBasis)
    setResultFilter(previous.resultFilter); setFolderFilter(previous.folderFilter); setFailOnly(previous.failOnly); setUnknownMetadataOnly(previous.unknownMetadataOnly)
    setAgentPreview(null); clearSelection()
  }

  const markChartCells = (cellKeys: readonly string[], additive: boolean) => {
    setMarkedCellKeys((current) => {
      const next = additive ? new Set(current) : new Set<string>()
      const allActive = cellKeys.every((key) => next.has(key))
      cellKeys.forEach((key) => allActive ? next.delete(key) : next.add(key))
      return next
    })
  }

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
  const activePreset = ANALYSIS_VIEW_PRESETS.find((preset) =>
    preset.basis === dataBasis
    &&
    preset.visualization === visualization
    && preset.aggregation === aggregation
    && JSON.stringify(preset.rowAxes) === JSON.stringify(rowAxes)
    && JSON.stringify(preset.columnAxes) === JSON.stringify(columnAxes),
  )
  const availableVisualizations = (Object.keys(ANALYSIS_VISUALIZATION_LABELS) as AnalysisVisualization[]).filter((item) =>
    dataBasis === 'evaluation' || ['cross_table', 'heatmap', 'bar', 'bar_horizontal'].includes(item),
  )
  const VisualizationIcon = VISUALIZATION_ICONS[visualization]
  const pivotExportOptions = {
    rowTotals: grid.rows.map((row) => { const cell = rowTotalByKey.get(row.key); return formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown, cell?.failureAddress) }),
    columnTotals: grid.columns.map((column) => { const cell = columnTotalByKey.get(column.key); return formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown, cell?.failureAddress) }),
    grandTotal: formatPivotValue(grid.total, aggregation, grid.breakdown, grid.failureAddress),
    formatCell: (cell: PivotCell) => formatPivotValue(cell.value, aggregation, cell.breakdown, cell.failureAddress),
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
    onNotify(`${scopedRecords.length.toLocaleString()}개 평가 결과를 CSV로 저장했습니다.`, 'success')
  }
  const downloadFailureAddresses = (target: HTMLElement) => {
    downloadText(serializeFailureAddressEventsCsv(visibleRows), `${projectFileName}-fail-address-events.csv`)
    closeShareMenu(target)
    onNotify(`Fail 주소 이벤트 ${visibleFailureAddresses.eventCount.toLocaleString()}회를 CSV로 저장했습니다.`, 'success')
  }
  const downloadSelected = (target: HTMLElement) => {
    const columns = analysisExportColumns(visibleRows, activeDimensions)
    downloadText(serializeLogRecordsCsv(visibleRows, columns), `${projectFileName}-selected-data.csv`)
    closeShareMenu(target)
    onNotify(`${visibleRows.length.toLocaleString()}개 선택 로그를 CSV로 저장했습니다.`, 'success')
  }
  const downloadChart = (target: HTMLElement) => {
    const image = chartExportRef.current?.()
    if (!image) return
    const anchor = document.createElement('a')
    anchor.href = image
    anchor.download = `${projectFileName}-${visualization}.png`
    anchor.click()
    closeShareMenu(target)
    onNotify('현재 시각화를 PNG로 저장했습니다.', 'success')
  }
  const analyzeView = () => {
    if (!onAnalyzeContext) return
    const rows = hasSelection ? visibleRows : scopedRecords
    onAnalyzeContext(analysisViewAgentContext({
      rows,
      rowAxes,
      columnAxes,
      aggregation,
      visualization,
      dataBasis,
      selected: markedCells.map((cell) => ({
        rowValues: cell.row.values,
        columnValues: cell.column.values,
        displayValue: formatPivotValue(cell.value, aggregation, cell.breakdown),
      })),
    }))
  }
  const changeVisualization = (next: AnalysisVisualization) => {
    setVisualization(next)
    if ((next === 'stacked_bar' || next === 'stacked_percent' || next === 'combo') && aggregation !== 'pass_fail') setAggregation('pass_fail')
    if (next === 'line' && aggregation === 'pass_fail') setAggregation('fail_rate')
  }
  const changeDataBasis = (next: AnalysisDataBasis) => {
    const preset = ANALYSIS_VIEW_PRESETS.find((item) => item.basis === next)
    if (!preset) return
    setDataBasis(next)
    setAxes([...preset.rowAxes], [...preset.columnAxes])
    setAggregation(preset.aggregation)
    setVisualization(preset.visualization)
  }
  const changeAggregation = (next: PivotAggregation) => {
    setAggregation(next)
    if ((visualization === 'stacked_bar' || visualization === 'stacked_percent' || visualization === 'combo') && next !== 'pass_fail') setVisualization('cross_table')
    clearSelection()
  }
  const applyViewPreset = (preset: AnalysisViewPreset, target: HTMLElement) => {
    setAxes([...preset.rowAxes], [...preset.columnAxes])
    setDataBasis(preset.basis)
    setAggregation(preset.aggregation)
    setVisualization(preset.visualization)
    closeShareMenu(target)
  }

  return <div className="data-view patterns-view">
    <header className="data-view-header"><div><h1>결과 정리</h1></div><div className="data-actions pattern-toolbar">
      <details className="pattern-share"><summary><Share2 size={16} />공유<ChevronDown size={14} /></summary><div className="pattern-share-menu">
        <div className="pattern-share-summary"><strong>{rowLabels.join(' · ')} × {columnAxes.length ? columnAxes.map((axis) => DIMENSION_LABEL[axis]).join(' · ') : '전체'}</strong><span>{AGGREGATIONS.find((item) => item.value === aggregation)?.label}</span></div>
        <button type="button" onClick={(event) => void copyPivot(event.currentTarget)}><Clipboard size={16} /><span><b>표 복사</b><small>Excel·메신저에 붙여넣기</small></span></button>
        <button type="button" onClick={(event) => downloadPivot(event.currentTarget)}><Download size={16} /><span><b>현재 표 CSV</b><small>화면의 왼쪽·상단 축 구성</small></span></button>
        {visualization !== 'cross_table' ? <button type="button" onClick={(event) => downloadChart(event.currentTarget)}><Download size={16} /><span><b>현재 시각화 PNG</b><small>보고서·메신저 공유</small></span></button> : null}
        {hasSelection ? <button type="button" onClick={(event) => downloadSelected(event.currentTarget)}><Download size={16} /><span><b>선택 로그 CSV</b><small>선택한 셀의 원본 행</small></span></button> : null}
        {visibleFailureAddresses.eventCount ? <button type="button" onClick={(event) => downloadFailureAddresses(event.currentTarget)}><Download size={16} /><span><b>Fail 주소 CSV</b><small>주소 이벤트 1회당 1행</small></span></button> : null}
        <button type="button" onClick={(event) => downloadRaw(event.currentTarget)}><Download size={16} /><span><b>평가 결과 CSV</b><small>로그 1개당 1행 · 조건과 판정</small></span></button>
      </div></details>
      <button onClick={() => void saveLayout()} disabled={!project || savingLayout}><Save size={16} />{savingLayout ? '저장 중…' : '구성 저장'}</button>
      {hasFilters || hasSelection ? <button onClick={clearAll}><FilterX size={15} />초기화</button> : null}
    </div></header>

    {!records.length ? <div className="data-empty pattern-empty"><strong>분석할 로그가 없습니다.</strong><span>로그 화면에서 폴더를 추가하세요.</span></div> : !scopedRecords.length ? <div className="data-empty pattern-empty"><strong>조건에 맞는 로그가 없습니다.</strong><span>필터를 초기화해 보세요.</span></div> : <>
      <section className="pattern-section pivot-section" aria-labelledby="pivot-heading">
        <h2 id="pivot-heading" className="sr-only">분석 보기</h2>
        {agentPreview ? <div className="analysis-agent-preview" role="status"><Sparkles size={14} /><span>Agent 추천 보기</span>{agentPreview.proposal.rationale ? <small>{agentPreview.proposal.rationale}</small> : null}<button type="button" onClick={undoAgentPreview}>되돌리기</button></div> : null}
        <div className="analysis-viewbar">
          <details className="analysis-view-presets"><summary><span>분석 보기</span><b>{activePreset?.label ?? '사용자 구성'}</b><ChevronDown size={14} /></summary><div className="analysis-view-menu">
            {ANALYSIS_VIEW_PRESETS.map((preset) => <button type="button" className={activePreset?.id === preset.id ? 'active' : ''} key={preset.id} onClick={(event) => applyViewPreset(preset, event.currentTarget)}><span>{preset.label}</span><small>{ANALYSIS_DATA_BASIS_LABELS[preset.basis]} · {ANALYSIS_VISUALIZATION_LABELS[preset.visualization]}</small></button>)}
          </div></details>
          <div className="analysis-basis" role="radiogroup" aria-label="분석 데이터 기준">
            {(Object.keys(ANALYSIS_DATA_BASIS_LABELS) as AnalysisDataBasis[]).map((basis) => <button type="button" role="radio" aria-checked={dataBasis === basis} className={dataBasis === basis ? 'active' : ''} key={basis} onClick={() => changeDataBasis(basis)}>{ANALYSIS_DATA_BASIS_LABELS[basis]}</button>)}
          </div>
          <details className="analysis-visualization-picker"><summary><VisualizationIcon size={16} /><b>{ANALYSIS_VISUALIZATION_LABELS[visualization]}</b><ChevronDown size={14} /></summary><div className="analysis-visualization-menu" role="radiogroup" aria-label="시각화 선택">
            {availableVisualizations.map((item) => { const Icon = VISUALIZATION_ICONS[item]; return <button type="button" role="radio" aria-checked={visualization === item} className={visualization === item ? 'active' : ''} key={item} onClick={(event) => { changeVisualization(item); closeShareMenu(event.currentTarget) }}><Icon size={17} /><span>{ANALYSIS_VISUALIZATION_LABELS[item]}</span></button> })}
          </div></details>
          {onAnalyzeContext ? <button type="button" className="analysis-agent-action" onClick={analyzeView}><Sparkles size={15} />현재 표 분석</button> : null}
          <div className="pattern-metrics" aria-label="표시할 값">
          {primaryAggregations.map((item) => <button type="button" role="radio" aria-checked={aggregation === item.value} className={aggregation === item.value ? 'active' : ''} key={item.value} onClick={() => changeAggregation(item.value)}>{item.label}</button>)}
          <details className="pattern-metric-more"><summary className={secondaryAggregation ? 'active' : ''}>{secondaryAggregation?.label ?? '기타'}<ChevronDown size={13} /></summary><div className="pattern-metric-menu" role="radiogroup" aria-label="다른 집계 방식">
            {secondaryAggregations.map((item) => <button type="button" role="radio" aria-checked={aggregation === item.value} className={aggregation === item.value ? 'active' : ''} key={item.value} onClick={(event) => { changeAggregation(item.value); event.currentTarget.closest('details')?.removeAttribute('open') }}>{item.label}</button>)}
          </div></details>
          </div>
        </div>
        <div className="pattern-controls" aria-label="표 필터">
          <SelectControl label="평가" value={folderFilter} onChange={(value) => { setFolderFilter(value); clearSelection() }}><option value="all">전체 평가</option>{folders.map((folder) => <option value={folder} key={folder}>{folder}</option>)}</SelectControl>
          <SelectControl label="결과" value={resultFilter} onChange={(value) => { setResultFilter(value as ResultLabel | 'all'); clearSelection() }}><option value="all">전체 결과</option>{resultChoices.map((result) => <option value={result} key={result}>{RESULT_LABEL_KO[result]}</option>)}</SelectControl>
          <button className={`pattern-quick-filter ${failOnly ? 'active' : ''}`} aria-pressed={failOnly} onClick={() => { setFailOnly((value) => !value); clearSelection() }}>FAIL만</button>
          <button className={`pattern-quick-filter ${unknownMetadataOnly ? 'active' : ''}`} aria-pressed={unknownMetadataOnly} onClick={() => { setUnknownMetadataOnly((value) => !value); clearSelection() }}>미확인 조건만</button>
        </div>
        <div className="pattern-axis-builder">
          <AxisWell group="rows" label="왼쪽 축" axes={rowAxes} selected={activeDimensions} dragged={draggedAxis} onDrag={setDraggedAxis} onDrop={moveAxis} onRemove={(index) => removeAxis('rows', index)} onAdd={(dimension) => addAxis('rows', dimension)} onKeyMove={keyboardMoveAxis} />
          <button type="button" className="pattern-swap-axes" onClick={() => setAxes([...columnAxes], [...rowAxes])} title="왼쪽 축과 상단 축 바꾸기"><ArrowLeftRight size={15} />축 바꾸기</button>
          <AxisWell group="columns" label="상단 축" axes={columnAxes} selected={activeDimensions} dragged={draggedAxis} onDrag={setDraggedAxis} onDrop={moveAxis} onRemove={(index) => removeAxis('columns', index)} onAdd={(dimension) => addAxis('columns', dimension)} onKeyMove={keyboardMoveAxis} />
        </div>
        {unknownActiveDimensions.length ? <p className="pivot-guidance">{unknownActiveDimensions.map((dimension) => DIMENSION_LABEL[dimension]).join(' · ')} 값이 없습니다. 다른 항목을 선택하거나 결과 화면에서 값을 입력하세요.</p> : null}
        {dataBasis === 'failure_address' && !grid.rows.length ? <div className="pattern-inline-empty"><strong>확인된 Fail 주소가 없습니다.</strong><span>FAIL 로그 본문에 DQ, BL, Bank 등의 주소 정보가 있어야 표시됩니다.</span></div> : visualization === 'cross_table' ? <div className="pivot-scroll"><table className={`pivot-table metric-${aggregation}`} style={{ minWidth: Math.max(720, (rowAxes.length || 1) * 118 + grid.columns.length * (dataBasis === 'failure_address' ? 108 : 82) + 90) }}>
          <thead>{columnHeaderRows.length ? columnHeaderRows.map((groups, level) => <tr key={level}>{level === 0 ? (rowAxes.length ? rowAxes.map((axis) => <th className="pivot-row-axis" rowSpan={columnHeaderRows.length} key={axis}>{DIMENSION_LABEL[axis]}</th>) : <th className="pivot-row-axis" rowSpan={columnHeaderRows.length}>전체</th>) : null}{groups.map((group) => <th colSpan={group.span} key={group.key}>{group.label}</th>)}{level === 0 ? <th className="pivot-total" rowSpan={columnHeaderRows.length}>합계</th> : null}</tr>) : <tr>{rowAxes.length ? rowAxes.map((axis) => <th className="pivot-row-axis" key={axis}>{DIMENSION_LABEL[axis]}</th>) : <th className="pivot-row-axis">전체</th>}<th>전체</th><th className="pivot-total">합계</th></tr>}</thead>
          <tbody>{grid.rows.map((row, rowIndex) => <tr key={row.key}>{rowAxes.length ? rowAxes.map((axis, level) => { const span = pivotRowHeaderSpan(grid.rows, rowIndex, level); return span ? <th className="pivot-row-value" scope="row" rowSpan={span} key={axis}>{row.values[level] ?? '미확인'}</th> : null }) : <th className="pivot-row-value" scope="row">전체</th>}{grid.columns.map((column, columnIndex) => {
            const cell = grid.cells[rowIndex][columnIndex]
            const cellKey = `${row.key}-${column.key}`
            const active = markedCellKeys.has(cellKey)
            const selectable = cell.sourceIds.length > 0
            const display = formatPivotValue(cell.value, aggregation, cell.breakdown, cell.failureAddress)
            const intensity = aggregation === 'pass_fail'
              ? cell.breakdown?.definitiveCount ? Math.max(.05, cell.breakdown.failCount / cell.breakdown.definitiveCount) : 0
              : maxCellValue ? Math.max(.05, cell.value / maxCellValue) : 0
            const scopeTitle = dataBasis === 'failure_address' && cell.failureAddress
              ? `Fail 주소 ${cell.failureAddress.eventCount.toLocaleString()}회 · ${cell.failureAddress.sourceCount.toLocaleString()}개 로그`
              : `${cell.sourceIds.length.toLocaleString()}개 로그`
            return <td key={column.key}><button data-testid={`pivot-cell-${row.key}-${column.key}`} className={active ? 'active' : ''} style={{ '--pivot-intensity': intensity } as CSSProperties} disabled={!selectable} aria-pressed={active} title={selectable ? `${scopeTitle} · Ctrl/⌘ 클릭으로 조건 추가` : '관련 로그 없음'} aria-label={selectable ? `${display}, ${scopeTitle}${active ? ', 선택됨' : ''}` : `${display}, 관련 로그 없음`} onClick={(event) => setMarkedCellKeys((current) => nextPivotMarking(current, cellKey, event.ctrlKey || event.metaKey || event.shiftKey))}>{display}</button></td>
          })}{(() => { const cell = rowTotalByKey.get(row.key); return <td className="pivot-total">{formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown, cell?.failureAddress)}</td> })()}</tr>)}</tbody>
          <tfoot><tr><th className="pivot-total-label" colSpan={rowAxes.length || 1}>합계</th>{grid.columns.map((column) => { const cell = columnTotalByKey.get(column.key); return <td className="pivot-total" key={column.key}>{formatPivotValue(cell?.value ?? 0, aggregation, cell?.breakdown, cell?.failureAddress)}</td> })}<td className="pivot-total pivot-grand-total">{formatPivotValue(grid.total, aggregation, grid.breakdown, grid.failureAddress)}</td></tr></tfoot>
        </table></div> : <Suspense fallback={<div className="analysis-chart-loading">시각화 준비 중…</div>}><AnalysisChart
          grid={grid}
          passFailGrid={passFailGrid}
          visualization={visualization}
          aggregation={aggregation}
          selectedCellKeys={markedCellKeys}
          onMark={markChartCells}
          onExportReady={(exportImage) => { chartExportRef.current = exportImage }}
        /></Suspense>}
        {hasSelection ? <section className="pattern-selection-inspector" aria-label="선택 상세">
          <div><strong>선택한 조건 {markedCells.length.toLocaleString()}개</strong><span>PASS {visibleRows.filter((row) => row.result === 'PASS').length.toLocaleString()} · FAIL {visibleRows.filter((row) => FAIL_RESULTS.has(row.result)).length.toLocaleString()}</span></div>
          {visibleFailureAddresses.eventCount ? <div className="pattern-address-summary"><span>Fail 주소 {visibleFailureAddresses.eventCount.toLocaleString()}회 · {visibleFailureAddresses.sourceCount.toLocaleString()}개 로그</span>{visibleFailureAddresses.distribution.slice(0, 3).map((item) => <b key={`${item.dimension}-${item.value}`}>{DIMENSION_LABEL[item.dimension as PivotDimension] ?? item.dimension} {item.value} · {item.eventCount.toLocaleString()}회</b>)}</div> : <span className="pattern-selection-muted">선택 범위에 Fail 주소 이벤트가 없습니다.</span>}
          <div className="pattern-selection-tools"><button type="button" onClick={clearSelection}><X size={14} />선택 해제</button><button type="button" onClick={(event) => dataBasis === 'failure_address' ? downloadFailureAddresses(event.currentTarget) : downloadSelected(event.currentTarget)}><Download size={14} />선택 CSV</button></div>
        </section> : null}
      </section>

      <details className="pattern-section marked-rows" open={hasSelection || rawDetailsOpen} onToggle={(event) => setRawDetailsOpen(event.currentTarget.open)}>
        <summary><span>{hasSelection ? `선택 로그 ${visibleRows.length.toLocaleString()}개` : `전체 로그 ${visibleRows.length.toLocaleString()}개`}</span><ChevronDown size={15} /></summary>
        <div className="marked-table-scroll"><table><thead><tr><th>파일명</th><th>평가 폴더</th><th>Sample</th><th>온도</th><th>결과</th><th>확인 상태</th></tr></thead><tbody>{visibleRows.slice(0, RESULT_LIMIT).map((row) => <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}><td><button onClick={(event) => { event.stopPropagation(); onOpenFile(row.id) }}>{row.fileName}</button></td><td>{row.folder}</td><td>{row.sample.value ?? '미확인'}</td><td>{row.temperature.value ?? '미확인'}</td><td><span className={`result-label result-${row.result.toLowerCase()}`}>{RESULT_LABEL_KO[row.result]}</span></td><td>{row.review === 'confirmed' ? '확정' : '검토 필요'}</td></tr>)}</tbody></table></div>
      </details>
    </>}
  </div>
}
