import { ArrowRight, Check, ChevronRight, CircleAlert, GitCommitHorizontal, ScanSearch, ShieldCheck, Sparkles } from 'lucide-react'
import { revisions } from '../data/demo'
import { StatusDot } from '../components/StatusDot'

interface TowerViewProps {
  onReview: () => void
  onInbox: () => void
}

const metrics = [
  { label: 'Sequences', value: '1,842', delta: '+28 이번 주' },
  { label: 'Detected families', value: '37', delta: '4개 검토 필요' },
  { label: 'Purpose verified', value: '64%', delta: '+11% 이번 달' },
  { label: 'Results linked', value: '412', delta: '71% coverage' },
]

const gaps = [
  { count: 12, title: '부모 관계 충돌', description: '유사도가 비슷한 후보가 2개 이상입니다.', action: '10분 예상' },
  { count: 3, title: 'PASS 규칙 미확인', description: '새 command family에 정상 기준이 없습니다.', action: '전문가 확인' },
  { count: 84, title: '결과 연결 가능', description: '파일명과 시간이 일치하는 로그를 찾았습니다.', action: '자동 연결' },
]

export function TowerView({ onReview, onInbox }: TowerViewProps) {
  return (
    <div className="view tower-view">
      <section className="project-hero guide-project-overview">
        <div className="project-hero-copy">
          <span className="section-kicker">CUSTOMER PROGRAM · QCOM-A-27</span>
          <h2>Qualcomm Product A</h2>
          <p>LPDDR5 고온·저전압 동작 Margin 평가</p>
          <div className="hero-status-row">
            <span><i className="live-dot" /> 1개 평가 진행 중</span>
            <span>최근 업데이트 8분 전</span>
            <span className="verified-mark"><ShieldCheck size={14} /> Evidence protected</span>
          </div>
        </div>
        <div className="hero-brief">
          <span>AGENT BRIEF</span>
          <strong>현재 가장 중요한 것은 10660 CLK Fail의 재현성입니다.</strong>
          <p>Pattern 6060에서 2회 관찰됐고, 장비·통신 이상 근거는 발견되지 않았습니다.</p>
          <button onClick={onReview}>근거와 다음 평가 보기 <ArrowRight size={15} /></button>
        </div>
      </section>

      <section className="metric-strip">
        {metrics.map((metric) => (
          <div className="metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.delta}</small>
          </div>
        ))}
        <div className="knowledge-gauge">
          <div className="gauge-ring" style={{ '--progress': '64%' } as React.CSSProperties}>
            <span>64</span>
          </div>
          <div>
            <span>Knowledge coverage</span>
            <strong>운영 가능한 수준</strong>
            <small>Unknown 146개를 숨기지 않고 관리 중</small>
          </div>
        </div>
      </section>

      <div className="tower-grid">
        <section className="panel lineage-panel guide-project-lineage">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">EVALUATION LINEAGE</span>
              <h3>목적에서 결과까지 이어지는 흐름</h3>
            </div>
            <div className="legend">
              <span><i className="line solid" /> 승인</span>
              <span><i className="line dashed" /> AI 추정</span>
            </div>
          </div>

          <div className="lineage-canvas">
            <div className="lineage-main-line" />
            <div className="lineage-branch-line" />
            {revisions.map((revision, index) => (
              <button
                key={revision.id}
                className={`revision-node node-${index + 1} branch-${revision.branch} ${revision.verified ? 'verified' : 'inferred'}`}
                onClick={onReview}
              >
                <div className={`commit-dot ${revision.status}`}>
                  {revision.status === 'pass' ? <Check size={12} /> : <GitCommitHorizontal size={13} />}
                </div>
                <div className="revision-card">
                  <div className="revision-meta">
                    <span>{revision.id}</span>
                    <StatusDot status={revision.status} />
                  </div>
                  <strong>{revision.label}</strong>
                  <p>{revision.message}</p>
                  <small>{revision.time} · {revision.author}</small>
                </div>
              </button>
            ))}
          </div>
        </section>

        <aside className="panel action-panel guide-knowledge-gaps">
          <div className="panel-heading compact">
            <div>
              <span className="section-kicker">KNOWLEDGE GAPS</span>
              <h3>Agent가 지금 묻는 것</h3>
            </div>
            <span className="count-badge">99</span>
          </div>
          <p className="panel-intro">모든 파일을 질문하지 않고, 계보 전체를 개선하는 답부터 요청합니다.</p>
          <div className="gap-list">
            {gaps.map((gap, index) => (
              <button key={gap.title} onClick={onInbox}>
                <span className={`gap-number gap-${index}`}>{gap.count}</span>
                <div>
                  <strong>{gap.title}</strong>
                  <p>{gap.description}</p>
                  <small>{gap.action}</small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          <div className="agent-policy-note">
            <Sparkles size={15} />
            <p><strong>질문 절약 정책 적용 중</strong> 같은 Family에서 한 번 확인된 답은 근거 범위 안에서 재사용합니다.</p>
          </div>
        </aside>
      </div>

      <section className="bottom-signal-row">
        <article className="signal-card critical">
          <CircleAlert size={18} />
          <div>
            <span>OPEN FINDING · F-132</span>
            <strong>Pattern 6060에서 ECC mismatch 반복</strong>
            <p>2개 Run · 동일 Block · 동일 failure signature</p>
          </div>
          <button onClick={onReview}>Review</button>
        </article>
        <article className="signal-card neutral">
          <ScanSearch size={18} />
          <div>
            <span>NEW EVIDENCE</span>
            <strong>기존 결과 로그 84개 연결 가능</strong>
            <p>파일명·생성 시간·Sequence hash 기준</p>
          </div>
          <button onClick={onInbox}>Inspect</button>
        </article>
      </section>
    </div>
  )
}
