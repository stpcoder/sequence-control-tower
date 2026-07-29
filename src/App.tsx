import { useEffect, useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'
import { AgentPanel } from './components/AgentPanel'
import { GuideOverlay } from './components/GuideOverlay'
import { Navigation } from './components/Navigation'
import { TopBar } from './components/TopBar'
import type { AppPage } from './data/demo'
import { ConsoleView } from './views/ConsoleView'
import { InboxView } from './views/InboxView'
import { KnowledgeView } from './views/KnowledgeView'
import { ReviewView } from './views/ReviewView'
import { SettingsView } from './views/SettingsView'
import { TowerView } from './views/TowerView'

const pages: Record<AppPage, { eyebrow: string; title: string }> = {
  tower: { eyebrow: 'PROJECT / QUALCOMM PRODUCT A', title: 'Project Tower' },
  inbox: { eyebrow: 'KNOWLEDGE INTAKE', title: 'Sequence Inbox' },
  review: { eyebrow: 'SEQ-1051 ↔ SEQ-1054', title: 'Semantic Review' },
  console: { eyebrow: 'EQUIPMENT-PC-03 / 4-SLOT', title: 'Equipment Console' },
  knowledge: { eyebrow: 'VERIFIED MEMORY', title: 'Knowledge Cases' },
  settings: { eyebrow: 'LOCAL WORKSPACE', title: 'Settings' },
}

function readInitialPage(): AppPage {
  const value = new URLSearchParams(window.location.search).get('screen')
  return value && value in pages ? value as AppPage : 'tower'
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>(readInitialPage)
  const [agentOpen, setAgentOpen] = useState(() => new URLSearchParams(window.location.search).get('agent') === '1')
  const [toast, setToast] = useState<string | null>(null)
  const guideMode = useMemo(() => new URLSearchParams(window.location.search).get('guide') === '1', [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setAgentOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const navigate = (page: AppPage) => {
    setActivePage(page)
    const query = new URLSearchParams(window.location.search)
    query.set('screen', page)
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`)
  }

  const importSequence = () => {
    navigate('inbox')
    setToast('가져오기 대기함을 열었습니다. 원본은 선택 후 SHA-256으로 보존됩니다.')
  }

  const content = (() => {
    switch (activePage) {
      case 'tower': return <TowerView onReview={() => navigate('review')} onInbox={() => navigate('inbox')} />
      case 'inbox': return <InboxView onReview={() => navigate('review')} />
      case 'review': return <ReviewView />
      case 'console': return <ConsoleView />
      case 'knowledge': return <KnowledgeView />
      case 'settings': return <SettingsView />
    }
  })()

  return (
    <div className={`app-shell ${agentOpen ? 'agent-is-open' : ''}`}>
      <Navigation active={activePage} onChange={navigate} onAgentOpen={() => setAgentOpen(true)} />
      <main className="main-shell">
        <TopBar title={pages[activePage].title} eyebrow={pages[activePage].eyebrow} onUpload={importSequence} />
        <div className="content-shell">{content}</div>
      </main>
      <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} onOpen={() => setAgentOpen(true)} />
      {toast ? <div className="toast"><Check size={16} />{toast}<button onClick={() => setToast(null)}><X size={14} /></button></div> : null}
      {guideMode ? <GuideOverlay page={activePage} /> : null}
    </div>
  )
}
