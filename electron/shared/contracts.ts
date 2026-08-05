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
  /** Safe, display-only locations. Absolute source and object-store paths never leave main. */
  sources?: ArtifactSourceLocation[]
  fingerprint?: SequenceFingerprint
}

export interface ArtifactSourceLocation {
  /** Stable opaque identity for the selected root; never contains the root path. */
  rootId: string
  /** The selected folder's basename, stripped of control characters. */
  folderLabel: string
  /** POSIX-style path relative to that selected folder. */
  relativePath: string
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
  /** True when the bounded folder intake stopped before scanning all candidates. */
  limitReached: boolean
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

export type ArtifactSearchMode = 'literal' | 'regex'

export interface ArtifactSearchInput {
  artifactIds: string[]
  query: string
  mode?: ArtifactSearchMode
  caseSensitive?: boolean
  /** Number of detailed matches returned. Counts continue after this cap. */
  maxMatches?: number
  /** Context lines included before and after each returned match. */
  contextLines?: number
}

export interface ArtifactSearchMatch {
  artifactId: string
  fileName: string
  lineNumber: number
  /** One-based UTF-16 columns, matching the desktop editor. */
  columnStart: number
  columnEnd: number
  lineText: string
  lineTruncated: boolean
  before: string[]
  after: string[]
}

export interface ArtifactSearchFileResult {
  artifactId: string
  fileName: string
  matchCount: number
  searchedLineCount: number
  error?: string
}

export interface ArtifactSearchResult {
  query: string
  mode: ArtifactSearchMode
  caseSensitive: boolean
  matches: ArtifactSearchMatch[]
  totalMatchCount: number
  truncated: boolean
  files: ArtifactSearchFileResult[]
}

/**
 * A stable source row for recipe inspection. Multiple physical log files may
 * share one content-addressed artifact while retaining different filenames.
 */
export interface ArtifactEvidenceSource {
  sourceId: string
  artifactId: string
  rootId?: string
  relativePath?: string
}

export type ArtifactEvidenceTarget = 'content' | 'file_name' | 'path'

export interface ArtifactEvidenceSpec {
  /** Caller-owned stable id, normally the recipe clause id. */
  id: string
  query: string
  mode?: ArtifactSearchMode
  caseSensitive?: boolean
  target?: ArtifactEvidenceTarget
}

export interface ArtifactEvidenceOccurrence {
  target: ArtifactEvidenceTarget
  /** Present only for content matches. */
  lineNumber?: number
  /** One-based UTF-16 columns, matching the desktop editor. */
  columnStart: number
  columnEnd: number
  /** Bounded display evidence; never an unbounded raw-log payload. */
  excerpt: string
  excerptTruncated: boolean
}

export interface ArtifactEvidenceItem {
  specId: string
  occurrenceCount?: number
  firstOccurrence?: ArtifactEvidenceOccurrence
  lastOccurrence?: ArtifactEvidenceOccurrence
  error?: string
}

export interface ArtifactEvidenceSourceResult {
  sourceId: string
  artifactId: string
  fileName: string
  relativePath?: string
  evidence: ArtifactEvidenceItem[]
  error?: string
}

export interface ArtifactEvidenceInput {
  sources: ArtifactEvidenceSource[]
  specs: ArtifactEvidenceSpec[]
}

export interface ArtifactEvidenceResult {
  sources: ArtifactEvidenceSourceResult[]
}

export interface ArtifactLineWindowInput {
  artifactId: string
  /** One-based first line. */
  startLine: number
  lineCount?: number
}

export interface ArtifactLine {
  lineNumber: number
  text: string
  truncated: boolean
}

export interface ArtifactLineWindow {
  artifactId: string
  startLine: number
  lines: ArtifactLine[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  /** Present when the end of the file was reached during this request. */
  totalLines?: number
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

export type MetadataSuggestionField = 'sample' | 'temperature' | 'mode' | 'grid'

export interface MetadataSuggestion {
  field: MetadataSuggestionField
  value: string
  confidence: number
  reason: string
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
  /** Suggestions are emitted only for filename fields that are unknown or conflicting. */
  metadataSuggestions: MetadataSuggestion[]
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
  requestsPerMinute?: number
  tokensPerMinute?: number
  timeoutSeconds?: number
  maxRetries?: number
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
    /** User-facing seconds value; timeoutMs is retained for runtime compatibility. */
    timeoutSeconds?: number
    maxRetries?: number
  }
}

export interface LlmModelDiscoveryInput {
  /** Optional unsaved URL from the settings form; otherwise uses effective saved/env config. */
  baseUrl?: string
  /** Optional unsaved token. It is used for this request only and never returned. */
  apiKey?: string
}

export interface LlmModelDiscoveryResult {
  models: string[]
  latencyMs: number
  truncated: boolean
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

export type EvaluationResultLabel =
  | 'PASS'
  | 'DIAG_FAIL'
  | 'TEST_FAIL'
  | 'TRAINING_FAIL'
  | 'SYSTEM_HALT'
  | 'SYSTEM_REBOOT'
  | 'INCOMPLETE'
  | 'UNKNOWN'
  | 'EXCLUDED'

/** Renderer input. sourceKey is hashed in main and is never written to disk. */
export interface EvaluationSourceInput {
  sourceId: string
  artifactId: string
  sourceKey: string
}

/** Durable source identity. A decision is always bound to one exact artifact SHA. */
export interface EvaluationSourceRef {
  sourceId: string
  artifactId: string
  sourceKeyHash: string
}

export interface EvaluationEvidenceRef {
  artifactId: string
  lineNumber?: number
  columnStart?: number
  columnEnd?: number
  matcherId?: string
}

export interface EvaluationDecisionRevision {
  id: string
  revision: number
  source: EvaluationSourceRef
  result: EvaluationResultLabel
  decidedBy: 'engineer'
  evidenceRefs: EvaluationEvidenceRef[]
  createdAt: string
  supersedesId?: string
}

export interface EvaluationRecipeClause {
  id: string
  presence: 'present' | 'absent'
  occurrence?: { kind: 'exact' | 'atLeast'; count: number }
  matcher: {
    kind: 'literal' | 'regex'
    pattern: string
    caseSensitive: boolean
    target: 'content' | 'file_name' | 'path'
  }
  sourceObservationId?: string
  order?: { afterClauseId: string }
}

export interface EvaluationRecipeRule {
  id: string
  label: Exclude<EvaluationResultLabel, 'UNKNOWN'>
  status: 'candidate' | 'verified'
  scope: { kind: 'analysis' | 'project' | 'customer' | 'global'; id?: string }
  clauses: EvaluationRecipeClause[]
  priority: number
  confidence: number
  repetition: number
  createdFromSourceIds: string[]
}

export interface EvaluationRecipeRevision {
  id: string
  recipeId: string
  revision: number
  name: string
  rules: EvaluationRecipeRule[]
  createdAt: string
  supersedesId?: string
}

export type EvaluationBatchExceptionCode =
  | 'NO_MATCH'
  | 'SEARCH_ERROR'
  | 'RULE_CONFLICT'
  | 'INVALID_METADATA'
  | 'CANCELLED'
  | 'OTHER'

export interface EvaluationBatchOutcomeInput {
  source: EvaluationSourceInput
  result: EvaluationResultLabel
  outcomeSource: 'rule' | 'engineer-preserved' | 'unknown'
  matchedRuleId?: string
  evidenceRefs?: EvaluationEvidenceRef[]
  exceptionCode?: EvaluationBatchExceptionCode
  conflictingDecisionId?: string
}

export interface EvaluationBatchOutcome extends Omit<EvaluationBatchOutcomeInput, 'source' | 'evidenceRefs'> {
  source: EvaluationSourceRef
  evidenceRefs: EvaluationEvidenceRef[]
}

export interface EvaluationBatchRun {
  id: string
  status: 'completed' | 'failed' | 'cancelled'
  recipeRevisionIds: string[]
  outcomes: EvaluationBatchOutcome[]
  matchedCount: number
  exceptionCount: number
  startedAt: string
  completedAt: string
}

export interface EvaluationMetadataApprovalRevision {
  id: string
  revision: number
  source: EvaluationSourceRef
  fieldKey: string
  candidateValue?: string
  approvedValue?: string
  extractorId?: string
  approval: 'approved' | 'rejected'
  approvedBy: 'engineer'
  createdAt: string
  supersedesId?: string
}

export interface EvaluationStorageNotice {
  kind: 'recovered-corrupt' | 'recovered-unsupported-version'
  recoveredAt: string
  /** Basename only; absolute userData paths never cross contextBridge. */
  backupFileName: string
}

export interface EvaluationProjectSnapshot {
  schemaVersion: 1
  projectIdHash: string
  revision: number
  decisions: EvaluationDecisionRevision[]
  recipes: EvaluationRecipeRevision[]
  batches: EvaluationBatchRun[]
  metadataApprovals: EvaluationMetadataApprovalRevision[]
  storageNotice?: EvaluationStorageNotice
}

export interface EvaluationProjectRequest {
  projectId: string
}

export interface EvaluationSaveDecisionInput extends EvaluationProjectRequest {
  expectedRevision: number
  source: EvaluationSourceInput
  result: EvaluationResultLabel
  evidenceRefs?: EvaluationEvidenceRef[]
}

export interface EvaluationSaveRecipeInput extends EvaluationProjectRequest {
  expectedRevision: number
  recipeId?: string
  name: string
  rules: EvaluationRecipeRule[]
}

export interface EvaluationSaveBatchInput extends EvaluationProjectRequest {
  expectedRevision: number
  status: 'completed' | 'failed' | 'cancelled'
  recipeRevisionIds: string[]
  outcomes: EvaluationBatchOutcomeInput[]
  startedAt?: string
}

export interface EvaluationSaveRecipeAndBatchInput extends EvaluationProjectRequest {
  expectedRevision: number
  recipe: { recipeId?: string; name: string; rules: EvaluationRecipeRule[] }
  batch: { status: 'completed' | 'failed' | 'cancelled'; outcomes: EvaluationBatchOutcomeInput[]; startedAt?: string }
}

export interface EvaluationApproveMetadataInput extends EvaluationProjectRequest {
  expectedRevision: number
  source: EvaluationSourceInput
  fieldKey: string
  candidateValue?: string
  approvedValue?: string
  extractorId?: string
  approval: 'approved' | 'rejected'
}

export interface EvaluationDecisionSaveResult {
  snapshot: EvaluationProjectSnapshot
  decision: EvaluationDecisionRevision
}

export interface EvaluationRecipeSaveResult {
  snapshot: EvaluationProjectSnapshot
  recipe: EvaluationRecipeRevision
}

export interface EvaluationBatchSaveResult {
  snapshot: EvaluationProjectSnapshot
  batch: EvaluationBatchRun
}

export interface EvaluationRecipeAndBatchSaveResult {
  snapshot: EvaluationProjectSnapshot
  recipe: EvaluationRecipeRevision
  batch: EvaluationBatchRun
}

export interface EvaluationMetadataSaveResult {
  snapshot: EvaluationProjectSnapshot
  metadataApproval: EvaluationMetadataApprovalRevision
}

export interface AppStatus {
  version: string
  platform: NodeJS.Platform
  packaged: boolean
  dataStoreReady: boolean
  llm: LlmConfigSummary
}

export type RendererCommand = 'open-logs' | 'find' | 'find-workspace' | 'preferences'

/** This is the only API exposed by contextBridge. */
export interface SequenceIntelligenceApi {
  app: {
    getStatus(): Promise<AppStatus>
    onCommand(listener: (command: RendererCommand) => void): () => void
  }
  artifacts: {
    importFiles(): Promise<ArtifactImportResult>
    importFolder(options?: ArtifactImportOptions): Promise<ArtifactImportResult>
    list(): Promise<ArtifactRecord[]>
    getTextPreview(artifactId: string, maxChars?: number): Promise<ArtifactTextPreview>
    search(input: ArtifactSearchInput): Promise<ArtifactSearchResult>
    inspectEvidence(input: ArtifactEvidenceInput): Promise<ArtifactEvidenceResult>
    getLineWindow(input: ArtifactLineWindowInput): Promise<ArtifactLineWindow>
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
    discoverModels(input?: LlmModelDiscoveryInput): Promise<LlmModelDiscoveryResult>
  }
  wiki: {
    save(input: WikiEntryInput): Promise<WikiEntryRecord>
    list(): Promise<WikiEntryRecord[]>
    export(entryId: string): Promise<WikiExportResult>
  }
  evaluations: {
    bootstrap(input: EvaluationProjectRequest): Promise<EvaluationProjectSnapshot>
    getSnapshot(input: EvaluationProjectRequest): Promise<EvaluationProjectSnapshot>
    saveDecision(input: EvaluationSaveDecisionInput): Promise<EvaluationDecisionSaveResult>
    saveRecipe(input: EvaluationSaveRecipeInput): Promise<EvaluationRecipeSaveResult>
    saveBatch(input: EvaluationSaveBatchInput): Promise<EvaluationBatchSaveResult>
    saveRecipeAndBatch(input: EvaluationSaveRecipeAndBatchInput): Promise<EvaluationRecipeAndBatchSaveResult>
    approveMetadata(input: EvaluationApproveMetadataInput): Promise<EvaluationMetadataSaveResult>
  }
}

export const IPC_CHANNELS = {
  appStatus: 'app:status',
  appCommand: 'app:command',
  artifactImportFiles: 'artifact:import-files',
  artifactImportFolder: 'artifact:import-folder',
  artifactList: 'artifact:list',
  artifactPreview: 'artifact:preview',
  artifactSearch: 'artifact:search',
  artifactInspectEvidence: 'artifact:inspect-evidence',
  artifactLineWindow: 'artifact:line-window',
  artifactSimilar: 'artifact:similar',
  analysisStart: 'analysis:start',
  analysisGet: 'analysis:get',
  analysisCancel: 'analysis:cancel',
  analysisUpdate: 'analysis:update',
  settingsGetLlm: 'settings:get-llm',
  settingsSaveLlm: 'settings:save-llm',
  settingsDiscoverModels: 'settings:discover-models',
  wikiSave: 'wiki:save',
  wikiList: 'wiki:list',
  wikiExport: 'wiki:export',
  evaluationBootstrap: 'evaluation:bootstrap',
  evaluationGetSnapshot: 'evaluation:get-snapshot',
  evaluationSaveDecision: 'evaluation:save-decision',
  evaluationSaveRecipe: 'evaluation:save-recipe',
  evaluationSaveBatch: 'evaluation:save-batch',
  evaluationSaveRecipeAndBatch: 'evaluation:save-recipe-and-batch',
  evaluationApproveMetadata: 'evaluation:approve-metadata'
} as const
