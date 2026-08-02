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
  ArtifactLineWindowInput,
  ArtifactSearchInput,
  LlmConfigInput,
  LlmModelDiscoveryInput,
  StartAnalysisInput,
  WikiEntryInput
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'
import { AnalysisService } from './analysis-service'
import { ArtifactService } from './artifact-service'
import { LlmConfigService } from './llm-service'
import { WikiService } from './wiki-service'

interface Services {
  artifacts: ArtifactService
  analysis: AnalysisService
  llmConfig: LlmConfigService
  wiki: WikiService
}

const packagedRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href

function isExactPackagedRenderer(frameUrl: string): boolean {
  try {
    const actual = new URL(frameUrl)
    const expected = new URL(packagedRendererUrl)
    // Hash navigation remains inside the same immutable renderer document.
    actual.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url
  if (!frameUrl) return false
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false
  if (app.isPackaged) return isExactPackagedRenderer(frameUrl)
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (!rendererUrl) return frameUrl.startsWith('file://')
  try {
    return new URL(frameUrl).origin === new URL(rendererUrl).origin
  } catch {
    return false
  }
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
  handle(IPC_CHANNELS.appStatus, async () => ({
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    dataStoreReady: true,
    llm: await services.llmConfig.summary()
  }))

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
      return { cancelled: true, artifacts: [], failures: [], skippedCount: 0 }
    }
    return services.artifacts.importFiles(result.filePaths)
  })

  handle(IPC_CHANNELS.artifactImportFolder, async (event, rawOptions) => {
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
      return { cancelled: true, artifacts: [], failures: [], skippedCount: 0 }
    }
    return services.artifacts.importFolders(result.filePaths, options)
  })

  handle(IPC_CHANNELS.artifactList, () => services.artifacts.list())
  handle(IPC_CHANNELS.artifactPreview, (_event, id, maxChars) =>
    services.artifacts.preview(String(id ?? ''), Number(maxChars) || undefined)
  )
  handle(IPC_CHANNELS.artifactSearch, (_event, input) =>
    services.artifacts.search(input as ArtifactSearchInput)
  )
  handle(IPC_CHANNELS.artifactLineWindow, (_event, input) =>
    services.artifacts.lineWindow(input as ArtifactLineWindowInput)
  )
  handle(IPC_CHANNELS.artifactSimilar, (_event, id, limit) =>
    services.artifacts.findSimilar(String(id ?? ''), Number(limit) || undefined)
  )

  handle(IPC_CHANNELS.analysisStart, (_event, input) =>
    services.analysis.start(input as StartAnalysisInput)
  )
  handle(IPC_CHANNELS.analysisGet, (_event, id) => services.analysis.get(String(id ?? '')))
  handle(IPC_CHANNELS.analysisCancel, (_event, id) => services.analysis.cancel(String(id ?? '')))

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
  Object.values(IPC_CHANNELS).forEach((channel) => {
    if (channel !== IPC_CHANNELS.analysisUpdate) ipcMain.removeHandler(channel)
  })
}
