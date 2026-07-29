import { useState } from 'react'
import { ArrowRight, BookOpenCheck, Check, ChevronDown, CircleAlert, Clock3, Code2, Eye, FileText, GitCompareArrows, Lightbulb, Link2, MessageSquareText, ShieldCheck, Sparkles } from 'lucide-react'
import { logEvidence, semanticDiff } from '../data/demo'

type ReviewTab = 'story' | 'sequence' | 'log'

export function ReviewView() {
  const [tab, setTab] = useState<ReviewTab>('story')
  const [accepted, setAccepted] = useState(false)

  return (
    <div className="view review-view">
      <div className="review-toolbar">
        <div className="compare-selector">
          <span>BASE</span>
          <button>SEQ-1051 · Low voltage <ChevronDown size={14} /></button>
          <GitCompareArrows size={17} />
          <span>COMPARE</span>
          <button>SEQ-1054 · CLK boundary <ChevronDown size={14} /></button>
        </div>
        <div className="review-tabs" role="tablist">
          <button className={tab === 'story' ? 'active' : ''} onClick={() => setTab('story')}><MessageSquareText size={15} /> Change story</button>
          <button className={tab === 'sequence' ? 'active' : ''} onClick={() => setTab('sequence')}><Code2 size={15} /> Sequence</button>
          <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}><FileText size={15} /> Log evidence</button>
        </div>
      </div>

      <div className="review-grid">
        <section className="story-column guide-semantic-story">
          <div className="story-lead">
            <div className="story-index">04</div>
            <div>
              <span className="section-kicker">CHANGE STORY · AI DRAFT</span>
              <h2>고온 Fail이 시작되는<br />CLK 경계를 좁혔습니다.</h2>
              <p>이 Revision은 새로운 기능을 추가한 것이 아니라, SEQ-1051에서 발견된 10660 Fail을 더 작은 조건으로 재현하기 위한 실험입니다.</p>
            </div>
          </div>

          <div className="story-facts">
            <article>
              <span>WHY</span>
              <strong>10660에서 최초 Fail</strong>
              <p>저주파에서는 통과했기 때문에 장비 전체 이상보다 고주파 조건 의존성을 먼저 확인합니다.</p>
            </article>
            <article>
              <span>WHAT CHANGED</span>
              <strong>Sweep → 경계 3점</strong>
              <p>9600, 10000, 10660으로 좁히고 1190·6060 Pattern만 관찰합니다.</p>
            </article>
            <article>
              <span>EXPECTED SIGNAL</span>
              <strong>경계와 Pattern 분리</strong>
              <p>Fail이 10660과 6060에만 집중되면 DUT 조건 의존성 근거가 강화됩니다.</p>
            </article>
          </div>

          <div className="truth-band">
            <div><ShieldCheck size={17} /><span><strong>7개 사실</strong>파일에서 직접 추출</span></div>
            <div><Sparkles size={17} /><span><strong>2개 해석</strong>Agent가 추론</span></div>
            <div><CircleAlert size={17} /><span><strong>1개 질문</strong>승인 필요</span></div>
          </div>

          <div className="purpose-confirm">
            <span>목적 확인</span>
            <p>“CLK 경계와 Pattern 의존성을 동시에 확인”하는 평가가 맞습니까?</p>
            <div>
              <button className={accepted ? 'accepted' : ''} onClick={() => setAccepted(true)}>
                <Check size={15} /> {accepted ? '승인됨' : '맞습니다'}
              </button>
              <button>설명 수정</button>
            </div>
          </div>
        </section>

        <section className="evidence-column guide-semantic-diff">
          <div className="evidence-head">
            <div>
              <span className="section-kicker">SEMANTIC DIFF</span>
              <h3>명령이 아니라 의미의 차이</h3>
            </div>
            <span className="noise-reduction"><Eye size={14} /> 163줄 중 3개 변화</span>
          </div>

          {tab === 'story' || tab === 'sequence' ? (
            <div className="diff-editor">
              <div className="editor-head">
                <span>sequence.seq</span>
                <div><i className="legend-minus" /> Removed <i className="legend-plus" /> Added</div>
              </div>
              {semanticDiff.map((line, index) => (
                <div className={`semantic-diff-line ${line.kind}`} key={`${line.after}-${index}`}>
                  <div className="line-numbers"><span>{42 + index * 3}</span><span>{42 + index * 3}</span></div>
                  <div className="diff-code">
                    {line.kind === 'context' ? <code><b> </b>{line.after}</code> : null}
                    {line.before ? <code className="removed"><b>−</b>{line.before}</code> : null}
                    {line.after && line.kind !== 'context' ? <code className="added"><b>+</b>{line.after}</code> : null}
                  </div>
                  <div className="semantic-note">
                    <span>{line.kind === 'context' ? 'CONTEXT' : 'MEANING'}</span>
                    <p>{line.note}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <LogEvidence />
          )}

          <div className="evidence-trail">
            <span className="section-kicker">EVIDENCE TRAIL</span>
            <div className="trail-items">
              <span><FileText size={14} /> Original SHA-256</span>
              <ArrowRight size={13} />
              <span><Code2 size={14} /> Parser v0.1</span>
              <ArrowRight size={13} />
              <span><Sparkles size={14} /> Agent review</span>
              <ArrowRight size={13} />
              <span><BookOpenCheck size={14} /> Human approval</span>
            </div>
          </div>
        </section>

        <aside className="finding-column guide-ai-finding">
          <div className="finding-title">
            <span className="finding-severity">CRITICAL FINDING</span>
            <h3>ECC mismatch가<br />6060에서만 반복됩니다.</h3>
            <p>현재 증거만 보면 통신 실패보다 DUT 조건 의존 Fail 가능성이 높습니다.</p>
          </div>

          <div className="confidence-bar">
            <div><span>Agent confidence</span><strong>87%</strong></div>
            <i><b style={{ width: '87%' }} /></i>
            <small>확정 판정이 아닌 검토 제안입니다.</small>
          </div>

          <div className="finding-reasons">
            <span>판단 근거</span>
            <p><Check size={14} /> 동일 signature 2회 반복</p>
            <p><Check size={14} /> Serial prompt 정상 복귀</p>
            <p><Check size={14} /> 온도·VDD readback 정상</p>
            <p><Check size={14} /> Android reboot 없음</p>
          </div>

          <button className="case-link">
            <div><BookOpenCheck size={16} /><span><small>SIMILAR CASE</small><strong>CASE-042</strong></span></div>
            <p>105℃ · Pattern 6060 단독 Fail</p>
            <Link2 size={15} />
          </button>

          <div className="next-evaluation">
            <span><Lightbulb size={15} /> NEXT BEST ACTION</span>
            <strong>동일 조건 3회 반복 후 CLK 10000을 비교하세요.</strong>
            <p>추정 소요시간 38분 · 기존 Recipe 재사용 가능</p>
            <button>다음 Revision 초안 만들기 <ArrowRight size={15} /></button>
          </div>

          <div className="analysis-meta">
            <span><Clock3 size={13} /> 분석 1.8s · cache</span>
            <span><Link2 size={13} /> 근거 6개</span>
          </div>
        </aside>
      </div>
    </div>
  )
}

function LogEvidence() {
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
