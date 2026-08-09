import { FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, History, LoaderCircle, Plus, Sparkles, Wrench, X } from 'lucide-react'
import type {
  AgentRun,
  EvaluationProjectSnapshot,
  EvaluationResultLabel,
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

interface AgentPanelProps {
  open: boolean
  onClose: () => void
  onOpen: () => void
  project: ProjectSnapshot | null
  selectedFile?: WorkbenchFile
  evaluationSnapshot: EvaluationProjectSnapshot | null
  onSnapshotSaved: (snapshot: EvaluationProjectSnapshot) => void
  onProjectUpdated: (project: ProjectSnapshot) => void
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
  const lead = [d.testMode, d.pattern, d.dq !== undefined ? `DQ${d.dq}` : '', d.channel !== undefined ? `CH${d.channel}` : ''].filter(Boolean).slice(0, 2)
  return `${lead.join(' · ') || proposal.outcome} 경향`
}

/** A revision bump is not a project switch: keep a slow native session alive. */
export function shouldRetainAgentSession(previous: ProjectSnapshot | null, next: ProjectSnapshot | null): boolean {
  return previous?.id === next?.id
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
  if (raw.includes('LLM_') || raw.includes('timeout') || raw.includes('429')) return '분석 서버 응답이 늦거나 제한되었습니다.'
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

export function AgentPanel({ open, onClose, onOpen, project, selectedFile, evaluationSnapshot, onSnapshotSaved, onProjectUpdated }: AgentPanelProps) {
  const [run, setRun] = useState<AgentRun | null>(null)
  const [evaluationRun, setEvaluationRun] = useState<EvaluationAgentSessionView | null>(null)
  const [nativeSessions, setNativeSessions] = useState<NativeAgentSessionSummary[]>([])
  const [nativeSession, setNativeSession] = useState<NativeAgentSessionView | null>(null)
  const [nativeBackend, setNativeBackend] = useState<NativeAgentBackendStatusView | null>(null)
  const [nativeHistoryOpen, setNativeHistoryOpen] = useState(false)
  const [scope, setScope] = useState<'current' | 'project'>('current')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const activeRunId = useRef<string | null>(null)
  const projectRef = useRef<ProjectSnapshot | null>(project)
  projectRef.current = project
  const projectKey = project?.id ?? 'no-project'
  const projectKeyRef = useRef(projectKey)
  projectKeyRef.current = projectKey

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
    setNativeSessions([])
    setNativeSession(null)
    setNativeBackend(null)
    setNativeHistoryOpen(false)
    setInput('')
    setBusy(false)
    setError('')
    setSavedMessage('')
  }, [projectKey])

  useEffect(() => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || !open) return undefined
    let active = true
    void Promise.all([api.list({ projectId: project.id }), api.backendStatus()]).then(async ([sessions, backend]) => {
      if (!active || projectKeyRef.current !== project.id) return
      setNativeSessions(sessions); setNativeBackend(backend)
      const first = sessions[0]
      if (first) {
        const detail = await api.get({ sessionId: first.id })
        if (active && detail && projectKeyRef.current === project.id) setNativeSession(detail)
      }
    }).catch((reason) => { if (active) setError(boundedError(reason)) })
    const unsubscribe = api.onUpdate((next) => {
      if (!active || next.projectId !== projectKeyRef.current) return
      setNativeSessions((current) => {
        const { messages: _messages, tools: _tools, ...summary } = next
        return [summary, ...current.filter((item) => item.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
      setNativeSession((current) => !current || current.id === next.id ? next : current)
      if (next.status === 'idle' || next.status === 'paused' || next.status === 'failed') setBusy(false)
    })
    return () => { active = false; unsubscribe() }
  }, [open, project?.id])

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
    setBusy(true); setError(''); setSavedMessage('')
    try {
      const next = await api.create({ projectId: project.id })
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
    try { setNativeSession(await api.get({ sessionId })) }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const sendNativeText = async (content: string) => {
    const api = window.sequenceIntelligence?.nativeAgent
    if (!api || !project || busy || !content.trim()) return
    let target = nativeSession
    if (!target) target = await createNativeSession()
    if (!target) return
    setBusy(true); setError(''); setInput('')
    try { setNativeSession(await api.send({ sessionId: target.id, content: content.trim() })) }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const retryNative = async () => {
    if (!nativeSession || busy || !window.sequenceIntelligence?.nativeAgent) return
    setBusy(true); setError('')
    try { setNativeSession(await window.sequenceIntelligence.nativeAgent.retry({ sessionId: nativeSession.id })) }
    catch (reason) { setError(boundedError(reason)); setBusy(false) }
  }

  const cancelNative = async () => {
    if (!nativeSession || !window.sequenceIntelligence?.nativeAgent) return
    try { setNativeSession(await window.sequenceIntelligence.nativeAgent.cancel({ sessionId: nativeSession.id })) }
    catch (reason) { setError(boundedError(reason)) }
    finally { setBusy(false) }
  }

  const startProjectTrend = async () => {
    const api = window.sequenceIntelligence
    if (!api?.evaluationAgent || !project || busy) return
    setBusy(true); setError(''); setSavedMessage(''); setEvaluationRun(null)
    try {
      const next = await api.evaluationAgent.start({ projectId: project.id, sourceIds: project.artifacts.slice(0, 32).map((source) => source.sourceId), intent: 'failure-trend' })
      if (projectKeyRef.current === projectKey) setEvaluationRun(next)
    } catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const resumeProjectTrend = async (input: { answer?: string; confirm?: 'accept' | 'reject' }) => {
    if (!evaluationRun || busy || !window.sequenceIntelligence?.evaluationAgent) return
    setBusy(true); setError('')
    try { setEvaluationRun(await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, ...input })) }
    catch (reason) { setError(boundedError(reason)) } finally { setBusy(false) }
  }

  const saveProjectProposal = async () => {
    if (!evaluationRun?.proposal || (evaluationRun.status !== 'waiting_confirmation' && evaluationRun.status !== 'completed') || busy || !project || !window.sequenceIntelligence?.evaluationAgent || !window.sequenceIntelligence?.projects) return
    setBusy(true); setError('')
    try {
      const completed = evaluationRun.status === 'completed' ? evaluationRun : await window.sequenceIntelligence.evaluationAgent.resume({ sessionId: evaluationRun.id, confirm: 'accept' })
      setEvaluationRun(completed)
      const prefix = `ea-${project.id}-${evaluationRun.id}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120)
      const payload = await window.sequenceIntelligence.evaluationAgent.memorySavePayload({ sessionId: evaluationRun.id, projectId: project.id, hypothesisId: `${prefix}-h`, nodeId: `${prefix}-n`, evidenceIdPrefix: `${prefix}-e` })
      if (!payload) throw new Error('저장할 제안이 없습니다.')
      // A slow LLM may complete after another same-project write. Always save
      // against the current prop/revision, not the revision that started it.
      const current = projectRef.current
      if (!current || current.id !== project.id) throw new Error('프로젝트가 변경되었습니다. 최신 프로젝트에서 다시 시도해 주세요.')
      const title = evaluationProposalTitle(evaluationRun.proposal)
      const namedPayload: EvaluationAgentMemoryPayloadView = { ...payload, hypothesis: { ...payload.hypothesis, title }, node: { ...payload.node, name: title } }
      const merged = mergeEvaluationAgentMemory(current, namedPayload)
      const saved = await window.sequenceIntelligence.projects.save({ projectId: current.id, expectedRevision: current.revision, failureHypotheses: merged.failureHypotheses, evaluationNodes: merged.evaluationNodes, evidenceRecords: merged.evidenceRecords })
      onProjectUpdated(saved)
      setSavedMessage('평가 이력에 저장됨')
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
  const projectCanStart = Boolean(project && project.artifacts.length && window.sequenceIntelligence?.evaluationAgent)
  if (!open) return <button className="agent-fab" onClick={onOpen}><Sparkles size={16} /><span>Agent 열기</span><kbd>⌘/Ctrl J</kbd></button>

  return <aside className="agent-panel" aria-label="Evaluation Agent">
    <div className="agent-panel-head">
      <div className="agent-orb"><Sparkles size={15} /></div>
      <div><strong>Evaluation Agent</strong><span>{scope === 'current' ? '현재 파일 기반 분석' : '프로젝트 기억 기반 대화'}</span></div>
      <button className="icon-button small" onClick={onClose} aria-label="Agent 패널 닫기"><X size={15} /></button>
    </div>
    <div className="agent-context"><span>컨텍스트</span><strong>{project ? project.name : '프로젝트 없음'}</strong><small>{selectedFile?.name ?? '선택한 artifact 없음'}</small></div>
    <div className="agent-scope" role="group" aria-label="분석 범위"><button className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')}>현재 로그</button><button className={scope === 'project' ? 'active' : ''} onClick={() => setScope('project')}>프로젝트 Agent</button></div>
    {scope === 'project' && project ? <div className="native-agent-toolbar">
      <button onClick={() => setNativeHistoryOpen((value) => !value)} aria-expanded={nativeHistoryOpen}><History size={13} />{nativeSession?.title ?? '대화 선택'}</button>
      <span className={`native-agent-backend ${nativeSession?.backend ?? nativeBackend?.active ?? 'internal'}`}>{(nativeSession?.backend ?? nativeBackend?.active) === 'opencode' ? 'OpenCode' : '내장 Agent'}</span>
      <button className="native-agent-new" onClick={() => void createNativeSession()} disabled={busy} aria-label="새 프로젝트 대화"><Plus size={14} /></button>
      {nativeHistoryOpen ? <div className="native-agent-history">{nativeSessions.map((item) => <button key={item.id} className={item.id === nativeSession?.id ? 'active' : ''} onClick={() => void openNativeSession(item.id)}><strong>{item.title}</strong><span>{new Date(item.updatedAt).toLocaleDateString('ko-KR')} · {item.backend === 'opencode' ? 'OpenCode' : '내장'}</span></button>)}{!nativeSessions.length ? <p>저장된 대화가 없습니다.</p> : null}</div> : null}
    </div> : null}
    <div className="agent-thread">
      {scope === 'current' && !run ? <div className="agent-empty"><p>{project ? (selectedFile?.artifactId ? '선택한 artifact의 판정을 분석합니다.' : '분석할 artifact를 선택하세요.') : '저장된 프로젝트를 선택하세요.'}</p><button className="agent-start" onClick={() => void start()} disabled={!canStart}>분석 시작</button></div> : null}
      {scope === 'project' && !nativeSession ? <div className="agent-empty"><p>{project ? (project.artifacts.length ? `로그 ${project.artifacts.length}개와 저장된 평가 이력을 함께 분석합니다.` : '프로젝트에 로그를 먼저 연결하세요.') : '저장된 프로젝트를 선택하세요.'}</p><button className="agent-start" onClick={() => void createNativeSession()} disabled={!project || busy}>새 대화</button></div> : null}
      {scope === 'current' && run?.question ? <><div className="agent-message question"><Sparkles size={13} /><p>{run.question.prompt}</p></div>{run.question.choices?.length ? <div className="quick-answers">{run.question.choices.map((choice) => <button key={choice} onClick={() => answer(choice)} disabled={busy}>{choice}</button>)}</div> : null}</> : null}
      {scope === 'current' && run?.candidate ? <div className="agent-candidate"><span>후보 결과</span><strong>{candidateText(run)}</strong><small>{confirmable ? '확인 후 저장됩니다.' : '현재는 검토만 가능합니다.'}</small>{confirmable ? <div className="agent-review-actions"><button onClick={() => void confirm()} disabled={busy}><Check size={13} />확인하고 저장</button><button onClick={dismiss} disabled={busy}>거절</button></div> : <button onClick={dismiss}>닫기</button>}</div> : null}
      {scope === 'current' && run?.status === 'failed' ? <div className="agent-error" role="alert">{run.failureReason ? boundedError(new Error(run.failureReason)) : '분석에 실패했습니다.'}</div> : null}
      {scope === 'current' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {scope === 'project' && nativeSession ? <>
        {nativeSession.messages.map((message) => <div key={message.id} className={`native-agent-message ${message.role}`}><span>{message.role === 'user' ? '나' : message.role === 'assistant' ? 'Agent' : 'System'}</span><p>{message.content}</p>{message.evidenceSourceIds?.length ? <small>근거 로그 {message.evidenceSourceIds.length}개</small> : null}</div>)}
        {nativeSession.tools.length ? <details className="native-agent-tools"><summary><Wrench size={12} />도구 실행 {nativeSession.tools.length}건</summary>{nativeSession.tools.slice(-12).map((tool) => <div key={tool.id} className={tool.state}><span>{tool.label}</span><small>{tool.state === 'running' ? '실행 중' : tool.summary ?? tool.state}</small></div>)}</details> : null}
        {nativeSession.status === 'idle' && nativeSession.messages.filter((item) => item.role === 'user').length === 0 ? <div className="native-agent-suggestions"><button onClick={() => void sendNativeText('새 로그에서 어떤 평가를 했고 온도, VDD, 자재, Sample, DQ 조건과 Pass/Fail이 무엇인지 확인해줘.')}>새 로그 평가 조건 확인</button><button onClick={() => void sendNativeText('온도와 VDD, DQ별 불량률과 집중 경향을 분모와 함께 비교해줘.')}>조건별 불량 경향</button><button onClick={() => void sendNativeText('과거 LPDDR5와 LPDDR6 유사 불량을 찾아서 다음 평가를 제안해줘.')}>과거 사례와 다음 평가</button></div> : null}
      </> : null}
      {scope === 'project' && error ? <div className="agent-error" role="alert">{error}</div> : null}
      {savedMessage ? <div className="agent-saved" role="status">{savedMessage}</div> : null}
    </div>
    {scope === 'current' && pending ? <div className="agent-stage" role="status"><LoaderCircle size={12} className="wb-spin" /><span>{stageText(run!)}</span><button onClick={() => void cancel()}>취소</button></div> : null}
    {scope === 'project' && nativeSession && nativeSession.status !== 'idle' ? <div className="agent-stage" role="status">{nativeSession.status === 'queued' || nativeSession.status === 'running' ? <LoaderCircle size={12} className="wb-spin" /> : null}<span>{nativeSession.status === 'queued' ? '대기 중' : nativeSession.status === 'running' ? '도구 실행 및 분석 중' : nativeSession.failure ?? '분석이 멈췄습니다.'}</span>{nativeSession.status === 'paused' || nativeSession.status === 'failed' ? <button onClick={() => void retryNative()} disabled={busy}>재시도</button> : <button onClick={() => void cancelNative()}>중지</button>}</div> : null}
    {scope === 'current' ? <form className="agent-composer" onSubmit={send}>
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="짧은 메시지 입력" rows={2} disabled={!run || busy} />
      <div><span>{run ? '분석 맥락에 추가' : '분석을 시작하면 입력할 수 있습니다'}</span><button type="submit" aria-label="메시지 보내기" disabled={!run || busy || !input.trim()}><ArrowUp size={15} /></button></div>
    </form> : <form className="agent-composer native" onSubmit={(event) => { event.preventDefault(); void sendNativeText(input) }}>
      <textarea ref={composerRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="평가 맥락이나 다음 실험을 질문하세요" rows={3} disabled={!project || busy || nativeSession?.status === 'queued' || nativeSession?.status === 'running'} />
      <div><span>{nativeSession ? '대화와 도구 근거가 프로젝트에 저장됩니다' : '새 대화가 자동으로 만들어집니다'}</span><button type="submit" aria-label="프로젝트 Agent에 메시지 보내기" disabled={!project || busy || !input.trim()}><ArrowUp size={15} /></button></div>
    </form>}
  </aside>
}
