import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Info, X } from 'lucide-react'
import { Navigation } from './components/Navigation'
import { isAppPage, type AppPage } from './state/appNavigation'
import {
  projectLogRecords,
  type LogResultRecord,
  type MetadataApprovalsBySource,
  type PatternAxis,
} from './state/logRecords'
import { PatternsView } from './views/PatternsView'
import { ResultsView } from './views/ResultsView'
import { SettingsView } from './views/SettingsView'
import {
  artifactFiles,
  DEMO_LOGS,
  dedupeWorkbenchFiles,
  mergeWorkbenchFiles,
  WorkbenchView,
  type WorkbenchDecision,
  type WorkbenchFile,
  type WorkbenchRecipeDraft,
  type PrecomputedBatchResolution,
} from './views/WorkbenchView'
import './data-views.css'
import type {
  ArtifactRecord,
  EvaluationBatchExceptionCode,
  EvaluationBatchOutcomeInput,
  EvaluationProjectSnapshot,
  EvaluationRecipeRule,
  RendererCommand,
} from '../electron/shared/contracts'
import type { RecipeRule } from './domain/workbench'

const PROJECT_ID = 'log-workbench'

export interface AppLifecycle {
  mounted: boolean
  generation: number
}

export function setupAppLifecycle(lifecycle: AppLifecycle): () => void {
  lifecycle.mounted = true
  const generation = lifecycle.generation
  return () => {
    if (lifecycle.generation !== generation) return
    lifecycle.mounted = false
    lifecycle.generation += 1
  }
}

export function isAppLifecycleActive(lifecycle: AppLifecycle, generation?: number): boolean {
  return lifecycle.mounted && (generation === undefined || lifecycle.generation === generation)
}

export function reconcileListedFiles(
  current: readonly WorkbenchFile[],
  artifacts: readonly ArtifactRecord[],
): WorkbenchFile[] {
  const listedLogs = dedupeWorkbenchFiles(artifacts
    .filter((artifact) => artifact.extension.replace(/^\./, '').toLowerCase() === 'log')
    .flatMap(artifactFiles))
  return mergeWorkbenchFiles(current, listedLogs)
}

