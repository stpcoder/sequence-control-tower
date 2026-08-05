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
  /** Absent in legacy snapshots; archived revisions are excluded from active rules. */
  archived?: boolean
}

/** Returns the newest non-archived revision for each recipe identity. */
export function getActiveEvaluationRecipeRevisions(
  revisions: readonly EvaluationRecipeRevision[]
): EvaluationRecipeRevision[] {
  const latest = new Map<string, EvaluationRecipeRevision>()
  revisions.forEach((revision) => {
    const current = latest.get(revision.recipeId)
    if (!current || revision.revision > current.revision) latest.set(revision.recipeId, revision)
  })
  return [...latest.values()].filter((revision) => revision.archived !== true)
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

export interface EvaluationArchiveRecipeInput extends EvaluationProjectRequest {
  expectedRevision: number
  recipeId: string
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

/** v0.7 agent core contracts. These are deliberately reference-only: raw log
 * payloads and unbounded arrays must not cross the agent boundary. */
export type AgentStageName = 'plan' | 'search' | 'inspect' | 'synthesize' | 'complete' | 'failed'
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed'
export type AgentQuestionKind = 'clarification' | 'approval'
export type AgentAnswerValue = string | number | boolean | string[]
export type AgentToolName = 'search' | 'lineWindow' | 'inspect'

export interface AgentRun {
  id: string
  status: AgentRunStatus
  stage: AgentStageName
  completionCount: number
  toolCount: number
  searchCount: number
  lineWindowCount: number
  promptChars: number
  startedAt: string
  updatedAt: string
  failureCode?: 'malformed-json' | 'unknown-tool' | 'budget-exceeded' | 'depth-exceeded' | 'invalid-action'
}

export interface Stage {
  name: AgentStageName
  depth: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  completionOrdinal?: number
}

export interface Question {
  id: string
  kind: AgentQuestionKind
  prompt: string
  choices?: string[]
}

export interface Answer {
  questionId: string
  value: AgentAnswerValue
}

export interface ToolAction {
  tool: AgentToolName
  input: Search | LineWindow | Inspect
  reason?: string
}

export interface Search {
  sourceId: string
  query: string
  mode: 'literal' | 'regex'
  caseSensitive: boolean
  observationId?: string
}

export interface LineWindow {
  sourceId: string
  startLine: number
  lineCount: number
  observationId?: string
}

export interface Inspect {
  sourceId: string
  target: 'metadata' | 'observation'
  observationId?: string
}

export interface Candidate {
  kind: 'metadata' | 'result' | 'question' | 'action'
  field?: 'sample' | 'temperature' | 'mode' | 'grid'
  value?: string
  result?: EvaluationResultLabel
  question?: Question
  action?: ToolAction
  status: 'candidate' | 'approved' | 'unknown'
  observationIds: string[]
}

export interface Trend {
  dimensions: {
    sample: Record<string, number>
    temperature: Record<string, number>
    mode: Record<string, number>
    grid: Record<string, number>
    result: Record<string, number>
    stage: Record<string, number>
    channel: Record<string, number>
  }
  majorConcentration: {
    dimension: keyof Trend['dimensions']
    value: string
    count: number
    share: number
  } | null
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  turn: number
}

export type ProjectFolderStatus = 'available' | 'missing' | 'permission-denied'
/** Renderer-safe project folder identity. The canonical path is main-process only. */
export interface ProjectFolderRef { rootId: string; displayLabel: string; status: ProjectFolderStatus; connectedAt: string }
export interface ProjectArtifactSourceRef { sourceId: string; rootId: string; artifactId: string; relativePath: string }
export interface ProjectEquipmentProfile { alias: string; profileId: string; updatedAt: string }
export interface ProjectTemplatePin { templateId: string; revision: number; pinnedAt: string }
export interface ProjectExportPreset {
  id: string; name: string; format: 'csv' | 'json' | 'markdown'
  options: Record<string, string | number | boolean>; createdAt: string; updatedAt: string; archived?: boolean
}
export interface ProjectOnboardingAnswers {
  evaluationTarget?: string
  importantMetadata?: string
  reuseRules?: string
}
export interface ProjectSnapshot {
  schemaVersion: 2; id: string; name: string; description?: string; revision: number; archived: boolean
  createdAt: string; updatedAt: string; folders: ProjectFolderRef[]; artifacts: ProjectArtifactSourceRef[]
  equipmentProfiles: ProjectEquipmentProfile[]; templatePins: ProjectTemplatePin[]; exportPresets: ProjectExportPreset[]
  onboardingAnswers?: ProjectOnboardingAnswers
}
export interface ProjectCreateInput { name: string; description?: string; onboardingAnswers?: ProjectOnboardingAnswers }
export interface ProjectListInput { includeArchived?: boolean }
export interface ProjectRequest { projectId: string }
export interface ProjectSaveInput extends ProjectRequest { expectedRevision: number; name?: string; description?: string; equipmentProfiles?: ProjectEquipmentProfile[]; templatePins?: ProjectTemplatePin[]; exportPresets?: ProjectExportPreset[]; onboardingAnswers?: ProjectOnboardingAnswers }
export interface ProjectArchiveInput extends ProjectRequest { expectedRevision: number }
export interface ProjectFolderInput extends ProjectRequest { expectedRevision: number }
export interface ProjectDetachFolderInput extends ProjectFolderInput { rootId: string }
export interface ProjectConnectArtifactsInput extends ProjectFolderInput { artifacts: Array<{ sourceId: string; rootId: string; artifactId: string; relativePath: string }> }
export interface ProjectValidateFoldersInput extends ProjectRequest { rootIds?: string[] }
export interface ProjectSaveExportPresetInput extends ProjectRequest { expectedRevision: number; preset: Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'> & { id?: string } }
export interface ProjectArchiveExportPresetInput extends ProjectRequest { expectedRevision: number; presetId: string }
export interface ProjectLoadResult { project: ProjectSnapshot; artifacts: ArtifactRecord[]; failures: ArtifactImportFailure[]; skippedCount: number }
export interface SequenceIntelligenceProjectsApi {
  create(input: ProjectCreateInput): Promise<ProjectSnapshot>
  list(input?: ProjectListInput): Promise<ProjectSnapshot[]>
  get(input: ProjectRequest): Promise<ProjectSnapshot | null>
  save(input: ProjectSaveInput): Promise<ProjectSnapshot>
  archive(input: ProjectArchiveInput): Promise<ProjectSnapshot>
  load(input: ProjectRequest): Promise<ProjectLoadResult | null>
  attachFolder(input: ProjectFolderInput): Promise<ProjectLoadResult | { cancelled: true }>
  detachFolder(input: ProjectDetachFolderInput): Promise<ProjectSnapshot>
  validateFolders(input: ProjectValidateFoldersInput): Promise<ProjectFolderRef[]>
  connectArtifacts(input: ProjectConnectArtifactsInput): Promise<ProjectSnapshot>
  saveExportPreset(input: ProjectSaveExportPresetInput): Promise<ProjectSnapshot>
  archiveExportPreset(input: ProjectArchiveExportPresetInput): Promise<ProjectSnapshot>
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
    archiveRecipe(input: EvaluationArchiveRecipeInput): Promise<EvaluationRecipeSaveResult>
    saveBatch(input: EvaluationSaveBatchInput): Promise<EvaluationBatchSaveResult>
    saveRecipeAndBatch(input: EvaluationSaveRecipeAndBatchInput): Promise<EvaluationRecipeAndBatchSaveResult>
    approveMetadata(input: EvaluationApproveMetadataInput): Promise<EvaluationMetadataSaveResult>
  }
  projects: SequenceIntelligenceProjectsApi
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
  evaluationArchiveRecipe: 'evaluation:archive-recipe',
  evaluationSaveBatch: 'evaluation:save-batch',
  evaluationSaveRecipeAndBatch: 'evaluation:save-recipe-and-batch',
  evaluationApproveMetadata: 'evaluation:approve-metadata',
  projectCreate: 'project:create', projectList: 'project:list', projectGet: 'project:get', projectSave: 'project:save',
  projectArchive: 'project:archive', projectLoad: 'project:load', projectAttachFolder: 'project:attach-folder',
  projectDetachFolder: 'project:detach-folder', projectValidateFolders: 'project:validate-folders',
  projectConnectArtifacts: 'project:connect-artifacts', projectSaveExportPreset: 'project:save-export-preset',
  projectArchiveExportPreset: 'project:archive-export-preset'
} as const
