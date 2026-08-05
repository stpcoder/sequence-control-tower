import {
  FileSearch2,
  GitBranch,
  ScanSearch,
  Settings,
  Table2,
} from 'lucide-react'
import type { AppPage } from '../state/appNavigation'

const primary = [
  { id: 'workbench' as const, label: '로그', icon: FileSearch2 },
  { id: 'results' as const, label: '결과', icon: Table2 },
  { id: 'patterns' as const, label: '결과 정리', icon: ScanSearch },
]

export function Navigation({ active, onChange }: { active: AppPage; onChange: (page: AppPage) => void; onAgentOpen?: () => void }) {
  return (
    <aside className="navigation">
      <div className="brand" aria-label="Sequence Control Tower">
        <div className="brand-mark">
          <GitBranch size={18} strokeWidth={2.4} />
        </div>
      </div>

      <nav className="nav-list" aria-label="주요 메뉴">
        {primary.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? 'nav-item active' : 'nav-item'}
            onClick={() => onChange(id)}
            aria-current={active === id ? 'page' : undefined}
            aria-label={label}
            title={label}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="nav-spacer" />
      <button className={active === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => onChange('settings')} aria-label="설정" title="설정">
        <Settings size={20} />
        <span>설정</span>
      </button>
    </aside>
  )
}
