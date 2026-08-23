import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ArtifactImportOptions,
  ArtifactEvidenceInput,
  ArtifactFailureAddressScanInput,
  ArtifactLineWindowInput,
  ArtifactSearchInput,
  EvaluationArchiveRecipeInput,
  EvaluationApproveMetadataInput,
  EvaluationApproveMetadataBatchInput,
  EvaluationProjectRequest,
  EvaluationSaveBatchInput,
  EvaluationSaveDecisionInput,
  EvaluationSaveRecipeInput,
  EvaluationSaveRecipeAndBatchInput,
  EvaluationAgentMemoryPayloadRequest,
  EvaluationAgentRestoreRequest,
  EvaluationAgentResumeRequest,
  EvaluationAgentStartRequest,
  EvaluationAgentMemoryPayloadView,
  EvaluationAgentSessionView,
  LlmConfigInput,
  LlmModelDiscoveryInput,
  NativeAgentCancelRequest,
  NativeAgentCompleteEvaluationInput,
  NativeAgentConfirmWorkflowInput,
  NativeAgentCreateRequest,
  NativeAgentDismissWorkflowInput,
  NativeAgentGetRequest,
  NativeAgentListRequest,
  NativeAgentListWorkflowsInput,
  NativeAgentRetryRequest,
  NativeAgentReuseKnowledgeInput,
  NativeAgentSearchEventInput,
  NativeAgentSendRequest,
  StartAnalysisInput,
  WikiEntryInput
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import { AnalysisService } from './analysis-service'
import { ArtifactService, artifactRootIdForPath } from './artifact-service'
import { EvaluationStore } from './evaluation-store'
import { LlmConfigService } from './llm-service'
import { isSameRendererDocument } from './renderer-document'
import { WikiService } from './wiki-service'
import { ProjectStore } from './project-store'
import { AgentService } from './agent-service'
import { EvaluationAgentService } from './evaluation-agent-service'
import { NativeAgentService } from './native-agent-service'
import { SampleProjectService } from './sample-project-service'
import { createHash } from 'node:crypto'
import type { ProjectLoadResult, ProjectSnapshot } from '../shared/contracts'
import type { WebContents } from 'electron'

interface Services {
  artifacts: ArtifactService
  evaluations: EvaluationStore
  analysis: AnalysisService
  llmConfig: LlmConfigService
  wiki: WikiService
  projects: ProjectStore
  agent: AgentService
  evaluationAgent?: EvaluationAgentService
  nativeAgent?: NativeAgentService
  samples?: SampleProjectService
}

const packagedRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
const activeArtifactSearches = new Map<number, AbortController>()
const activeArtifactEvidenceInspections = new Map<number, AbortController>()
const activeArtifactStageInspections = new Map<number, AbortController>()
const activeArtifactFailureAddressInspections = new Map<number, AbortController>()
const activeArtifactFolderImports = new Map<string, symbol>()
const agentOwners = new Map<string, number>()
const agentRunsBySender = new Map<number, Set<string>>()
const agentSenders = new Map<number, WebContents>()
const agentSenderCleanup = new Map<number, () => void>()
const evaluationAgentOwners = new Map<string, number>()
const evaluationAgentSessionsBySender = new Map<number, Set<string>>()
const evaluationAgentSenders = new Map<number, WebContents>()
const evaluationAgentSenderCleanup = new Map<number, () => void>()
let agentUpdateUnsubscribe: (() => void) | null = null
let registeredAgent: AgentService | null = null
let nativeAgentUpdateUnsubscribe: (() => void) | null = null
const FOLDER_IMPORT_IN_PROGRESS_ERROR =
  '폴더 가져오기가 이미 진행 중입니다. 현재 작업이 끝난 후 다시 시도해 주세요.'

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url
  if (!frameUrl) return false
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (
    !owner ||
    owner.isDestroyed() ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) return false
  const expectedRendererUrl = app.isPackaged
    ? packagedRendererUrl
    : process.env.ELECTRON_RENDERER_URL || packagedRendererUrl
  return isSameRendererDocument(frameUrl, expectedRendererUrl)
}

function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('IPC 요청이 차단되었습니다.')
    return listener(event, ...args)
  })
}

