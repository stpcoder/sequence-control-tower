import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  FileCode2,
  Filter,
  FolderInput,
  LoaderCircle,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { intakeItems, type IntakeItem } from '../data/demo'
import type {
  AnalysisJobSnapshot,
  ArtifactRecord,
  SimilarArtifact,
  WikiEntryInput,
  WikiEntryRecord,
} from '../../electron/shared/contracts'
import {
  analysisConfidence,
  artifactDisplayName,
  artifactShortId,
  type WorkspaceArtifact,
} from '../state/workspace'

interface InboxViewProps {
  workspaceItems: WorkspaceArtifact[]
  selectedArtifactId: string | null
  onSelectArtifact: (artifactId: string | null) => void
  onArtifactsImported: (artifacts: ArtifactRecord[]) => void
  onQueueAnalyses: (artifacts: ArtifactRecord[], userComment: string) => Promise<AnalysisJobSnapshot[]>
  onReview: (artifactId?: string) => void
  onSaveKnowledge: (input: WikiEntryInput) => Promise<WikiEntryRecord | null>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function cleanTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
}

export function InboxView({
  workspaceItems,
  selectedArtifactId,
  onSelectArtifact,
  onArtifactsImported,
  onQueueAnalyses,
  onReview,
  onSaveKnowledge,
  onNotify,
}: InboxViewProps) {
  const [selectedDemoId, setSelectedDemoId] = useState(intakeItems[0].id)
  const [answer, setAnswer] = useState('')
  const [customAnswer, setCustomAnswer] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [contextNote, setContextNote] = useState('')
  const [pendingArtifacts, setPendingArtifacts] = useState<ArtifactRecord[]>([])
  const [importMessage, setImportMessage] = useState('')
  const [similarArtifacts, setSimilarArtifacts] = useState<SimilarArtifact[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [reviewOnly, setReviewOnly] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)

  const liveSelected = useMemo(
    () => workspaceItems.find((item) => item.artifact.id === selectedArtifactId),
    [selectedArtifactId, workspaceItems],
  )
  const demoSelected = useMemo(
    () => intakeItems.find((item) => item.id === selectedDemoId) ?? intakeItems[0],
    [selectedDemoId],
  )
  const activeJob = liveSelected?.job ?? workspaceItems.find((item) =>
    item.job && !['completed', 'failed', 'cancelled'].includes(item.job.status),
  )?.job

  const filteredWorkspaceItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return workspaceItems.filter((item) => {
      const needsReview = !item.analysis || Boolean(item.analysis.questions.length) ||
        Boolean(item.job && item.job.status !== 'completed' && item.job.status !== 'cancelled')
      if (reviewOnly && !needsReview) return false
      if (!query) return true
      const searchable = [
        artifactDisplayName(item.artifact),
        item.userComment,
        item.analysis?.summary,
        item.analysis?.suggestedTags.join(' '),
        item.analysis?.facts.map((fact) => `${fact.label} ${fact.value}`).join(' '),
      ].filter(Boolean).join(' ').toLowerCase()
      return searchable.includes(query)
    })
  }, [reviewOnly, searchQuery, workspaceItems])

  const filteredDemoItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return intakeItems.filter((item) => {
      if (reviewOnly && item.status === 'ready') return false
      if (!query) return true
      return [item.id, item.file, item.project, item.family, item.note, ...item.changes]
        .join(' ').toLowerCase().includes(query)
    })
  }, [reviewOnly, searchQuery])

  useEffect(() => {
    setAnswer('')
    setCustomAnswer('')
    setConfirmed(false)
  }, [selectedArtifactId, selectedDemoId])

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

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api || !liveSelected) {
      setSimilarArtifacts([])
      return undefined
    }
    let active = true
    void api.artifacts.findSimilar(liveSelected.artifact.id, 3)
      .then((items) => {
        if (active) setSimilarArtifacts(items)
      })
      .catch(() => {
        if (active) setSimilarArtifacts([])
      })
    return () => { active = false }
  }, [liveSelected?.artifact.id])

  const selectDemo = (id: string) => {
    setSelectedDemoId(id)
    onSelectArtifact(null)
  }

  const importFromDesktop = async (folder = false) => {
    const api = window.sequenceIntelligence
    if (!api) {
      setPendingArtifacts([])
      setImportMessage('웹 미리보기에서는 데모 파일이 사용됩니다. Windows 앱에서 실제 파일 선택기가 열립니다.')
      return
    }
    setImportMessage('원본을 확인하고 있습니다…')
    try {
      const result = folder ? await api.artifacts.importFolder() : await api.artifacts.importFiles()
      if (result.cancelled) {
        setImportMessage('가져오기를 취소했습니다.')
        return
      }
      setPendingArtifacts(result.artifacts)
      onArtifactsImported(result.artifacts)
      setImportMessage(
        `${result.artifacts.length}개 원본 보존 완료` +
        `${result.failures.length ? ` · 실패 ${result.failures.length}` : ''}` +
        `${result.skippedCount ? ` · 제외 ${result.skippedCount}` : ''}`,
      )
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '파일을 가져오지 못했습니다.')
    }
  }

  const queueAnalysis = async () => {
    if (!pendingArtifacts.length) {
      if (!window.sequenceIntelligence) {
        setImportOpen(false)
        onNotify('웹 미리보기에서는 데모 분석 흐름을 보여줍니다.', 'info')
      }
      return
    }
    try {
      const jobs = await onQueueAnalyses(pendingArtifacts, contextNote)
      setImportMessage(`${jobs.length}개 분석을 대기열에 추가했습니다.`)
      setImportOpen(false)
      setPendingArtifacts([])
      setContextNote('')
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '분석 작업을 시작하지 못했습니다.')
    }
  }

  const facts = liveSelected?.analysis?.facts ?? liveSelected?.artifact.fingerprint?.facts ?? []
  const factMap = new Map(facts.map((fact) => [fact.key, fact.value]))
  const liveQuestion = liveSelected?.analysis?.questions[0]
  const selectedAnswer = answer === '직접 입력' ? customAnswer.trim() : answer
  const liveChanges = liveSelected?.analysis?.changes.map((change) => {
    if (change.kind === 'added') return `${change.label} ${change.after} 추가`
    if (change.kind === 'removed') return `${change.label} ${change.before} 제거`
    return `${change.label}: ${change.before} → ${change.after}`
  }) ?? []
  const parentCandidate = liveSelected?.analysis?.parentArtifactId
    ? workspaceItems.find((item) => item.artifact.id === liveSelected.analysis?.parentArtifactId)?.artifact
    : similarArtifacts[0]?.artifact
  const parentScore = liveSelected?.analysis?.parentArtifactId ? 100 : Math.round((similarArtifacts[0]?.score ?? 0) * 100)
  const displayQuestion = liveSelected ? liveQuestion?.question : demoSelected.question
  const displayChoices = liveSelected
    ? liveQuestion?.choices ?? []
    : ['CLK 경계 확인', 'Pattern 의존성 확인', '두 가지 모두']

  const saveCommit = async () => {
    if (!liveSelected?.analysis) {
      setConfirmed(true)
      return
    }
    setSaving(true)
    const confirmedParentId = liveQuestion?.id === 'confirm-parent'
      ? similarArtifacts.find((item) => item.artifact.originalNames.includes(selectedAnswer))?.artifact.id
      : undefined
    const purpose = liveQuestion?.id === 'confirm-parent'
      ? liveSelected.userComment || liveSelected.analysis.summary
      : selectedAnswer || liveSelected.userComment || undefined
    const input: WikiEntryInput = {
      artifactId: liveSelected.artifact.id,
      parentArtifactId: liveSelected.analysis.parentArtifactId ?? confirmedParentId,
      project: 'Qualcomm · Product A',
      title: cleanTitle(artifactDisplayName(liveSelected.artifact)),
      purpose,
      userComment: liveSelected.userComment,
      status: liveSelected.analysis.questions.length > 1 ? 'inferred' : 'verified',
      tags: liveSelected.analysis.suggestedTags,
      analysis: liveSelected.analysis,
      engineerDecision: liveQuestion && selectedAnswer
        ? `${liveQuestion.question}\n답변: ${selectedAnswer}`
        : 'Sequence Commit 내용을 검토하고 Knowledge Wiki 저장을 승인함.',
    }
    const record = await onSaveKnowledge(input)
    setSaving(false)
    if (record) setConfirmed(true)
  }

  const liveCount = workspaceItems.length
  const reviewReadyCount = workspaceItems.filter((item) => item.analysis).length
  const questionCount = workspaceItems.filter((item) => item.analysis?.questions.length).length

  return (
    <div className="view inbox-view">
      <div className="inbox-toolbar guide-import-sequence">
        <div className="inbox-search">
          <Search size={16} />
          <input ref={searchInput} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="파일, 프로젝트, command 검색" />
          <kbd>Ctrl K</kbd>
        </div>
        <button className={`secondary-button ${reviewOnly ? 'active-filter' : ''}`} aria-pressed={reviewOnly} onClick={() => setReviewOnly((current) => !current)}><Filter size={16} /> 검토 필요만</button>
        <button className="primary-button" onClick={() => setImportOpen((current) => !current)}><FolderInput size={17} /> 파일 또는 폴더 가져오기</button>
      </div>

      {importOpen ? (
        <section className="import-context-panel">
          <button className="import-drop" onClick={() => void importFromDesktop(false)}>
            <FolderInput size={20} />
            <span><strong>{pendingArtifacts.length ? `${pendingArtifacts.length}개 파일 선택됨` : 'SEQ 파일 선택'}</strong><small>{importMessage || '원본은 변경 없이 SHA-256 artifact로 보존됩니다.'}</small></span>
          </button>
          <label>
            <span>짧은 맥락 <small>선택 사항</small></span>
            <textarea value={contextNote} onChange={(event) => setContextNote(event.target.value)} placeholder="예: 고온 fail 때문에 CLK 나눠본 버전" rows={2} />
          </label>
          <div className="import-context-actions">
            <p>모르는 내용은 비워두세요. Agent가 꼭 필요한 경우에만 나중에 질문합니다.</p>
            <button className="secondary-button" onClick={() => void importFromDesktop(true)}>폴더 선택</button>
            <button className="secondary-button" onClick={() => { setContextNote(''); setPendingArtifacts([]); setImportOpen(false) }}>취소</button>
            <button className="primary-button" onClick={() => void queueAnalysis()} disabled={Boolean(window.sequenceIntelligence) && pendingArtifacts.length === 0}>분석 대기열에 추가</button>
          </div>
        </section>
      ) : null}

      {activeJob ? (
        <div className={`analysis-job-banner ${activeJob.status}`}>
          {activeJob.status === 'completed' ? <Check size={14} /> : activeJob.status === 'failed' ? <CircleAlert size={14} /> : <LoaderCircle className={activeJob.status === 'running' ? 'spin' : ''} size={14} />}
          <strong>{activeJob.stage}</strong>
          <span>{activeJob.status === 'queued' ? `대기 순서 ${activeJob.queuePosition}` : activeJob.result?.source === 'deterministic-fallback' ? '로컬 분석으로 완료' : activeJob.error ?? activeJob.result?.model ?? '원본은 안전하게 보존됨'}</span>
        </div>
      ) : importMessage && !importOpen ? <div className="analysis-job-banner info"><ShieldCheck size={14} /><strong>{importMessage}</strong></div> : null}

      <div className="inbox-layout">
        <section className="inbox-list guide-inbox-list">
          <div className="list-head">
            <div>
              <strong>{liveCount ? '실제 작업공간' : '분류 대기함 · Demo'}</strong>
              <span>{liveCount ? `${liveCount} files · 분석 완료 ${reviewReadyCount} · 질문 ${questionCount}` : '128 files · 질문이 필요한 항목 14개'}</span>
            </div>
            <button>최신순⌄</button>
          </div>
          {liveCount ? filteredWorkspaceItems.map((item) => (
            <LiveIntakeRow
              key={item.artifact.id}
              item={item}
              active={selectedArtifactId === item.artifact.id}
              onClick={() => onSelectArtifact(item.artifact.id)}
            />
          )) : filteredDemoItems.map((item) => (
            <IntakeRow key={item.id} item={item} active={!selectedArtifactId && selectedDemoId === item.id} onClick={() => selectDemo(item.id)} />
          ))}
          {!(liveCount ? filteredWorkspaceItems.length : filteredDemoItems.length) ? <div className="list-filter-empty"><Search size={17} /><span>조건에 맞는 Sequence가 없습니다.</span></div> : null}
          <div className="inbox-empty-tail">
            <Archive size={18} />
            <span>{liveCount ? '원본, fingerprint, Agent Review가 동일한 artifact ID로 연결됩니다.' : '자동 분류된 114개 파일은 검토 없이 안전하게 보관되었습니다.'}</span>
          </div>
        </section>

        <section className="intake-review guide-agent-question">
          <div className="review-file-head">
            <div className="file-glyph">SEQ</div>
            <div>
              <span>{liveSelected ? artifactShortId(liveSelected.artifact) : demoSelected.id}{liveSelected ? ' · LOCAL ARTIFACT' : ' · DEMO DATA'}</span>
              <h2>{liveSelected ? artifactDisplayName(liveSelected.artifact) : demoSelected.file}</h2>
              <p>{liveSelected
                ? `SHA-256 ${liveSelected.artifact.sha256.slice(0, 12)}… · ${liveSelected.artifact.fingerprint?.blockCount ?? 0} blocks · ${liveSelected.artifact.fingerprint?.commandCount ?? 0} commands`
                : 'SHA-256 원본 보존됨 · 24 blocks · 163 commands'}</p>
            </div>
            <div className="confidence-stamp">
              <span>분류 확신도</span>
              <strong>{liveSelected ? analysisConfidence(liveSelected.analysis, liveSelected.artifact) : demoSelected.confidence}%</strong>
            </div>
          </div>

          <div className="intake-columns">
            <div className="sequence-dna">
              <span className="section-kicker">SEQUENCE DNA · EXTRACTED</span>
              <dl>
                <div><dt>Project</dt><dd>{liveSelected ? 'Qualcomm · Product A' : demoSelected.project}</dd></div>
                <div><dt>Family</dt><dd>{liveSelected ? liveSelected.analysis?.suggestedTags.slice(0, 2).join(' / ') || '분류 대기' : demoSelected.family}</dd></div>
                <div><dt>Temperature</dt><dd>{liveSelected ? factMap.get('temperature') ?? '확인되지 않음' : '105℃'}</dd></div>
                <div><dt>VDD</dt><dd>{liveSelected ? factMap.get('voltage') ?? '확인되지 않음' : '0.91V'}</dd></div>
                <div><dt>ECC</dt><dd>{liveSelected ? factMap.get('ecc') ?? '확인되지 않음' : 'Enable'}</dd></div>
                <div><dt>CLK</dt><dd>{liveSelected ? factMap.get('clock') ?? '확인되지 않음' : '9600 · 10000 · 10660'}</dd></div>
                <div><dt>Pattern</dt><dd>{liveSelected ? factMap.get('pattern') ?? '확인되지 않음' : '1190 · 6060'}</dd></div>
              </dl>
              <button disabled={Boolean(liveSelected && !liveSelected.analysis)} onClick={() => onReview(liveSelected?.artifact.id)}>전체 Semantic Review <ChevronRight size={15} /></button>
            </div>

            <div className="parent-candidate">
              <span className="section-kicker">LIKELY PARENT · CONFIRM FIRST</span>
              <div className="candidate-card">
                <div>
                  <span>{parentCandidate ? artifactShortId(parentCandidate) : liveSelected ? 'NO VERIFIED PARENT' : 'SEQ-1051'}</span>
                  <strong>{parentCandidate ? artifactDisplayName(parentCandidate) : liveSelected ? '후보를 찾는 중' : 'Low voltage'}</strong>
                  <small>{parentCandidate ? `${similarArtifacts[0]?.reasons.join(' · ') || 'Agent 분석에서 연결됨'}` : liveSelected ? '관계는 자동 확정되지 않습니다.' : '명령 구조 96% 일치'}</small>
                </div>
                <div className="similarity-ring">{liveSelected ? parentScore || '—' : 96}</div>
              </div>
              <div className="change-summary">
                {(liveSelected ? liveChanges : demoSelected.changes).slice(0, 4).map((change) => <p key={change}><span>+</span>{change}</p>)}
                {liveSelected && !liveChanges.length ? <p><span>·</span>부모 확인 후 의미 변경이 계산됩니다.</p> : null}
              </div>
            </div>
          </div>

          {displayQuestion ? (
            <div className="agent-question-card">
              <div className="question-mark"><Sparkles size={18} /></div>
              <div className="question-body">
                <span>AGENT가 한 가지만 확인하고 싶습니다</span>
                <h3>{displayQuestion}</h3>
                <p>{liveQuestion?.why ?? '파일에서 단정할 수 없는 내용입니다. 이 답은 같은 Family의 Sequence 분류에 재사용됩니다.'}</p>
                <div className="answer-options">
                  {displayChoices.map((option) => (
                    <button key={option} className={answer === option ? 'selected' : ''} onClick={() => setAnswer(option)}>
                      {answer === option ? <Check size={14} /> : null}{option}
                    </button>
                  ))}
                  <button className={answer === '직접 입력' ? 'selected' : ''} onClick={() => setAnswer('직접 입력')}>직접 입력</button>
                </div>
                {answer === '직접 입력' ? <textarea className="question-custom-answer" value={customAnswer} onChange={(event) => setCustomAnswer(event.target.value)} placeholder="평가 목적이나 부모 관계를 짧게 적어주세요." rows={2} /> : null}
              </div>
            </div>
          ) : (
            <div className="agent-question-card verified-card">
              <div className="question-mark"><ShieldCheck size={18} /></div>
              <div className="question-body">
                <span>{liveSelected?.analysis ? '추가 질문이 필요하지 않습니다' : liveSelected ? '분석 결과를 기다리고 있습니다' : '추가 질문이 필요하지 않습니다'}</span>
                <h3>{liveSelected?.analysis?.summary ?? (liveSelected ? '파일 구조와 조건을 로컬에서 먼저 분석합니다.' : '기존에 승인된 ECC Comparison 규칙과 일치합니다.')}</h3>
                <p>원본과 분석 근거를 함께 보존하고, 승인 후에만 Verified 지식으로 저장합니다.</p>
              </div>
            </div>
          )}

          <div className="intake-footer">
            <div>
              <CircleHelp size={15} />
              <span>확인 전까지 AI 추론은 사실로 저장되지 않습니다.</span>
            </div>
            <button className="secondary-button" onClick={() => onNotify('검토 대기 상태로 유지했습니다.', 'info')}>나중에 확인</button>
            <button
              className="primary-button"
              disabled={saving || Boolean(liveSelected && !liveSelected.analysis) || Boolean(displayQuestion && !selectedAnswer)}
              onClick={() => void saveCommit()}
            >
              {saving ? <><LoaderCircle className="spin" size={16} /> Wiki 저장 중</> : confirmed ? <><Check size={16} /> Knowledge에 저장됨</> : <><Sparkles size={16} /> 확인하고 Commit 생성</>}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function LiveIntakeRow({ item, active, onClick }: { item: WorkspaceArtifact; active: boolean; onClick: () => void }) {
  const job = item.job
  const status = job?.status === 'failed'
    ? <><CircleAlert size={13} /> 분석 실패</>
    : job && !['completed', 'failed', 'cancelled'].includes(job.status)
      ? <><LoaderCircle className="spin" size={13} /> {job.status === 'queued' ? `대기 ${job.queuePosition}` : '분석 중'}</>
      : item.analysis?.questions.length
        ? <><CircleHelp size={13} /> 질문 {item.analysis.questions.length}개</>
        : item.analysis
          ? <><Check size={13} /> Commit 준비</>
          : <><CircleHelp size={13} /> 분석 필요</>
  const statusClass = job?.status === 'failed'
    ? 'failed'
    : job && !['completed', 'failed', 'cancelled'].includes(job.status)
      ? 'processing'
      : item.analysis?.questions.length
        ? 'question'
        : item.analysis ? 'ready' : 'processing'

  return (
    <button className={active ? 'intake-row active' : 'intake-row'} onClick={onClick}>
      <div className="row-file-icon"><FileCode2 size={18} /></div>
      <div className="row-main">
        <strong>{artifactDisplayName(item.artifact)}</strong>
        <span>Local artifact · {item.artifact.extension || 'text'} · {(item.artifact.size / 1024).toFixed(1)} KB</span>
        <small>{item.userComment || item.analysis?.summary || '사용자 코멘트 없음'}</small>
      </div>
      <div className={`row-status ${statusClass}`}>{status}</div>
      <ChevronRight size={16} />
    </button>
  )
}

function IntakeRow({ item, active, onClick }: { item: IntakeItem; active: boolean; onClick: () => void }) {
  const status = item.status === 'processing'
    ? <><LoaderCircle className="spin" size={13} /> 분석 중</>
    : item.status === 'question'
      ? <><CircleHelp size={13} /> 질문 {item.confidence < 50 ? '2' : '1'}개</>
      : <><Check size={13} /> Commit 준비</>

  return (
    <button className={active ? 'intake-row active' : 'intake-row'} onClick={onClick}>
      <div className="row-file-icon"><FileCode2 size={18} /></div>
      <div className="row-main">
        <strong>{item.file}</strong>
        <span>{item.project} · {item.family}</span>
        <small>{item.note || '사용자 코멘트 없음'}</small>
      </div>
      <div className={`row-status ${item.status}`}>{status}</div>
      <ChevronRight size={16} />
    </button>
  )
}
