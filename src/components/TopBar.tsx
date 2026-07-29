import { Bell, ChevronDown, CircleHelp, Upload } from 'lucide-react'

interface TopBarProps {
  title: string
  eyebrow: string
  onUpload: () => void
}

export function TopBar({ title, eyebrow, onUpload }: TopBarProps) {
  return (
    <header className="topbar">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <div className="topbar-actions">
        <div className="system-pill" title="LLM이 느리거나 사용량 제한에 도달해도 로컬 분석은 계속됩니다.">
          <span className="system-light" />
          Local engine ready
          <ChevronDown size={14} />
        </div>
        <button className="icon-button" aria-label="도움말">
          <CircleHelp size={18} />
        </button>
        <button className="icon-button" aria-label="알림">
          <Bell size={18} />
          <i className="notification-dot" />
        </button>
        <button className="primary-button upload-trigger" onClick={onUpload}>
          <Upload size={17} />
          Sequence 가져오기
        </button>
      </div>
    </header>
  )
}
