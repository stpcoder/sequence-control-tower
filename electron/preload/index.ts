import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalysisJobSnapshot,
  ArtifactImportOptions,
  LlmConfigInput,
  SequenceIntelligenceApi,
  StartAnalysisInput,
  WikiEntryInput
} from '../shared/contracts'
import { IPC_CHANNELS } from '../shared/contracts'

const api: SequenceIntelligenceApi = {
  app: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.appStatus)
  },
  artifacts: {
    importFiles: () => ipcRenderer.invoke(IPC_CHANNELS.artifactImportFiles),
    importFolder: (options?: ArtifactImportOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactImportFolder, options),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.artifactList),
    getTextPreview: (artifactId: string, maxChars?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactPreview, artifactId, maxChars),
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
    saveLlm: (input: LlmConfigInput) => ipcRenderer.invoke(IPC_CHANNELS.settingsSaveLlm, input)
  },
  wiki: {
    save: (input: WikiEntryInput) => ipcRenderer.invoke(IPC_CHANNELS.wikiSave, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.wikiList),
    export: (entryId: string) => ipcRenderer.invoke(IPC_CHANNELS.wikiExport, entryId)
  }
}

contextBridge.exposeInMainWorld('sequenceIntelligence', Object.freeze(api))
