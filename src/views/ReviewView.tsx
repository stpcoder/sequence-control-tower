import { useMemo, useState } from 'react'
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Code2,
  Eye,
  FileText,
  GitCompareArrows,
  Lightbulb,
  Link2,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { logEvidence, semanticDiff as demoSemanticDiff } from '../data/demo'
import type { WikiEntryInput, WikiEntryRecord } from '../../electron/shared/contracts'
import {
  analysisConfidence,
  artifactDisplayName,
  artifactShortId,
  type WorkspaceArtifact,
} from '../state/workspace'

type ReviewTab = 'story' | 'sequence' | 'log'

interface ReviewViewProps {
  workspaceItem?: WorkspaceArtifact
  onSaveKnowledge: (input: WikiEntryInput) => Promise<WikiEntryRecord | null>
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void
}

function cleanTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
}

export function ReviewView({ workspaceItem, onSaveKnowledge, onNotify }: ReviewViewProps) {
  const [tab, setTab] = useState<ReviewTab>('story')
  const [accepted, setAccepted] = useState(false)
  const [saving, setSaving] = useState(false)
  const analysis = workspaceItem?.analysis
  const artifact = analysis ? workspaceItem?.artifact : undefined
  const live = Boolean(analysis && artifact)

  const diffLines = useMemo(() => {
    if (!analysis) return demoSemanticDiff
    if (!analysis.changes.length) {
      return analysis.facts.slice(0, 5).map((fact) => ({
        kind: 'context',
        before: `${fact.label}: ${fact.value}`,
        after: `${fact.label}: ${fact.value}`,
        note: '파일에서 직접 추출한 조건',
      }))
    }
    return analysis.changes.map((change) => ({
      kind: change.kind === 'added' ? 'add' : 'change',
      before: change.kind === 'added' ? '' : `${change.label}: ${change.before ?? '확인되지 않음'}`,
      after: change.kind === 'removed' ? '' : `${change.label}: ${change.after ?? '확인되지 않음'}`,
      note: change.kind === 'added' ? '조건 추가' : change.kind === 'removed' ? '조건 제거' : `${change.significance.toUpperCase()} 영향 변경`,
    }))
  }, [analysis])

  const primaryInference = analysis?.inferences[0]
  const primaryQuestion = analysis?.questions[0]
  const confidence = analysisConfidence(analysis, artifact)
  const changedSummary = analysis?.changes.length
    ? analysis.changes.slice(0, 3).map((change) => change.label).join(' · ')
    : '부모 정보가 없어 기준 조건으로 저장'

  const approveAndSave = async () => {
    if (!analysis || !artifact) {
      setAccepted(true)
      return
    }
    if (primaryQuestion) {
      onNotify('Sequence Inbox에서 Agent 질문에 답한 뒤 Verified Wiki로 저장해 주세요.', 'info')
      return
    }
    setSaving(true)
    const input: WikiEntryInput = {
      artifactId: artifact.id,
      parentArtifactId: analysis.parentArtifactId,
      project: 'Qualcomm · Product A',
      title: cleanTitle(artifactDisplayName(artifact)),
      purpose: workspaceItem.userComment || primaryInference?.detail || analysis.summary,
      userComment: workspaceItem.userComment,
      status: 'verified',
      tags: analysis.suggestedTags,
      analysis,
      engineerDecision: 'Semantic Review의 사실·추론 구분과 변경 내용을 확인하고 Wiki 저장을 승인함.',
    }
    const record = await onSaveKnowledge(input)
    setSaving(false)
    if (record) setAccepted(true)
  }

  return (
    <div className="view review-view">
      <div className="review-toolbar">
        <div className="compare-selector">
          <span>BASE</span>
          <button>{analysis?.parentArtifactId ? `SEQ-${analysis.parentArtifactId.slice(0, 6).toUpperCase()}` : '확인된 부모 없음'} <ChevronDown size={14} /></button>
          <GitCompareArrows size={17} />
          <span>COMPARE</span>
          <button>{artifact ? `${artifactShortId(artifact)} · ${artifactDisplayName(artifact)}` : 'SEQ-1054 · CLK boundary'} <ChevronDown size={14} /></button>
        </div>
        <div className="review-tabs" role="tablist">
          <button className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}><MessageSquareText size={15} /> Change story</button>
          <button className={tab === 'sequence' ? 'active' : ''} onClick={() => setTab('sequence')}><Code2 size={15} /> Sequence</button>
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}><FileText size={15} /> Evidence</button>
        </div>
      </div>

      <div className="review-grid">
        <section className="story-column guide-semantic-story">
          <div className="story-lead">
            <div className="story-index">{live ? 'LIVE' : '04'}</div>
            <div>
              <span className="section-kicker">CHANGE STORY · {live ? analysis?.source.toUpperCase() : 'AI DRAFT'}</span>
              <h2>{live ? primaryInference?.title ?? 'Sequence의 조건과 맥락을 정리했습니다.' : <>고온 Fail이 시작되는<br />CLK 경계를 좁혔습니다.</>}</h2>
              <p>{analysis?.summary ?? '이 Revision은 새로운 기능을 추가한 것이 아니라, SEQ-1051에서 발견된 10660 Fail을 더 작은 조건으로 재현하기 위한 실험입니다.'}</p>
            </div>
          </div>

          <div className="story-facts">
            <article>
              <span>WHY</span>
              <strong>{workspaceItem?.userComment || primaryQuestion?.question || '10660에서 최초 Fail'}</strong>
              <p>{primaryQuestion?.why ?? (live ? '파일에서 확인되지 않은 평가 목적은 확정하지 않고 엔지니어 검토 대상으로 남깁니다.' : '저주파에서는 통과했기 때문에 장비 전체 이상보다 고주파 조건 의존성을 먼저 확인합니다.')}</p>
            </article>
            <article>
              <span>WHAT CHANGED</span>
              <strong>{live ? changedSummary : 'Sweep → 경계 3점'}</strong>
              <p>{live ? `${analysis?.changes.length ?? 0}개 의미 변경을 부모 Sequence와 비교했습니다.` : '9600, 10000, 10660으로 좁히고 1190·6060 Pattern만 관찰합니다.'}</p>
            </article>
            <article>
              <span>AGENT VIEW</span>
              <strong>{primaryInference ? `${Math.round(primaryInference.confidence * 100)}% confidence` : live ? '추론 없음' : '경계와 Pattern 분리'}</strong>
              <p>{primaryInference?.detail ?? (live ? '근거가 충분하지 않아 추가 해석을 만들지 않았습니다.' : 'Fail이 10660과 6060에만 집중되면 DUT 조건 의존성 근거가 강화됩니다.')}</p>
            </article>
          </div>

          <div className="truth-band">
            <div><ShieldCheck size={17} /><span><strong>{analysis?.facts.length ?? 7}개 사실</strong>파일에서 직접 추출</span></div>
            <div><Sparkles size={17} /><span><strong>{analysis?.inferences.length ?? 2}개 해석</strong>Agent가 추론</span></div>
            <div><CircleAlert size={17} /><span><strong>{analysis?.questions.length ?? 1}개 질문</strong>승인 필요</span></div>
          </div>

          <div className="purpose-confirm">
            <span>{live ? 'KNOWLEDGE COMMIT' : '목적 확인'}</span>
            <p>{live ? primaryQuestion ? '확정하지 못한 질문이 남아 있습니다. Sequence Inbox에서 답변하기 전에는 Verified 지식으로 저장하지 않습니다.' : '추출 사실과 Agent 해석을 확인했습니다. 이 상태를 Verified Wiki 항목으로 저장할까요?' : '“CLK 경계와 Pattern 의존성을 동시에 확인”하는 평가가 맞습니까?'}</p>
            <div>
              <button className={accepted ? 'accepted' : ''} disabled={saving || Boolean(live && primaryQuestion)} onClick={() => void approveAndSave()}>
                {saving ? <LoaderCircle className="spin" size={15} /> : primaryQuestion && live ? <CircleAlert size={15} /> : <Check size={15} />} {saving ? '저장 중' : accepted ? 'Wiki 저장됨' : live ? primaryQuestion ? 'Inbox 질문 답변 필요' : '검토 승인 · Wiki 저장' : '맞습니다'}
              </button>
              <button onClick={() => onNotify('수정할 설명을 Agent 대화창에서 남겨주세요.', 'info')}>설명 수정</button>
            </div>
          </div>
        </section>

        <section className="evidence-column guide-semantic-diff">
          <div className="evidence-head">
            <div>
              <span className="section-kicker">SEMANTIC DIFF</span>
              <h3>명령이 아니라 의미의 차이</h3>
            </div>
            <span className="noise-reduction"><Eye size={14} /> {artifact?.fingerprint?.lineCount ?? 163}줄 중 {diffLines.length}개 핵심 항목</span>
          </div>

          {tab === 'story' || tab === 'sequence' ? (
            <div className="diff-editor">
              <div className="editor-head">
                <span>{artifact ? artifactDisplayName(artifact) : 'sequence.seq'}</span>
                <div><i className="legend-minus" /> Before <i className="legend-plus" /> After</div>
              </div>
              {diffLines.map((line, index) => (
                <div className={`semantic-diff-line ${line.kind}`} key={`${line.after}-${line.before}-${index}`}>
                  <div className="line-numbers"><span>{index + 1}</span><span>{index + 1}</span></div>
                  <div className="diff-code">
                    {line.kind === 'context' ? <code><b> </b>{line.after}</code> : null}
                    {line.before ? <code className="removed"><b>−</b>{line.before}</code> : null}
                    {line.after && line.kind !== 'context' ? <code className="added"><b>+</b>{line.after}</code> : null}
                  </div>
                  <div className="semantic-note">
                    <span>{line.kind === 'context' ? 'EXTRACTED' : 'MEANING'}</span>
                    <p>{line.note}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <LogEvidence workspaceItem={workspaceItem} />
          )}

          <div className="evidence-trail">
            <span className="section-kicker">EVIDENCE TRAIL</span>
            <div className="trail-items">
              <span><FileText size={14} /> {artifact ? `SHA ${artifact.sha256.slice(0, 8)}` : 'Original SHA-256'}</span>
              <ArrowRight size={13} />
              <span><Code2 size={14} /> {analysis?.parserVersion ?? 'Parser v0.1'}</span>
              <ArrowRight size={13} />
              <span><Sparkles size={14} /> {analysis?.source ?? 'Agent review'}</span>
              <ArrowRight size={13} />
              <span><BookOpenCheck size={14} /> {accepted ? 'Human approved' : 'Approval pending'}</span>
            </div>
          </div>
        </section>

        <aside className="finding-column guide-ai-finding">
          <div className="finding-title">
            <span className="finding-severity">{live ? 'AGENT INTERPRETATION' : 'CRITICAL FINDING'}</span>
            <h3>{primaryInference?.title ?? (live ? '확인된 조건을 중심으로 검토하세요.' : <>ECC mismatch가<br />6060에서만 반복됩니다.</>)}</h3>
            <p>{primaryInference?.detail ?? analysis?.summary ?? '현재 증거만 보면 통신 실패보다 DUT 조건 의존 Fail 가능성이 높습니다.'}</p>
          </div>

          <div className="confidence-bar">
            <div><span>Agent confidence</span><strong>{live ? confidence : 87}%</strong></div>
            <i><b style={{ width: `${live ? confidence : 87}%` }} /></i>
            <small>확정 판정이 아닌 검토 제안입니다.</small>
          </div>

          <div className="finding-reasons">
            <span>근거로 연결된 사실</span>
            {(analysis?.facts.slice(0, 4) ?? []).map((fact) => <p key={fact.key}><Check size={14} /> {fact.label}: {fact.value}</p>)}
            {!analysis ? <>
              <p><Check size={14} /> 동일 signature 2회 반복</p>
              <p><Check size={14} /> Serial prompt 정상 복귀</p>
              <p><Check size={14} /> 온도·VDD readback 정상</p>
              <p><Check size={14} /> Android reboot 없음</p>
            </> : null}
          </div>

          {!live ? <button className="case-link">
            <div><BookOpenCheck size={16} /><span><small>SIMILAR CASE</small><strong>CASE-042</strong></span></div>
            <p>105℃ · Pattern 6060 단독 Fail</p>
            <Link2 size={15} />
          </button> : null}

          <div className="next-evaluation">
            <span><Lightbulb size={15} /> NEXT BEST ACTION</span>
            <strong>{primaryQuestion?.question ?? (live ? '목적과 부모 관계를 확인한 뒤 다음 Revision을 만드세요.' : '동일 조건 3회 반복 후 CLK 10000을 비교하세요.')}</strong>
            <p>{primaryQuestion?.why ?? (analysis?.warnings[0] || '추정 소요시간 38분 · 기존 Recipe 재사용 가능')}</p>
            <button onClick={() => onNotify('현재 Review를 근거로 다음 Revision 초안을 준비합니다.', 'info')}>다음 Revision 초안 만들기 <ArrowRight size={15} /></button>
          </div>

          <div className="analysis-meta">
            <span><Clock3 size={13} /> {analysis ? `${analysis.source}${analysis.cached ? ' · cache' : ''}` : '분석 1.8s · cache'}</span>
            <span><Link2 size={13} /> 확인 항목 {analysis?.facts.length ?? 6}개</span>
          </div>
        </aside>
      </div>
    </div>
  )
}

function LogEvidence({ workspaceItem }: { workspaceItem?: WorkspaceArtifact }) {
  const facts = workspaceItem?.analysis?.facts
  if (facts) {
    return (
      <div className="log-evidence">
        <div className="editor-head">
          <span>extracted evidence · {facts.length} facts</span>
          <div>원문 위치와 함께 보존됨</div>
        </div>
        {facts.map((fact) => (
          <div className="log-line good" key={fact.key}>
            <span>{fact.line ? `L${fact.line}` : 'META'}</span>
            <b>+</b>
            <code>{fact.evidence ?? `${fact.label}=${fact.value}`}</code>
          </div>
        ))}
        {!facts.length ? <div className="review-empty-state">파일에서 표시할 핵심 조건을 추출하지 못했습니다.</div> : null}
      </div>
    )
  }
  return (
    <div className="log-evidence">
      <div className="editor-head">
        <span>block_018.log · 6 significant events</span>
        <div>1,284,392 lines → 23 candidates → 6 evidence</div>
      </div>
      {logEvidence.map((line) => (
        <div className={`log-line ${line.tone}`} key={`${line.time}-${line.text}`}>
          <span>{line.time}</span>
          <b>{line.tone === 'bad' ? '+' : line.tone === 'removed' ? '−' : ' '}</b>
          <code>{line.text}</code>
        </div>
      ))}
    </div>
  )
}
