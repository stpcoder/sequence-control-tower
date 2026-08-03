import { useMemo, useState } from 'react'
import { FilterX } from 'lucide-react'
import type { ResultLabel } from '../domain/workbench'
import { patternMatrix, RESULT_LABEL_KO, visibleResults, type LogResultRecord, type PatternAxis } from '../state/logRecords'

interface PatternsViewProps {
  records: readonly LogResultRecord[]
  onOpenFile: (fileId: string) => void
}

const AXES: Array<{ value: PatternAxis; label: string }> = [
  { value: 'sample', label: 'Sample' },
  { value: 'temperature', label: '온도' },
  { value: 'mode', label: 'Mode' },
]

const RESULT_LIMIT = 150

export function PatternsView({ records, onOpenFile }: PatternsViewProps) {
  const [axis, setAxis] = useState<PatternAxis>('temperature')
  const [result, setResult] = useState<ResultLabel | null>(null)
  const [axisValue, setAxisValue] = useState<string | null>(null)
  const results = useMemo(() => visibleResults(records), [records])
  const distribution = useMemo(() => results.map((value) => ({ value, count: records.filter((row) => row.result === value).length })), [records, results])
  const maxCount = Math.max(1, ...distribution.map((item) => item.count))
  const matrix = useMemo(() => patternMatrix(records, axis), [axis, records])
  const filtered = useMemo(() => records.filter((row) => (!result || row.result === result) && (!axisValue || (row[axis].value ?? '미확인') === axisValue)), [axis, axisValue, records, result])
  const hasMarking = Boolean(result || axisValue)

  const mark = (nextResult: ResultLabel | null, nextAxisValue: string | null) => {
    setResult(nextResult)
    setAxisValue(nextAxisValue)
  }

  return (
    <div className="data-view patterns-view">
      <header className="data-view-header">
        <div><h1>패턴</h1><span>{records.length.toLocaleString()} logs · 셀을 선택하면 원본 행이 표시됩니다</span></div>
        {hasMarking ? <button className="clear-marking" onClick={() => mark(null, null)}><FilterX size={16} />선택 해제</button> : null}
      </header>

      {!records.length ? <div className="data-empty pattern-empty"><strong>분석할 로그가 없습니다.</strong><span>로그 화면에서 폴더를 추가하면 분포와 피벗이 생성됩니다.</span></div> : (
        <>
          <section className="pattern-section distribution-section" aria-labelledby="distribution-heading">
            <div className="pattern-section-heading"><h2 id="distribution-heading">결과 분포</h2><span>결과를 눌러 마킹</span></div>
            <div className="distribution-list">
              {distribution.map((item) => <button data-testid={`distribution-${item.value}`} className={result === item.value && !axisValue ? 'active' : ''} onClick={() => mark(result === item.value && !axisValue ? null : item.value, null)} key={item.value} aria-pressed={result === item.value && !axisValue}>
                <span>{RESULT_LABEL_KO[item.value]}</span><i><b className={`result-${item.value.toLowerCase()}`} style={{ width: `${Math.max(3, item.count / maxCount * 100)}%` }} /></i><strong>{item.count}</strong>
              </button>)}
            </div>
          </section>

          <section className="pattern-section pivot-section" aria-labelledby="pivot-heading">
            <div className="pattern-section-heading"><h2 id="pivot-heading">조건별 결과</h2><label><span>축</span><select value={axis} onChange={(event) => { setAxis(event.target.value as PatternAxis); setAxisValue(null) }}>{AXES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label></div>
            <div className="pivot-scroll"><table className="pivot-table"><thead><tr><th>{AXES.find((item) => item.value === axis)?.label}</th><th>전체</th>{results.map((item) => <th key={item}>{RESULT_LABEL_KO[item]}</th>)}</tr></thead><tbody>{matrix.map((row) => <tr key={row.value}><th scope="row"><button onClick={() => mark(null, axisValue === row.value && !result ? null : row.value)}>{row.value}{row.value !== '미확인' ? <small>후보</small> : null}</button></th><td><button className={!result && axisValue === row.value ? 'active' : ''} onClick={() => mark(null, row.value)}>{row.total}</button></td>{results.map((item) => <td key={item}><button data-testid={`pivot-${axis}-${row.value}-${item}`} className={result === item && axisValue === row.value ? `active result-${item.toLowerCase()}` : ''} disabled={!row.counts[item]} onClick={() => mark(item, row.value)}>{row.counts[item] ?? 0}</button></td>)}</tr>)}</tbody></table></div>
          </section>

          <section className="pattern-section marked-rows" aria-labelledby="marked-heading">
            <div className="pattern-section-heading"><h2 id="marked-heading">선택 로그</h2><span>{filtered.length.toLocaleString()}{filtered.length > RESULT_LIMIT ? ` · 상위 ${RESULT_LIMIT}개 표시` : ''}</span></div>
            <div className="marked-table-scroll"><table><thead><tr><th>파일명</th><th>폴더</th><th>{AXES.find((item) => item.value === axis)?.label}</th><th>결과</th><th>검토</th></tr></thead><tbody>{filtered.slice(0, RESULT_LIMIT).map((row) => <tr key={row.id} tabIndex={0} onClick={() => onOpenFile(row.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenFile(row.id) } }} aria-label={`${row.fileName} 로그 열기`}><td><button onClick={(event) => { event.stopPropagation(); onOpenFile(row.id) }}>{row.fileName}</button></td><td>{row.folder}</td><td>{row[axis].value ?? '미확인'}</td><td><span className={`result-label result-${row.result.toLowerCase()}`}>{RESULT_LABEL_KO[row.result]}</span></td><td>{row.review === 'confirmed' ? '확정' : '검토 필요'}</td></tr>)}</tbody></table></div>
          </section>
        </>
      )}
    </div>
  )
}
