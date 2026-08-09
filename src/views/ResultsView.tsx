import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ChevronDown, Clipboard, Download, FilterX, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  filterLogRecords,
  buildLogRecordExportPreview,
  confirmLogRecordExport,
  DEFAULT_EXPORT_COLUMNS,
  EVIDENCE_EXPORT_COLUMNS,
  EXPORT_COLUMN_DEFINITIONS,
  exportableLogRecords,
  normalizeExportColumns,
  RESULT_LABEL_KO,
  selectedLogRecords,
  selectAllFilteredLogRecords,
  serializeLogRecordsCsv,
  exportCellValue,
  sortLogRecords,
  STAGE_LABEL_KO,
  toggleLogRecordSelection,
  type CandidateValue,
  type LogRecordExportColumn,
  type LogRecordSortKey,
  type LogResultRecord,
  type PatternAxis,
  type ReviewState,
  type SortDirection,
  type LogRecordExportPreview,
  type EvaluationStage,
  type EvaluationStageStatus,
} from '../state/logRecords'

interface ResultsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
  onApproveMetadata?: (record: LogResultRecord, field: PatternAxis, value: string) => void | Promise<void>
  onEditMetadata?: (record: LogResultRecord, field: PatternAxis, value: string) => void | Promise<void>
  onResetMetadata?: (record: LogResultRecord, field: PatternAxis) => void | Promise<void>
  onNotify?: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const PAGE_SIZE = 200

const COLUMNS: Array<{ key: LogRecordSortKey; label: string }> = [
  { key: 'fileName', label: '파일명' },
  { key: 'folder', label: '폴더' },
  { key: 'sample', label: 'Sample' },
  { key: 'temperature', label: '온도' },
  { key: 'mode', label: 'Mode' },
  { key: 'grid', label: 'Grid' },
  { key: 'stageResults', label: '단계별 결과' },
  { key: 'result', label: '결과' },
  { key: 'review', label: '판정 검토' },
  { key: 'evidenceCount', label: '근거' },
]

const DEFAULT_UI_EXPORT_COLUMNS = EXPORT_COLUMN_DEFINITIONS
  .filter((column) => !column.group)
  .map((column) => column.key)

export function createResultsCsvBlob(
  rows: readonly LogResultRecord[],
  columns: readonly LogRecordExportColumn[] = DEFAULT_EXPORT_COLUMNS,
): Blob {
  return new Blob([serializeLogRecordsCsv(rows, columns)], { type: 'text/csv;charset=utf-8' })
}

const PREVIEW_LABELS = new Map(EXPORT_COLUMN_DEFINITIONS.map((column) => [column.key, column.label]))

const METADATA_LABEL: Record<PatternAxis, string> = { sample: 'Sample', temperature: '온도', mode: 'Mode', grid: 'Grid' }

function candidateLabel(field: CandidateValue, suffix = '', onOpen?: () => void) {
  if (!field.value) return onOpen
    ? <button className={`candidate-value candidate-action ${field.state}`} title="값 검토" onClick={(event) => { event.stopPropagation(); onOpen() }}>미확인</button>
    : <span className={`candidate-value ${field.state}`}>미확인</span>
  const content = <>{field.value}{suffix}<small>{field.state === 'approved' ? '승인' : field.state === 'rejected' ? '거절' : '후보'}</small></>
  if (!onOpen) return <span className={`candidate-value ${field.state}`}>{content}</span>
  return <button className={`candidate-value candidate-action ${field.state}`} title="값 검토" onClick={(event) => { event.stopPropagation(); onOpen() }}>{content}</button>
}

