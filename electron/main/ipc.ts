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
  ArtifactLineWindowInput,
  ArtifactSearchInput,
  EvaluationArchiveRecipeInput,
  EvaluationApproveMetadataInput,
  EvaluationProjectRequest,
  EvaluationSaveBatchInput,
  EvaluationSaveDecisionInput,
  EvaluationSaveRecipeInput,
  EvaluationSaveRecipeAndBatchInput,
  LlmConfigInput,
  LlmModelDiscoveryInput,
  StartAnalysisInput,
  WikiEntryInput
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import { AnalysisService } from './analysis-service'
import { ArtifactService } from './artifact-service'
import { EvaluationStore } from './evaluation-store'
import { LlmConfigService } from './llm-service'
import { isSameRendererDocument } from './renderer-document'
import { WikiService } from './wiki-service'
import { ProjectStore } from './project-store'
import { AgentService } from './agent-service'
import { createHash } from 'node:crypto'
import type { ProjectLoadResult, ProjectSnapshot } from '../shared/contracts'

interface Services {
  artifacts: ArtifactService
  evaluations: EvaluationStore
  analysis: AnalysisService
  llmConfig: LlmConfigService
  wiki: WikiService
  projects: ProjectStore
  agent: AgentService
}

const packagedRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
const activeArtifactSearches = new Map<number, AbortController>()
const activeArtifactEvidenceInspections = new Map<number, AbortController>()
const activeArtifactFolderImports = new Map<string, symbol>()
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

export function registerIpc(services: Services): void {
  const hydrateProject = async (project: ProjectSnapshot | null): Promise<ProjectLoadResult | null> => {
    if (!project) return null
    const statuses = await services.projects.validateFolders(project.id)
    const refreshed = await services.projects.get(project.id)
    if (!refreshed) return null
    const available = await services.projects.availableFolderPaths(project.id)
    const imported = available.length ? await services.artifacts.importFolders(available.map((item) => item.path), { maxFiles: 10000 }) : { artifacts: [], failures: [], skippedCount: 0 }
    const rootIds = new Set(available.map((item) => item.rootId))
    const sources = imported.artifacts.flatMap((artifact) => (artifact.sources ?? []).filter((source) => rootIds.has(source.rootId)).map((source) => ({
      sourceId: createHash('sha256').update(`${refreshed.id}\0${source.rootId}\0${source.relativePath}`).digest('hex').slice(0, 40),
      rootId: source.rootId,
      artifactId: artifact.id,
      relativePath: source.relativePath,
    })))
    const connected = sources.length ? await services.projects.connectArtifacts({ projectId: refreshed.id, expectedRevision: refreshed.revision, artifacts: sources }) : refreshed
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

  handle(IPC_CHANNELS.analysisStart, (_event, input) =>
    services.analysis.start(input as StartAnalysisInput)
  )
  handle(IPC_CHANNELS.analysisGet, (_event, id) => services.analysis.get(String(id ?? '')))
  handle(IPC_CHANNELS.analysisCancel, (_event, id) => services.analysis.cancel(String(id ?? '')))

  handle(IPC_CHANNELS.agentStart, (_event, input) => services.agent.start(input as never))
  handle(IPC_CHANNELS.agentGet, (_event, id) => services.agent.get(String(id ?? '')))
  handle(IPC_CHANNELS.agentAnswer, (_event, input) => services.agent.answer(input as never))
  handle(IPC_CHANNELS.agentMessage, (_event, input) => services.agent.message(input as never))
  handle(IPC_CHANNELS.agentConfirm, (_event, input) => services.agent.confirm(input as never))
  handle(IPC_CHANNELS.agentCancel, (_event, input) => services.agent.cancel(input as never))

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
  activeArtifactSearches.forEach((controller) => controller.abort())
  activeArtifactSearches.clear()
  activeArtifactEvidenceInspections.forEach((controller) => controller.abort())
  activeArtifactEvidenceInspections.clear()
  Object.values(IPC_CHANNELS).forEach((channel) => {
    if (channel !== IPC_CHANNELS.analysisUpdate && channel !== IPC_CHANNELS.agentUpdate && channel !== IPC_CHANNELS.appCommand) {
      ipcMain.removeHandler(channel)
    }
  })
}
