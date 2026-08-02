import {
  Boxes,
  Cable,
  FileDiff,
  FileSearch2,
  GitBranch,
  Inbox,
  LibraryBig,
  Settings,
  Sparkles,
} from 'lucide-react'
import type { AppPage } from '../data/demo'

const primary = [
  { id: 'workbench' as const, label: 'Log Workbench', description: '검색으로 판정 규칙 만들기', icon: FileSearch2 },
  { id: 'tower' as const, label: 'Project Tower', description: '평가 흐름과 지식 상태', icon: Boxes },
  { id: 'inbox' as const, label: 'Sequence Inbox', description: '업로드·분류·확인 질문', icon: Inbox },
  { id: 'review' as const, label: 'Semantic Review', description: '변경의 의미와 근거', icon: FileDiff },
  { id: 'console' as const, label: 'Equipment Console', description: '4-slot 실행 모니터링', icon: Cable },
  { id: 'knowledge' as const, label: 'Knowledge Cases', description: '승인된 과거 사례', icon: LibraryBig },
]

export function Navigation({ active, onChange, onAgentOpen }: { active: AppPage; onChange: (page: AppPage) => void; onAgentOpen: () => void }) {
  return (
    <aside className="navigation">
      <div className="brand" aria-label="Sequence Control Tower">
        <div className="brand-mark">
          <GitBranch size={18} strokeWidth={2.4} />
        </div>
        <div>
          <strong>Sequence</strong>
          <span>CONTROL TOWER</span>
        </div>
      </div>

      <div className="workspace-label">WORKSPACE</div>
      <button className="workspace-card" onClick={() => onChange('tower')}>
        <div className="workspace-monogram">QA</div>
        <div>
          <strong>Qualcomm · Product A</strong>
          <span>LPDDR5 evaluation</span>
        </div>
        <span className="workspace-caret">⌄</span>
      </button>

      <nav className="nav-list" aria-label="주요 메뉴">
        {primary.map(({ id, label, description, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? 'nav-item active' : 'nav-item'}
            onClick={() => onChange(id)}
            aria-current={active === id ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <Icon size={18} />
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="nav-spacer" />
      <button className="agent-health" onClick={onAgentOpen} aria-label="Evaluation Agent" title="Evaluation Agent">
        <div className="agent-health-icon">
          <Sparkles size={15} />
        </div>
        <div>
          <strong>Agent queue</strong>
          <span>2 queued · cache ready</span>
        </div>
        <i className="pulse" />
      </button>
      <button className={active === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onChange('settings')} aria-label="Settings" title="Settings">
        <Settings size={18} />
        <span>
          <strong>Settings</strong>
          <small>LLM · Storage · Parser</small>
        </span>
      </button>
      <div className="build-version">LOCAL-FIRST · POC 0.2</div>
    </aside>
  )
}