export function ResultsView({ records, onOpenFile, onApproveMetadata, onEditMetadata, onResetMetadata, onNotify }: ResultsViewProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResultLabel | 'all'>('all')
  const [review, setReview] = useState<ReviewState | 'all'>('all')
  const [folder, setFolder] = useState<string | 'all'>('all')
  const [stage, setStage] = useState<EvaluationStage | 'all'>('all')
  const [stageStatus, setStageStatus] = useState<EvaluationStageStatus | 'all'>('all')
  const [sortKey, setSortKey] = useState<LogRecordSortKey>('fileName')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedExportColumnKeys, setSelectedExportColumnKeys] = useState<ReadonlySet<LogRecordExportColumn>>(
    () => new Set(DEFAULT_UI_EXPORT_COLUMNS),
  )
  const [preset, setPreset] = useState<'fail' | 'needs_review' | null>(null)
  const [exportPreview, setExportPreview] = useState<LogRecordExportPreview | null>(null)
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: PatternAxis } | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [savingMetadata, setSavingMetadata] = useState(false)

  const folders = useMemo(() => [...new Set(records.map((row) => row.folder))].sort((left, right) => left.localeCompare(right, 'ko-KR')), [records])
  const filtered = useMemo(() => sortLogRecords(filterLogRecords(records, { query, result, review, folder }).filter((row) => {
    if (stage !== 'all' && !row.stageResults.some((item) => item.stage === stage && (stageStatus === 'all' || item.status === stageStatus))) return false
    if (stage === 'all' && stageStatus !== 'all' && !row.stageResults.some((item) => item.status === stageStatus)) return false
    if (preset === 'fail') return new Set(['DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT']).has(row.result)
    if (preset === 'needs_review') return row.review === 'needs_review' || [row.sample, row.temperature, row.mode, row.grid].some((field) => field.state === 'missing' || field.state === 'malformed')
    return true
  }), sortKey, sortDirection), [query, records, result, review, folder, stage, stageStatus, preset, sortDirection, sortKey])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const selectedFilteredCount = filtered.reduce((count, row) => count + (selectedIds.has(row.id) ? 1 : 0), 0)
  const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length
  const selectedRows = selectedLogRecords(filtered, selectedIds)
  const exportRows = exportableLogRecords(filtered, selectedIds)
  const exportColumns = useMemo(
    () => EXPORT_COLUMN_DEFINITIONS.filter((column) => selectedExportColumnKeys.has(column.key)).map((column) => column.key),
    [selectedExportColumnKeys],
  )
  const hasFilters = Boolean(query || result !== 'all' || review !== 'all' || folder !== 'all' || stage !== 'all' || stageStatus !== 'all' || preset)
  const evidenceColumnsSelected = EVIDENCE_EXPORT_COLUMNS.every((column) => selectedExportColumnKeys.has(column))
  const editingRow = editingCell ? records.find((item) => item.id === editingCell.rowId) : undefined

  const updateSort = (key: LogRecordSortKey) => {
    if (sortKey === key) setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setSortDirection('asc')
    }
    setPage(1)
  }

  const clearFilters = () => {
    setQuery('')
    setResult('all')
    setReview('all')
    setFolder('all')
    setStage('all')
    setStageStatus('all')
    setPreset(null)
    setPage(1)
  }

  const beginExport = (format: 'csv' | 'tsv') => {
    if (!exportRows.length || !exportColumns.length) return
    setExportPreview(buildLogRecordExportPreview(filtered, selectedIds, exportColumns, format))
  }

  const copyTsv = async (preview: LogRecordExportPreview) => {
    try {
      await navigator.clipboard.writeText(confirmLogRecordExport(preview))
      setExportPreview(null)
      onNotify?.(`${preview.rows.length}개 행을 TSV로 복사했습니다.`)
    } catch {
      onNotify?.('클립보드에 복사하지 못했습니다.', 'error')
    }
  }

  const exportCsv = (preview: LogRecordExportPreview) => {
    const blob = new Blob([confirmLogRecordExport(preview)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `log-results-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    setExportPreview(null)
    onNotify?.(`${preview.rows.length}개 행을 CSV로 내보냈습니다.`)
  }

  const beginEdit = (row: LogResultRecord, field: PatternAxis) => {
    setEditingCell({ rowId: row.id, field })
    setEditingValue(row[field].value ?? '')
  }

  const saveEdit = async () => {
    if (!editingCell || !onEditMetadata) return
    const row = records.find((item) => item.id === editingCell.rowId)
    if (!row) return
    const value = editingValue.trim()
    if (!value) {
      onNotify?.('metadata 값은 비워 둘 수 없습니다.', 'error')
      return
    }
    setSavingMetadata(true)
    try {
      await onEditMetadata(row, editingCell.field, value)
      setEditingCell(null)
    } finally { setSavingMetadata(false) }
  }

  const approveCandidate = async () => {
    if (!editingCell || !onApproveMetadata) return
    const row = records.find((item) => item.id === editingCell.rowId)
    const value = editingValue.trim()
    if (!row || !value) return
    setSavingMetadata(true)
    try { await onApproveMetadata(row, editingCell.field, value); setEditingCell(null) }
    finally { setSavingMetadata(false) }
  }

  const resetApproval = async () => {
    if (!editingCell || !onResetMetadata) return
    const row = records.find((item) => item.id === editingCell.rowId)
    if (!row) return
    setSavingMetadata(true)
    try { await onResetMetadata(row, editingCell.field); setEditingCell(null) }
    finally { setSavingMetadata(false) }
  }

  const toggleAllFiltered = () => {
    setSelectedIds((current) => selectAllFilteredLogRecords(current, filtered, !allFilteredSelected))
  }

  const toggleEvidenceColumns = (checked: boolean) => {
    setSelectedExportColumnKeys((current) => {
      const next = new Set(current)
      for (const column of EVIDENCE_EXPORT_COLUMNS) {
        if (checked) next.add(column)
        else next.delete(column)
      }
      return new Set(normalizeExportColumns([...next]))
    })
  }

  return (
    <div className="data-view results-view">
      <header className="data-view-header">
        <div><h1>결과</h1></div>
        <div className="data-actions">
          <details className="export-columns">
            <summary><SlidersHorizontal size={15} />열 선택<ChevronDown size={14} /></summary>
            <div className="export-columns-menu">
              <div className="export-columns-heading"><strong>내보낼 열</strong><span>CSV · TSV 공통</span></div>
              <label className="export-column-option export-column-group">
                <input type="checkbox" checked={evidenceColumnsSelected} onChange={(event) => toggleEvidenceColumns(event.target.checked)} />
                <span><strong>근거</strong><small>evidence_count · selected_evidence_count</small></span>
              </label>
              {EXPORT_COLUMN_DEFINITIONS.filter((column) => !column.group).map((column) => (
                <label className="export-column-option" key={column.key}>
                  <input
                    type="checkbox"
                    checked={selectedExportColumnKeys.has(column.key)}
                    onChange={(event) => setSelectedExportColumnKeys((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(column.key)
                      else next.delete(column.key)
                      return new Set(normalizeExportColumns([...next]))
                    })}
                  />
                  <span>{column.label}</span>
                </label>
              ))}
            </div>
          </details>
          <button onClick={() => beginExport('tsv')} disabled={!exportRows.length || !exportColumns.length}><Clipboard size={16} />TSV 복사</button>
          <button onClick={() => beginExport('csv')} disabled={!exportRows.length || !exportColumns.length}><Download size={16} />CSV</button>
        </div>
      </header>

      <section className="data-filter-bar" aria-label="결과 필터">
        <label className="data-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="파일명, 폴더, 조건 검색" aria-label="결과 검색" /></label>
        <label><span>결과</span><select value={result} onChange={(event) => { setResult(event.target.value as ResultLabel | 'all'); setPage(1) }}><option value="all">전체</option>{Object.entries(RESULT_LABEL_KO).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>검토</span><select value={review} onChange={(event) => { setReview(event.target.value as ReviewState | 'all'); setPage(1) }}><option value="all">전체</option><option value="needs_review">검토 필요</option><option value="confirmed">확정</option></select></label>
        <label><span>단계</span><select value={stage} onChange={(event) => { setStage(event.target.value as EvaluationStage | 'all'); setPage(1) }}><option value="all">전체 단계</option>{Object.entries(STAGE_LABEL_KO).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>단계 판정</span><select value={stageStatus} onChange={(event) => { setStageStatus(event.target.value as EvaluationStageStatus | 'all'); setPage(1) }}><option value="all">전체</option><option value="pass">PASS</option><option value="fail">FAIL</option><option value="reached">도달</option></select></label>
        <label><span>폴더 범위</span><select value={folder} onChange={(event) => { setFolder(event.target.value); setPage(1) }}><option value="all">전체 폴더</option>{folders.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <button className="results-preset" aria-pressed={preset === 'fail'} onClick={() => { setPreset((current) => current === 'fail' ? null : 'fail'); setPage(1) }}>FAIL 모아보기</button>
        <button className="results-preset" aria-pressed={preset === 'needs_review'} onClick={() => { setPreset((current) => current === 'needs_review' ? null : 'needs_review'); setReview('all'); setPage(1) }}>미확인·검토필요</button>
        {hasFilters ? <button className="clear-filter" onClick={clearFilters}><FilterX size={16} />초기화</button> : null}
      </section>

      <div className="data-table-scroll">
        <table className="data-table">
          <thead><tr>
            <th scope="col" className="selection-column">
              <input type="checkbox" checked={allFilteredSelected} ref={(element) => { if (element) element.indeterminate = selectedFilteredCount > 0 && !allFilteredSelected }} onChange={toggleAllFiltered} aria-label="필터된 행 전체 선택" />
            </th>
            {COLUMNS.map((column) => <th scope="col" key={column.key}><button onClick={() => updateSort(column.key)} aria-label={`${column.label} 기준 정렬`}>{column.label}{sortKey === column.key ? sortDirection === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : null}</button></th>)}
          </tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}>
                <td className="selection-cell"><input type="checkbox" checked={selectedIds.has(row.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelectedIds((current) => toggleLogRecordSelection(current, row.id))} aria-label={`${row.fileName} 선택`} /></td>
                <td><button className="file-link" onClick={(event) => { event.stopPropagation(); onOpenFile(row.id) }} title={row.relativePath}>{row.fileName}</button></td>
                <td title={row.folder}>{row.folder}</td>
                {(['sample', 'temperature', 'mode', 'grid'] as const).map((field) => <td key={field}>
                  {candidateLabel(row[field], field === 'temperature' ? '°C' : '', onEditMetadata || onApproveMetadata ? () => beginEdit(row, field) : undefined)}
                </td>)}
                <td><div className="stage-results">{row.stageResults.length ? row.stageResults.map((item) => <span className={`stage-result ${item.status}`} key={item.stage}>{STAGE_LABEL_KO[item.stage]} <b>{item.status === 'reached' ? '도달' : item.status.toUpperCase()}</b></span>) : <span className="stage-result unknown">미확인</span>}</div></td>
                <td><span className={`result-label result-${row.result.toLowerCase()}`}>{RESULT_LABEL_KO[row.result]}</span>{row.resultSource === 'candidate' ? <small className="row-note">후보</small> : null}</td>
                <td><span className={`review-label ${row.review}`}>{row.review === 'confirmed' ? '확정' : '검토 필요'}</span></td>
                <td><span className="evidence-count">{row.evidenceCount}</span>{row.selectedEvidenceCount ? <small className="row-note">선택됨</small> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length ? <div className="data-empty"><strong>{records.length ? '조건에 맞는 로그가 없습니다.' : '분석할 로그가 없습니다.'}</strong><span>{records.length ? '필터를 초기화해 보세요.' : '로그 화면에서 폴더를 추가하세요.'}</span></div> : null}
      </div>

      <footer className="data-pagination">
        <span>{filtered.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)}` : '0'} / {filtered.length.toLocaleString()}{selectedIds.size ? ` · ${selectedIds.size.toLocaleString()}개 선택됨` : ''}{selectedIds.size && selectedRows.length !== selectedIds.size ? ` · 현재 범위 ${selectedRows.length.toLocaleString()}개` : ''}</span>
        <div><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1}>이전</button><span>{currentPage} / {pageCount}</span><button onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount}>다음</button></div>
      </footer>
      {editingCell && editingRow ? <MetadataReviewDialog
        row={editingRow}
        field={editingCell.field}
        value={editingValue}
        busy={savingMetadata}
        onValueChange={setEditingValue}
        onClose={() => setEditingCell(null)}
        onApprove={() => void approveCandidate()}
        onSave={() => void saveEdit()}
        onReset={onResetMetadata ? () => void resetApproval() : undefined}
      /> : null}
      {exportPreview ? <ExportPreviewModal preview={exportPreview} onClose={() => setExportPreview(null)} onCopy={copyTsv} onCsv={exportCsv} /> : null}
    </div>
  )
}

