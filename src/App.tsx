import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Info, X } from 'lucide-react'
import { Navigation } from './components/Navigation'
import { isAppPage, type AppPage } from './state/appNavigation'
import {
  projectLogRecords,
  type LogResultRecord,
  type MetadataApprovalsBySource,
  type PatternAxis,
  type StageResultsBySource,
} from './state/logRecords'
import { PatternsView } from './views/PatternsView'
import { ResultsView } from './views/ResultsView'
import { SettingsView } from './views/SettingsView'
import { ProjectControl } from './components/ProjectControl'
import { AgentPanel, type EvaluationAgentLaunchRequest } from './components/AgentPanel'
import {
  artifactFiles,
  DEMO_LOGS,
  dedupeWorkbenchFiles,
  mergeWorkbenchFiles,
  WorkbenchView,
  filterUserRecipeRevisions,
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
  EvaluationRecipeRevision,
  ProjectLoadResult,
  ProjectSnapshot,
  RendererCommand,
  ArtifactStageScanInput,
} from '../electron/shared/contracts'
import { getActiveEvaluationRecipeRevisions } from '../electron/shared/contracts'
import type { RecipeRule } from './domain/workbench'
import { matchesPersistedSource, matchesProjectSource, resolveProjectSource } from './state/sourceIdentity'
import { evaluationMemoryToProjectSave, projectSnapshotToEvaluationMemory } from './state/evaluationMemory'
import type { EvaluationMemory } from './domain/evaluation-memory'
import { EvaluationMemoryView, type AvailableEvaluationLog } from './views/EvaluationMemoryView'

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

/**
 * Builds rows only for sources connected to the active project. Artifact
 * records are content-addressed and can contain source locations from several
 * projects, so filtering by artifact id alone is not sufficient.
 */
export function projectArtifactFiles(
  artifacts: readonly ArtifactRecord[],
  projectSources: readonly ProjectSnapshot['artifacts'][number][],
): WorkbenchFile[] {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  return dedupeWorkbenchFiles(projectSources.flatMap((source) => {
    const artifact = artifactById.get(source.artifactId)
    if (!artifact || artifact.extension.replace(/^\./, '').toLowerCase() !== 'log') return []
    const rootId = source.artifactRootId ?? source.rootId
    const locations = (artifact.sources ?? []).filter((location) => (
      location.rootId === rootId
      && location.relativePath.replace(/\\/g, '/') === source.relativePath.replace(/\\/g, '/')
    ))
    const narrowed: ArtifactRecord = {
      ...artifact,
      sources: locations.length ? locations : [{ rootId, folderLabel: 'Project logs', relativePath: source.relativePath }],
    }
    return artifactFiles(narrowed).filter((file) => matchesProjectSource(file, source))
  }))
}

export function reconcileProjectListedFiles(
  current: readonly WorkbenchFile[],
  artifacts: readonly ArtifactRecord[],
  projectSources: readonly ProjectSnapshot['artifacts'][number][],
): WorkbenchFile[] {
  const currentProjectRows = current.filter((file) => projectSources.some((source) => matchesProjectSource(file, source)))
  return mergeWorkbenchFiles(currentProjectRows, projectArtifactFiles(artifacts, projectSources))
}

export interface ProjectUpdateFileState {
  files: WorkbenchFile[]
  selectedFileId: string | null
}

export function reconcileProjectUpdateFileState(
  current: readonly WorkbenchFile[],
  selectedFileId: string | null,
  previous: ProjectSnapshot | null,
  next: ProjectSnapshot,
): ProjectUpdateFileState {
  if (!previous || previous.id !== next.id) return { files: [...current], selectedFileId }
  const nextRoots = new Set(next.folders.map((folder) => folder.rootId))
  const detachedRoots = new Set(previous.folders.map((folder) => folder.rootId).filter((rootId) => !nextRoots.has(rootId)))
  if (!detachedRoots.size) return { files: [...current], selectedFileId }
  const files = current.filter((file) => !file.rootId || !detachedRoots.has(file.rootId))
  return {
    files,
    selectedFileId: selectedFileId && files.some((file) => file.id === selectedFileId) ? selectedFileId : files[0]?.id ?? null,
  }
}