function safeAgentText(value: unknown, max = 800): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
}
function safeEvidenceSummary(value: unknown): string {
  return safeAgentText(value, 500)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\\/\s]+[\\/])+[^\\/\s,;)]*/g, '<PATH>')
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '<SECRET>')
}

function evaluationEvidenceLines(evidence: import('../../src/domain/evaluation-agent').EvaluationEvidence): number[] {
  if (evidence.kind !== 'search' || !evidence.excerpt) return []
  return [...evidence.excerpt.matchAll(/(?:^|\n)L(\d+):/g)]
    .map((match) => Number(match[1]))
    .filter((line) => Number.isSafeInteger(line) && line > 0)
    .slice(0, 8)
}

/** Removes excerpts/aggregates so the renderer sees decisions, not raw log text. */
function evaluationAgentView(session: import('../../src/domain/evaluation-agent').EvaluationAgentSession): EvaluationAgentSessionView {
  const question = session.question
    ? { ...session.question, field: session.question.field ?? session.question.dimension ?? 'evaluationIntent' as const }
    : undefined
  return {
    schemaVersion: 1, id: session.id, status: session.status, depth: session.depth, calls: session.calls, searches: session.searches,
    files: session.files.map((file) => ({ sourceId: file.id, name: safeAgentText(file.name, 240), lineCount: file.lineCount, size: file.size, dimensions: file.metadata })),
    evidence: session.evidence.map((evidence) => ({ id: evidence.id, kind: evidence.kind, sourceId: evidence.fileId, summary: safeAgentText(evidence.detail, 400), lineNumbers: evaluationEvidenceLines(evidence) })),
    transcript: session.transcript.map((item) => ({ at: item.at, role: item.role, type: item.type })),
    dimensions: session.context.dimensions,
    ...(session.context.evaluationIntent ? { evaluationIntent: safeAgentText(session.context.evaluationIntent, 400) } : {}),
    ...(session.context.analysisPolicy ? { analysisPolicy: session.context.analysisPolicy } : {}),
    ...(question ? { question } : {}),
    proposal: session.proposal, failure: session.failure ? safeAgentText(session.failure, 300) : undefined
  }
}

function evaluationMemoryView(payload: NonNullable<ReturnType<EvaluationAgentService['memorySavePayload']>>): EvaluationAgentMemoryPayloadView {
  return {
    hypothesis: payload.hypothesis,
    node: payload.node,
    evidence: payload.evidence.map((item) => ({ id: item.id, projectId: item.projectId, evaluationNodeId: item.evaluationNodeId, status: item.status, result: item.result, dimensions: item.dimensions, sourceIds: item.logRef ? [item.logRef] : [], summary: safeEvidenceSummary(item.note), origin: item.origin }))
  }
}