function MetadataReviewDialog({ row, field, value, busy, onValueChange, onClose, onApprove, onSave, onReset }: {
  row: LogResultRecord
  field: PatternAxis
  value: string
  busy: boolean
  onValueChange: (value: string) => void
  onClose: () => void
  onApprove: () => void
  onSave: () => void
  onReset?: () => void
}) {
  const current = row[field]
  const canSubmit = Boolean(value.trim()) && !busy
  const dialogRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])
  return <div className="export-preview-modal metadata-review-modal" role="dialog" aria-modal="true" aria-labelledby="metadata-review-title" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <form ref={dialogRef} className="export-preview-dialog metadata-review-dialog" onSubmit={(event) => { event.preventDefault(); onSave() }}>
      <header><div><h2 id="metadata-review-title">{METADATA_LABEL[field]} 검토</h2><span title={row.fileName}>{row.fileName}</span></div><button type="button" onClick={onClose} aria-label="닫기"><X size={16} /></button></header>
      <div className="metadata-review-body">
        <label><span>값</span><input autoFocus value={value} onChange={(event) => onValueChange(event.target.value)} placeholder="값 입력" /></label>
        <p>{current.state === 'approved' ? '엔지니어가 승인한 값입니다.' : current.value ? '로그에서 찾은 후보입니다.' : '값을 찾지 못했습니다. 직접 입력할 수 있습니다.'}</p>
      </div>
      <footer>
        {current.state === 'approved' && onReset ? <button type="button" className="metadata-reset" disabled={busy} onClick={onReset}><RotateCcw size={14} />승인 취소</button> : <span />}
        <div><button type="button" disabled={busy} onClick={onClose}>닫기</button>{current.state === 'candidate' && value.trim() === current.value ? <button type="button" className="is-primary" disabled={!canSubmit} onClick={onApprove}><Check size={14} />후보 승인</button> : <button type="submit" className="is-primary" disabled={!canSubmit}>수정 후 승인</button>}</div>
      </footer>
    </form>
  </div>
}

