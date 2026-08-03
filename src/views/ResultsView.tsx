import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Clipboard, Download, FilterX, Search } from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import {
  filterLogRecords,
  RESULT_LABEL_KO,
  serializeLogRecordsCsv,
  serializeLogRecordsTsv,
  sortLogRecords,
  type CandidateValue,
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
  const [sortKey, setSortKey] = useState<LogRecordSortKey>('fileName')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => sortLogRecords(filterLogRecords(records, { query, result, review }), sortKey, sortDirection), [query, records, result, review, sortDirection, sortKey])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const hasFilters = Boolean(query || result !== 'all' || review !== 'all')

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
    setPage(1)
  }

  const copyTsv = async () => {
    try {
      await navigator.clipboard.writeText(serializeLogRecordsTsv(filtered))
      onNotify?.(`${filtered.length}개 행을 TSV로 복사했습니다.`)
    } catch {
      onNotify?.('클립보드에 복사하지 못했습니다.', 'error')
    }
  }

  const exportCsv = () => {
    const blob = new Blob([`\uFEFF${serializeLogRecordsCsv(filtered)}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `log-results-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    onNotify?.(`${filtered.length}개 행을 CSV로 내보냈습니다.`)
  }

  return (
    <div className="data-view results-view">
      <header className="data-view-header">
        <div><h1>결과표</h1><span>{filtered.length.toLocaleString()} / {records.length.toLocaleString()} logs</span></div>
        <div className="data-actions">
          <button onClick={() => void copyTsv()} disabled={!filtered.length}><Clipboard size={16} />TSV 복사</button>
          <button onClick={exportCsv} disabled={!filtered.length}><Download size={16} />CSV</button>
        </div>
      </header>

      <section className="data-filter-bar" aria-label="결과 필터">
        <label className="data-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="파일명, 폴더, 조건 검색" aria-label="결과 검색" /></label>
        <label><span>결과</span><select value={result} onChange={(event) => { setResult(event.target.value as ResultLabel | 'all'); setPage(1) }}><option value="all">전체</option>{Object.entries(RESULT_LABEL_KO).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>검토</span><select value={review} onChange={(event) => { setReview(event.target.value as ReviewState | 'all'); setPage(1) }}><option value="all">전체</option><option value="needs_review">검토 필요</option><option value="confirmed">확정</option></select></label>
        {hasFilters ? <button className="clear-filter" onClick={clearFilters}><FilterX size={16} />초기화</button> : null}
      </section>

      <div className="data-table-scroll">
        <table className="data-table">
          <thead><tr>{COLUMNS.map((column) => <th scope="col" key={column.key}><button onClick={() => updateSort(column.key)} aria-label={`${column.label} 기준 정렬`}>{column.label}{sortKey === column.key ? sortDirection === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} /> : null}</button></th>)}</tr></thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}>
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
        <span>{filtered.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)}` : '0'} / {filtered.length.toLocaleString()}</span>
        <div><button onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1}>이전</button><span>{currentPage} / {pageCount}</span><button onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount}>다음</button></div>
      </footer>
    </div>
  )
}
