import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Clipboard, Download, FilterX, Search, SlidersHorizontal } from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  filterLogRecords,
  DEFAULT_EXPORT_COLUMNS,
  EVIDENCE_EXPORT_COLUMNS,
  EXPORT_COLUMN_DEFINITIONS,
  exportableLogRecords,
  normalizeExportColumns,
  RESULT_LABEL_KO,
  selectedLogRecords,
  selectAllFilteredLogRecords,
  serializeLogRecordsCsv,
  serializeLogRecordsTsv,
  sortLogRecords,
  toggleLogRecordSelection,
  type CandidateValue,
  type LogRecordExportColumn,
  type LogRecordSortKey,
  type LogResultRecord,
  type PatternAxis,
  type ReviewState,
  type SortDirection,
} from '../state/logRecords'

interface ResultsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
  onApproveMetadata?: (record: LogResultRecord, field: PatternAxis, value: string) => void | Promise<void>
  onNotify?: (message: string, tone?: 'success' | 'error' | 'info') => void
}

const PAGE_SIZE = 200

const COLUMNS: Array<{ key: LogRecordSortKey; label: string }> = [
  { key: 'fileName', label: '파일명' },
  { key: 'folder', label: '폴더' },
  { key: 'sample', label: 'Sample' },
  { key: 'temperature', label: '온도' },
  { key: 'mode', label: 'Mode' },
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

function candidateLabel(field: CandidateValue, suffix = '', onApprove?: (value: string) => void) {
  if (!field.value) return <span className={`candidate-value ${field.state}`}>미확인</span>
  const content = <>{field.value}{suffix}<small>{field.state === 'approved' ? '승인' : field.state === 'rejected' ? '거절' : '후보'}</small></>
  if (field.state !== 'candidate' || !onApprove) return <span className={`candidate-value ${field.state}`}>{content}</span>
  return <button className="candidate-value candidate-action" title="클릭하여 이 후보를 승인" onClick={(event) => { event.stopPropagation(); onApprove(field.value!) }}>{content}</button>
}

export function ResultsView({ records, onOpenFile, onApproveMetadata, onNotify }: ResultsViewProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResultLabel | 'all'>('all')
  const [review, setReview] = useState<ReviewState | 'all'>('all')
  const [folder, setFolder] = useState<string | 'all'>('all')
  const [sortKey, setSortKey] = useState<LogRecordSortKey>('fileName')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [page, setPage] = useState(1)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedExportColumnKeys, setSelectedExportColumnKeys] = useState<ReadonlySet<LogRecordExportColumn>>(
    () => new Set(DEFAULT_UI_EXPORT_COLUMNS),
  )

  const folders = useMemo(() => [...new Set(records.map((row) => row.folder))].sort((left, right) => left.localeCompare(right, 'ko-KR')), [records])
  const filtered = useMemo(() => sortLogRecords(filterLogRecords(records, { query, result, review, folder }), sortKey, sortDirection), [query, records, result, review, folder, sortDirection, sortKey])
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
  const hasFilters = Boolean(query || result !== 'all' || review !== 'all' || folder !== 'all')
  const evidenceColumnsSelected = EVIDENCE_EXPORT_COLUMNS.every((column) => selectedExportColumnKeys.has(column))

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
    setPage(1)
  }

  const copyTsv = async () => {
    try {
      await navigator.clipboard.writeText(serializeLogRecordsTsv(exportRows, exportColumns))
      onNotify?.(`${exportRows.length}개 행을 TSV로 복사했습니다.`)
    } catch {
      onNotify?.('클립보드에 복사하지 못했습니다.', 'error')
    }
  }

  const exportCsv = () => {
    const blob = createResultsCsvBlob(exportRows, exportColumns)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `log-results-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    onNotify?.(`${exportRows.length}개 행을 CSV로 내보냈습니다.`)
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
        <div><h1>결과표</h1><span>{filtered.length.toLocaleString()} / {records.length.toLocaleString()} logs</span></div>
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
          <button onClick={() => void copyTsv()} disabled={!exportRows.length || !exportColumns.length}><Clipboard size={16} />TSV 복사</button>
          <button onClick={exportCsv} disabled={!exportRows.length || !exportColumns.length}><Download size={16} />CSV</button>
        </div>
      </header>

      <section className="data-filter-bar" aria-label="결과 필터">
        <label className="data-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="파일명, 폴더, 조건 검색" aria-label="결과 검색" /></label>
        <label><span>결과</span><select value={result} onChange={(event) => { setResult(event.target.value as ResultLabel | 'all'); setPage(1) }}><option value="all">전체</option>{Object.entries(RESULT_LABEL_KO).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>검토</span><select value={review} onChange={(event) => { setReview(event.target.value as ReviewState | 'all'); setPage(1) }}><option value="all">전체</option><option value="needs_review">검토 필요</option><option value="confirmed">확정</option></select></label>
        <label><span>폴더 범위</span><select value={folder} onChange={(event) => { setFolder(event.target.value); setPage(1) }}><option value="all">전체 폴더</option>{folders.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
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
                <td>{candidateLabel(row.sample, '', onApproveMetadata ? (value) => void onApproveMetadata(row, 'sample', value) : undefined)}</td>
                <td>{candidateLabel(row.temperature, '°C', onApproveMetadata ? (value) => void onApproveMetadata(row, 'temperature', value) : undefined)}</td>
                <td>{candidateLabel(row.mode, '', onApproveMetadata ? (value) => void onApproveMetadata(row, 'mode', value) : undefined)}</td>
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
    </div>
  )
}