function ExportPreviewModal({ preview, onClose, onCopy, onCsv }: { preview: LogRecordExportPreview; onClose: () => void; onCopy: (preview: LogRecordExportPreview) => void; onCsv: (preview: LogRecordExportPreview) => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = focusable(); if (!items.length) return
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  return <div className="export-preview-modal" role="dialog" aria-modal="true" aria-labelledby="export-preview-title" ref={dialogRef}>
        <div className="export-preview-dialog"><header><div><h2 id="export-preview-title">{preview.format.toUpperCase()} 내보내기 확인</h2><span>{preview.rows.length}개 행 · {preview.columns.length}개 열 · 첫 5행 미리보기</span></div><button onClick={onClose} aria-label="내보내기 미리보기 닫기"><X size={16} /></button></header>
          <div className="export-preview-table"><table><thead><tr>{preview.columns.map((column) => <th key={column}>{PREVIEW_LABELS.get(column) ?? column}</th>)}</tr></thead><tbody>{preview.rows.slice(0, 5).map((row) => <tr key={row.id}>{preview.columns.map((column) => <td key={column}>{exportCellValue(row, column)}</td>)}</tr>)}</tbody></table></div>
          <footer><button onClick={onClose}>취소</button><button onClick={() => preview.format === 'tsv' ? void onCopy(preview) : onCsv(preview)}>확정</button></footer>
        </div>
      </div>
}