export function registerIpc(services: Services): void {
  registeredAgent = services.agent
  agentUpdateUnsubscribe?.()
  agentUpdateUnsubscribe = services.agent.onUpdate((run) => {
    const senderId = agentOwners.get(run.id)
    if (senderId === undefined) return
    const sender = agentSenders.get(senderId)
    if (!sender || sender.isDestroyed()) return
    sender.send(IPC_CHANNELS.agentUpdate, run)
  })
  nativeAgentUpdateUnsubscribe?.()
  nativeAgentUpdateUnsubscribe = services.nativeAgent?.onUpdate((session) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.nativeAgentUpdate, session)
    })
  }) ?? null

  const removeAgentOwner = (runId: string): void => {
    const senderId = agentOwners.get(runId)
    if (senderId === undefined) return
    agentOwners.delete(runId)
    const runs = agentRunsBySender.get(senderId)
    runs?.delete(runId)
    if (runs?.size) return
    agentRunsBySender.delete(senderId)
    const sender = agentSenders.get(senderId)
    const cleanup = agentSenderCleanup.get(senderId)
    if (sender && cleanup) sender.removeListener('destroyed', cleanup)
    agentSenderCleanup.delete(senderId)
    agentSenders.delete(senderId)
  }

  const cancelOwnedAgentRuns = (senderId: number): void => {
    const runIds = [...(agentRunsBySender.get(senderId) ?? [])]
    runIds.forEach((runId) => removeAgentOwner(runId))
    runIds.forEach((runId) => {
      const run = services.agent.get(runId)
      if (run && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
        void services.agent.cancel({ runId })
      }
    })
  }

  const registerAgentOwner = (sender: WebContents, runId: string): void => {
    const senderId = sender.id
    agentOwners.set(runId, senderId)
    let runs = agentRunsBySender.get(senderId)
    if (!runs) {
      runs = new Set<string>()
      agentRunsBySender.set(senderId, runs)
      agentSenders.set(senderId, sender)
      const cleanup = (): void => cancelOwnedAgentRuns(senderId)
      agentSenderCleanup.set(senderId, cleanup)
      sender.once('destroyed', cleanup)
    }
    runs.add(runId)
  }

  const requireAgentOwner = (event: IpcMainInvokeEvent, runId: string): void => {
    if (agentOwners.get(runId) !== event.sender.id) throw new Error('agent run을 찾을 수 없습니다.')
  }
  const evaluationAgent = (): EvaluationAgentService => {
    if (!services.evaluationAgent) throw new Error('evaluation agent is unavailable')
    return services.evaluationAgent
  }
  const removeEvaluationAgentOwner = (sessionId: string): void => {
    const senderId = evaluationAgentOwners.get(sessionId); if (senderId === undefined) return
    evaluationAgentOwners.delete(sessionId); const ids = evaluationAgentSessionsBySender.get(senderId); ids?.delete(sessionId)
    if (ids?.size) return
    evaluationAgentSessionsBySender.delete(senderId); const sender = evaluationAgentSenders.get(senderId); const cleanup = evaluationAgentSenderCleanup.get(senderId)
    if (sender && cleanup) sender.removeListener('destroyed', cleanup)
    evaluationAgentSenderCleanup.delete(senderId); evaluationAgentSenders.delete(senderId)
  }
  const registerEvaluationAgentOwner = (sender: WebContents, sessionId: string): void => {
    const senderId = sender.id; evaluationAgentOwners.set(sessionId, senderId)
    let ids = evaluationAgentSessionsBySender.get(senderId)
    if (!ids) {
      ids = new Set(); evaluationAgentSessionsBySender.set(senderId, ids); evaluationAgentSenders.set(senderId, sender)
      const cleanup = (): void => { [...(evaluationAgentSessionsBySender.get(senderId) ?? [])].forEach(removeEvaluationAgentOwner) }
      evaluationAgentSenderCleanup.set(senderId, cleanup); sender.once('destroyed', cleanup)
    }
    ids.add(sessionId)
  }
  const requireEvaluationAgentOwner = (event: IpcMainInvokeEvent, sessionId: string): void => {
    if (evaluationAgentOwners.get(sessionId) !== event.sender.id) throw new Error('evaluation agent session not found')
  }

  const hydrateProject = async (project: ProjectSnapshot | null): Promise<ProjectLoadResult | null> => {
    if (!project) return null
    const statuses = await services.projects.validateFolders(project.id)
    const refreshed = await services.projects.get(project.id)
    if (!refreshed) return null
    const available = await services.projects.availableFolderPaths(project.id)
    const imported = available.length ? await services.artifacts.importFolders(available.map((item) => item.path), { extensions: ['log'], maxFiles: 10000 }) : { artifacts: [], failures: [], skippedCount: 0 }
    const rootsByArtifactId = new Map(available.map((item) => [artifactRootIdForPath(item.path), item]))
    const sources = imported.artifacts.flatMap((artifact) => (artifact.sources ?? []).flatMap((source) => {
      const projectRoot = rootsByArtifactId.get(source.rootId)
      return projectRoot ? [{
      sourceId: createHash('sha256').update(`${refreshed.id}\0${projectRoot.rootId}\0${source.relativePath}`).digest('hex').slice(0, 40),
      rootId: projectRoot.rootId,
      artifactRootId: source.rootId,
      artifactId: artifact.id,
      relativePath: source.relativePath,
    }] : [] }))
    const connected = available.length
      ? await services.projects.syncArtifacts(
        { projectId: refreshed.id, expectedRevision: refreshed.revision, artifacts: sources },
        available.map((item) => item.rootId),
      )
      : refreshed
    return { project: { ...connected, folders: connected.folders.map((folder) => statuses.find((item) => item.rootId === folder.rootId) ?? folder) }, artifacts: imported.artifacts, failures: imported.failures, skippedCount: imported.skippedCount }
  }
  handle(IPC_CHANNELS.appStatus, async () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    dataStoreReady: true,
    llm: await services.llmConfig.summary()
  }))

  handle(IPC_CHANNELS.projectCreate, (_event, input) => services.projects.create(input as never))
  handle(IPC_CHANNELS.projectList, (_event, input) => services.projects.list((input as { includeArchived?: boolean } | undefined)?.includeArchived === true))
  handle(IPC_CHANNELS.projectGet, (_event, input) => services.projects.get((input as { projectId: string }).projectId))
  handle(IPC_CHANNELS.projectLoad, async (_event, input) => hydrateProject(await services.projects.load((input as { projectId: string }).projectId)))
  handle(IPC_CHANNELS.projectSave, (_event, input) => services.projects.save(input as never))
  handle(IPC_CHANNELS.projectArchive, (_event, input) => services.projects.archive(input as never))
  handle(IPC_CHANNELS.projectValidateFolders, (_event, input) => {
    const value = input as { projectId: string; rootIds?: string[] }
    return services.projects.validateFolders(value.projectId, value.rootIds)
  })
  handle(IPC_CHANNELS.projectAttachFolder, async (event, input) => {
    const value = input as { projectId: string; expectedRevision: number }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, { title: '프로젝트 로그 폴더 연결', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '프로젝트 로그 폴더 연결', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    const attached = await services.projects.attachFolder(value.projectId, value.expectedRevision, result.filePaths[0])
    return hydrateProject(attached)
  })
  handle(IPC_CHANNELS.projectDetachFolder, (_event, input) => {
    const value = input as { projectId: string; expectedRevision: number; rootId: string }
    return services.projects.detachFolder(value.projectId, value.expectedRevision, value.rootId)
  })
  handle(IPC_CHANNELS.projectConnectArtifacts, (_event, input) => services.projects.connectArtifacts(input as never))
  handle(IPC_CHANNELS.projectSaveExportPreset, (_event, input) => services.projects.saveExportPreset(input as never))
  handle(IPC_CHANNELS.projectArchiveExportPreset, (_event, input) => services.projects.archiveExportPreset(input as never))
  handle(IPC_CHANNELS.projectCreateSample, () => {
    if (!services.samples) throw new Error('샘플 프로젝트 서비스를 사용할 수 없습니다.')
    return services.samples.create()
  })

  handle(IPC_CHANNELS.artifactImportFiles, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      title: 'Sequence 또는 로그 파일 가져오기',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Sequence & Logs',
          extensions: ['seq', 'txt', 'log', 'cfg', 'conf', 'json', 'yaml', 'yml', 'xml', 'csv']
        },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) {
      return { cancelled: true, limitReached: false, artifacts: [], failures: [], skippedCount: 0 }
    }
    return services.artifacts.importFiles(result.filePaths)
  })

  handle(IPC_CHANNELS.artifactImportFolder, async (event, rawOptions) => {
    const importChannel = IPC_CHANNELS.artifactImportFolder
    if (activeArtifactFolderImports.has(importChannel)) {
      throw new Error(FOLDER_IMPORT_IN_PROGRESS_ERROR)
    }
    const lock = Symbol('artifact-folder-import')
    activeArtifactFolderImports.set(importChannel, lock)

    try {
      const options = (rawOptions ?? {}) as ArtifactImportOptions
      const owner = BrowserWindow.fromWebContents(event.sender)
      const pickerOptions: OpenDialogOptions = {
        title: '분석할 로그 폴더 선택',
        properties: ['openDirectory', 'multiSelections']
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions)
      if (result.canceled || !result.filePaths.length) {
        return { cancelled: true, limitReached: false, artifacts: [], failures: [], skippedCount: 0 }
      }
      return await services.artifacts.importFolders(result.filePaths, options)
    } finally {
      if (activeArtifactFolderImports.get(importChannel) === lock) {
        activeArtifactFolderImports.delete(importChannel)
      }
    }
  })

  handle(IPC_CHANNELS.artifactList, () => services.artifacts.list())
  handle(IPC_CHANNELS.artifactPreview, (_event, id, maxChars) =>
    services.artifacts.preview(String(id ?? ''), Number(maxChars) || undefined)
  )
  handle(IPC_CHANNELS.artifactSearch, async (event, input) => {
    const senderId = event.sender.id
    activeArtifactSearches.get(senderId)?.abort()
    const controller = new AbortController()
    activeArtifactSearches.set(senderId, controller)
    try {
      return await services.artifacts.search(input as ArtifactSearchInput, controller.signal)
    } finally {
      if (activeArtifactSearches.get(senderId) === controller) activeArtifactSearches.delete(senderId)
    }
  })
  handle(IPC_CHANNELS.artifactInspectEvidence, async (event, input) => {
    const senderId = event.sender.id
    activeArtifactEvidenceInspections.get(senderId)?.abort()
    const controller = new AbortController()
    activeArtifactEvidenceInspections.set(senderId, controller)
    try {
      return await services.artifacts.inspectEvidence(input as ArtifactEvidenceInput, controller.signal)
    } finally {
      if (activeArtifactEvidenceInspections.get(senderId) === controller) {
        activeArtifactEvidenceInspections.delete(senderId)
      }
    }
  })
  handle(IPC_CHANNELS.artifactInspectStages, async (event, input) => {
    const senderId = event.sender.id
    activeArtifactStageInspections.get(senderId)?.abort()
    const controller = new AbortController()
    activeArtifactStageInspections.set(senderId, controller)
    try {
      return await services.artifacts.inspectStages(input as import('../shared/contracts').ArtifactStageScanInput, controller.signal)
    } finally {
      if (activeArtifactStageInspections.get(senderId) === controller) activeArtifactStageInspections.delete(senderId)
    }
  })
  handle(IPC_CHANNELS.artifactInspectFailureAddresses, async (event, input) => {
    const senderId = event.sender.id
    activeArtifactFailureAddressInspections.get(senderId)?.abort()
    const controller = new AbortController()
    activeArtifactFailureAddressInspections.set(senderId, controller)
    try {
      return await services.artifacts.inspectFailureAddresses(input as ArtifactFailureAddressScanInput, controller.signal)
    } finally {
      if (activeArtifactFailureAddressInspections.get(senderId) === controller) activeArtifactFailureAddressInspections.delete(senderId)
    }
  })
  handle(IPC_CHANNELS.artifactLineWindow, (_event, input) =>
    services.artifacts.lineWindow(input as ArtifactLineWindowInput)
  )
  handle(IPC_CHANNELS.artifactSimilar, (_event, id, limit) =>
    services.artifacts.findSimilar(String(id ?? ''), Number(limit) || undefined)
  )

  handle(IPC_CHANNELS.evaluationBootstrap, (_event, input) =>
    services.evaluations.snapshot((input as EvaluationProjectRequest)?.projectId)
  )
  handle(IPC_CHANNELS.evaluationGetSnapshot, (_event, input) =>
    services.evaluations.snapshot((input as EvaluationProjectRequest)?.projectId)
  )
  handle(IPC_CHANNELS.evaluationSaveDecision, (_event, input) =>
    services.evaluations.saveDecision(input as EvaluationSaveDecisionInput)
  )
  handle(IPC_CHANNELS.evaluationSaveRecipe, (_event, input) =>
    services.evaluations.saveRecipe(input as EvaluationSaveRecipeInput)
  )
  handle(IPC_CHANNELS.evaluationArchiveRecipe, (_event, input) =>
    services.evaluations.archiveRecipe(input as EvaluationArchiveRecipeInput)
  )
  handle(IPC_CHANNELS.evaluationSaveBatch, (_event, input) =>
    services.evaluations.saveBatch(input as EvaluationSaveBatchInput)
  )
  handle(IPC_CHANNELS.evaluationSaveRecipeAndBatch, (_event, input) =>
    services.evaluations.saveRecipeAndBatch(input as EvaluationSaveRecipeAndBatchInput)
  )
  handle(IPC_CHANNELS.evaluationApproveMetadata, (_event, input) =>
    services.evaluations.approveMetadata(input as EvaluationApproveMetadataInput)
  )
  handle(IPC_CHANNELS.evaluationApproveMetadataBatch, (_event, input) =>
    services.evaluations.approveMetadataBatch(input as EvaluationApproveMetadataBatchInput)
  )

  handle(IPC_CHANNELS.analysisStart, (_event, input) =>
    services.analysis.start(input as StartAnalysisInput)
  )
  handle(IPC_CHANNELS.analysisGet, (_event, id) => services.analysis.get(String(id ?? '')))
  handle(IPC_CHANNELS.analysisCancel, (_event, id) => services.analysis.cancel(String(id ?? '')))

  handle(IPC_CHANNELS.agentStart, async (event, input) => {
    const run = await services.agent.start(input as never)
    if (event.sender.isDestroyed()) {
      void services.agent.cancel({ runId: run.id })
      return run
    }
    registerAgentOwner(event.sender, run.id)
    event.sender.send(IPC_CHANNELS.agentUpdate, run)
    return run
  })
  handle(IPC_CHANNELS.agentGet, (event, id) => {
    const runId = String(id ?? '')
    requireAgentOwner(event, runId)
    return services.agent.get(runId)
  })
  handle(IPC_CHANNELS.agentAnswer, (event, input) => {
    const value = input as { runId: string }
    requireAgentOwner(event, value.runId)
    return services.agent.answer(input as never)
  })
  handle(IPC_CHANNELS.agentMessage, (event, input) => {
    const value = input as { runId: string }
    requireAgentOwner(event, value.runId)
    return services.agent.message(input as never)
  })
  handle(IPC_CHANNELS.agentConfirm, (event, input) => {
    const value = input as { runId: string }
    requireAgentOwner(event, value.runId)
    return services.agent.confirm(input as never)
  })
  handle(IPC_CHANNELS.agentCancel, (event, input) => {
    const value = input as { runId: string }
    requireAgentOwner(event, value.runId)
    return services.agent.cancel(input as never)
  })

  handle(IPC_CHANNELS.evaluationAgentStart, async (event, input) => {
    const session = await evaluationAgent().start(input as EvaluationAgentStartRequest)
    if (event.sender.isDestroyed()) return evaluationAgentView(session)
    registerEvaluationAgentOwner(event.sender, session.id)
    return evaluationAgentView(session)
  })
  handle(IPC_CHANNELS.evaluationAgentRestore, async (event, input) => {
    const value = input as EvaluationAgentRestoreRequest
    const session = await evaluationAgent().restoreLatest(value.projectId, value.evaluationScopeId)
    if (!session || event.sender.isDestroyed()) return session ? evaluationAgentView(session) : null
    registerEvaluationAgentOwner(event.sender, session.id)
    return evaluationAgentView(session)
  })
  handle(IPC_CHANNELS.evaluationAgentGet, (event, id) => {
    const sessionId = String(id ?? ''); requireEvaluationAgentOwner(event, sessionId)
    const session = evaluationAgent().get(sessionId); return session ? evaluationAgentView(session) : null
  })
  handle(IPC_CHANNELS.evaluationAgentResume, async (event, input) => {
    const value = input as EvaluationAgentResumeRequest; requireEvaluationAgentOwner(event, value.sessionId)
    return evaluationAgentView(await evaluationAgent().resume(value.sessionId, { answer: value.answer, confirm: value.confirm }))
  })
  handle(IPC_CHANNELS.evaluationAgentMemorySavePayload, (event, input) => {
    const value = input as EvaluationAgentMemoryPayloadRequest; requireEvaluationAgentOwner(event, value.sessionId)
    const prefix = safeAgentText(value.evidenceIdPrefix, 120); if (!prefix) throw new Error('invalid evidence ID prefix')
    const payload = evaluationAgent().memorySavePayload(value.sessionId, { projectId: value.projectId, hypothesisId: value.hypothesisId, nodeId: value.nodeId, evidenceId: (id) => `${prefix}-${safeAgentText(id, 120)}` })
    return payload ? evaluationMemoryView(payload) : null
  })

  handle(IPC_CHANNELS.nativeAgentBackendStatus, () => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.backendStatus()
  })
  handle(IPC_CHANNELS.nativeAgentCreate, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    const value = input as NativeAgentCreateRequest
    return services.nativeAgent.create(value.projectId, value.title, value.evaluationScopeId, value.sourceIds)
  })
  handle(IPC_CHANNELS.nativeAgentList, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    const value = input as NativeAgentListRequest
    return services.nativeAgent.list(value.projectId, value.evaluationScopeId)
  })
  handle(IPC_CHANNELS.nativeAgentGet, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.get((input as NativeAgentGetRequest).sessionId)
  })
  handle(IPC_CHANNELS.nativeAgentSend, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    const value = input as NativeAgentSendRequest
    return services.nativeAgent.send(value.sessionId, value.content, value.sourceIds, value.contextKind)
  })
  handle(IPC_CHANNELS.nativeAgentRetry, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.retry((input as NativeAgentRetryRequest).sessionId)
  })
  handle(IPC_CHANNELS.nativeAgentCancel, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.cancel((input as NativeAgentCancelRequest).sessionId)
  })
  handle(IPC_CHANNELS.nativeAgentRecordSearch, (_event, input) => {
    if (!services.nativeAgent) return
    return services.nativeAgent.recordSearch(input as NativeAgentSearchEventInput)
  })
  handle(IPC_CHANNELS.nativeAgentCompleteEvaluation, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.completeEvaluation(input as NativeAgentCompleteEvaluationInput)
  })
  handle(IPC_CHANNELS.nativeAgentConfirmWorkflow, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.confirmWorkflow(input as NativeAgentConfirmWorkflowInput)
  })
  handle(IPC_CHANNELS.nativeAgentDismissWorkflow, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.dismissWorkflow(input as NativeAgentDismissWorkflowInput)
  })
  handle(IPC_CHANNELS.nativeAgentListWorkflows, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.listWorkflows((input as NativeAgentListWorkflowsInput).projectId)
  })
  handle(IPC_CHANNELS.nativeAgentReuseKnowledge, (_event, input) => {
    if (!services.nativeAgent) throw new Error('Native Agent를 사용할 수 없습니다.')
    return services.nativeAgent.reuseConfirmedKnowledge(input as NativeAgentReuseKnowledgeInput)
  })

  handle(IPC_CHANNELS.settingsGetLlm, () => services.llmConfig.summary())
  handle(IPC_CHANNELS.settingsSaveLlm, (_event, input) =>
    services.llmConfig.save(input as LlmConfigInput)
  )
  handle(IPC_CHANNELS.settingsDiscoverModels, (_event, input) =>
    services.llmConfig.discoverModels((input ?? {}) as LlmModelDiscoveryInput)
  )

  handle(IPC_CHANNELS.wikiSave, (_event, input) => services.wiki.save(input as WikiEntryInput))
  handle(IPC_CHANNELS.wikiList, () => services.wiki.list())
  handle(IPC_CHANNELS.wikiExport, async (event, id) => {
    const source = await services.wiki.source(String(id ?? ''))
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: SaveDialogOptions = {
      title: 'Obsidian Markdown 내보내기',
      defaultPath: source.suggestedName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    await writeFile(result.filePath, source.markdown, { encoding: 'utf8' })
    return { cancelled: false, fileName: source.suggestedName }
  })
}