export function setupAppCommandListener(
  lifecycle: AppLifecycle,
  onCommand: (listener: (command: RendererCommand) => void) => () => void,
  navigate: (page: AppPage) => void,
  scheduleAnimationFrame: (callback: () => void) => number = (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (frameId: number) => void = (frameId) => window.cancelAnimationFrame(frameId),
  dispatchCommand: (command: RendererCommand) => void = (command) => {
    window.dispatchEvent(new CustomEvent('sequence-control-tower:command', { detail: command }))
  },
): () => void {
  const generation = lifecycle.generation
  const pendingAnimationFrames = new Set<number>()
  const unsubscribe = onCommand((command) => {
    if (!isAppLifecycleActive(lifecycle, generation)) return
    if (command === 'preferences') {
      navigate('settings')
      return
    }
    navigate('workbench')
    const frameId = scheduleAnimationFrame(() => {
      pendingAnimationFrames.delete(frameId)
      if (!isAppLifecycleActive(lifecycle, generation)) return
      dispatchCommand(command)
    })
    pendingAnimationFrames.add(frameId)
  })
  return () => {
    pendingAnimationFrames.forEach((frameId) => cancelAnimationFrame(frameId))
    pendingAnimationFrames.clear()
    unsubscribe()
  }
}

export function hydrateEvaluation(files: readonly WorkbenchFile[], snapshot: EvaluationProjectSnapshot | null): WorkbenchFile[] {
  if (!snapshot) return [...files]
  const decisions = new Map(snapshot.decisions.map((decision) => [
    `${decision.source.sourceId}\u0000${decision.source.artifactId}`,
    decision,
  ]))
  const outcomes = new Map<string, EvaluationProjectSnapshot['batches'][number]['outcomes'][number]>()
  snapshot.batches.forEach((batch) => batch.outcomes.forEach((outcome) => {
    outcomes.set(`${outcome.source.sourceId}\u0000${outcome.source.artifactId}`, outcome)
  }))
  return files.map((file) => {
    if (!file.artifactId) return file
    const { decision: _legacyDecision, ruleResult: _legacyRuleResult, ruleNeedsReview: _legacyRuleNeedsReview, ...base } = file
    const key = `${file.id}\u0000${file.artifactId}`
    const decision = decisions.get(key)
    const outcome = outcomes.get(key)
    return {
      ...base,
      ...(decision ? { decision: decision.result } : {}),
      ...(outcome ? {
        ruleResult: outcome.result,
        ruleNeedsReview: Boolean(outcome.exceptionCode) || outcome.result === 'UNKNOWN',
      } : {}),
    }
  })
}

export function projectMetadataApprovals(
  files: readonly WorkbenchFile[],
  snapshot: EvaluationProjectSnapshot | null,
): MetadataApprovalsBySource {
  if (!snapshot) return {}
  const exactArtifacts = new Map(files.flatMap((file) => file.artifactId ? [[file.id, file.artifactId] as const] : []))
  const latest = new Map<string, EvaluationProjectSnapshot['metadataApprovals'][number]>()
  snapshot.metadataApprovals.forEach((approval) => {
    if (exactArtifacts.get(approval.source.sourceId) !== approval.source.artifactId) return
    latest.set(`${approval.source.sourceId}\u0000${approval.fieldKey}`, approval)
  })
  const bySource: Record<string, Record<string, { approval: 'approved' | 'rejected'; candidateValue?: string; approvedValue?: string }>> = {}
  latest.forEach((approval) => {
    bySource[approval.source.sourceId] ??= {}
    bySource[approval.source.sourceId][approval.fieldKey] = {
      approval: approval.approval,
      ...(approval.candidateValue ? { candidateValue: approval.candidateValue } : {}),
      ...(approval.approvedValue ? { approvedValue: approval.approvedValue } : {}),
    }
  })
  return bySource
}

export function projectEvidenceCounts(
  files: readonly WorkbenchFile[],
  snapshot: EvaluationProjectSnapshot | null,
): Record<string, number> {
  if (!snapshot) return {}
  const artifacts = new Map(files.flatMap((file) => file.artifactId ? [[file.id, file.artifactId] as const] : []))
  const counts: Record<string, number> = {}
  snapshot.batches.forEach((batch) => batch.outcomes.forEach((outcome) => {
    if (artifacts.get(outcome.source.sourceId) === outcome.source.artifactId) {
      counts[outcome.source.sourceId] = outcome.evidenceRefs.length
    }
  }))
  snapshot.decisions.forEach((decision) => {
    if (artifacts.get(decision.source.sourceId) === decision.source.artifactId) {
      counts[decision.source.sourceId] = decision.evidenceRefs.length
    }
  })
  return counts
}

function batchExceptionCode(resolution: PrecomputedBatchResolution, sourceId: string): EvaluationBatchExceptionCode | undefined {
  if (resolution.conflictIds.includes(sourceId)) return 'RULE_CONFLICT'
  const code = resolution.evaluations[sourceId]?.exceptions[0]?.code
  if (code === 'NO_MATCH' || code === 'RULE_CONFLICT') return code
  if (code === 'MISSING_EVIDENCE' || code === 'EVIDENCE_ERROR') return 'SEARCH_ERROR'
  return code ? 'OTHER' : undefined
}

function readInitialPage(): AppPage {
  const value = new URLSearchParams(window.location.search).get('screen')
  if (value === 'tower') return 'results'
  if (value === 'console') return 'patterns'
  return isAppPage(value) ? value : 'workbench'
}

function initialFiles(): WorkbenchFile[] {
  return window.sequenceIntelligence ? [] : DEMO_LOGS
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>(readInitialPage)
  const [files, setFiles] = useState<WorkbenchFile[]>(initialFiles)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(() => initialFiles()[1]?.id ?? initialFiles()[0]?.id ?? null)
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({})
  const [evaluationSnapshot, setEvaluationSnapshot] = useState<EvaluationProjectSnapshot | null>(null)
  const [previewMetadataApprovals, setPreviewMetadataApprovals] = useState<MetadataApprovalsBySource>({})
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const evaluationSnapshotRef = useRef<EvaluationProjectSnapshot | null>(null)
  const evaluationQueue = useRef<Promise<void>>(Promise.resolve())
  const shownStorageNotice = useRef('')
  const lifecycleRef = useRef<AppLifecycle>({ mounted: false, generation: 0 })
  const filesRef = useRef(files)
  filesRef.current = files

  useEffect(() => {
    return setupAppLifecycle(lifecycleRef.current)
  }, [])

  const notify = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'success', generation?: number) => {
    const lifecycle = lifecycleRef.current
    if (!isAppLifecycleActive(lifecycle, generation)) return
    setToast({ message, tone })
  }, [])

  const navigate = useCallback((page: AppPage) => {
    setActivePage(page)
    const query = new URLSearchParams(window.location.search)
    query.set('screen', page)
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`)
  }, [])

  const acceptEvaluationSnapshot = useCallback((snapshot: EvaluationProjectSnapshot, generation?: number) => {
    const lifecycle = lifecycleRef.current
    if (!isAppLifecycleActive(lifecycle, generation)) return
    evaluationSnapshotRef.current = snapshot
    setEvaluationSnapshot(snapshot)
    setFiles((current) => hydrateEvaluation(current, snapshot))
    if (snapshot.storageNotice && shownStorageNotice.current !== snapshot.storageNotice.backupFileName) {
      shownStorageNotice.current = snapshot.storageNotice.backupFileName
      notify(`손상된 분석 저장소를 ${snapshot.storageNotice.backupFileName}으로 보존하고 복구했습니다.`, 'info', generation)
    }
  }, [notify])

  const enqueueEvaluation = useCallback((
    operation: (snapshot: EvaluationProjectSnapshot) => Promise<{ snapshot: EvaluationProjectSnapshot }>,
    failureMessage: string,
  ): Promise<void> => {
    const api = window.sequenceIntelligence
    if (!api?.evaluations) return Promise.resolve()
    const generation = lifecycleRef.current.generation
    const task = evaluationQueue.current.then(async () => {
      let snapshot = evaluationSnapshotRef.current ?? await api.evaluations.bootstrap({ projectId: PROJECT_ID })
      let result: { snapshot: EvaluationProjectSnapshot }
      try {
        result = await operation(snapshot)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('EVALUATION_REVISION_CONFLICT')) throw error
        snapshot = await api.evaluations.getSnapshot({ projectId: PROJECT_ID })
        result = await operation(snapshot)
      }
      acceptEvaluationSnapshot(result.snapshot, generation)
    })
    evaluationQueue.current = task.catch(() => undefined)
    return task.catch((error) => {
      notify(error instanceof Error ? `${failureMessage}: ${error.message}` : failureMessage, 'error', generation)
      throw error
    })
  }, [acceptEvaluationSnapshot, notify])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api) return undefined
    let active = true
    const generation = lifecycleRef.current.generation
    void api.artifacts.list().then((artifacts) => {
      if (!active || !isAppLifecycleActive(lifecycleRef.current, generation)) return
      const next = reconcileListedFiles(filesRef.current, artifacts)
      filesRef.current = next
      setFiles(hydrateEvaluation(next, evaluationSnapshotRef.current))
      setSelectedFileId((current) => current && next.some((file) => file.id === current) ? current : next[0]?.id ?? null)
    }).catch((error) => {
      if (active && isAppLifecycleActive(lifecycleRef.current, generation)) {
        notify(error instanceof Error ? error.message : '저장된 로그를 불러오지 못했습니다.', 'error', generation)
      }
    })
    return () => { active = false }
  }, [notify])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api?.evaluations) return undefined
    let active = true
    void api.evaluations.bootstrap({ projectId: PROJECT_ID }).then((snapshot) => {
      if (active) acceptEvaluationSnapshot(snapshot)
    }).catch((error) => {
      if (active) notify(error instanceof Error ? `분석 결과 저장소를 열지 못했습니다: ${error.message}` : '분석 결과 저장소를 열지 못했습니다.', 'error')
    })
    return () => { active = false }
  }, [acceptEvaluationSnapshot, notify])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api?.app.onCommand) return undefined
    return setupAppCommandListener(lifecycleRef.current, api.app.onCommand, navigate)
  }, [navigate])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const metadataApprovals = useMemo<MetadataApprovalsBySource>(() => {
    const persisted = projectMetadataApprovals(files, evaluationSnapshot)
    const merged: Record<string, Record<string, { approval: 'approved' | 'rejected'; candidateValue?: string; approvedValue?: string }>> = {}
    for (const [sourceId, fields] of Object.entries(persisted)) merged[sourceId] = { ...fields }
    for (const [sourceId, fields] of Object.entries(previewMetadataApprovals)) {
      merged[sourceId] = { ...(merged[sourceId] ?? {}), ...fields }
    }
    return merged
  }, [evaluationSnapshot, files, previewMetadataApprovals])

  const persistedEvidenceCounts = useMemo(
    () => projectEvidenceCounts(files, evaluationSnapshot),
    [evaluationSnapshot, files],
  )

  const records = useMemo(
    () => projectLogRecords(files, { ...evidenceCounts, ...persistedEvidenceCounts }, metadataApprovals),
    [evidenceCounts, files, metadataApprovals, persistedEvidenceCounts],
  )

  const durableRules = useMemo<readonly RecipeRule[] | undefined>(() => {
    if (!window.sequenceIntelligence?.evaluations || !evaluationSnapshot) return undefined
    const latestRecipes = new Map(evaluationSnapshot.recipes.map((recipe) => [recipe.recipeId, recipe]))
    const rules = new Map<string, RecipeRule>()
    latestRecipes.forEach((recipe) => recipe.rules.forEach((rule) => rules.set(rule.id, rule as RecipeRule)))
    return [...rules.values()]
  }, [evaluationSnapshot])

  const updateFiles = useCallback((next: WorkbenchFile[]) => {
    filesRef.current = next
    setFiles(hydrateEvaluation(next, evaluationSnapshotRef.current))
    setSelectedFileId((current) => current && next.some((file) => file.id === current) ? current : next[0]?.id ?? null)
  }, [])

  const updateDecision = useCallback(async (file: WorkbenchFile, decision: WorkbenchDecision, evidenceLines: number[]) => {
    if (!file.artifactId || !window.sequenceIntelligence?.evaluations) {
      setFiles((current) => current.map((item) => item.id === file.id ? { ...item, decision } : item))
      return
    }
    await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.saveDecision({
      projectId: PROJECT_ID,
      expectedRevision: snapshot.revision,
      source: { sourceId: file.id, artifactId: file.artifactId!, sourceKey: file.sourceKey ?? file.id },
      result: decision,
      evidenceRefs: evidenceLines.map((lineNumber) => ({ artifactId: file.artifactId!, lineNumber })),
    }), '엔지니어 판정을 저장하지 못했습니다')
  }, [enqueueEvaluation])

  const updateEvidenceCount = useCallback((fileId: string, count: number) => {
    setEvidenceCounts((current) => current[fileId] === count ? current : { ...current, [fileId]: count })
  }, [])

  const saveRecipeRevision = useCallback(async (draft: WorkbenchRecipeDraft) => {
    if (!draft.rule) return
    await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.saveRecipe({
      projectId: PROJECT_ID,
      expectedRevision: snapshot.revision,
      recipeId: draft.rule!.id,
      name: `${draft.decision} 판정 규칙`,
      rules: [draft.rule!] as EvaluationRecipeRule[],
    }), '분석 규칙을 저장하지 못했습니다')
  }, [enqueueEvaluation])

  const updateBatchResults = useCallback(async (resolution: PrecomputedBatchResolution) => {
    if (!window.sequenceIntelligence?.evaluations) {
      const exceptions = new Set(resolution.exceptionIds)
      setFiles((current) => current.map((file) => Object.prototype.hasOwnProperty.call(resolution.outcomes, file.id)
        ? { ...file, ruleResult: resolution.outcomes[file.id], ruleNeedsReview: exceptions.has(file.id) }
        : file))
      return
    }
    await enqueueEvaluation(async (snapshot) => {
      const decisionBySource = new Map(snapshot.decisions.map((decision) => [
        `${decision.source.sourceId}\u0000${decision.source.artifactId}`,
        decision,
      ]))
      const outcomes: EvaluationBatchOutcomeInput[] = files.flatMap((file) => {
        if (!file.artifactId || !Object.prototype.hasOwnProperty.call(resolution.outcomes, file.id)) return []
        const evaluation = resolution.evaluations[file.id]
        const selectedRule = evaluation?.matchedRules.find((rule) => rule.ruleId === evaluation.selectedRuleId)
        const evidenceRefs = selectedRule?.clauseEvaluations.flatMap((clause) => {
          const occurrence = clause.firstOccurrence ?? clause.lastOccurrence
          return occurrence?.lineNumber ? [{
            artifactId: file.artifactId!,
            lineNumber: occurrence.lineNumber,
            columnStart: occurrence.columnStart,
            columnEnd: occurrence.columnEnd,
            matcherId: clause.clauseId,
          }] : []
        }) ?? []
        const conflict = decisionBySource.get(`${file.id}\u0000${file.artifactId}`)
        const exceptionCode = batchExceptionCode(resolution, file.id)
        return [{
          source: { sourceId: file.id, artifactId: file.artifactId, sourceKey: file.sourceKey ?? file.id },
          result: resolution.outcomes[file.id],
          outcomeSource: file.decision ? 'engineer-preserved' : resolution.outcomes[file.id] === 'UNKNOWN' ? 'unknown' : 'rule',
          ...(evaluation?.selectedRuleId ? { matchedRuleId: evaluation.selectedRuleId } : {}),
          ...(evidenceRefs.length ? { evidenceRefs } : {}),
          ...(exceptionCode ? { exceptionCode } : {}),
          ...(resolution.conflictIds.includes(file.id) && conflict ? { conflictingDecisionId: conflict.id } : {}),
        }]
      })
      return window.sequenceIntelligence!.evaluations.saveRecipeAndBatch({
        projectId: PROJECT_ID,
        expectedRevision: snapshot.revision,
        recipe: {
          recipeId: 'active-batch-ruleset',
          name: 'Applied batch rule set',
          rules: resolution.appliedRules as EvaluationRecipeRule[],
        },
        batch: { status: 'completed', outcomes },
      })
    }, '일괄 판정 결과를 저장하지 못했습니다')
  }, [enqueueEvaluation, files])

  const approveMetadata = useCallback(async (record: LogResultRecord, field: PatternAxis, value: string) => {
    const file = files.find((item) => item.id === record.id)
    if (!file?.artifactId) {
      setPreviewMetadataApprovals((current) => ({
        ...current,
        [record.id]: {
          ...(current[record.id] ?? {}),
          [field]: { approval: 'approved', candidateValue: value, approvedValue: value },
        },
      }))
      notify(`웹 미리보기에서 ${field} 후보를 승인했습니다.`, 'info')
      return
    }
    const generation = lifecycleRef.current.generation
    try {
      await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.approveMetadata({
        projectId: PROJECT_ID,
        expectedRevision: snapshot.revision,
        source: { sourceId: file.id, artifactId: file.artifactId!, sourceKey: file.sourceKey ?? file.id },
        fieldKey: field,
        candidateValue: value,
        approvedValue: value,
        extractorId: `default-filename-${field}-v1`,
        approval: 'approved',
      }), '메타데이터 후보를 승인하지 못했습니다')
      notify(`${record.fileName}의 ${field} 후보를 승인했습니다.`, 'success', generation)
    } catch {
      // enqueueEvaluation already surfaced the durable-store failure.
    }
  }, [enqueueEvaluation, files, notify])

  const openFile = useCallback((fileId: string) => {
    setSelectedFileId(fileId)
    navigate('workbench')
  }, [navigate])

  const content = activePage === 'workbench' ? (
    <WorkbenchView
      files={files}
      durableRules={durableRules}
      selectedFileId={selectedFileId ?? undefined}
      onFilesChange={updateFiles}
      onSelectedFileChange={setSelectedFileId}
      onEvidenceCountChange={updateEvidenceCount}
      onDecision={updateDecision}
      onSaveRecipe={saveRecipeRevision}
      onBatchResults={updateBatchResults}
      onNotify={notify}
    />
  ) : activePage === 'results' ? (
    <ResultsView records={records} onOpenFile={openFile} onApproveMetadata={approveMetadata} onEditMetadata={approveMetadata} onNotify={notify} />
  ) : activePage === 'patterns' ? (
    <PatternsView records={records} onOpenFile={openFile} />
  ) : <SettingsView />

  return (
    <div className="app-shell analysis-app" data-page={activePage}>
      <Navigation active={activePage} onChange={navigate} />
      <main className="main-shell">
        <div className="content-shell">{content}</div>
      </main>
      {toast ? <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
        {toast.tone === 'error' ? <AlertCircle size={16} /> : toast.tone === 'info' ? <Info size={16} /> : <Check size={16} />}
        {toast.message}
        <button onClick={() => setToast(null)} aria-label="알림 닫기"><X size={14} /></button>
      </div> : null}
    </div>
  )
}
