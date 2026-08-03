import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Info, X } from 'lucide-react'
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
import { WorkbenchView } from './views/WorkbenchView'
import type {
  AnalysisJobSnapshot,
  AnalysisResult,
  ArtifactRecord,
  WikiEntryInput,
  WikiEntryRecord,
  WikiExportResult,
} from '../electron/shared/contracts'
import {
  mergeArtifacts,
  type SavedKnowledgeDetail,
  type WorkspaceArtifact,
  upsertWikiEntries,
} from './state/workspace'

const pages: Record<AppPage, { eyebrow: string; title: string }> = {
  workbench: { eyebrow: 'LOCAL LOG ANALYSIS', title: 'Log Workbench' },
  tower: { eyebrow: 'PROJECT / QUALCOMM PRODUCT A', title: 'Project Tower' },
  inbox: { eyebrow: 'KNOWLEDGE INTAKE', title: 'Sequence Inbox' },
  review: { eyebrow: 'SEQ-1051 ↔ SEQ-1054', title: 'Semantic Review' },
  console: { eyebrow: 'EQUIPMENT-PC-03 / 4-SLOT', title: 'Equipment Console' },
  knowledge: { eyebrow: 'VERIFIED MEMORY', title: 'Knowledge Cases' },
  settings: { eyebrow: 'LOCAL WORKSPACE', title: 'Settings' },
}

