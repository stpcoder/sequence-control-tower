import { BookMarked, Check, ChevronRight, Filter, GitBranch, Link2, Search, ShieldCheck, Sparkles, Tags } from 'lucide-react'
import { knowledgeCases } from '../data/demo'

export function KnowledgeView() {
  return (
    <div className="view knowledge-view">
      <section className="knowledge-hero guide-knowledge-library">
        <div>
          <span className="section-kicker">VERIFIED LAB MEMORY</span>
          <h2>한 번 해결한 문제를<br />다시 처음부터 풀지 않습니다.</h2>
          <p>Sequence, Run, Finding, 엔지니어의 판단을 근거와 함께 연결합니다.</p>
        </div>
        <div className="knowledge-stats">
          <div><strong>37</strong><span>Approved cases</span></div>
          <div><strong>12</strong><span>Review queue</span></div>
          <div><strong>412</strong><span>Linked runs</span></div>
        </div>
      </section>

      <div className="knowledge-toolbar">
        <div className="inbox-search"><Search size={16} /><input placeholder="증상, 조건, command, 사례 검색" /><kbd>Ctrl K</kbd></div>
        <button className="secondary-button"><Filter size={15} /> 적용 범위</button>
        <button className="secondary-button"><Tags size={15} /> 태그</button>
      </div>

      <div className="knowledge-layout">
        <section className="case-list">
          {knowledgeCases.map((item, index) => (
            <article className={index === 0 ? 'case-card active' : 'case-card'} key={item.id}>
              <div className="case-card-top"><span>{item.id}</span><span className={item.status === '승인됨' ? 'verified' : 'review'}>{item.status === '승인됨' ? <ShieldCheck size={13} /> : <Sparkles size={13} />}{item.status}</span></div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <div className="case-scope"><Tags size={13} /> {item.scope}</div>
              <footer><span><Link2 size={13} /> Evidence {item.evidence}</span><span>Confidence {item.confidence}%</span><ChevronRight size={15} /></footer>
            </article>
          ))}
        </section>

        <section className="case-detail guide-knowledge-case">
          <div className="case-detail-head">
            <div className="case-icon"><BookMarked size={20} /></div>
            <div><span>CASE-042 · VERIFIED</span><h2>105℃ · Pattern 6060 단독 Fail</h2><p>SM8750 / LPDDR5 / hdiag 2.4.x</p></div>
          </div>

          <div className="case-section">
            <span>관찰된 증상</span>
            <p>10660 CLK에서 Pattern 6060을 실행할 때 ECC mismatch가 반복되며, 같은 Run의 1190과 저주파 조건은 통과했습니다.</p>
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
      </div>
    </div>
  )
}
