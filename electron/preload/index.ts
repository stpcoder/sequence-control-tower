import { contextBridge, ipcRenderer } from 'electron'
import type {
  AnalysisJobSnapshot,
  AgentAnswerInput,
  AgentConfirmInput,
  AgentMessageInput,
  AgentRun,
  AgentStartInput,
  AgentConfirmResult,
  ArtifactEvidenceInput,
  ArtifactImportOptions,
  ArtifactLineWindowInput,
  ArtifactSearchInput,
  ArtifactStageScanInput,
  EvaluationApproveMetadataInput,
  EvaluationArchiveRecipeInput,
  EvaluationProjectRequest,
  EvaluationSaveBatchInput,
  EvaluationSaveDecisionInput,
  EvaluationSaveRecipeInput,
  EvaluationSaveRecipeAndBatchInput,
  EvaluationAgentStartRequest,
  EvaluationAgentResumeRequest,
  EvaluationAgentMemoryPayloadRequest,
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
  NativeAgentSessionView,
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
    inspectEvidence: (input: ArtifactEvidenceInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactInspectEvidence, input),
    inspectStages: (input: ArtifactStageScanInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.artifactInspectStages, input),
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
  agent: {
    start: (input: AgentStartInput) => ipcRenderer.invoke(IPC_CHANNELS.agentStart, input),
    get: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.agentGet, runId),
    answer: (input: AgentAnswerInput) => ipcRenderer.invoke(IPC_CHANNELS.agentAnswer, input),
    message: (input: AgentMessageInput) => ipcRenderer.invoke(IPC_CHANNELS.agentMessage, input),
    confirm: (input: AgentConfirmInput) => ipcRenderer.invoke(IPC_CHANNELS.agentConfirm, input),
    cancel: (input: { runId: string }) => ipcRenderer.invoke(IPC_CHANNELS.agentCancel, input),
    onRunUpdate: (listener: (run: AgentRun) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, run: AgentRun): void => listener(run)
      ipcRenderer.on(IPC_CHANNELS.agentUpdate, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentUpdate, handler)
    }
  },
  evaluationAgent: {
    start: (input: EvaluationAgentStartRequest) => ipcRenderer.invoke(IPC_CHANNELS.evaluationAgentStart, input),
    get: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.evaluationAgentGet, sessionId),
    resume: (input: EvaluationAgentResumeRequest) => ipcRenderer.invoke(IPC_CHANNELS.evaluationAgentResume, input),
    memorySavePayload: (input: EvaluationAgentMemoryPayloadRequest) => ipcRenderer.invoke(IPC_CHANNELS.evaluationAgentMemorySavePayload, input)
  },
  nativeAgent: {
    backendStatus: () => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentBackendStatus),
    create: (input: NativeAgentCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentCreate, input),
    list: (input: NativeAgentListRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentList, input),
    get: (input: NativeAgentGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentGet, input),
    send: (input: NativeAgentSendRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentSend, input),
    retry: (input: NativeAgentRetryRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentRetry, input),
    cancel: (input: NativeAgentCancelRequest) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentCancel, input),
    recordSearch: (input: NativeAgentSearchEventInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentRecordSearch, input),
    completeEvaluation: (input: NativeAgentCompleteEvaluationInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentCompleteEvaluation, input),
    confirmWorkflow: (input: NativeAgentConfirmWorkflowInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentConfirmWorkflow, input),
    dismissWorkflow: (input: NativeAgentDismissWorkflowInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentDismissWorkflow, input),
    listWorkflows: (input: NativeAgentListWorkflowsInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentListWorkflows, input),
    reuseConfirmedKnowledge: (input: NativeAgentReuseKnowledgeInput) => ipcRenderer.invoke(IPC_CHANNELS.nativeAgentReuseKnowledge, input),
    onUpdate: (listener: (session: NativeAgentSessionView) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, session: NativeAgentSessionView): void => listener(session)
      ipcRenderer.on(IPC_CHANNELS.nativeAgentUpdate, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.nativeAgentUpdate, handler)
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
  },
  evaluations: {
    bootstrap: (input: EvaluationProjectRequest) => ipcRenderer.invoke(IPC_CHANNELS.evaluationBootstrap, input),
    getSnapshot: (input: EvaluationProjectRequest) => ipcRenderer.invoke(IPC_CHANNELS.evaluationGetSnapshot, input),
    saveDecision: (input: EvaluationSaveDecisionInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationSaveDecision, input),
    saveRecipe: (input: EvaluationSaveRecipeInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationSaveRecipe, input),
    archiveRecipe: (input: EvaluationArchiveRecipeInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationArchiveRecipe, input),
    saveBatch: (input: EvaluationSaveBatchInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationSaveBatch, input),
    saveRecipeAndBatch: (input: EvaluationSaveRecipeAndBatchInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationSaveRecipeAndBatch, input),
    approveMetadata: (input: EvaluationApproveMetadataInput) => ipcRenderer.invoke(IPC_CHANNELS.evaluationApproveMetadata, input)
  },
  projects: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreate, input),
    list: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectList, input),
    get: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectGet, input),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectSave, input),
    archive: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectArchive, input),
    load: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectLoad, input),
    attachFolder: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectAttachFolder, input),
    detachFolder: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectDetachFolder, input),
    validateFolders: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectValidateFolders, input),
    connectArtifacts: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectConnectArtifacts, input),
    saveExportPreset: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectSaveExportPreset, input),
    archiveExportPreset: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectArchiveExportPreset, input),
    createSample: () => ipcRenderer.invoke(IPC_CHANNELS.projectCreateSample)
  }
}

contextBridge.exposeInMainWorld('sequenceIntelligence', Object.freeze(api))