function readInitialPage(): AppPage {
  const value = new URLSearchParams(window.location.search).get('screen')
  return value && value in pages ? value as AppPage : 'workbench'
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>(readInitialPage)
  const [agentOpen, setAgentOpen] = useState(() => new URLSearchParams(window.location.search).get('agent') === '1')
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [jobsByArtifact, setJobsByArtifact] = useState<Record<string, AnalysisJobSnapshot>>({})
  const [analysesByArtifact, setAnalysesByArtifact] = useState<Record<string, AnalysisResult>>({})
  const [commentsByArtifact, setCommentsByArtifact] = useState<Record<string, string>>({})
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [wikiEntries, setWikiEntries] = useState<WikiEntryRecord[]>([])
  const [savedKnowledge, setSavedKnowledge] = useState<Record<string, SavedKnowledgeDetail>>({})
  const jobArtifactIds = useRef<Record<string, string>>({})
  const pollTimers = useRef<Record<string, number>>({})
  const guideMode = useMemo(() => new URLSearchParams(window.location.search).get('guide') === '1', [])

  const notify = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'success') => {
    setToast({ message, tone })
  }, [])

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
    const api = window.sequenceIntelligence
    if (!api?.app.onCommand) return undefined
    return api.app.onCommand((command) => {
      if (command === 'preferences') {
        setActivePage('settings')
        return
      }
      setActivePage('workbench')
      // Allow a newly selected Workbench to mount before forwarding the
      // native menu action into its renderer-owned passive-effect listener.
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('sequence-control-tower:command', { detail: command }))
        }, 0)
      })
    })
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const acceptJobSnapshot = useCallback((job: AnalysisJobSnapshot, fallbackArtifactId?: string) => {
    const artifactId = job.result?.artifactId ?? fallbackArtifactId ?? jobArtifactIds.current[job.id]
    if (!artifactId) return
    jobArtifactIds.current[job.id] = artifactId
    setJobsByArtifact((current) => ({ ...current, [artifactId]: job }))
    if (job.result) {
      setAnalysesByArtifact((current) => ({ ...current, [artifactId]: job.result! }))
    }
  }, [])

  const pollJob = useCallback((jobId: string, artifactId: string) => {
    const api = window.sequenceIntelligence
    if (!api) return
    const poll = async () => {
      try {
        const latest = await api.analysis.get(jobId)
        if (!latest) return
        acceptJobSnapshot(latest, artifactId)
        if (!['completed', 'failed', 'cancelled'].includes(latest.status)) {
          pollTimers.current[jobId] = window.setTimeout(() => void poll(), 900)
        }
      } catch {
        pollTimers.current[jobId] = window.setTimeout(() => void poll(), 1800)
      }
    }
    pollTimers.current[jobId] = window.setTimeout(() => void poll(), 350)
  }, [acceptJobSnapshot])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api) return undefined
    let active = true
    void Promise.all([api.artifacts.list(), api.wiki.list()])
      .then(([storedArtifacts, storedWiki]) => {
        if (!active) return
        setArtifacts(storedArtifacts)
        setWikiEntries(storedWiki)
        if (storedArtifacts[0]) setSelectedArtifactId((current) => current ?? storedArtifacts[0].id)
      })
      .catch((error) => {
        if (active) notify(error instanceof Error ? error.message : '로컬 작업공간을 불러오지 못했습니다.', 'error')
      })
    const unsubscribe = api.analysis.onJobUpdate((job) => acceptJobSnapshot(job))
    return () => {
      active = false
      unsubscribe()
      Object.values(pollTimers.current).forEach((timer) => window.clearTimeout(timer))
      pollTimers.current = {}
    }
  }, [acceptJobSnapshot, notify])

  const workspaceArtifacts = useMemo<WorkspaceArtifact[]>(() => artifacts.map((artifact) => ({
    artifact,
    job: jobsByArtifact[artifact.id],
    analysis: analysesByArtifact[artifact.id],
    userComment: commentsByArtifact[artifact.id],
  })), [analysesByArtifact, artifacts, commentsByArtifact, jobsByArtifact])

  const addArtifacts = useCallback((incoming: ArtifactRecord[]) => {
    setArtifacts((current) => mergeArtifacts(current, incoming))
    if (incoming[0]) setSelectedArtifactId(incoming[0].id)
  }, [])

  const queueAnalyses = useCallback(async (incoming: ArtifactRecord[], userComment: string) => {
    const api = window.sequenceIntelligence
    if (!api) throw new Error('데스크톱 앱에서만 실제 분석을 실행할 수 있습니다.')
    const comment = userComment.trim()
    if (comment) {
      setCommentsByArtifact((current) => ({
        ...current,
        ...Object.fromEntries(incoming.map((artifact) => [artifact.id, comment])),
      }))
    }
    const queued: AnalysisJobSnapshot[] = []
    for (const artifact of incoming) {
      const job = await api.analysis.start({
        artifactId: artifact.id,
        userComment: comment || undefined,
        projectContext: 'Qualcomm · Product A',
      })
      jobArtifactIds.current[job.id] = artifact.id
      acceptJobSnapshot(job, artifact.id)
      pollJob(job.id, artifact.id)
      queued.push(job)
    }
    return queued
  }, [acceptJobSnapshot, pollJob])

  const saveKnowledgeEntry = useCallback(async (input: WikiEntryInput): Promise<WikiEntryRecord | null> => {
    const api = window.sequenceIntelligence
    if (!api) {
      notify('웹 미리보기에서는 Wiki 저장을 시뮬레이션만 합니다.', 'info')
      return null
    }
    try {
      const record = await api.wiki.save(input)
      setWikiEntries((current) => upsertWikiEntries(current, record))
      setSavedKnowledge((current) => ({ ...current, [record.id]: { record, input } }))
      notify(`${record.title}을 Knowledge Wiki에 저장했습니다.`)
      return record
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Knowledge Wiki에 저장하지 못했습니다.', 'error')
      return null
    }
  }, [notify])

  const exportKnowledgeEntry = useCallback(async (entryId: string): Promise<WikiExportResult | null> => {
    const api = window.sequenceIntelligence
    if (!api) {
      notify('Markdown 내보내기는 데스크톱 앱에서 사용할 수 있습니다.', 'info')
      return null
    }
    try {
      const result = await api.wiki.export(entryId)
      if (result.cancelled) notify('Markdown 내보내기를 취소했습니다.', 'info')
      else notify(`${result.fileName ?? 'Wiki 문서'}를 내보냈습니다.`)
      return result
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Markdown을 내보내지 못했습니다.', 'error')
      return null
    }
  }, [notify])

  const navigate = (page: AppPage) => {
    setActivePage(page)
    const query = new URLSearchParams(window.location.search)
    query.set('screen', page)
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`)
  }

  const importSequence = () => {
    navigate('inbox')
    notify('가져오기 대기함을 열었습니다. 원본은 선택 후 SHA-256으로 보존됩니다.', 'info')
  }

  const openReview = (artifactId?: string) => {
    if (artifactId) setSelectedArtifactId(artifactId)
    navigate('review')
  }

  const selectedWorkspace = workspaceArtifacts.find((item) => item.artifact.id === selectedArtifactId)

  const content = (() => {
    switch (activePage) {
      case 'workbench': return <WorkbenchView onNotify={notify} />
      case 'tower': return <TowerView onReview={() => openReview()} onInbox={() => navigate('inbox')} />
      case 'inbox': return <InboxView
        workspaceItems={workspaceArtifacts}
        selectedArtifactId={selectedArtifactId}
        onSelectArtifact={setSelectedArtifactId}
        onArtifactsImported={addArtifacts}
        onQueueAnalyses={queueAnalyses}
        onReview={openReview}
        onSaveKnowledge={saveKnowledgeEntry}
        onNotify={notify}
      />
      case 'review': return <ReviewView
        workspaceItem={selectedWorkspace}
        onSaveKnowledge={saveKnowledgeEntry}
        onNotify={notify}
      />
      case 'console': return <ConsoleView />
      case 'knowledge': return <KnowledgeView
        entries={wikiEntries}
        savedKnowledge={savedKnowledge}
        onExport={exportKnowledgeEntry}
        onNotify={notify}
      />
      case 'settings': return <SettingsView />
    }
  })()

  return (
    <div className={`app-shell ${agentOpen ? 'agent-is-open' : ''} ${activePage === 'workbench' ? 'workbench-is-open' : ''}`}>
      <Navigation active={activePage} onChange={navigate} onAgentOpen={() => setAgentOpen(true)} />
      <main className="main-shell">
        {activePage === 'workbench' ? null : <TopBar title={pages[activePage].title} eyebrow={pages[activePage].eyebrow} onUpload={importSequence} />}
        <div className="content-shell">{content}</div>
      </main>
      <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} onOpen={() => setAgentOpen(true)} />
      {toast ? <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
        {toast.tone === 'error' ? <AlertCircle size={16} /> : toast.tone === 'info' ? <Info size={16} /> : <Check size={16} />}
        {toast.message}
        <button onClick={() => setToast(null)}><X size={14} /></button>
      </div> : null}
      {guideMode ? <GuideOverlay page={activePage} /> : null}
    </div>
  )
}
