import { FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, History, LoaderCircle, Plus, RotateCcw, Sparkles, Wrench, X } from 'lucide-react'
import type {
  AgentRun,
  EvaluationProjectSnapshot,
  EvaluationResultLabel,
  EvaluationAgentPublicOutcome,
  EvaluationSaveDecisionInput,
  EvaluationAgentMemoryPayloadView,
  EvaluationAgentSessionView,
  NativeAgentBackendStatusView,
  NativeAgentSessionSummary,
  NativeAgentSessionView,
  ProjectSnapshot,
} from '../../electron/shared/contracts'
import type { WorkbenchFile } from '../views/WorkbenchView'
import { resolveProjectSource } from '../state/sourceIdentity'
import { AgentMarkdown } from './AgentMarkdown'

interface AgentPanelProps {
  open: boolean
  onClose: () => void
  onOpen: () => void
  project: ProjectSnapshot | null
  selectedFile?: WorkbenchFile
  evaluationSnapshot: EvaluationProjectSnapshot | null
  onSnapshotSaved: (snapshot: EvaluationProjectSnapshot) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
  evaluationLaunchRequest?: EvaluationAgentLaunchRequest | null
}

export interface EvaluationAgentLaunchRequest {
  id: string
  evaluationScopeId: string
  title: string
  sourceIds: string[]
}

export function mergeEvaluationAgentMemory(project: ProjectSnapshot, payload: EvaluationAgentMemoryPayloadView): ProjectSnapshot {
  const confirmed = 'engineer-confirmed' as const
  const upsert = <T extends { id: string }>(existing: readonly T[], additions: readonly T[]): T[] => {
    const byId = new Map(existing.map((item) => [item.id, item]))
    additions.forEach((item) => byId.set(item.id, { ...byId.get(item.id), ...item }))
    return [...byId.values()]
  }
  const evidence = payload.evidence.map((item) => {
    const previous = (project.evidenceRecords ?? []).find((record) => record.id === item.id)
    return {
      ...item,
      sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...item.sourceIds])],
      note: item.summary ?? previous?.note,
      origin: confirmed,
    }
  })
  return {
    ...project,
    failureHypotheses: upsert(project.failureHypotheses ?? [], [{ ...payload.hypothesis, origin: confirmed }]),
    evaluationNodes: upsert(project.evaluationNodes ?? [], [payload.node]),
    evidenceRecords: upsert(project.evidenceRecords ?? [], evidence)
  }
}

export function evaluationProposalTitle(proposal: EvaluationAgentSessionView['proposal']): string {
  if (!proposal) return '평가 경향'
  const d = proposal.dimensions
  const lead = [d.testMode, d.pattern, d.dq !== undefined ? `DQ${d.dq}` : '', d.channel !== undefined ? `CH${d.channel}` : '', d.subChannel !== undefined ? `SCH${d.subChannel}` : '', d.bank !== undefined ? `BANK${d.bank}` : ''].filter(Boolean).slice(0, 2)
  return `${lead.join(' · ') || proposal.outcome} 경향`
}

