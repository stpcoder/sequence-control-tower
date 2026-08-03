import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalysisJobSnapshot,
  ArtifactImportOptions,
  ArtifactLineWindowInput,
  ArtifactSearchInput,
  LlmConfigInput,
  LlmModelDiscoveryInput,
  RendererCommand,
  SequenceIntelligenceApi,
  StartAnalysisInput,
  WikiEntryInput
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'

const api: SequenceIntelligenceApi = {
  app: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.appStatus),
    onCommand: (listener: (command: RendererCommand) => void) => {
      const allowed = new Set<RendererCommand>(['open-logs', 'find', 'find-workspace', 'preferences'])
      const handler = (_event: Electron.IpcRendererEvent, command: RendererCommand): void => {
        if (allowed.has(command)) listener(command)
      }
      ipcRenderer.on(IPC_CHANNELS.appCommand, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.appCommand, handler)
    }
  },
  artifacts: {
    importFiles: () => ipcRenderer.invoke(IPC_CHANNELS.artifactImportFiles),
    importFolder: (options?: ArtifactImportOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactImportFolder, options),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.artifactList),
    getTextPreview: (artifactId: string, maxChars?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactPreview, artifactId, maxChars),
    search: (input: ArtifactSearchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactSearch, input),
    getLineWindow: (input: ArtifactLineWindowInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactLineWindow, input),
    findSimilar: (artifactId: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactSimilar, artifactId, limit)
  },
  analysis: {
    start: (input: StartAnalysisInput) => ipcRenderer.invoke(IPC_CHANNELS.analysisStart, input),
    get: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.analysisGet, jobId),
    cancel: (jobId: string) => ipcRenderer.invoke(IPC_CHANNELS.analysisCancel, jobId),
    onJobUpdate: (listener: (job: AnalysisJobSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, job: AnalysisJobSnapshot): void => listener(job)
      ipcRenderer.on(IPC_CHANNELS.analysisUpdate, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.analysisUpdate, handler)
    }
  },
  settings: {
    getLlm: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGetLlm),
    saveLlm: (input: LlmConfigInput) => ipcRenderer.invoke(IPC_CHANNELS.settingsSaveLlm, input),
    discoverModels: (input?: LlmModelDiscoveryInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsDiscoverModels, input)
  },
  wiki: {
    save: (input: WikiEntryInput) => ipcRenderer.invoke(IPC_CHANNELS.wikiSave, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.wikiList),
    export: (entryId: string) => ipcRenderer.invoke(IPC_CHANNELS.wikiExport, entryId)
  }
}

contextBridge.exposeInMainWorld('sequenceIntelligence', Object.freeze(api))
