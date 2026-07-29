/**
 * The renderer's complete privileged surface.
 *
 * Keep this file dependency-free: both Electron's main process and the
 * sandboxed preload import it. The renderer must never receive filesystem
 * paths for the content-addressed store or a stored LLM API key.
 */

export type KnowledgeState = 'extracted' | 'inferred' | 'verified' | 'unknown'

export interface SequenceFact {
  key: string
  label: string
  value: string
  evidence?: string
  line?: number
  confidence: number
  state: Extract<KnowledgeState, 'extracted'>
}

export interface SequenceFingerprint {
  parserVersion: string
  lineCount: number
  blockCount: number
  commandCount: number
  commandTokens: string[]
  structuralHash: string
  facts: SequenceFact[]
}

export interface ArtifactRecord {
  id: string
  sha256: string
  size: number
  extension: string
  originalNames: string[]
  importedAt: string
  lastSeenAt: string
  importCount: number
  fingerprint?: SequenceFingerprint
}

export interface ArtifactImportOptions {
  /** Folder imports use this allow-list. A leading dot is optional. */
  extensions?: string[]
  /** Defaults to 5,000. Hard-capped in main. */
  maxFiles?: number
}

export interface ArtifactImportFailure {
  name: string
  reason: string
}

export interface ArtifactImportResult {
  cancelled: boolean
  artifacts: ArtifactRecord[]
  failures: ArtifactImportFailure[]
  skippedCount: number
}

export interface ArtifactTextPreview {
  artifactId: string
  text: string
  truncated: boolean
  totalBytes: number
  encoding: 'utf-8'
}

export interface SimilarArtifact {
  artifact: ArtifactRecord
  score: number
  reasons: string[]
}

export type SemanticChangeKind = 'added' | 'removed' | 'changed'

export interface SemanticChange {
  kind: SemanticChangeKind
  key: string
  label: string
  before?: string
  after?: string
  significance: 'high' | 'medium' | 'low'
}

export interface AnalysisInference {
  title: string
  detail: string
  confidence: number
  evidenceFactKeys: string[]
  state: Extract<KnowledgeState, 'inferred'>
}

export interface ClarifyingQuestion {
  id: string
  question: string
  why: string
  choices?: string[]
}

export interface AnalysisResult {
  artifactId: string
  parentArtifactId?: string
  generatedAt: string
  parserVersion: string
  source: 'llm' | 'deterministic-fallback'
  model?: string
  cached: boolean
  summary: string
  facts: SequenceFact[]
  changes: SemanticChange[]
  inferences: AnalysisInference[]
  questions: ClarifyingQuestion[]
  suggestedTags: string[]
  warnings: string[]
}

export interface StartAnalysisInput {
  artifactId: string
  parentArtifactId?: string
  /** A short human hint, not a form that must be completed. */
  userComment?: string
  projectContext?: string
}

export type AnalysisJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AnalysisJobSnapshot {
  id: string
  status: AnalysisJobStatus
  stage: string
  queuePosition: number
  createdAt: string
  updatedAt: string
  result?: AnalysisResult
  error?: string
}

export interface LlmConfigInput {
  baseUrl: string
  model: string
  /** Omit to retain the existing key. It is never returned to the renderer. */
  apiKey?: string
  clearApiKey?: boolean
}

export interface LlmConfigSummary {
  baseUrl: string
  model: string
  configured: boolean
  apiKeyConfigured: boolean
  apiKeyPersisted: boolean
  source: 'environment' | 'saved' | 'mixed' | 'none'
  managedByEnvironment: {
    baseUrl: boolean
    model: boolean
    apiKey: boolean
  }
  limits: {
    requestsPerMinute: number
    tokensPerMinute: number
    timeoutMs: number
  }
}

export interface WikiEntryInput {
  artifactId: string
  parentArtifactId?: string
  project: string
  title: string
  purpose?: string
  userComment?: string
  status: KnowledgeState
  tags?: string[]
  analysis?: AnalysisResult
  engineerDecision?: string
}

export interface WikiEntryRecord {
  id: string
  artifactId: string
  title: string
  project: string
  status: KnowledgeState
  relativeFileName: string
  createdAt: string
  updatedAt: string
}

export interface WikiExportResult {
  cancelled: boolean
  fileName?: string
}

export interface AppStatus {
  version: string
  platform: NodeJS.Platform
  packaged: boolean
  dataStoreReady: boolean
  llm: LlmConfigSummary
}

/** This is the only API exposed by contextBridge. */
export interface SequenceIntelligenceApi {
  app: {
    getStatus(): Promise<AppStatus>
  }
  artifacts: {
    importFiles(): Promise<ArtifactImportResult>
    importFolder(options?: ArtifactImportOptions): Promise<ArtifactImportResult>
    list(): Promise<ArtifactRecord[]>
    getTextPreview(artifactId: string, maxChars?: number): Promise<ArtifactTextPreview>
    findSimilar(artifactId: string, limit?: number): Promise<SimilarArtifact[]>
  }
  analysis: {
    start(input: StartAnalysisInput): Promise<AnalysisJobSnapshot>
    get(jobId: string): Promise<AnalysisJobSnapshot | null>
    cancel(jobId: string): Promise<boolean>
    onJobUpdate(listener: (job: AnalysisJobSnapshot) => void): () => void
  }
  settings: {
    getLlm(): Promise<LlmConfigSummary>
    saveLlm(input: LlmConfigInput): Promise<LlmConfigSummary>
  }
  wiki: {
    save(input: WikiEntryInput): Promise<WikiEntryRecord>
    list(): Promise<WikiEntryRecord[]>
    export(entryId: string): Promise<WikiExportResult>
  }
}

export const IPC_CHANNELS = {
  appStatus: 'app:status',
  artifactImportFiles: 'artifact:import-files',
  artifactImportFolder: 'artifact:import-folder',
  artifactList: 'artifact:list',
  artifactPreview: 'artifact:preview',
  artifactSimilar: 'artifact:similar',
  analysisStart: 'analysis:start',
  analysisGet: 'analysis:get',
  analysisCancel: 'analysis:cancel',
  analysisUpdate: 'analysis:update',
  settingsGetLlm: 'settings:get-llm',
  settingsSaveLlm: 'settings:save-llm',
  wikiSave: 'wiki:save',
  wikiList: 'wiki:list',
  wikiExport: 'wiki:export'
} as const