export function evaluationAgentRecordPrefix(projectId: string, sessionId: string): string {
  return `ea-${projectId}-${sessionId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
}

export function agentEvaluationPurposeLabel(purpose: NonNullable<NonNullable<EvaluationAgentSessionView['proposal']>['purpose']>): string {
  return {
    screening: '불량 검출 강화', improvement: '개선 조건 확인', reproduction: '동일 불량 재현',
    characterization: '불량 경향 파악', verification: '개선 효과 검증',
  }[purpose]
}

export function proposalDecisionResult(outcome: EvaluationAgentPublicOutcome): EvaluationResultLabel | null {
  if (!outcome || outcome === 'UNKNOWN') return null
  return outcome
}

export function proposalSourceDecisions(proposal: NonNullable<EvaluationAgentSessionView['proposal']>): Array<{ sourceId: string; outcome: EvaluationAgentPublicOutcome; evidenceIds: string[] }> {
  if (proposal.sourceAssessments?.length) return proposal.sourceAssessments
  if (proposal.sourceIds.length === 1) return [{ sourceId: proposal.sourceIds[0], outcome: proposal.outcome, evidenceIds: proposal.evidenceIds }]
  return []
}

export function shouldShowNativeAgentSuggestions(session: NativeAgentSessionView): boolean {
  if (session.status !== 'idle' || session.question) return false
  // Profile, console and command confirmations are onboarding, not ordinary
  // chat. Keep the primary project actions reachable after those answers.
  return session.messages.filter((message) => message.role === 'user').length <= 3
}

export function evaluationDimensionSummary(dimensions: EvaluationAgentSessionView['dimensions']): string[] {
  const values: Array<[string, unknown]> = [
    ['SKEW', dimensions.skew], ['Sample', dimensions.sample], ['Die', dimensions.die],
    ['CH', dimensions.channel], ['Sub CH', dimensions.subChannel], ['Rank', dimensions.rank],
    ['BG', dimensions.bankGroup], ['Bank', dimensions.bank], ['Row', dimensions.row], ['Column', dimensions.column],
    ['DQ', dimensions.dq], ['BL', dimensions.bl], ['Pattern', dimensions.pattern],
    ['온도', dimensions.temperatureC === undefined ? undefined : `${dimensions.temperatureC}°C`],
    ['VDD', dimensions.vdd === undefined ? undefined : `${dimensions.vdd}V`],
    ['주파수', dimensions.frequencyMHz === undefined ? undefined : `${dimensions.frequencyMHz}MHz`],
  ]
  return values.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => `${label} ${value}`)
}

export function agentProjectScopeKey(project: ProjectSnapshot | null): string {
  if (!project) return 'no-project'
  const sources = project.artifacts
    .map((source) => `${source.sourceId}:${source.artifactId}`)
    .sort()
    .join('|')
  return `${project.id}\u0000${sources}`
}

/** One connected root folder is one evaluation. A selected log fixes the
 * Agent to that folder; a single-folder project is safe without a selection. */
export function agentEvaluationSources(project: ProjectSnapshot | null, selectedFile?: WorkbenchFile): ProjectSnapshot['artifacts'] {
  if (!project) return []
  const selected = selectedFile ? resolveProjectSource(project, selectedFile) : null
  if (selected) return project.artifacts.filter((source) => source.rootId === selected.rootId)
  const roots = [...new Set(project.artifacts.map((source) => source.rootId))]
  return roots.length === 1 ? project.artifacts.filter((source) => source.rootId === roots[0]) : []
}

/** Keep slow work only while both the project and its analysed log set match. */
export function shouldRetainAgentSession(previous: ProjectSnapshot | null, next: ProjectSnapshot | null): boolean {
  return agentProjectScopeKey(previous) === agentProjectScopeKey(next)
}

function isProjectRevisionConflict(error: unknown): boolean {
  return error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))
}

export function toolsForAssistantMessage(
  message: NativeAgentSessionView['messages'][number],
  messages: readonly NativeAgentSessionView['messages'][number][],
  tools: readonly NativeAgentSessionView['tools'][number][],
) {
  if (message.role !== 'assistant') return []
  const messageIndex = messages.findIndex((item) => item.id === message.id)
  const previousMessage = messages.slice(0, messageIndex).reverse().find((item) => item.role === 'user' || item.role === 'assistant')
  const from = previousMessage ? Date.parse(previousMessage.createdAt) : -Infinity
  const until = Date.parse(message.createdAt)
  const evidence = new Set(message.evidenceSourceIds ?? [])
  return tools.filter((tool) => {
    const started = Date.parse(tool.startedAt)
    if (Number.isFinite(started)) return started >= from && started <= until
    return Boolean(evidence.size && tool.evidenceSourceIds?.some((id) => evidence.has(id)))
  })
}

export function buildAgentDecisionInput(
  project: ProjectSnapshot | null,
  file: WorkbenchFile | undefined,
  snapshot: EvaluationProjectSnapshot | null,
  result: EvaluationResultLabel | undefined,
): EvaluationSaveDecisionInput | null {
  if (!project || !file?.artifactId || !snapshot || !isEvaluationResultLabel(result) || result === 'UNKNOWN') return null
  const source = resolveProjectSource(project, file)
  if (!source) return null
  return {
    projectId: project.id,
    expectedRevision: snapshot.revision,
    source: { sourceId: source.sourceId, artifactId: source.artifactId, sourceKey: file.sourceKey ?? file.id },
    result,
  }
}

export function shouldAcceptAgentRun(run: AgentRun, activeRunId: string | null, projectId: string | undefined): boolean {
  return Boolean(activeRunId && run.id === activeRunId && projectId && run.projectId === projectId)
}

const EVALUATION_RESULT_LABELS = new Set<EvaluationResultLabel>([
  'PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED',
])

function isEvaluationResultLabel(value: unknown): value is EvaluationResultLabel {
  return typeof value === 'string' && EVALUATION_RESULT_LABELS.has(value as EvaluationResultLabel)
}

export function isAgentRunPending(run: AgentRun): boolean {
  if (run.status === 'queued') return true
  if (run.status !== 'running' || run.stage === 'complete') return false
  return !run.question && !run.candidate && run.state !== 'HUMAN_CONFIRM'
}

function shouldClearSubmissionBusy(run: AgentRun): boolean {
  return Boolean(
    run.question ||
    run.candidate ||
    run.state === 'HUMAN_CONFIRM' ||
    run.stage === 'complete' ||
    run.status === 'failed' ||
    run.status === 'completed' ||
    run.status === 'cancelled',
  )
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ''
  if (raw.includes('REVISION_CONFLICT')) return '분석 결과가 바뀌었습니다. 최신 결과를 확인해 주세요.'
  if (raw.includes('찾을 수 없습니다')) return '프로젝트 또는 실행을 찾을 수 없습니다.'
  if (raw.includes('입력인지 출력인지 선택')) return '먼저 위 질문에 답해 주세요.'
  if (raw.includes('LLM_') || raw.includes('provider failed') || raw.includes('timeout') || raw.includes('429')) return '분석 서버 응답이 늦거나 제한되었습니다.'
  if (raw.includes('Error invoking remote method')) return 'Agent 요청을 처리하지 못했습니다. 다시 시도해 주세요.'
  return raw ? `작업을 완료하지 못했습니다: ${raw.replace(/[\r\n]+/g, ' ').slice(0, 120)}` : '작업을 완료하지 못했습니다.'
}

function candidateText(run: AgentRun): string {
  const candidate = run.candidate
  if (!candidate) return ''
  if (candidate.kind === 'result') return candidate.result ? `판정 후보 · ${candidate.result}` : '판정 후보를 검토해 주세요.'
  if (candidate.kind === 'metadata' && candidate.field && candidate.value) return `메타데이터 후보 · ${candidate.field}: ${candidate.value}`
  return '저장할 수 없는 후보입니다. 검토만 가능합니다.'
}

function stageText(run: AgentRun): string {
  if (run.queueMessage) return run.queueMessage
  if (run.status === 'queued') return '대기 중'
  if (run.status === 'running') return run.stage === 'complete' ? '확인 대기 중' : '분석 중'
  if (run.status === 'cancelled') return '취소됨'
  return ''
}

export function AgentPanel({ open, onClose, onOpen, project, selectedFile, evaluationSnapshot, onSnapshotSaved, onProjectUpdated, evaluationLaunchRequest }: AgentPanelProps) {
  const [run, setRun] = useState<AgentRun | null>(null)
  const [evaluationRun, setEvaluationRun] = useState<EvaluationAgentSessionView | null>(null)
  const [evaluationRunScopeId, setEvaluationRunScopeId] = useState<string | undefined>()
  const [evaluationStarting, setEvaluationStarting] = useState(false)
  const [nativeSessions, setNativeSessions] = useState<NativeAgentSessionSummary[]>([])
  const [nativeSession, setNativeSession] = useState<NativeAgentSessionView | null>(null)
  const [nativeBackend, setNativeBackend] = useState<NativeAgentBackendStatusView | null>(null)
  const [nativeHistoryOpen, setNativeHistoryOpen] = useState(false)
  const [input, setInput] = useState('')
  const [evaluationAnswer, setEvaluationAnswer] = useState('')
  const [mentionedSourceIds, setMentionedSourceIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const handledEvaluationLaunch = useRef<string | null>(null)
  const restoredEvaluationScope = useRef('')
  const activeRunId = useRef<string | null>(null)
  const projectRef = useRef<ProjectSnapshot | null>(project)
  projectRef.current = project
  const evaluationSources = agentEvaluationSources(project, selectedFile)
  const evaluationScopeId = evaluationSources[0]?.rootId
  const projectKey = project?.id ?? 'no-project'
  const projectScopeKey = `${agentProjectScopeKey(project)}\u0000evaluation:${evaluationScopeId ?? 'none'}`
  const projectKeyRef = useRef(projectKey)
  projectKeyRef.current = projectKey
  const projectScopeKeyRef = useRef(projectScopeKey)
  projectScopeKeyRef.current = projectScopeKey

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api?.agent) return undefined
    return api.agent.onRunUpdate((next) => {
      if (!shouldAcceptAgentRun(next, activeRunId.current, project?.id) || projectKeyRef.current !== projectKey) return
      setRun(next)
      if (shouldClearSubmissionBusy(next)) setBusy(false)
    })
  }, [project?.id, projectKey])

  useEffect(() => {
    activeRunId.current = null
    setRun(null)
    setEvaluationRun(null)
    setEvaluationRunScopeId(undefined)
    setNativeSessions([])
    setNativeSession(null)
    setNativeBackend(null)
    setNativeHistoryOpen(false)
    setInput('')
    setEvaluationAnswer('')
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setMentionedSourceIds([])
    restoredEvaluationScope.current = ''
  }, [projectKey])

  useEffect(() => {
    activeRunId.current = null
    setRun(null)
    setEvaluationRun(null)
    setEvaluationRunScopeId(undefined)
    setNativeSession(null)
    setNativeSessions([])
    setNativeHistoryOpen(false)
    setEvaluationAnswer('')
    setEvaluationStarting(false)
    setBusy(false)
    setError('')
    setSavedMessage('')
    setMentionedSourceIds((current) => current.filter((sourceId) => project?.artifacts.some((source) => source.sourceId === sourceId)))
    restoredEvaluationScope.current = ''
  }, [projectScopeKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.evaluationAgent
    if (!api || !open || !project || !evaluationScopeId || evaluationRun || evaluationStarting) return undefined
    const restoreKey = `${project.id}\u0000${evaluationScopeId}`
    if (restoredEvaluationScope.current === restoreKey) return undefined
    restoredEvaluationScope.current = restoreKey
    let active = true
    void api.restore({ projectId: project.id, evaluationScopeId }).then((session) => {
      if (!active || !session || projectScopeKeyRef.current !== projectScopeKey) return
      const savedNodeId = `${evaluationAgentRecordPrefix(project.id, session.id)}-n`
      if (session.status === 'completed' && project.evaluationNodes?.some((node) => node.id === savedNodeId)) return
      setEvaluationRunScopeId(evaluationScopeId)
      setEvaluationRun(session)
    }).catch(() => undefined)
    return () => { active = false }
  }, [evaluationRun, evaluationScopeId, evaluationStarting, open, project, projectScopeKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.evaluationAgent
    if (!api || !evaluationRun || evaluationRun.status !== 'running') return undefined
    let active = true
    let polling = false
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const next = await api.get(evaluationRun.id)
        if (active && next && projectScopeKeyRef.current === projectScopeKey) setEvaluationRun(next)
      } catch (reason) {
        if (active) setError(boundedError(reason))
      } finally { polling = false }
    }
    const timer = window.setInterval(() => { void poll() }, 750)
    void poll()
    return () => { active = false; window.clearInterval(timer) }
  }, [evaluationRun?.id, evaluationRun?.status, projectScopeKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || !open) return undefined
    let active = true
    void Promise.all([api.list({ projectId: project.id, ...(evaluationScopeId ? { evaluationScopeId } : {}) }), api.backendStatus()]).then(async ([sessions, backend]) => {
      if (!active || projectScopeKeyRef.current !== projectScopeKey) return
      setNativeSessions(sessions); setNativeBackend(backend)
      const first = evaluationScopeId || !project.artifacts.length ? sessions[0] : undefined
      if (first) {
        const detail = await api.get({ sessionId: first.id })
        if (active && detail && projectScopeKeyRef.current === projectScopeKey) setNativeSession(detail)
      }
    }).catch((reason) => { if (active) setError(boundedError(reason)) })
    const unsubscribe = api.onUpdate((next) => {
      if (!active || next.projectId !== projectKeyRef.current || (evaluationScopeId !== undefined && next.evaluationScopeId !== evaluationScopeId)) return
      setNativeSessions((current) => {
        const { messages: _messages, tools: _tools, ...summary } = next
        return [summary, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
      setNativeSession((current) => !current || current.id === next.id ? next : current)
      if (next.status === 'idle' || next.status === 'paused' || next.status === 'failed') setBusy(false)
    })
    return () => { active = false; unsubscribe() }
  }, [open, projectScopeKey])

  useEffect(() => {
    const toggle = () => {
      if (open) onClose()
      else { onOpen(); window.setTimeout(() => composerRef.current?.focus(), 0) }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j')) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      toggle()
    }
    const onCommand = (event: Event) => {
      if ((event as CustomEvent).detail === 'toggle-agent') toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('sequence-control-tower:command', onCommand)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('sequence-control-tower:command', onCommand)
    }
  }, [onClose, onOpen, open])

  const invoke = async (action: () => Promise<AgentRun>, clearInput = false) => {
    if (busy || !activeRunId.current) return
    setBusy(true)
    setError('')
    try {
      const next = await action()
      if (shouldAcceptAgentRun(next, activeRunId.current, project?.id) && projectKeyRef.current === projectKey) {
        setRun(next)
        if (shouldClearSubmissionBusy(next)) setBusy(false)
      }
    } catch (reason) {
      setBusy(false)
      setError(boundedError(reason))
    }
    if (clearInput) setInput('')
  }

  const start = async () => {
    const api = window.sequenceIntelligence
    if (!api?.agent || !project) return
    if (busy) return
    setBusy(true); setError(''); setRun(null)
    try {
      const source = selectedFile ? resolveProjectSource(project, selectedFile) : null
      if (!source) { setBusy(false); setError('선택한 파일의 프로젝트 source를 정확히 확인할 수 없습니다.'); return }
      const next = await api.agent.start({ projectId: project.id, artifactIds: [source.artifactId], sourceId: source.sourceId })
      if (projectKeyRef.current !== projectKey) return
      activeRunId.current = next.id
      setRun(next)
      if (shouldClearSubmissionBusy(next)) setBusy(false)
    } catch (reason) { setBusy(false); setError(boundedError(reason)) }
  }

  const createNativeSession = async () => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy) return null
    const startedScope = projectScopeKey
    setBusy(true); setError(''); setSavedMessage(''); setNativeHistoryOpen(false)
    try {
      const next = await api.create({
        projectId: project.id,
        ...(evaluationScopeId ? { evaluationScopeId } : {}),
        sourceIds: evaluationSources.slice(0, 100).map((source) => source.sourceId),
      })
      if (projectScopeKeyRef.current !== startedScope) return null
      setNativeSession(next)
      setNativeSessions((current) => [{ ...next }, ...current.filter((item) => item.id !== next.id)])
      return next
    } catch (reason) { setError(boundedError(reason)); return null }
    finally { setBusy(false) }
  }

  const openNativeSession = async (sessionId: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || busy) return
    setBusy(true); setError(''); setNativeHistoryOpen(false)
    const startedScope = projectScopeKey
    try {
      const next = await api.get({ sessionId })
      if (next && projectScopeKeyRef.current === startedScope) setNativeSession(next)
    }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const sendNativeText = async (content: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy || !content.trim()) return
    const startedScope = projectScopeKey
    let target = nativeSession
    if (!target) target = await createNativeSession()
    if (!target) return
    setBusy(true); setError(''); setInput(''); setNativeHistoryOpen(false)
    try {
      const sourceIds = mentionedSourceIds.length ? mentionedSourceIds : evaluationSources.slice(0, 100).map((source) => source.sourceId)
      const next = await api.send({ sessionId: target.id, content: content.trim(), sourceIds: sourceIds.length ? sourceIds : undefined })
      if (projectScopeKeyRef.current === startedScope) {
        setNativeSession(next)
        setMentionedSourceIds([])
      }
    }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const retryNative = async () => {
    if (!nativeSession || busy || !window.sequenceIntelligence?.nativeAgent) return
    setBusy(true); setError('')
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.nativeAgent.retry({ sessionId: nativeSession.id })
      if (projectScopeKeyRef.current === startedScope) setNativeSession(next)
    }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const cancelNative = async () => {
    if (!nativeSession || !window.sequenceIntelligence?.nativeAgent) return
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.nativeAgent.cancel({ sessionId: nativeSession.id })
      if (projectScopeKeyRef.current === startedScope) setNativeSession(next)
    }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const startProjectTrend = async (sourceIds?: readonly string[], requestedScopeId = evaluationScopeId) => {
    const api = window.sequenceIntelligence
    if (!api?.evaluationAgent || !project || busy) return
    setBusy(true); setEvaluationStarting(true); setError(''); setSavedMessage(''); setEvaluationRun(null)
    try {
      const scopedSourceIds = sourceIds?.length ? [...sourceIds] : evaluationSources.map((source) => source.sourceId)
      if (!scopedSourceIds.length) throw new Error('분석할 평가 폴더의 로그를 먼저 선택해 주세요.')
      setEvaluationRunScopeId(requestedScopeId)
      const next = await api.evaluationAgent.start({ projectId: project.id, sourceIds: scopedSourceIds.slice(0, 32), intent: 'failure-trend' })
      if (projectScopeKeyRef.current === projectScopeKey) setEvaluationRun(next)
    } catch (reason) { setError(boundedError(reason)) } finally { setBusy(false); setEvaluationStarting(false) }
  }

  useEffect(() => {
    if (!open || !evaluationLaunchRequest || !project || busy || handledEvaluationLaunch.current === evaluationLaunchRequest.id) return
    handledEvaluationLaunch.current = evaluationLaunchRequest.id
    void startProjectTrend(evaluationLaunchRequest.sourceIds, evaluationLaunchRequest.evaluationScopeId)
  }, [busy, evaluationLaunchRequest?.id, open, project?.id])

  const resumeProjectTrend = async (input: { answer?: string; confirm?: 'accept' | 'reject' }) => {
    if (!evaluationRun || busy || !window.sequenceIntelligence?.evaluationAgent) return
    setBusy(true); setError('')
    const startedScope = projectScopeKey
    try {
      const next = await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, ...input })
      if (projectScopeKeyRef.current === startedScope) setEvaluationRun(next)
      setEvaluationAnswer('')
    }
    catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const saveProjectProposal = async () => {
    if (!evaluationRun?.proposal || (evaluationRun.status !== 'waiting_confirmation' && evaluationRun.status !== 'completed') || busy || !project || !window.sequenceIntelligence?.evaluationAgent || !window.sequenceIntelligence?.projects) return
    setBusy(true); setError('')
    try {
      const completed = evaluationRun.status === 'completed' ? evaluationRun : await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, confirm: 'accept' })
      setEvaluationRun(completed)
      const prefix = evaluationAgentRecordPrefix(project.id, evaluationRun.id)
      const payload = await window.sequenceIntelligence.evaluationAgent.memorySavePayload({ sessionId: evaluationRun.id, projectId: project.id, hypothesisId: `${prefix}-h`, nodeId: `${prefix}-n`, evidenceIdPrefix: `${prefix}-e` })
      if (!payload) throw new Error('저장할 제안이 없습니다.')
      // A slow LLM may complete after another same-project write. Always save
      // against the current prop/revision, not the revision that started it.
      const current = projectRef.current
      if (!current || current.id !== project.id) throw new Error('프로젝트가 변경되었습니다. 최신 프로젝트에서 다시 시도해 주세요.')
      const sourceDecisions = proposalSourceDecisions(evaluationRun.proposal)
        .flatMap((assessment) => {
          const result = proposalDecisionResult(assessment.outcome)
          return result ? [{ ...assessment, result }] : []
        })
      let nextEvaluation = evaluationSnapshot
      if (sourceDecisions.length && nextEvaluation && window.sequenceIntelligence.evaluations) {
        for (const assessment of sourceDecisions) {
          const source = current.artifacts.find((item) => item.sourceId === assessment.sourceId)
          if (!source) continue
          const saveDecision = (expectedRevision: number) => window.sequenceIntelligence!.evaluations.saveDecision({
              projectId: current.id,
              expectedRevision,
              source: { sourceId: source.sourceId, artifactId: source.artifactId, sourceKey: source.sourceId },
              result: assessment.result,
              evidenceRefs: evaluationRun.evidence
                .filter((item) => item.sourceId === assessment.sourceId && assessment.evidenceIds.includes(item.id))
                .flatMap((item) => item.lineNumbers)
                .map((lineNumber) => ({ artifactId: source.artifactId, lineNumber })),
            })
          let decision: Awaited<ReturnType<typeof saveDecision>>
          try {
            decision = await saveDecision(nextEvaluation.revision)
          } catch (reason) {
            if (!isProjectRevisionConflict(reason)) throw reason
            nextEvaluation = await window.sequenceIntelligence.evaluations.getSnapshot({ projectId: current.id })
            decision = await saveDecision(nextEvaluation.revision)
          }
          nextEvaluation = decision.snapshot
        }
        if (nextEvaluation !== evaluationSnapshot) onSnapshotSaved(nextEvaluation)
      }
      const title = evaluationProposalTitle(evaluationRun.proposal)
      const namedPayload: EvaluationAgentMemoryPayloadView = {
        ...payload,
        hypothesis: { ...payload.hypothesis, title },
        node: {
          ...payload.node,
          name: title,
          ...(evaluationRunScopeId ? { evaluationScopeId: evaluationRunScopeId } : {}),
          interpretation: evaluationRun.proposal.rationale,
          authorship: 'agent',
          reviewState: 'confirmed',
        },
      }
      const persist = (target: ProjectSnapshot) => {
        const merged = mergeEvaluationAgentMemory(target, namedPayload)
        return window.sequenceIntelligence!.projects.save({ projectId: target.id, expectedRevision: target.revision, failureHypotheses: merged.failureHypotheses, evaluationNodes: merged.evaluationNodes, evidenceRecords: merged.evidenceRecords })
      }
      let saved: ProjectSnapshot
      try {
        saved = await persist(current)
      } catch (reason) {
        if (!isProjectRevisionConflict(reason)) throw reason
        const refreshed = await window.sequenceIntelligence.projects.get({ projectId: current.id })
        if (!refreshed) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
        saved = await persist(refreshed)
      }
      onProjectUpdated(saved)
      setSavedMessage(sourceDecisions.length ? '결과와 평가 이력에 저장됨' : '평가 이력에 저장됨')
    } catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const answer = (value: string) => {
    if (!run?.question) return
    void invoke(() => window.sequenceIntelligence!.agent.answer({ runId: run.id, questionId: run.question!.id, value }))
  }

  const send = (event: FormEvent) => {
    event.preventDefault()
    const value = input.trim()
    if (!value || !run) return
    void invoke(() => window.sequenceIntelligence!.agent.message({ runId: run.id, content: value }), true)
  }

  const cancel = async () => {
    if (!run || !isAgentRunPending(run)) return
    try {
      const next = await window.sequenceIntelligence?.agent.cancel({ runId: run.id })
      if (next) setRun(next)
    } catch (reason) { setError(boundedError(reason)) }
    activeRunId.current = null
    setBusy(false)
  }

  const confirm = async () => {
    if (!run || busy) return
    const result = run.candidate?.kind === 'result' ? run.candidate.result : undefined
    const decision = buildAgentDecisionInput(project, selectedFile, evaluationSnapshot, result)
    if (!decision || !window.sequenceIntelligence?.agent) return
    setBusy(true); setError('')
    try {
      const saved = await window.sequenceIntelligence.agent.confirm({ runId: run.id, kind: 'decision', expectedRevision: decision.expectedRevision, decision })
      if (saved.saved && 'snapshot' in saved.saved) onSnapshotSaved(saved.saved.snapshot)
      setRun(saved.run); setBusy(false)
    } catch (reason) { setBusy(false); setError(boundedError(reason)) }
  }

  const dismiss = () => { activeRunId.current = null; setRun(null); setEvaluationRun(null); setBusy(false); setError(''); setSavedMessage('') }
  const canStart = Boolean(project && window.sequenceIntelligence?.agent && selectedFile?.artifactId)
  const confirmable = Boolean(run?.candidate?.kind === 'result' && buildAgentDecisionInput(project, selectedFile, evaluationSnapshot, run.candidate.result))
  const pending = Boolean(run && isAgentRunPending(run))

  const projectPending = evaluationRun?.status === 'running' || evaluationRun?.status === 'paused'
  const projectCanStart = Boolean(project && evaluationSources.length && window.sequenceIntelligence?.evaluationAgent)
  const folderScopeRequired = Boolean(project?.artifacts.length && !evaluationScopeId)
  const scope = project ? 'project' as const : 'current' as const
  const slashMatch = /(^|\s)\/([^\s/]*)$/.exec(input)
  const fileMentions = slashMatch && project ? evaluationSources.filter((artifact) => {
    const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath
    return name.toLocaleLowerCase().includes(slashMatch[2].toLocaleLowerCase())
  }).slice(0, 6) : []
  const chooseFileMention = (sourceId: string, name: string) => {
    if (!slashMatch) return
    const start = slashMatch.index + slashMatch[1].length
    setInput(`${input.slice(0, start)}/${name} ${input.slice(start + slashMatch[0].trimStart().length)}`)
    setMentionedSourceIds((current) => [...new Set([...current, sourceId])])
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }
  if (!open) return <button className="agent-fab" onClick={onOpen}><Sparkles size={17} /><span>Agent에게 묻기</span></button>

  return <aside className="agent-panel" aria-label="Agent">
    <div className="agent-panel-head">
      <div><strong>Agent</strong>{project ? <span title={project.name}>{project.name}</span> : null}</div>
      <button className="icon-button small" onClick={onClose} aria-label="Agent 패널 닫기"><X size={15} /></button>
    </div>
    <div className="agent-thread">
      {scope === 'current' && !run ? <div className="agent-empty"><p>{project ? (selectedFile?.artifactId ? selectedFile.name : '로그를 선택하세요.') : '프로젝트를 선택하세요.'}</p><button className="agent-start" onClick={() => void start()} disabled={!canStart}>분석</button></div> : null}
      {scope === 'project' && !nativeSession ? <div className="agent-empty">{!project?.artifacts.length || !evaluationScopeId ? <p>{!project?.artifacts.length ? (project ? '로그를 연결하세요.' : '프로젝트를 선택하세요.') : '분석할 폴더의 로그를 선택하세요.'}</p> : null}<button className="agent-start" onClick={() => void createNativeSession()} disabled={!project || busy || Boolean(project.artifacts.length && !evaluationScopeId)}>새 대화</button></div> : null}
      {scope === 'current' && run?.question ? <><div className="agent-message question"><Sparkles size={13} /><p>{run.question.prompt}</p></div>{run.question.choices?.length ? <div className="quick-answers">{run.question.choices.map((choice) => <button key={choice} onClick={() => answer(choice)} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div> : null}</> : null}
      {scope === 'current' && run?.candidate ? <div className="agent-candidate"><span>후보 결과</span><strong>{candidateText(run)}</strong><small>{confirmable ? '확인 후 저장됩니다.' : '현재는 검토만 가능합니다.'}</small>{confirmable ? <div className="agent-review-actions"><button onClick={() => void confirm()} disabled={busy}><Check size={13} />확인하고 저장</button><button onClick={dismiss} disabled={busy}>거절</button></div> : <button onClick={dismiss}>닫기</button>}</div> : null}
      {scope === 'current' && run?.status === 'failed' ? <div className="agent-error" role="alert">{run.failureReason ? boundedError(new Error(run.failureReason)) : '분석에 실패했습니다.'}</div> : null}
      {scope === 'current' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {scope === 'project' && nativeSession ? <>
        {nativeSession.messages.map((message) => {
          const evidenceTools = toolsForAssistantMessage(message, nativeSession.messages, nativeSession.tools)
          return <div key={message.id} className="native-agent-turn">
            {message.role === 'assistant' && evidenceTools.length ? <details className="native-agent-tools"><summary><Wrench size={12} />근거 {evidenceTools.length}</summary>{evidenceTools.map((tool) => <div key={tool.id} className={tool.state}><span>{tool.label}</span><small>{tool.state === 'running' ? '확인 중' : tool.summary ?? tool.state}</small></div>)}</details> : null}
            <div className={`native-agent-message ${message.role}`} aria-label={message.role === 'user' ? '내 메시지' : message.role === 'assistant' ? 'Agent 응답' : '기록'}>{message.role === 'assistant' ? <AgentMarkdown>{message.content}</AgentMarkdown> : <p>{message.content}</p>}</div>
          </div>
        })}
        {nativeSession.question ? <div className="native-agent-question"><AgentMarkdown>{nativeSession.question.prompt}</AgentMarkdown><div className="quick-answers">{nativeSession.question.choices.map((choice) => <button key={choice} onClick={() => { if (choice === '직접 입력') composerRef.current?.focus(); else void sendNativeText(choice) }} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div></div> : null}
        {nativeSession.status === 'running' && nativeSession.tools.some((tool) => tool.state === 'running') ? <div className="native-agent-running-tools">{nativeSession.tools.filter((tool) => tool.state === 'running').at(-1)?.label} 확인 중</div> : null}
        {shouldShowNativeAgentSuggestions(nativeSession) ? <div className="native-agent-suggestions"><button onClick={() => void startProjectTrend()} disabled={!projectCanStart || busy}>결과와 평가 이력 정리</button><button onClick={() => void sendNativeText('온도와 VDD, DQ별 불량률과 집중 경향을 분모와 함께 비교해줘.')} disabled={busy}>조건별 불량 경향</button><button onClick={() => void sendNativeText('과거 LPDDR5와 LPDDR6 유사 불량을 찾아서 다음 평가를 제안해줘.')} disabled={busy}>과거 사례와 다음 평가</button></div> : null}
      </> : null}
      {scope === 'project' && evaluationStarting ? <section className="agent-evaluation-review" aria-label="결과와 평가 이력 준비 중"><div className="agent-evaluation-progress"><LoaderCircle size={13} className="wb-spin" /><span>평가 폴더를 확인하는 중</span></div></section> : null}
      {scope === 'project' && evaluationRun ? <section className="agent-evaluation-review" aria-label="결과와 평가 이력 검토">
        <div className="agent-evaluation-review-head"><strong>결과와 평가 이력</strong><button type="button" onClick={() => setEvaluationRun(null)} aria-label="검토 닫기"><X size={14} /></button></div>
        {projectPending ? <div className="agent-evaluation-progress"><span>{evaluationRun.status === 'paused' ? boundedError(new Error(evaluationRun.failure ?? '분석을 이어갈 수 있습니다.')) : '분석 중'}</span>{evaluationRun.status === 'paused' ? <button type="button" onClick={() => void resumeProjectTrend({})} disabled={busy}><RotateCcw size={14} />다시 시도</button> : null}</div> : null}
        {evaluationRun.question ? <div className="agent-evaluation-question"><AgentMarkdown>{evaluationRun.question.prompt}</AgentMarkdown>{evaluationRun.question.choices?.length ? <div className="quick-answers">{evaluationRun.question.choices.map((choice) => <button type="button" key={choice} onClick={() => void resumeProjectTrend({ answer: choice })} disabled={busy}><i aria-hidden="true" />{choice}</button>)}</div> : <form onSubmit={(event) => { event.preventDefault(); if (evaluationAnswer.trim()) void resumeProjectTrend({ answer: evaluationAnswer.trim() }) }}><input value={evaluationAnswer} onChange={(event) => setEvaluationAnswer(event.target.value)} placeholder="확인할 값 입력" /><button type="submit" disabled={busy || !evaluationAnswer.trim()}>확인</button></form>}</div> : null}
        {evaluationRun.proposal ? <div className="agent-evaluation-proposal"><div><strong>{evaluationRun.proposal.outcome}</strong>{evaluationRun.proposal.purpose ? <span>{agentEvaluationPurposeLabel(evaluationRun.proposal.purpose)}</span> : null}</div><p>{evaluationRun.proposal.rationale}</p>{evaluationDimensionSummary(evaluationRun.proposal.dimensions).length ? <ul>{evaluationDimensionSummary(evaluationRun.proposal.dimensions).map((item) => <li key={item}>{item}</li>)}</ul> : null}<div className="agent-review-actions"><button type="button" onClick={() => void saveProjectProposal()} disabled={busy}><Check size={14} />결과·이력 저장</button>{evaluationRun.status === 'waiting_confirmation' ? <button type="button" onClick={() => void resumeProjectTrend({ confirm: 'reject' })} disabled={busy}>다시 분석</button> : null}</div></div> : null}
      </section> : null}
      {scope === 'project' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {savedMessage ? <div className="agent-saved" role="status">{savedMessage}</div> : null}
    </div>
    {scope === 'current' && pending ? <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{stageText(run!)}</span><button onClick={() => void cancel()}>취소</button></div> : null}
    {scope === 'project' && nativeSession && nativeSession.status !== 'idle' ? nativeSession.status === 'paused' || nativeSession.status === 'failed' ? <div className="agent-stage retry-only"><button onClick={() => void retryNative()} disabled={busy} aria-label="재시도" title="재시도"><RotateCcw size={15} /></button></div> : <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{nativeSession.status === 'queued' ? '대기 중' : '분석 중'}</span><button onClick={() => void cancelNative()}>중지</button></div> : null}
    {scope === 'current' ? <form className="agent-composer" onSubmit={send}>
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="짧은 메시지 입력" rows={2} disabled={!run || busy} />
      <div><span /><button type="submit" aria-label="메시지 보내기" disabled={!run || busy || !input.trim()}><ArrowUp size={15} /></button></div>
    </form> : <form className="agent-composer native" onSubmit={(event) => { event.preventDefault(); void sendNativeText(input) }}>
      {fileMentions.length ? <div className="agent-file-mentions" role="listbox" aria-label="파일 지정">{fileMentions.map((artifact) => { const name = artifact.relativePath.split(/[\\/]/).at(-1) ?? artifact.relativePath; return <button type="button" role="option" key={artifact.sourceId} onClick={() => chooseFileMention(artifact.sourceId, name)}><span>{name}</span><small>{artifact.relativePath}</small></button> })}</div> : null}
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder={folderScopeRequired ? '분석할 폴더의 로그를 선택하세요' : '질문 입력 · / 로 파일 지정'} rows={2} disabled={!project || folderScopeRequired || busy || nativeSession?.status === 'queued' || nativeSession?.status === 'running'} />
      <div className="agent-composer-footer"><span className="native-agent-controls"><button type="button" onClick={() => setNativeHistoryOpen((value) => !value)} aria-expanded={nativeHistoryOpen} aria-label="대화 기록" title="대화 기록"><History size={17} /></button><i className={`native-agent-backend ${nativeSession?.backend ?? nativeBackend?.active ?? 'internal'}`} title={(nativeSession?.backend ?? nativeBackend?.active) === 'opencode' ? 'OpenCode' : '내장'} /><button type="button" onClick={() => void createNativeSession()} disabled={!project || busy || folderScopeRequired} aria-label="새 대화" title="새 대화"><Plus size={17} /></button></span><button type="submit" aria-label="Agent에 메시지 보내기" disabled={!project || folderScopeRequired || busy || !input.trim()}><ArrowUp size={18} /></button></div>
      {nativeHistoryOpen ? <div className="native-agent-history">{nativeSessions.map((item) => <button type="button" key={item.id} className={item.id === nativeSession?.id ? 'active' : ''} onClick={() => void openNativeSession(item.id)} disabled={busy}><strong>{item.title}</strong><span>{new Date(item.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></button>)}{!nativeSessions.length ? <p>저장된 대화가 없습니다.</p> : null}</div> : null}
    </form>}
  </aside>
}
