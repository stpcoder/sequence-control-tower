import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookMarked,
  Check,
  ChevronRight,
  Download,
  Filter,
  GitBranch,
  Link2,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
} from 'lucide-react'
import { knowledgeCases } from '../data/demo'
import type { WikiEntryRecord, WikiExportResult } from '../../electron/shared/contracts'
import type { SavedKnowledgeDetail } from '../state/workspace'

interface KnowledgeViewProps {
  entries: WikiEntryRecord[]
  savedKnowledge: Record<string, SavedKnowledgeDetail>
  onExport: (entryId: string) => Promise<WikiExportResult | null>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function displayDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function KnowledgeView({ entries, savedKnowledge, onExport, onNotify }: KnowledgeViewProps) {
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [selectedDemoId, setSelectedDemoId] = useState(knowledgeCases[0].id)
  const [exporting, setExporting] = useState(false)
  const [actionFeedback, setActionFeedback] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [verifiedOnly, setVerifiedOnly] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!entries.length) {
      setSelectedEntryId(null)
      return
    }
    setSelectedEntryId((current) => current && entries.some((entry) => entry.id === current) ? current : entries[0].id)
  }, [entries])

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedEntryId),
    [entries, selectedEntryId],
  )
  const selectedDetail = selectedEntry ? savedKnowledge[selectedEntry.id]?.input : undefined
  const selectedDemo = knowledgeCases.find((item) => item.id === selectedDemoId) ?? knowledgeCases[0]
  const verifiedCount = entries.filter((entry) => entry.status === 'verified').length
  const reviewCount = entries.filter((entry) => entry.status !== 'verified').length
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return entries.filter((entry) => {
      if (verifiedOnly && entry.status !== 'verified') return false
      if (!query) return true
      const detail = savedKnowledge[entry.id]?.input
      return [
        entry.id,
        entry.title,
        entry.project,
        entry.status,
        detail?.purpose,
        detail?.engineerDecision,
        detail?.tags?.join(' '),
        detail?.analysis?.summary,
        detail?.analysis?.facts.map((fact) => `${fact.label} ${fact.value}`).join(' '),
      ].filter(Boolean).join(' ').toLowerCase().includes(query)
    })
  }, [entries, savedKnowledge, searchQuery, verifiedOnly])
  const filteredDemoCases = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return knowledgeCases.filter((item) => {
      if (verifiedOnly && item.status !== '승인됨') return false
      if (!query) return true
      return [item.id, item.title, item.scope, item.summary, item.status].join(' ').toLowerCase().includes(query)
    })
  }, [searchQuery, verifiedOnly])

  const exportSelected = async () => {
    if (!selectedEntry) {
      onNotify('실제 Sequence를 Knowledge Wiki에 저장한 뒤 내보낼 수 있습니다.', 'info')
      return
    }
    setExporting(true)
    setActionFeedback('Markdown을 준비하고 있습니다…')
    const result = await onExport(selectedEntry.id)
    setExporting(false)
    if (!result) setActionFeedback('내보내기에 실패했습니다. 알림의 오류 내용을 확인하세요.')
    else if (result.cancelled) setActionFeedback('내보내기를 취소했습니다.')
    else setActionFeedback(`${result.fileName ?? 'Wiki 문서'} 내보내기 완료`)
  }

  return (
    <div className="view knowledge-view">
      <section className="knowledge-hero guide-knowledge-library">
        <div>
          <span className="section-kicker">VERIFIED LAB MEMORY</span>
          <h2>한 번 해결한 문제를<br />다시 처음부터 풀지 않습니다.</h2>
          <p>Sequence, Run, Finding, 엔지니어의 판단을 근거와 함께 연결합니다.</p>
        </div>
        <div className="knowledge-stats">
          <div><strong>{entries.length ? verifiedCount : 37}</strong><span>Approved cases</span></div>
          <div><strong>{entries.length ? reviewCount : 12}</strong><span>Review queue</span></div>
          <div><strong>{entries.length || 412}</strong><span>Linked artifacts</span></div>
        </div>
      </section>

      <div className="knowledge-toolbar">
        <div className="inbox-search"><Search size={16} /><input ref={searchInput} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="증상, 조건, command, 사례 검색" /><kbd>Ctrl K</kbd></div>
        <button className={`secondary-button ${verifiedOnly ? 'active-filter' : ''}`} aria-pressed={verifiedOnly} onClick={() => setVerifiedOnly((current) => !current)}><Filter size={15} /> 승인 사례만</button>
        <button className="primary-button" disabled={exporting} onClick={() => void exportSelected()}>
          {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} Obsidian Markdown 내보내기
        </button>
      </div>
      {actionFeedback ? <div className="knowledge-action-feedback"><ShieldCheck size={14} />{actionFeedback}</div> : null}

      <div className="knowledge-layout">
        <section className="case-list">
          {entries.length ? filteredEntries.map((entry) => (
            <button
              className={entry.id === selectedEntryId ? 'case-card active' : 'case-card'}
              key={entry.id}
              onClick={() => setSelectedEntryId(entry.id)}
            >
              <div className="case-card-top">
                <span>{entry.id.slice(0, 8).toUpperCase()}</span>
                <span className={entry.status === 'verified' ? 'verified' : 'review'}>
                  {entry.status === 'verified' ? <ShieldCheck size={13} /> : <Sparkles size={13} />}
                  {entry.status === 'verified' ? '승인됨' : '검토 필요'}
                </span>
              </div>
              <h3>{entry.title}</h3>
              <p>{savedKnowledge[entry.id]?.input.analysis?.summary ?? '원본과 Wiki 메타데이터가 로컬 작업공간에 보존되어 있습니다.'}</p>
              <div className="case-scope"><Tags size={13} /> {entry.project}</div>
              <footer><span><Link2 size={13} /> SHA {entry.artifactId.slice(0, 8)}</span><span>{displayDate(entry.updatedAt)}</span><ChevronRight size={15} /></footer>
            </button>
          )) : filteredDemoCases.map((item) => (
            <button className={item.id === selectedDemoId ? 'case-card active' : 'case-card'} key={item.id} onClick={() => setSelectedDemoId(item.id)}>
              <div className="case-card-top"><span>{item.id}</span><span className={item.status === '승인됨' ? 'verified' : 'review'}>{item.status === '승인됨' ? <ShieldCheck size={13} /> : <Sparkles size={13} />}{item.status}</span></div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <div className="case-scope"><Tags size={13} /> {item.scope}</div>
              <footer><span><Link2 size={13} /> Evidence {item.evidence}</span><span>Confidence {item.confidence}%</span><ChevronRight size={15} /></footer>
            </button>
          ))}
          {!(entries.length ? filteredEntries.length : filteredDemoCases.length) ? <div className="list-filter-empty knowledge-filter-empty"><Search size={17} /><span>조건에 맞는 Knowledge Case가 없습니다.</span></div> : null}
        </section>

        {selectedEntry ? (
          <LiveKnowledgeDetail entry={selectedEntry} detail={selectedDetail} onExport={() => void exportSelected()} exporting={exporting} />
        ) : (
          <section className="case-detail guide-knowledge-case">
            <div className="case-detail-head">
              <div className="case-icon"><BookMarked size={20} /></div>
              <div><span>{selectedDemo.id} · DEMO</span><h2>{selectedDemo.title}</h2><p>{selectedDemo.scope}</p></div>
            </div>

            <div className="case-section">
              <span>관찰된 증상</span>
              <p>{selectedDemo.summary} 동일 조건의 반복 여부와 장비 readback을 함께 확인했습니다.</p>
            </div>
            <div className="case-section two-column">
              <div><span>확인된 조건</span><p><Check size={14} /> 105℃ readback 정상</p><p><Check size={14} /> VDD 0.91V 안정</p><p><Check size={14} /> Serial prompt 정상</p></div>
              <div><span>배제된 원인</span><p><Check size={14} /> ADB disconnect 없음</p><p><Check size={14} /> Board reboot 없음</p><p><Check size={14} /> Log tail 누락 없음</p></div>
            </div>
            <div className="case-section recommendation-block">
              <span>검증된 대응</span>
              <ol><li>동일 조건을 3회 반복합니다.</li><li>Pattern 1190과 6060을 분리합니다.</li><li>CLK 10000과 10660 사이 경계를 세분화합니다.</li></ol>
            </div>

            <div className="case-evidence-tree">
              <span>근거 계보</span>
              <div><GitBranch size={15} /><p><strong>3 Sequence revisions</strong><small>SEQ-1051 · SEQ-1054 · SEQ-1059</small></p></div>
              <div><Link2 size={15} /><p><strong>7 Run artifacts</strong><small>raw logs · manifests · parsed events</small></p></div>
              <div><ShieldCheck size={15} /><p><strong>Engineer approved</strong><small>박서연 · 2026.07.29</small></p></div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function LiveKnowledgeDetail({
  entry,
  detail,
  onExport,
  exporting,
}: {
  entry: WikiEntryRecord
  detail?: SavedKnowledgeDetail['input']
  onExport: () => void
  exporting: boolean
}) {
  const analysis = detail?.analysis
  return (
    <section className="case-detail guide-knowledge-case">
      <div className="case-detail-head live-case-head">
        <div className="case-icon"><BookMarked size={20} /></div>
        <div><span>{entry.id.slice(0, 8).toUpperCase()} · {entry.status.toUpperCase()}</span><h2>{entry.title}</h2><p>{entry.project} · Updated {displayDate(entry.updatedAt)}</p></div>
        <button className="secondary-button" disabled={exporting} onClick={onExport}>{exporting ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />} Markdown</button>
      </div>

      <div className="case-section">
        <span>저장된 평가 목적과 Agent Review</span>
        <p>{detail?.purpose ?? analysis?.summary ?? '이 항목은 이전 세션에서 저장되었습니다. Markdown 원문에는 저장 당시의 목적과 근거가 보존되어 있습니다.'}</p>
      </div>

      <div className="case-section two-column live-facts-grid">
        <div>
          <span>파일에서 확인된 사실</span>
          {(analysis?.facts ?? []).slice(0, 6).map((fact) => <p key={fact.key}><Check size={14} /> {fact.label}: {fact.value}</p>)}
          {!analysis?.facts.length ? <p><Link2 size={14} /> Artifact SHA {entry.artifactId.slice(0, 12)}…</p> : null}
        </div>
        <div>
          <span>부모 대비 의미 변경</span>
          {(analysis?.changes ?? []).slice(0, 6).map((change) => <p key={`${change.key}-${change.kind}`}><GitBranch size={14} /> {change.label}: {change.before ?? '—'} → {change.after ?? '—'}</p>)}
          {!analysis?.changes.length ? <p><GitBranch size={14} /> 확인된 부모 변경 정보 없음</p> : null}
        </div>
      </div>

      <div className="case-section recommendation-block">
        <span>엔지니어 판단 · 재사용할 맥락</span>
        <ol>
          {detail?.engineerDecision ? <li>{detail.engineerDecision}</li> : null}
          {(analysis?.inferences ?? []).slice(0, 3).map((inference) => <li key={inference.title}>{inference.title}: {inference.detail} ({Math.round(inference.confidence * 100)}%)</li>)}
          {(analysis?.questions ?? []).slice(0, 2).map((question) => <li key={question.id}>확인 필요: {question.question}</li>)}
          {!detail?.engineerDecision && !analysis?.inferences.length && !analysis?.questions.length ? <li>Markdown을 내보내 Obsidian에서 저장된 전체 지식 내용을 확인할 수 있습니다.</li> : null}
        </ol>
      </div>

      <div className="case-evidence-tree">
        <span>근거 계보</span>
        <div><GitBranch size={15} /><p><strong>{entry.status === 'verified' ? 'Engineer verified' : 'Review pending'}</strong><small>{detail?.engineerDecision ?? '저장 상태를 기준으로 표시'}</small></p></div>
        <div><Link2 size={15} /><p><strong>Content-addressed artifact</strong><small>sha256:{entry.artifactId}</small></p></div>
        <div><ShieldCheck size={15} /><p><strong>Obsidian-ready Markdown</strong><small>{entry.relativeFileName}</small></p></div>
      </div>
    </section>
  )
}
