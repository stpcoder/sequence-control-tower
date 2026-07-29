import { useMemo, useState } from 'react'
import { Archive, Check, ChevronRight, CircleHelp, FileCode2, Filter, FolderInput, LoaderCircle, Search, ShieldCheck, Sparkles } from 'lucide-react'
import { intakeItems, type IntakeItem } from '../data/demo'
import type { AnalysisJobSnapshot, ArtifactRecord } from '../../electron/shared/contracts'

interface InboxViewProps {
  onReview: () => void
}

export function InboxView({ onReview }: InboxViewProps) {
  const [selectedId, setSelectedId] = useState(intakeItems[0].id)
  const [answer, setAnswer] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [contextNote, setContextNote] = useState('')
  const [pendingArtifacts, setPendingArtifacts] = useState<ArtifactRecord[]>([])
  const [importMessage, setImportMessage] = useState('')
  const [analysisJob, setAnalysisJob] = useState<AnalysisJobSnapshot | null>(null)
  const selected = useMemo(() => intakeItems.find((item) => item.id === selectedId) ?? intakeItems[0], [selectedId])

  const chooseAnswer = (value: string) => {
    setAnswer(value)
    setConfirmed(false)
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
      setImportMessage(`${result.artifacts.length}개 원본 보존 완료${result.failures.length ? ` · 실패 ${result.failures.length}` : ''}`)
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '파일을 가져오지 못했습니다.')
    }
  }

  const queueAnalysis = async () => {
    const api = window.sequenceIntelligence
    const artifact = pendingArtifacts[0]
    if (!api || !artifact) {
      setImportOpen(false)
      setImportMessage('')
      return
    }
    try {
      const job = await api.analysis.start({
        artifactId: artifact.id,
        userComment: contextNote.trim() || undefined,
        projectContext: 'Qualcomm · Product A',
      })
      setAnalysisJob(job)
      setImportMessage(`분석 대기열 ${job.queuePosition || 1}번에 추가했습니다.`)
      const unsubscribe = api.analysis.onJobUpdate((updated) => {
        if (updated.id !== job.id) return
        setAnalysisJob(updated)
        if (['completed', 'failed', 'cancelled'].includes(updated.status)) unsubscribe()
      })
      setImportOpen(false)
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '분석 작업을 시작하지 못했습니다.')
    }
  }

  return (
    <div className="view inbox-view">
      <div className="inbox-toolbar guide-import-sequence">
        <div className="inbox-search">
          <Search size={16} />
          <input placeholder="파일, 프로젝트, command 검색" />
          <kbd>Ctrl K</kbd>
        </div>
        <button className="secondary-button"><Filter size={16} /> 검토 필요만</button>
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

      {analysisJob ? (
        <div className={`analysis-job-banner ${analysisJob.status}`}>
          {analysisJob.status === 'completed' ? <Check size={14} /> : <LoaderCircle className={analysisJob.status === 'running' ? 'spin' : ''} size={14} />}
          <strong>{analysisJob.stage}</strong>
          <span>{analysisJob.status === 'queued' ? `대기 순서 ${analysisJob.queuePosition}` : analysisJob.result?.source === 'deterministic-fallback' ? '로컬 분석으로 완료' : analysisJob.result?.model || '원본은 안전하게 보존됨'}</span>
        </div>
      ) : importMessage && !importOpen ? <div className="analysis-job-banner info"><ShieldCheck size={14} /><strong>{importMessage}</strong></div> : null}

      <div className="inbox-layout">
        <section className="inbox-list guide-inbox-list">
          <div className="list-head">
            <div>
              <strong>분류 대기함</strong>
              <span>128 files · 질문이 필요한 항목 14개</span>
            </div>
            <button>최신순⌄</button>
          </div>
          {intakeItems.map((item) => (
            <IntakeRow key={item.id} item={item} active={selectedId === item.id} onClick={() => { setSelectedId(item.id); setAnswer(''); setConfirmed(false) }} />
          ))}
          <div className="inbox-empty-tail">
            <Archive size={18} />
            <span>자동 분류된 114개 파일은 검토 없이 안전하게 보관되었습니다.</span>
          </div>
        </section>

        <section className="intake-review guide-agent-question">
          <div className="review-file-head">
            <div className="file-glyph">SEQ</div>
            <div>
              <span>{selected.id}</span>
              <h2>{selected.file}</h2>
              <p>SHA-256 원본 보존됨 · 24 blocks · 163 commands</p>
            </div>
            <div className="confidence-stamp">
              <span>분류 확신도</span>
              <strong>{selected.confidence}%</strong>
            </div>
          </div>

          <div className="intake-columns">
            <div className="sequence-dna">
              <span className="section-kicker">SEQUENCE DNA</span>
              <dl>
                <div><dt>Project</dt><dd>{selected.project}</dd></div>
                <div><dt>Family</dt><dd>{selected.family}</dd></div>
                <div><dt>Temperature</dt><dd>105℃</dd></div>
                <div><dt>VDD</dt><dd>0.91V</dd></div>
                <div><dt>ECC</dt><dd>Enable</dd></div>
                <div><dt>CLK</dt><dd>9600 · 10000 · 10660</dd></div>
                <div><dt>Pattern</dt><dd>1190 · 6060</dd></div>
              </dl>
              <button onClick={onReview}>전체 Semantic Diff <ChevronRight size={15} /></button>
            </div>

            <div className="parent-candidate">
              <span className="section-kicker">LIKELY PARENT</span>
              <div className="candidate-card">
                <div>
                  <span>SEQ-1051</span>
                  <strong>Low voltage</strong>
                  <small>명령 구조 96% 일치</small>
                </div>
                <div className="similarity-ring">96</div>
              </div>
              <div className="change-summary">
                {selected.changes.map((change) => <p key={change}><span>+</span>{change}</p>)}
              </div>
            </div>
          </div>

          {selected.question ? (
            <div className="agent-question-card">
              <div className="question-mark"><Sparkles size={18} /></div>
              <div className="question-body">
                <span>AGENT가 한 가지만 확인하고 싶습니다</span>
                <h3>{selected.question}</h3>
                <p>파일에서 단정할 수 없는 내용입니다. 이 답은 같은 Family의 18개 Sequence 분류에 재사용됩니다.</p>
                <div className="answer-options">
                  {['CLK 경계 확인', 'Pattern 의존성 확인', '두 가지 모두'].map((option) => (
                    <button key={option} className={answer === option ? 'selected' : ''} onClick={() => chooseAnswer(option)}>
                      {answer === option ? <Check size={14} /> : null}{option}
                    </button>
                  ))}
                  <button className={answer === '직접 입력' ? 'selected' : ''} onClick={() => chooseAnswer('직접 입력')}>직접 입력</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="agent-question-card verified-card">
              <div className="question-mark"><ShieldCheck size={18} /></div>
              <div className="question-body">
                <span>추가 질문이 필요하지 않습니다</span>
                <h3>기존에 승인된 ECC Comparison 규칙과 일치합니다.</h3>
                <p>원본과 분석 근거는 보존하고 Commit 초안을 바로 만들 수 있습니다.</p>
              </div>
            </div>
          )}

          <div className="intake-footer">
            <div>
              <CircleHelp size={15} />
              <span>확인 전까지 AI 추론은 사실로 저장되지 않습니다.</span>
            </div>
            <button className="secondary-button">나중에 확인</button>
            <button
              className="primary-button"
              disabled={Boolean(selected.question) && !answer}
              onClick={() => setConfirmed(true)}
            >
              {confirmed ? <><Check size={16} /> Commit 저장됨</> : <><Sparkles size={16} /> 확인하고 Commit 생성</>}
            </button>
          </div>
        </section>
      </div>
    </div>
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
