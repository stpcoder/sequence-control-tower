import {
  Boxes,
  Cable,
  FileSearch2,
  GitBranch,
  Settings,
} from 'lucide-react'
import type { AppPage } from '../data/demo'

const primary = [
  { id: 'workbench' as const, label: '로그 분석', description: '검색 · 판정 · Recipe', icon: FileSearch2 },
  { id: 'tower' as const, label: '프로젝트', description: '평가 흐름과 결과', icon: Boxes },
  { id: 'console' as const, label: '실장기', description: '4-slot 실행 상태', icon: Cable },
]

export function Navigation({ active, onChange }: { active: AppPage; onChange: (page: AppPage) => void; onAgentOpen?: () => void }) {
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
      <button className={active === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onChange('settings')} aria-label="Settings" title="Settings">
        <Settings size={18} />
        <span>
          <strong>설정</strong>
          <small>LLM · 저장소 · 파서</small>
        </span>
      </button>
      <div className="build-version">SEQUENCE CONTROL TOWER</div>
    </aside>
  )
}
