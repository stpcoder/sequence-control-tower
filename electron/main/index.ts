import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AnalysisService } from './analysis-service'
import { AgentService } from './agent-service'
import { EvaluationAgentService } from './evaluation-agent-service'
import { EvaluationAgentSessionStore } from './evaluation-agent-session-store'
import { buildMacMenuTemplate, rendererCommandForDesktopShortcut } from './app-menu'
import { ArtifactService } from './artifact-service'
import { EvaluationStore } from './evaluation-store'
import { registerIpc, unregisterIpc } from './ipc'
import { LlmConfigService, OpenAiCompatibleClient } from './llm-service'
import { WikiService } from './wiki-service'
import { ProjectStore } from './project-store'
import { NativeAgentStore } from './native-agent-store'
import { LpddrAgentToolService } from './lpddr-agent-tools'
import { startSctMcpServer, type SctMcpServerHandle } from './sct-mcp-server'
import { OpenCodeHost } from './opencode-host'
import { NativeAgentService } from './native-agent-service'
import { SampleProjectService } from './sample-project-service'
import { isSameRendererDocument } from './renderer-document'
import { IPC_CHANNELS } from '../shared/contracts'
import type { RendererCommand } from '../shared/contracts'

let mainWindow: BrowserWindow | null = null
let nativeAgentForShutdown: NativeAgentService | null = null
let mcpForShutdown: SctMcpServerHandle | null = null
const packagedRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href

function allowedNavigation(target: string): boolean {
  const expectedRendererUrl = app.isPackaged
    ? packagedRendererUrl
    : process.env.ELECTRON_RENDERER_URL || packagedRendererUrl
  return isSameRendererDocument(target, expectedRendererUrl)
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    title: 'Sequence Control Tower',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    if (!allowedNavigation(target)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  if (process.platform !== 'darwin') {
    window.webContents.on('before-input-event', (event, input) => {
      const command = rendererCommandForDesktopShortcut(input)
      if (!command) return
      event.preventDefault()
      sendRendererCommand(command)
    })
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function openMainWindow(): BrowserWindow {
  const window = createWindow()
  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  return window
}

function sendRendererCommand(command: RendererCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return
  const deliver = (): void => {
    if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
      target.webContents.send(IPC_CHANNELS.appCommand, command)
    }
  }
  if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', deliver)
  else deliver()
}

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    // Preserve the existing Windows application chrome and shortcut behavior.
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacMenuTemplate({
    appName: app.name || 'Sequence Control Tower',
    development: !app.isPackaged,
    sendCommand: sendRendererCommand
  })))
}

async function bootstrap(): Promise<void> {
  const dataRoot = join(app.getPath('userData'), 'sequence-intelligence')
  const artifacts = new ArtifactService(dataRoot)
  const evaluations = new EvaluationStore(dataRoot)
  const projects = new ProjectStore(dataRoot)
  const llmConfig = new LlmConfigService(dataRoot)
  const llm = new OpenAiCompatibleClient(llmConfig)
  const wiki = new WikiService(dataRoot, artifacts)
  const analysis = new AnalysisService(dataRoot, artifacts, llmConfig, llm, (job) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.analysisUpdate, job)
    })
  })
  const agent = new AgentService({ artifacts, evaluations, projects, llm, llmConfig })
  const evaluationAgentSessions = new EvaluationAgentSessionStore(dataRoot)
  const evaluationAgent = new EvaluationAgentService({ artifacts, projects, llm, sessions: evaluationAgentSessions })
  const nativeAgentStore = new NativeAgentStore(dataRoot)
  await Promise.all([
    artifacts.initialize(),
    evaluations.initialize(),
    projects.initialize(),
    llmConfig.initialize(),
    wiki.initialize(),
    analysis.initialize(),
    evaluationAgentSessions.initialize(),
    nativeAgentStore.initialize()
  ])
  const nativeTools = new LpddrAgentToolService({ artifacts, projects, agentStore: nativeAgentStore })
  const mcp = await startSctMcpServer(nativeTools)
  const skillRoot = app.isPackaged ? join(process.resourcesPath, 'agent-skills') : join(app.getAppPath(), 'agent-skills')
  const opencode = new OpenCodeHost({ dataRoot, skillRoot, mcpUrl: mcp.url, mcpToken: mcp.token, effectiveLlm: () => llmConfig.effective() })
  const nativeAgent = new NativeAgentService({ store: nativeAgentStore, tools: nativeTools, projects, artifacts, llm, opencode })
  const samples = new SampleProjectService(dataRoot, { artifacts, projects })
  nativeAgentForShutdown = nativeAgent
  mcpForShutdown = mcp
  registerIpc({ artifacts, evaluations, analysis, llmConfig, wiki, projects, agent, evaluationAgent, nativeAgent, samples })

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'"
          ]
        }
      })
    })
  }
  openMainWindow()
  installApplicationMenu()
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.sequence-intelligence.control-tower')
      await bootstrap()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
      })
    })
    .catch((error) => {
      // Keep the native dialog concise while retaining a useful diagnostic in
      // terminal and CI logs for packaged-startup failures.
      console.error('Sequence Control Tower bootstrap failed', error)
      dialog.showErrorBox(
        'Sequence Control Tower',
        '로컬 데이터 저장소를 초기화하지 못했습니다. 디스크 공간과 사용자 권한을 확인해 주세요.'
      )
      app.quit()
    })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  nativeAgentForShutdown?.close()
  void mcpForShutdown?.close()
  unregisterIpc()
})