export function unregisterIpc(): void {
  agentUpdateUnsubscribe?.()
  agentUpdateUnsubscribe = null
  registeredAgent?.cancelAll()
  registeredAgent = null
  nativeAgentUpdateUnsubscribe?.()
  nativeAgentUpdateUnsubscribe = null
  agentSenderCleanup.forEach((cleanup, senderId) => {
    agentSenders.get(senderId)?.removeListener('destroyed', cleanup)
  })
  agentSenderCleanup.clear()
  agentSenders.clear()
  agentRunsBySender.clear()
  agentOwners.clear()
  evaluationAgentSenderCleanup.forEach((cleanup, senderId) => evaluationAgentSenders.get(senderId)?.removeListener('destroyed', cleanup))
  evaluationAgentSenderCleanup.clear(); evaluationAgentSenders.clear(); evaluationAgentSessionsBySender.clear(); evaluationAgentOwners.clear()
  activeArtifactSearches.forEach((controller) => controller.abort())
  activeArtifactSearches.clear()
  activeArtifactEvidenceInspections.forEach((controller) => controller.abort())
  activeArtifactEvidenceInspections.clear()
  activeArtifactStageInspections.forEach((controller) => controller.abort())
  activeArtifactStageInspections.clear()
  activeArtifactFailureAddressInspections.forEach((controller) => controller.abort())
  activeArtifactFailureAddressInspections.clear()
  Object.values(IPC_CHANNELS).forEach((channel) => {
    if (channel !== IPC_CHANNELS.analysisUpdate && channel !== IPC_CHANNELS.agentUpdate && channel !== IPC_CHANNELS.nativeAgentUpdate && channel !== IPC_CHANNELS.appCommand) {
      ipcMain.removeHandler(channel)
    }
  })
}