export function projectLoadFileState(
  artifacts: readonly ArtifactRecord[],
  projectSources?: readonly ProjectSnapshot['artifacts'][number][],
): ProjectUpdateFileState {
  const files = projectSources ? projectArtifactFiles(artifacts, projectSources) : dedupeWorkbenchFiles(artifacts.flatMap(artifactFiles))
  return { files, selectedFileId: files[0]?.id ?? null }
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

export function hydrateEvaluation(files: readonly WorkbenchFile[], snapshot: EvaluationProjectSnapshot | null, projectSources: ReadonlyArray<ProjectSnapshot['artifacts'][number]> = []): WorkbenchFile[] {
  if (!snapshot) return [...files]
  return files.map((file) => {
    if (!file.artifactId) return file
    const { decision: _legacyDecision, ruleResult: _legacyRuleResult, ruleNeedsReview: _legacyRuleNeedsReview, ...base } = file
    const decision = [...snapshot.decisions].reverse().find((item) => matchesPersistedSource(file, item.source, projectSources))
    const outcome = [...snapshot.batches].reverse().flatMap((batch) => [...batch.outcomes].reverse()).find((item) => matchesPersistedSource(file, item.source, projectSources))
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
  projectSources: ReadonlyArray<ProjectSnapshot['artifacts'][number]> = [],
): MetadataApprovalsBySource {
  if (!snapshot) return {}
  const latest = new Map<string, EvaluationProjectSnapshot['metadataApprovals'][number]>()
  snapshot.metadataApprovals.forEach((approval) => {
    if (!files.some((file) => matchesPersistedSource(file, approval.source, projectSources))) return
    latest.set(`${approval.source.sourceId}\u0000${approval.fieldKey}`, approval)
  })
  const bySource: Record<string, Record<string, { approval: 'approved' | 'rejected' | 'reset'; candidateValue?: string; approvedValue?: string }>> = {}
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
  projectSources: ReadonlyArray<ProjectSnapshot['artifacts'][number]> = [],
): Record<string, number> {
  if (!snapshot) return {}
  const counts: Record<string, number> = {}
  snapshot.batches.forEach((batch) => batch.outcomes.forEach((outcome) => {
    if (files.some((file) => matchesPersistedSource(file, outcome.source, projectSources))) {
      counts[outcome.source.sourceId] = outcome.evidenceRefs.length
    }
  }))
  snapshot.decisions.forEach((decision) => {
    if (files.some((file) => matchesPersistedSource(file, decision.source, projectSources))) {
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

function previewEvaluationMemory(): EvaluationMemory {
  return {
    project: { id: PROJECT_ID, name: 'LPDDR6 Sample 분석' },
    hypotheses: [
      { id: 'preview-h-85', projectId: PROJECT_ID, title: '85°C DIAG 종료 상태', origin: 'engineer-confirmed', evaluationNodeIds: ['preview-n-85'] },
      { id: 'preview-h-105', projectId: PROJECT_ID, title: '105°C Training·Reboot 경향', origin: 'ai-proposed', evaluationNodeIds: ['preview-n-105'] },
    ],
    nodes: [
      { id: 'preview-n-85', projectId: PROJECT_ID, hypothesisId: 'preview-h-85', evaluationScopeId: 'Qualcomm_A / 85C', name: '85°C DIAG 확인', purpose: 'verification', status: 'pass', interpretation: '85°C의 두 로그에서 stress test PASS가 확인됐습니다. 한 로그는 종료 marker가 없어 정상 종료 여부를 추가 확인해야 합니다.', authorship: 'engineer', reviewState: 'confirmed', dimensions: { temperatureC: 85, testMode: 'DIAG' } },
      { id: 'preview-n-105', projectId: PROJECT_ID, hypothesisId: 'preview-h-105', parentId: 'preview-n-85', evaluationScopeId: 'Qualcomm_A / 105C', name: '105°C 실패 경향', purpose: 'characterization', status: 'fail', interpretation: '105°C에서 Training fail과 watchdog reboot가 각각 확인됐습니다. 동일 원인으로 확정하지 않고 Sample과 전압 조건을 분리해 재평가해야 합니다.', authorship: 'agent', reviewState: 'proposed', dimensions: { temperatureC: 105, testMode: 'DIAG' } },
    ],
    evidence: [
      { id: 'preview-e-01', projectId: PROJECT_ID, evaluationNodeId: 'preview-n-85', status: 'pass', result: 'PASS', dimensions: { sample: '01', temperatureC: 85 }, sourceIds: ['demo-pass-01'], origin: 'engineer-confirmed' },
      { id: 'preview-e-03', projectId: PROJECT_ID, evaluationNodeId: 'preview-n-85', status: 'inconclusive', result: 'UNKNOWN', dimensions: { sample: '03', temperatureC: 85 }, sourceIds: ['demo-halt-03'], origin: 'engineer-confirmed' },
      { id: 'preview-e-07', projectId: PROJECT_ID, evaluationNodeId: 'preview-n-105', status: 'fail', result: 'TRAINING_FAIL', dimensions: { sample: '07', temperatureC: 105 }, sourceIds: ['demo-training-07'], origin: 'ai-proposed' },
      { id: 'preview-e-09', projectId: PROJECT_ID, evaluationNodeId: 'preview-n-105', status: 'fail', result: 'SYSTEM_REBOOT', dimensions: { sample: '09', temperatureC: 105 }, sourceIds: ['demo-reboot-09'], origin: 'ai-proposed' },
    ],
  }
}

export function availableEvaluationLogs(records: readonly LogResultRecord[], files: readonly WorkbenchFile[], project: ProjectSnapshot | null): AvailableEvaluationLog[] {
  const filesById = new Map(files.map((file) => [file.id, file]))
  return records.flatMap((record) => {
    const file = filesById.get(record.id)
    const source = project && file ? resolveProjectSource(project, file) : null
    // Electron persistence accepts only a connected project source. The browser
    // preview intentionally falls back to the renderer identity.
    if (project && !source) return []
    const temperature = record.temperature.value === null ? Number.NaN : Number(record.temperature.value)
    return [{
      id: source?.sourceId ?? record.id, openId: file?.id ?? record.id, name: record.fileName, result: record.result,
      ...(source?.rootId
        ? { rootId: source.rootId, folderName: project?.folders.find((folder) => folder.rootId === source.rootId)?.displayLabel ?? source.rootId }
        : file?.origin ? { rootId: file.origin, folderName: file.origin } : {}),
      ...(record.sample.value ? { sample: record.sample.value } : {}),
      ...(Number.isFinite(temperature) ? { temperatureC: temperature } : {}),
      ...(record.mode.value ? { mode: record.mode.value } : {}),
      ...(record.grid.value ? { grid: record.grid.value } : {}),
    }]
  })
}

/** Serializes requests and reads the current project immediately before each save. */
export function createLatestProjectSaveQueue<TProject, TValue>(
  getProject: () => TProject | null,
  save: (project: TProject, value: TValue) => Promise<TProject>,
  onSaved: (project: TProject) => void,
): (value: TValue) => Promise<TProject | null> {
  let tail: Promise<void> = Promise.resolve()
  return (value) => {
    const task = tail.then(async () => {
      const project = getProject()
      if (!project) return null
      const saved = await save(project, value)
      onSaved(saved)
      return saved
    })
    tail = task.then(() => undefined, () => undefined)
    return task
  }
}

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>(readInitialPage)
  const [files, setFiles] = useState<WorkbenchFile[]>(initialFiles)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(() => initialFiles()[1]?.id ?? initialFiles()[0]?.id ?? null)
  const [selectedEvaluationRootId, setSelectedEvaluationRootId] = useState<string | undefined>()
  const [agentOpen, setAgentOpen] = useState(false)
  const [evaluationAgentLaunch, setEvaluationAgentLaunch] = useState<EvaluationAgentLaunchRequest | null>(null)
  const [evidenceCounts, setEvidenceCounts] = useState<Record<string, number>>({})
  const [evaluationSnapshot, setEvaluationSnapshot] = useState<EvaluationProjectSnapshot | null>(null)
  const [project, setProject] = useState<ProjectSnapshot | null>(null)
  const [previewMemory, setPreviewMemory] = useState<EvaluationMemory>(previewEvaluationMemory)
  const activeProjectId = project?.id ?? PROJECT_ID
  const projectGeneration = useRef(0)
  const [previewMetadataApprovals, setPreviewMetadataApprovals] = useState<MetadataApprovalsBySource>({})
  const [stageResultsBySource, setStageResultsBySource] = useState<StageResultsBySource>({})
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const evaluationSnapshotRef = useRef<EvaluationProjectSnapshot | null>(null)
  const evaluationQueue = useRef<Promise<void>>(Promise.resolve())
  const shownStorageNotice = useRef('')
  const stageInspectionCache = useRef(new Map<string, StageResultsBySource>())
  const lifecycleRef = useRef<AppLifecycle>({ mounted: false, generation: 0 })
  const filesRef = useRef(files)
  const projectRef = useRef<ProjectSnapshot | null>(project)
  const projectUpdatedRef = useRef<(next: ProjectSnapshot) => void>(() => undefined)
  const notifyRef = useRef<(message: string, tone?: 'success' | 'error' | 'info', generation?: number) => void>(() => undefined)
  filesRef.current = files
  projectRef.current = project

  useEffect(() => {
    return setupAppLifecycle(lifecycleRef.current)
  }, [])

  const notify = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'success', generation?: number) => {
    const lifecycle = lifecycleRef.current
    if (!isAppLifecycleActive(lifecycle, generation)) return
    setToast({ message, tone })
  }, [])
  notifyRef.current = notify

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
    setFiles((current) => hydrateEvaluation(current, snapshot, project?.artifacts ?? []))
    if (snapshot.storageNotice && shownStorageNotice.current !== snapshot.storageNotice.backupFileName) {
      shownStorageNotice.current = snapshot.storageNotice.backupFileName
      notify(`손상된 분석 저장소를 ${snapshot.storageNotice.backupFileName}으로 보존하고 복구했습니다.`, 'info', generation)
    }
  }, [notify, project?.artifacts])

  const enqueueEvaluation = useCallback((
    operation: (snapshot: EvaluationProjectSnapshot) => Promise<{ snapshot: EvaluationProjectSnapshot }>,
    failureMessage: string,
  ): Promise<void> => {
    const api = window.sequenceIntelligence
    if (!api?.evaluations) return Promise.resolve()
    const generation = lifecycleRef.current.generation
    const task = evaluationQueue.current.then(async () => {
      let snapshot = evaluationSnapshotRef.current ?? await api.evaluations.bootstrap({ projectId: activeProjectId })
      let result: { snapshot: EvaluationProjectSnapshot }
      try {
        result = await operation(snapshot)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('EVALUATION_REVISION_CONFLICT')) throw error
        snapshot = await api.evaluations.getSnapshot({ projectId: activeProjectId })
        result = await operation(snapshot)
      }
      acceptEvaluationSnapshot(result.snapshot, generation)
    })
    evaluationQueue.current = task.catch(() => undefined)
    return task.catch((error) => {
      notify(error instanceof Error ? `${failureMessage}: ${error.message}` : failureMessage, 'error', generation)
      throw error
    })
  }, [acceptEvaluationSnapshot, activeProjectId, notify])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api) return undefined
    let active = true
    const generation = lifecycleRef.current.generation
    const projectLoadGeneration = projectGeneration.current
    void api.artifacts.list().then((artifacts) => {
      if (!active || projectGeneration.current !== projectLoadGeneration || !isAppLifecycleActive(lifecycleRef.current, generation)) return
      const next = project
        ? reconcileProjectListedFiles(filesRef.current, artifacts, project.artifacts)
        : reconcileListedFiles(filesRef.current, artifacts)
      filesRef.current = next
      setFiles(hydrateEvaluation(next, evaluationSnapshotRef.current, project?.artifacts ?? []))
      setSelectedFileId((current) => current && next.some((file) => file.id === current) ? current : next[0]?.id ?? null)
    }).catch((error) => {
      if (active && isAppLifecycleActive(lifecycleRef.current, generation)) {
        notify(error instanceof Error ? error.message : '저장된 로그를 불러오지 못했습니다.', 'error', generation)
      }
    })
    return () => { active = false }
  }, [notify, project?.artifacts])

  const projectLoaded = useCallback((result: ProjectLoadResult) => {
    const generation = projectGeneration.current + 1
    projectGeneration.current = generation
    setProject(result.project)
    evaluationSnapshotRef.current = null
    setEvaluationSnapshot(null)
    const next = projectLoadFileState(result.artifacts, result.project.artifacts)
    filesRef.current = next.files
    setFiles(next.files)
    setSelectedFileId(next.selectedFileId)
    setSelectedEvaluationRootId(undefined)
  }, [])

  const projectUpdated = useCallback((nextProject: ProjectSnapshot) => {
    const next = reconcileProjectUpdateFileState(filesRef.current, selectedFileId, project, nextProject)
    setProject(nextProject)
    filesRef.current = next.files
    setFiles(next.files)
    setSelectedFileId(next.selectedFileId)
    setSelectedEvaluationRootId((current) => current && nextProject.artifacts.some((source) => source.rootId === current) ? current : undefined)
  }, [project, selectedFileId])
  projectUpdatedRef.current = projectUpdated

  const importProjectFolder = useCallback(async (): Promise<{ cancelled: true } | { cancelled: false; importedCount: number; failureCount: number; skippedCount: number }> => {
    const api = window.sequenceIntelligence
    const target = projectRef.current
    if (!api?.projects || !target) return { cancelled: true }
    const latest = await api.projects.get({ projectId: target.id }) ?? target
    const previousSources = new Set(latest.artifacts.map((source) => source.sourceId))
    const result = await api.projects.attachFolder({ projectId: latest.id, expectedRevision: latest.revision })
    if ('cancelled' in result) return { cancelled: true }
    projectLoaded(result)
    return {
      cancelled: false,
      importedCount: result.project.artifacts.filter((source) => !previousSources.has(source.sourceId)).length,
      failureCount: result.failures.length,
      skippedCount: result.skippedCount,
    }
  }, [projectLoaded])

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api?.evaluations) return undefined
    let active = true
    void api.evaluations.bootstrap({ projectId: activeProjectId }).then((snapshot) => {
      if (active) acceptEvaluationSnapshot(snapshot)
    }).catch((error) => {
      if (active) notify(error instanceof Error ? `분석 결과 저장소를 열지 못했습니다: ${error.message}` : '분석 결과 저장소를 열지 못했습니다.', 'error')
    })
    return () => { active = false }
  }, [acceptEvaluationSnapshot, activeProjectId, notify])

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
    const persisted = projectMetadataApprovals(files, evaluationSnapshot, project?.artifacts ?? [])
    const merged: Record<string, Record<string, { approval: 'approved' | 'rejected' | 'reset'; candidateValue?: string; approvedValue?: string }>> = {}
    for (const [sourceId, fields] of Object.entries(persisted)) merged[sourceId] = { ...fields }
    for (const [sourceId, fields] of Object.entries(previewMetadataApprovals)) {
      merged[sourceId] = { ...(merged[sourceId] ?? {}), ...fields }
    }
    return merged
  }, [evaluationSnapshot, files, previewMetadataApprovals, project?.artifacts])

  const persistedEvidenceCounts = useMemo(
    () => projectEvidenceCounts(files, evaluationSnapshot, project?.artifacts ?? []),
    [evaluationSnapshot, files, project?.artifacts],
  )

  const stageInspectionPlan = useMemo(() => {
    const sources: ArtifactStageScanInput['sources'] = []
    const fileIds = new Map<string, string>()
    for (const file of files) {
      if (!file.artifactId) continue
      const source = project?.artifacts.find((candidate) => matchesProjectSource(file, candidate))
      if (source) {
        sources.push({
          sourceId: source.sourceId,
          artifactId: source.artifactId,
          ...(source.artifactRootId ? { rootId: source.artifactRootId } : {}),
          relativePath: source.relativePath,
        })
        fileIds.set(source.sourceId, file.id)
      } else {
        sources.push({
          sourceId: file.id,
          artifactId: file.artifactId,
          ...(file.rootId ? { rootId: file.rootId } : {}),
          ...(file.relativePath ? { relativePath: file.relativePath } : {}),
        })
        fileIds.set(file.id, file.id)
      }
    }
    const key = `${project?.id ?? 'workspace'}\u0000${sources.map((source) => `${source.sourceId}:${source.artifactId}`).sort().join('|')}`
    return { key, sources, fileIds }
  }, [files, project])

  useEffect(() => {
    if (activePage !== 'results' && activePage !== 'patterns') return undefined
    const api = window.sequenceIntelligence
    if (!api?.artifacts.inspectStages || !stageInspectionPlan.sources.length) {
      setStageResultsBySource({})
      return undefined
    }
    const cached = stageInspectionCache.current.get(stageInspectionPlan.key)
    if (cached) {
      setStageResultsBySource(cached)
      return undefined
    }
    let active = true
    setStageResultsBySource({})
    void api.artifacts.inspectStages({ sources: stageInspectionPlan.sources }).then((result) => {
      if (!active) return
      const next: Record<string, import('./state/logRecords').EvaluationStageResult[]> = {}
      for (const source of result.sources) {
        const fileId = stageInspectionPlan.fileIds.get(source.sourceId)
        if (!fileId || source.error) continue
        next[fileId] = source.stages
      }
      stageInspectionCache.current.set(stageInspectionPlan.key, next)
      while (stageInspectionCache.current.size > 8) {
        const oldest = stageInspectionCache.current.keys().next().value as string | undefined
        if (!oldest) break
        stageInspectionCache.current.delete(oldest)
      }
      setStageResultsBySource(next)
    }).catch((error) => {
      if (active && !(error instanceof Error && error.name === 'AbortError')) {
        notify(error instanceof Error ? `단계 결과를 확인하지 못했습니다: ${error.message}` : '단계 결과를 확인하지 못했습니다.', 'error')
      }
    })
    return () => { active = false }
  }, [activePage, notify, stageInspectionPlan])

  const records = useMemo(
    () => projectLogRecords(files, { ...evidenceCounts, ...persistedEvidenceCounts }, metadataApprovals, stageResultsBySource),
    [evidenceCounts, files, metadataApprovals, persistedEvidenceCounts, stageResultsBySource],
  )

  const memory = useMemo(() => project ? projectSnapshotToEvaluationMemory(project) : previewMemory, [previewMemory, project])
  const availableLogs = useMemo(() => availableEvaluationLogs(records, files, project), [files, project, records])

  const durableRules = useMemo<readonly RecipeRule[] | undefined>(() => {
    if (!window.sequenceIntelligence?.evaluations || !evaluationSnapshot) return undefined
    const latestRecipes = filterUserRecipeRevisions(getActiveEvaluationRecipeRevisions(evaluationSnapshot.recipes))
    const rules = new Map<string, RecipeRule>()
    latestRecipes.forEach((recipe) => recipe.rules.forEach((rule) => rules.set(rule.id, rule as RecipeRule)))
    return [...rules.values()]
  }, [evaluationSnapshot])

  const durableRecipes = useMemo<readonly EvaluationRecipeRevision[] | undefined>(() => {
    if (!window.sequenceIntelligence?.evaluations || !evaluationSnapshot) return undefined
    return filterUserRecipeRevisions(getActiveEvaluationRecipeRevisions(evaluationSnapshot.recipes))
  }, [evaluationSnapshot])

  const selectedFile = useMemo(() => files.find((file) => file.id === selectedFileId), [files, selectedFileId])

  const updateFiles = useCallback((next: WorkbenchFile[]) => {
    filesRef.current = next
    setFiles(hydrateEvaluation(next, evaluationSnapshotRef.current, project?.artifacts ?? []))
    setSelectedFileId((current) => current && next.some((file) => file.id === current) ? current : next[0]?.id ?? null)
  }, [project?.artifacts])

  const updateDecision = useCallback(async (file: WorkbenchFile, decision: WorkbenchDecision, evidenceLines: number[]) => {
    if (!file.artifactId || !window.sequenceIntelligence?.evaluations) {
      setFiles((current) => current.map((item) => item.id === file.id ? { ...item, decision } : item))
      return
    }
    await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.saveDecision({
      projectId: activeProjectId,
      expectedRevision: snapshot.revision,
      source: { sourceId: file.id, artifactId: file.artifactId!, sourceKey: file.sourceKey ?? file.id },
      result: decision,
      evidenceRefs: evidenceLines.map((lineNumber) => ({ artifactId: file.artifactId!, lineNumber })),
    }), '엔지니어 판정을 저장하지 못했습니다')
  }, [activeProjectId, enqueueEvaluation])

  const updateEvidenceCount = useCallback((fileId: string, count: number) => {
    setEvidenceCounts((current) => current[fileId] === count ? current : { ...current, [fileId]: count })
  }, [])

  const saveRecipeRevision = useCallback(async (draft: WorkbenchRecipeDraft) => {
    if (!draft.rule) return
    const source = filesRef.current.find((file) => file.id === draft.sourceFileId)
    const folderLabel = source?.origin || source?.relativePath?.replace(/\\/g, '/').split('/')[0]
    await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.saveRecipe({
      projectId: activeProjectId,
      expectedRevision: snapshot.revision,
      recipeId: draft.recipeId ?? draft.rule!.id,
      name: `${folderLabel ? `${folderLabel} · ` : ''}${draft.decision} 판정`,
      rules: [draft.rule!] as EvaluationRecipeRule[],
    }), '분석 규칙을 저장하지 못했습니다')
  }, [activeProjectId, enqueueEvaluation])

  const archiveRecipeRevision = useCallback(async (recipeId: string) => {
    if (!window.sequenceIntelligence?.evaluations) return
    await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.archiveRecipe({
      projectId: activeProjectId,
      expectedRevision: snapshot.revision,
      recipeId,
    }), '분석 규칙을 보관하지 못했습니다')
  }, [activeProjectId, enqueueEvaluation])

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
        projectId: activeProjectId,
        expectedRevision: snapshot.revision,
        recipe: {
          recipeId: 'active-batch-ruleset',
          name: 'Applied batch rule set',
          rules: resolution.appliedRules as EvaluationRecipeRule[],
        },
        batch: { status: 'completed', outcomes },
      })
    }, '일괄 판정 결과를 저장하지 못했습니다')
  }, [activeProjectId, enqueueEvaluation, files])

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
        projectId: activeProjectId,
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
  }, [activeProjectId, enqueueEvaluation, files, notify])

  const resetMetadataApproval = useCallback(async (record: LogResultRecord, field: PatternAxis) => {
    const file = files.find((item) => item.id === record.id)
    if (!file?.artifactId) {
      setPreviewMetadataApprovals((current) => ({
        ...current,
        [record.id]: {
          ...(current[record.id] ?? {}),
          [field]: { approval: 'reset' },
        },
      }))
      notify('승인을 취소하고 원래 후보로 되돌렸습니다.', 'info')
      return
    }
    const generation = lifecycleRef.current.generation
    try {
      await enqueueEvaluation((snapshot) => window.sequenceIntelligence!.evaluations.approveMetadata({
        projectId: activeProjectId,
        expectedRevision: snapshot.revision,
        source: { sourceId: file.id, artifactId: file.artifactId!, sourceKey: file.sourceKey ?? file.id },
        fieldKey: field,
        extractorId: `default-filename-${field}-v1`,
        approval: 'reset',
      }), '메타데이터 승인을 취소하지 못했습니다')
      notify(`${record.fileName}의 승인을 취소했습니다.`, 'info', generation)
    } catch {
      // enqueueEvaluation already surfaced the durable-store failure.
    }
  }, [activeProjectId, enqueueEvaluation, files, notify])

  const applyMetadataSuggestion = useCallback(async (fileId: string, field: PatternAxis, value: string) => {
    const record = records.find((item) => item.id === fileId)
    if (!record) {
      notify('LLM metadata 후보를 적용할 로그를 찾지 못했습니다.', 'error')
      return
    }
    await approveMetadata(record, field, value)
  }, [approveMetadata, notify, records])

  const openFile = useCallback((fileId: string) => {
    setSelectedFileId(fileId)
    const next = filesRef.current.find((file) => file.id === fileId)
    setSelectedEvaluationRootId(next && projectRef.current ? resolveProjectSource(projectRef.current, next)?.rootId : undefined)
    navigate('workbench')
  }, [navigate])

  const memorySaveQueue = useRef<ReturnType<typeof createLatestProjectSaveQueue<ProjectSnapshot, EvaluationMemory>> | null>(null)
  if (!memorySaveQueue.current) {
    memorySaveQueue.current = createLatestProjectSaveQueue(
      () => projectRef.current,
      async (currentProject, nextMemory) => {
        const api = window.sequenceIntelligence
        if (!api?.projects) return currentProject
        const payload = evaluationMemoryToProjectSave(nextMemory)
        const save = (target: ProjectSnapshot) => api.projects.save({ ...payload, projectId: target.id, expectedRevision: target.revision })
        try {
          const saved = await save(currentProject)
          notifyRef.current('평가 이력을 저장했습니다.')
          return saved
        } catch (error) {
          const conflict = error instanceof Error && (error.message.includes('PROJECT_REVISION_CONFLICT') || error.message.includes('최신 revision'))
          if (!conflict) {
            notifyRef.current(error instanceof Error ? `평가 이력을 저장하지 못했습니다: ${error.message}` : '평가 이력을 저장하지 못했습니다.', 'error')
            throw error
          }
          try {
            const refreshed = await api.projects.get({ projectId: currentProject.id })
            if (!refreshed) throw new Error('프로젝트를 다시 불러오지 못했습니다.')
            const remoteMemory = evaluationMemoryToProjectSave(projectSnapshotToEvaluationMemory(refreshed))
            const baselineMemory = evaluationMemoryToProjectSave(projectSnapshotToEvaluationMemory(currentProject))
            if (JSON.stringify(remoteMemory) !== JSON.stringify(baselineMemory)) {
              notifyRef.current('다른 변경으로 평가 이력이 갱신되었습니다. 최신 프로젝트를 불러왔습니다. 다시 시도하세요.', 'info')
              projectRef.current = refreshed
              projectUpdatedRef.current(refreshed)
              throw new Error('다른 변경으로 평가 이력이 갱신되었습니다.')
            }
            const saved = await save(refreshed)
            notifyRef.current('최신 프로젝트 기준으로 평가 이력을 저장했습니다.')
            return saved
          } catch (retryError) {
            notifyRef.current(retryError instanceof Error ? `평가 이력을 저장하지 못했습니다: ${retryError.message}` : '평가 이력을 저장하지 못했습니다.', 'error')
            throw retryError
          }
        }
      },
      (saved) => { projectRef.current = saved; projectUpdatedRef.current(saved) },
    )
  }
  const saveEvaluationMemory = useCallback(async (nextMemory: EvaluationMemory) => {
    if (!window.sequenceIntelligence?.projects || !projectRef.current) {
      setPreviewMemory(nextMemory)
      notify('웹 미리보기에서는 평가 이력이 로컬 상태로만 유지됩니다. 프로젝트를 열면 저장할 수 있습니다.', 'info')
      return
    }
    await memorySaveQueue.current!(nextMemory)
  }, [notify])

  const content = activePage === 'workbench' ? (
    <WorkbenchView
      files={files}
      durableRules={durableRules}
      durableRecipes={durableRecipes}
      selectedFileId={selectedFileId ?? undefined}
      selectedFolderRootId={selectedEvaluationRootId}
      onFilesChange={updateFiles}
      onSelectedFileChange={(fileId) => {
        setSelectedFileId(fileId)
        const next = filesRef.current.find((file) => file.id === fileId)
        setSelectedEvaluationRootId(next && projectRef.current ? resolveProjectSource(projectRef.current, next)?.rootId : undefined)
      }}
      onSelectedFolderChange={(rootId) => setSelectedEvaluationRootId(rootId ?? undefined)}
      onEvidenceCountChange={updateEvidenceCount}
      onDecision={updateDecision}
      onSaveRecipe={saveRecipeRevision}
      onArchiveRecipe={archiveRecipeRevision}
      onBatchResults={updateBatchResults}
      onApplyMetadataSuggestion={applyMetadataSuggestion}
      onImportProjectFolder={project ? importProjectFolder : undefined}
      onNotify={notify}
      onOpenAgent={() => setAgentOpen(true)}
      projectId={project?.id ?? PROJECT_ID}
      projectSources={project?.artifacts ?? []}
    />
  ) : activePage === 'results' ? (
    <ResultsView records={records} onOpenFile={openFile} onApproveMetadata={approveMetadata} onEditMetadata={approveMetadata} onResetMetadata={resetMetadataApproval} onNotify={notify} project={project} onProjectUpdated={projectUpdated} />
  ) : activePage === 'patterns' ? (
    <PatternsView records={records} onOpenFile={openFile} project={project} onProjectUpdated={setProject} onNotify={notify} />
  ) : activePage === 'history' ? (
    <EvaluationMemoryView
      memory={memory}
      availableLogs={availableLogs}
      onChange={saveEvaluationMemory}
      onOpenLog={openFile}
      onSelectLog={(id) => {
        setSelectedFileId(id)
        const next = filesRef.current.find((file) => file.id === id)
        setSelectedEvaluationRootId(next && projectRef.current ? resolveProjectSource(projectRef.current, next)?.rootId : undefined)
      }}
      onAnalyzeEvaluation={(request) => {
        if (request.openId) setSelectedFileId(request.openId)
        setSelectedEvaluationRootId(request.evaluationScopeId)
        setEvaluationAgentLaunch({ id: `${Date.now()}-${request.evaluationScopeId}`, evaluationScopeId: request.evaluationScopeId, title: request.title, sourceIds: request.sourceIds, ...(request.intent ? { intent: request.intent } : {}) })
        setAgentOpen(true)
      }}
      selectedEvaluationScopeId={selectedEvaluationRootId}
      onNotify={notify}
    />
  ) : <SettingsView />

  return (
    <div className={`app-shell analysis-app${activePage === 'workbench' ? ' workbench-is-open' : ''}`} data-page={activePage}>
      <Navigation active={activePage} onChange={navigate} />
      <main className="main-shell">
        <div className="content-shell">
          <div className="project-topbar"><ProjectControl project={project} onLoaded={projectLoaded} onProjectUpdated={projectUpdated} onError={(message) => notify(message, 'error')} /></div>
          {content}
        </div>
      </main>
      {activePage !== 'history' || agentOpen ? <AgentPanel
        open={agentOpen}
        onOpen={() => setAgentOpen(true)}
        onClose={() => setAgentOpen(false)}
        project={project}
        selectedFile={selectedFile}
        selectedEvaluationRootId={selectedEvaluationRootId}
        evaluationSnapshot={evaluationSnapshot}
        onSnapshotSaved={(snapshot) => acceptEvaluationSnapshot(snapshot)}
        onProjectUpdated={projectUpdated}
        evaluationLaunchRequest={evaluationAgentLaunch}
      /> : null}
      {toast ? <div className={`toast ${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
        {toast.tone === 'error' ? <AlertCircle size={16} /> : toast.tone === 'info' ? <Info size={16} /> : <Check size={16} />}
        {toast.message}
        <button onClick={() => setToast(null)} aria-label="알림 닫기"><X size={14} /></button>
      </div> : null}
    </div>
  )
}
