import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertTriangle,
  Braces,
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Circle,
  CircleDot,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Play,
  Regex,
  Search,
  SearchCode,
  SlidersHorizontal,
  WholeWord,
  X,
} from 'lucide-react'
import type {
  AnalysisJobSnapshot,
  AnalysisJobStatus,
  ArtifactRecord,
  ArtifactSearchInput,
  ArtifactSearchResult,
  RendererCommand,
  SequenceIntelligenceApi,
} from '../../electron/shared/contracts'
import {
  buildCandidateRule,
  buildRecipeEvidencePlan,
  evaluatePrecomputedEvidence,
  precomputeDocumentEvidence,
  precomputedEvidenceFromInspection,
  recordObservation,
  selectDecisionEvidence,
  type PrecomputedDocumentEvidence,
  type RecipeRule,
  type ResultLabel,
  type RuleClause,
  type SearchObservation,
  type DocumentEvaluation,
} from '../domain/workbench'
import {
  loadLogWorkbenchState,
  logWorkbenchStorageKey,
  saveLogWorkbenchState,
  type LogWorkbenchRecipe,
} from '../state/logWorkbench'
import {
  addCurrentReplacement,
  addReplaceAll,
  applyLogDraftLine,
  canMatchZeroWidth,
  createLogDraft,
  resetLogDraft,
  isUnsafeRegex,
  wholeTokenPattern,
  type DraftValidationResult,
  type LogDraft,
} from '../state/logDraft'
import '../workbench.css'

export type WorkbenchDecision = ResultLabel

export interface WorkbenchFile {
  id: string
  name: string
  origin?: string
  relativePath?: string
  /** In-memory demo/external text only. Artifact text is loaded into a volatile line window. */
  text?: string
  artifactId?: string
  /** Stable source identity. Root-backed identities survive content/SHA changes. */
  sourceKey?: string
  rootId?: string
  lastSeenAt?: string
  size?: number
  truncated?: boolean
  decision?: WorkbenchDecision
  /** Deterministic batch result. It remains a candidate until an engineer confirms it. */
  ruleResult?: WorkbenchDecision
  ruleNeedsReview?: boolean
}

export interface WorkbenchRecipeDraft {
  decision: WorkbenchDecision
  positiveTerms: string[]
  missingTerms: string[]
  evidenceLines: number[]
  sourceFileId: string
  rule?: RecipeRule
}

export interface WorkbenchViewProps {
  files?: WorkbenchFile[]
  /** Main-process EvaluationStore rules. Desktop uses these as authority. */
  durableRules?: readonly RecipeRule[]
  selectedFileId?: string
  onFilesChange?: (files: WorkbenchFile[]) => void
  onSelectedFileChange?: (fileId: string | null) => void
  onEvidenceCountChange?: (fileId: string, count: number) => void
  onDecision?: (file: WorkbenchFile, decision: WorkbenchDecision, evidenceLines: number[]) => void | Promise<void>
  onBatchResults?: (resolution: PrecomputedBatchResolution) => void | Promise<void>
  onSaveRecipe?: (draft: WorkbenchRecipeDraft) => void | Promise<void>
  onNotify?: (message: string, tone?: 'success' | 'error' | 'info') => void
  projectId?: string
}

export type SearchScope = 'file' | 'open' | 'workspace'
type SideMode = 'files' | 'search'

export function resolveSearchScopeFiles(
  scope: SearchScope,
  files: readonly WorkbenchFile[],
  activeFileId: string | undefined,
  openFileIds: readonly string[],
): WorkbenchFile[] {
  if (scope === 'file') return files.filter((file) => file.id === activeFileId)
  if (scope === 'workspace') return [...files]

  const filesById = new Map(files.map((file) => [file.id, file]))
  return openFileIds.flatMap((fileId) => {
    const file = filesById.get(fileId)
    return file ? [file] : []
  })
}

interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

interface SearchHit {
  fileId: string
  line: number
  start: number
  end: number
  excerpt: string
}

interface LoadedLineWindow {
  startLine: number
  lines: Array<{ lineNumber: number; text: string; truncated: boolean }>
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  totalLines?: number
}

type LineWindowEdge = 'before' | 'after'

interface LineScrollAnchor {
  fileId: string
  lineNumber: number
  viewportOffset: number
}

export function mergeLineWindow(
  current: LoadedLineWindow | undefined,
  incoming: LoadedLineWindow,
  edge: LineWindowEdge,
  maxLines = 1000,
): LoadedLineWindow {
  const byLine = new Map<number, LoadedLineWindow['lines'][number]>()
  current?.lines.forEach((line) => byLine.set(line.lineNumber, line))
  incoming.lines.forEach((line) => byLine.set(line.lineNumber, line))
  const allLines = [...byLine.values()].sort((a, b) => a.lineNumber - b.lineNumber)
  const lines = allLines.length <= maxLines
    ? allLines
    : edge === 'before' ? allLines.slice(0, maxLines) : allLines.slice(-maxLines)
  const trimmedBefore = lines[0]?.lineNumber !== allLines[0]?.lineNumber
  const trimmedAfter = lines.at(-1)?.lineNumber !== allLines.at(-1)?.lineNumber
  return {
    startLine: lines[0]?.lineNumber ?? incoming.startLine,
    lines,
    hasMoreBefore: Boolean((edge === 'before' ? incoming.hasMoreBefore : current?.hasMoreBefore) || trimmedBefore),
    hasMoreAfter: Boolean((edge === 'after' ? incoming.hasMoreAfter : current?.hasMoreAfter) || trimmedAfter),
    totalLines: incoming.totalLines ?? current?.totalLines,
  }
}

export function clampSearchHitIndex(index: number, hitCount: number): number {
  if (hitCount <= 0) return 0
  return Math.min(Math.max(index, 0), hitCount - 1)
}

export function lineWindowEdgeRequestKey(fileId: string, edge: LineWindowEdge, boundary: number): string {
  return `${fileId}:${edge}:${boundary}`
}

interface BatchPreview {
  status: 'idle' | 'running' | 'done' | 'error'
  matched: number
  exceptions: number
  error?: string
  outcomes?: Record<string, ResultLabel>
  conflicts?: number
  exceptionIds?: string[]
  conflictIds?: string[]
  evaluations?: Record<string, DocumentEvaluation>
}

type PatternReviewStatus = AnalysisJobStatus | 'idle' | 'starting' | 'cancelling'

interface PatternReviewState {
  status: PatternReviewStatus
  jobId?: string
  stage?: string
  queuePosition?: number
  result?: AnalysisJobSnapshot['result']
  error?: string
}

interface CountEvidence {
  count?: number
  error?: string
}

type CurrentReplacementText =
  | { ok: true; text: string }
  | { ok: false; message: string }

export function resolveCurrentReplacementText(
  activeFileId: string | undefined,
  hit: Pick<SearchHit, 'fileId' | 'line' | 'start' | 'end'> | undefined,
  sourceLine: { lineNumber: number; text: string; truncated: boolean } | undefined,
): CurrentReplacementText {
  if (!hit || activeFileId !== hit.fileId) {
    return { ok: false, message: '현재 탭과 검색 결과가 다릅니다.' }
  }
  if (!sourceLine || sourceLine.lineNumber !== hit.line) {
    return { ok: false, message: '표시 중인 원문 줄이 없습니다.' }
  }

  // Artifact line windows append an ellipsis when the source line is longer
  // than the displayed prefix. Never treat that marker as source text.
  const availableEnd = sourceLine.truncated && sourceLine.text.endsWith('…')
    ? sourceLine.text.length - 1
    : sourceLine.text.length
  const { start, end } = hit
  if (!Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > availableEnd) {
    return { ok: false, message: '원문 줄이 잘려 현재 바꿀 수 없습니다.' }
  }

  const text = sourceLine.text.slice(start, end)
  if (text.length !== end - start) {
    return { ok: false, message: '원문 줄이 잘려 현재 바꿀 수 없습니다.' }
  }
  return { ok: true, text }
}

export function advanceFileRequestGeneration(
  generations: ReadonlyMap<string, number>,
  fileId: string,
): { generation: number; generations: Map<string, number> } {
  const generation = (generations.get(fileId) ?? 0) + 1
  const next = new Map(generations)
  next.set(fileId, generation)
  return { generation, generations: next }
}

export function canApplyLineWindowResult(
  mounted: boolean,
  generations: ReadonlyMap<string, number>,
  fileId: string,
  generation: number,
): boolean {
  return mounted && generations.get(fileId) === generation
}

export function advanceSearchRequestGeneration(currentGeneration: number): number {
  return currentGeneration + 1
}

export function canApplySearchResult(
  mounted: boolean,
  currentGeneration: number,
  requestGeneration: number,
): boolean {
  return mounted && currentGeneration === requestGeneration
}

export function advanceBatchGeneration(currentGeneration: number): number {
  return currentGeneration + 1
}

export function invalidateImportBatchGeneration(currentGeneration: number): number {
  return advanceBatchGeneration(currentGeneration)
}

export function canApplyBatchResult(
  mounted: boolean,
  currentGeneration: number,
  runGeneration: number,
): boolean {
  return mounted && currentGeneration === runGeneration
}

export function shouldCancelAnalysisJob(
  status: AnalysisJobStatus | 'idle' | 'starting' | 'cancelling',
  jobId: string,
): boolean {
  return Boolean(jobId) && (status === 'queued' || status === 'running')
}

function bestEffortCancelAnalysisJob(
  api: SequenceIntelligenceApi | undefined,
  status: AnalysisJobStatus | 'idle' | 'starting' | 'cancelling',
  jobId: string,
): void {
  if (!api?.analysis || !shouldCancelAnalysisJob(status, jobId)) return
  try {
    void Promise.resolve(api.analysis.cancel(jobId)).catch(() => undefined)
  } catch {
    // Cleanup is best effort; a synchronous bridge failure must not interrupt it.
  }
}

export function chooseNextTabId(
  openFileIds: readonly string[],
  closingFileId: string,
  activeFileId: string,
): string {
  const next = openFileIds.filter((id) => id !== closingFileId)
  if (closingFileId !== activeFileId) return next.includes(activeFileId) ? activeFileId : (next.at(-1) ?? '')
  const closingIndex = openFileIds.indexOf(closingFileId)
  return next[closingIndex] ?? next[closingIndex - 1] ?? ''
}

export function canApplyAnalysisUpdate(
  mounted: boolean,
  currentGeneration: number,
  requestGeneration: number,
  currentJobId: string,
  updateJobId: string,
): boolean {
  return mounted
    && currentGeneration === requestGeneration
    && Boolean(currentJobId)
    && currentJobId === updateJobId
}

function clipPatternReviewText(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

export function buildPatternReviewComment(
  userComment: string,
  query: string,
  observations: readonly SearchObservation[],
): string {
  const parts: string[] = []
  const comment = clipPatternReviewText(userComment, 160)
  const searchQuery = clipPatternReviewText(query, 96)
  const searchObservation = observations.slice(-3)
    .map((item) => `${clipPatternReviewText(item.query, 48)}=${item.matched ? `${item.matchCount}회 일치` : '불일치'}`)
    .join(', ')

  if (comment) parts.push(`사용자 메모: ${comment}`)
  if (searchQuery) parts.push(`현재 검색어: ${searchQuery}`)
  if (searchObservation) parts.push(`검색 관찰: ${clipPatternReviewText(searchObservation, 180)}`)
  if (!parts.length) parts.push('현재 로그의 반복 패턴과 예외 신호를 검토해 주세요.')
  return parts.join(' · ').slice(0, 480)
}

export function canStartImport(inFlight: boolean): boolean {
  return !inFlight
}

export function canApplyImportContinuation(mounted: boolean): boolean {
  return mounted
}

export function canApplyRevealRequest(
  mounted: boolean,
  currentGeneration: number,
  requestGeneration: number,
  expectedActiveHitKey?: string,
  currentActiveHitKey?: string,
): boolean {
  return mounted
    && currentGeneration === requestGeneration
    && (expectedActiveHitKey === undefined || expectedActiveHitKey === currentActiveHitKey)
}

/** Only reveal a hit when the user is already viewing that hit's file. */
export function canRevealActiveHit(
  searchOpen: boolean,
  activeFileId: string | undefined,
  hitFileId: string | undefined,
  activeHitKey: string,
  authorizedHitKey: string,
): boolean {
  return searchOpen
    && Boolean(activeFileId && hitFileId && activeFileId === hitFileId)
    && activeHitKey === authorizedHitKey
}

export function omitFileCacheEntry<T>(cache: Readonly<Record<string, T>>, fileId: string): Record<string, T> {
  const next = { ...cache }
  delete next[fileId]
  return next
}

export const DEMO_LOGS: WorkbenchFile[] = [
  {
    id: 'demo-pass-01',
    origin: 'Qualcomm_A / 85C',
    relativePath: 'LOT12/SAMPLE_01/LOT12_S01_85C_DIAG.log',
    name: 'LOT12_S01_85C_DIAG.log',
    text: `[2026-07-31 09:14:02.118] boot: platform init\n[2026-07-31 09:14:04.903] env: temperature=85.1C, vdd=0.780V\n[2026-07-31 09:14:05.220] mode: DIAG inserted\n[2026-07-31 09:14:06.101] stressapp: start, duration=3600\n[2026-07-31 09:14:41.308] stressapp: memory pattern 0xAA PASS\n[2026-07-31 09:15:18.427] stressapp: memory pattern 0x55 PASS\n[2026-07-31 09:15:30.601] hidag: start\n[2026-07-31 09:15:33.885] hidag: training phase complete\n[2026-07-31 09:15:41.092] hidag: link margin 14.2%\n[2026-07-31 09:15:45.716] @PASS DIAG_COMPLETE\n[2026-07-31 09:15:45.719] normal_end: true\n[2026-07-31 09:15:46.002] session closed`,
    decision: 'PASS',
  },
  {
    id: 'demo-halt-03',
    origin: 'Qualcomm_A / 85C',
    relativePath: 'LOT12/SAMPLE_03/LOT12_S03_85C_DIAG.log',
    name: 'LOT12_S03_85C_DIAG.log',
    text: `[2026-07-31 10:42:11.008] boot: platform init\n[2026-07-31 10:42:13.711] env: temperature=84.8C, vdd=0.780V\n[2026-07-31 10:42:14.104] mode: DIAG inserted\n[2026-07-31 10:42:15.884] stressapp: start, duration=3600\n[2026-07-31 10:42:50.049] stressapp: memory pattern 0xAA PASS\n[2026-07-31 10:43:17.201] stressapp: memory pattern 0x55 PASS\n[2026-07-31 10:43:29.774] hidag: start\n[2026-07-31 10:43:32.192] hidag: training phase complete\n[2026-07-31 10:43:35.668] hidag: link margin 3.1%\n[2026-07-31 10:43:35.811] watchdog: heartbeat delayed\n[2026-07-31 10:43:36.901] watchdog: heartbeat delayed\n[2026-07-31 10:43:38.119] pmic: rail monitor timeout\n[2026-07-31 10:43:38.120]`,
  },
  {
    id: 'demo-training-07',
    origin: 'Qualcomm_A / 105C',
    relativePath: 'LOT12/SAMPLE_07/LOT12_S07_105C_DIAG.log',
    name: 'LOT12_S07_105C_DIAG.log',
    text: `[2026-07-31 13:08:01.220] boot: platform init\n[2026-07-31 13:08:03.101] env: temperature=105.3C, vdd=0.760V\n[2026-07-31 13:08:03.908] mode: DIAG inserted\n[2026-07-31 13:08:05.345] stressapp: start, duration=3600\n[2026-07-31 13:08:29.720] stressapp: memory pattern 0xAA PASS\n[2026-07-31 13:08:48.387] hidag: start\n[2026-07-31 13:08:50.001] training: lane0 complete\n[2026-07-31 13:08:51.118] training: lane1 timeout\n[2026-07-31 13:08:51.201] TRAINING_FAIL lane=1 retry=3\n[2026-07-31 13:08:51.208] @FAIL code=TR_014\n[2026-07-31 13:08:51.511] normal_end: true`,
  },
  {
    id: 'demo-reboot-09',
    origin: 'Qualcomm_A / 105C',
    relativePath: 'LOT12/SAMPLE_09/LOT12_S09_105C_DIAG.log',
    name: 'LOT12_S09_105C_DIAG.log',
    text: `[2026-07-31 14:11:07.100] boot: platform init\n[2026-07-31 14:11:09.824] env: temperature=104.9C, vdd=0.760V\n[2026-07-31 14:11:10.090] mode: DIAG inserted\n[2026-07-31 14:11:11.431] stressapp: start, duration=3600\n[2026-07-31 14:11:44.812] kernel: fatal exception at 0x4E20\n[2026-07-31 14:11:44.816] reboot_reason: WATCHDOG_RESET\n[2026-07-31 14:11:48.027] boot: platform init\n[2026-07-31 14:11:50.638] session recovery detected`,
  },
]

const DECISIONS: Array<{ value: ResultLabel; label: string; tone: string }> = [
  { value: 'PASS', label: 'Pass', tone: 'pass' },
  { value: 'DIAG_FAIL', label: 'Diag fail', tone: 'fail' },
  { value: 'TEST_FAIL', label: 'Test fail', tone: 'fail' },
  { value: 'TRAINING_FAIL', label: 'Training fail', tone: 'training' },
  { value: 'SYSTEM_HALT', label: 'System halt', tone: 'halt' },
  { value: 'SYSTEM_REBOOT', label: 'System reboot', tone: 'reboot' },
  { value: 'INCOMPLETE', label: 'Incomplete', tone: 'incomplete' },
  { value: 'UNKNOWN', label: 'Unknown', tone: 'unknown' },
  { value: 'EXCLUDED', label: 'Excluded', tone: 'excluded' },
]

const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
}

const artifactName = (artifact: ArtifactRecord) => artifact.originalNames[0] ?? `${artifact.id}.log`

function sourceIdentity(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function artifactFiles(artifact: ArtifactRecord): WorkbenchFile[] {
  const sources = artifact.sources?.length ? artifact.sources : [undefined]
  return sources.map((source, index) => {
    const rootId = typeof source?.rootId === 'string' && source.rootId ? source.rootId : undefined
    const relativePath = source?.relativePath ?? artifactName(artifact)
    const sourceKey = rootId
      ? `root:${rootId}\u001f${relativePath}`
      : `legacy:${artifact.id}\u001f${index}\u001f${source?.folderLabel ?? ''}\u001f${relativePath}`
    return {
      id: `${artifact.id}:source-${sourceIdentity(sourceKey)}`,
      artifactId: artifact.id,
      sourceKey,
      rootId,
      lastSeenAt: artifact.lastSeenAt,
      name: relativePath.split('/').at(-1) ?? artifactName(artifact),
      origin: source?.folderLabel ?? 'Imported logs',
      relativePath,
      size: artifact.size,
      text: undefined,
    }
  })
}

function seenAt(file: WorkbenchFile): number {
  const value = file.lastSeenAt ? Date.parse(file.lastSeenAt) : Number.NaN
  return Number.isFinite(value) ? value : 0
}

/** Keeps only the newest SHA for a stable rootId + relativePath source. */
export function dedupeWorkbenchFiles(input: readonly WorkbenchFile[]): WorkbenchFile[] {
  const byIdentity = new Map<string, WorkbenchFile>()
  for (const file of input) {
    const key = file.sourceKey ?? `row:${file.id}`
    const current = byIdentity.get(key)
    if (!current || seenAt(file) > seenAt(current) || (seenAt(file) === seenAt(current) && (file.artifactId ?? file.id).localeCompare(current.artifactId ?? current.id) > 0)) {
      byIdentity.set(key, file)
    }
  }
  return [...byIdentity.values()]
}

export function mergeWorkbenchFiles(
  current: readonly WorkbenchFile[],
  imported: readonly WorkbenchFile[],
): WorkbenchFile[] {
  return dedupeWorkbenchFiles([...current, ...imported])
}

export interface WorkbenchFileGroup {
  key: string
  label: string
  files: WorkbenchFile[]
}

function workbenchFolderLabel(file: WorkbenchFile): string {
  return file.origin || file.relativePath?.split(/[\\/]/)[0] || 'Imported logs'
}

function legacyRootIdentity(file: WorkbenchFile): string {
  if (file.sourceKey) {
    const sourceKeyRoot = file.sourceKey.split('\u001f', 1)[0]
    if (sourceKeyRoot) return sourceKeyRoot
  }

  const relativeSource = file.relativePath?.replace(/\\/g, '/').split('/')[0]
  return `${file.origin ?? ''}\u001f${relativeSource ?? file.name}`
}

export function workbenchRootGroupKey(file: WorkbenchFile): string {
  return file.rootId ? `root:${file.rootId}` : `legacy:${sourceIdentity(legacyRootIdentity(file))}`
}

export function groupWorkbenchFiles(input: readonly WorkbenchFile[]): WorkbenchFileGroup[] {
  const groups = new Map<string, { label: string; files: WorkbenchFile[] }>()
  for (const file of input) {
    const key = workbenchRootGroupKey(file)
    const current = groups.get(key)
    if (current) current.files.push(file)
    else groups.set(key, { label: workbenchFolderLabel(file), files: [file] })
  }

  const labelCounts = new Map<string, number>()
  for (const group of groups.values()) {
    labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1)
  }

  // The input order changes when persisted artifacts are reloaded or an import
  // completes. Assign ordinals from the stable group key so a duplicate label
  // keeps its number across those order changes.
  const labelOrdinals = new Map<string, number>()
  const groupsByLabel = new Map<string, string[]>()
  for (const [key, group] of groups) {
    if ((labelCounts.get(group.label) ?? 0) <= 1) continue
    const keys = groupsByLabel.get(group.label) ?? []
    keys.push(key)
    groupsByLabel.set(group.label, keys)
  }
  for (const keys of groupsByLabel.values()) {
    keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    keys.forEach((key, index) => labelOrdinals.set(key, index + 1))
  }

  return [...groups.entries()].map(([key, group]) => {
    const count = labelCounts.get(group.label) ?? 0
    if (count <= 1) return { key, label: group.label, files: group.files }
    const ordinal = labelOrdinals.get(key) ?? 1
    return { key, label: `${group.label} · ${ordinal}`, files: group.files }
  })
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function createSearchPattern(query: string, options: SearchOptions, global = true): RegExp | null {
  if (!query) return null
  const source = options.regex ? query : escapeRegExp(query)
  if (options.regex && isUnsafeRegex(source)) return null
  const bounded = options.wholeWord ? wholeTokenPattern(source) : source
  try {
    const pattern = new RegExp(bounded, `${global ? 'g' : ''}${options.caseSensitive ? '' : 'i'}u`)
    if (canMatchZeroWidth(pattern)) return null
    return pattern
  } catch {
    return null
  }
}

function collectHits(files: WorkbenchFile[], query: string, options: SearchOptions): SearchHit[] {
  const pattern = createSearchPattern(query, options)
  if (!pattern) return []
  const hits: SearchHit[] = []
  for (const file of files) {
    if (file.artifactId || file.text === undefined) continue
    const lines = file.text.split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      pattern.lastIndex = 0
      let match = pattern.exec(line)
      while (match) {
        hits.push({
          fileId: file.id,
          line: lineIndex + 1,
          start: match.index,
          end: match.index + match[0].length,
          excerpt: line.trim(),
        })
        if (!match[0].length) pattern.lastIndex += 1
        match = pattern.exec(line)
      }
    }
  }
  return hits
}

function electronApi(): SequenceIntelligenceApi | undefined {
  return (window as Window & { sequenceIntelligence?: SequenceIntelligenceApi }).sequenceIntelligence
}

async function searchArtifactsBatched(
  api: SequenceIntelligenceApi,
  artifactIds: string[],
  input: Omit<ArtifactSearchInput, 'artifactIds'>,
): Promise<ArtifactSearchResult> {
  const ids = [...new Set(artifactIds)]
  // The backend accepts the full 10k import ceiling and owns cancellation.
  // One IPC request prevents an older multi-batch search from cancelling a
  // newer query between renderer batches.
  return api.artifacts.search({ ...input, artifactIds: ids })
}

/** Missing and failed file results stay absent so they cannot become negative evidence. */
export function successfulSearchCounts(
  rows: readonly WorkbenchFile[],
  result: ArtifactSearchResult,
): Record<string, number> {
  const byArtifact = new Map(result.files.filter((file) => !file.error).map((file) => [file.artifactId, file.matchCount]))
  return Object.fromEntries(rows.flatMap((row) => {
    if (!row.artifactId || !byArtifact.has(row.artifactId)) return []
    return [[row.id, byArtifact.get(row.artifactId)!]]
  }))
}

function backendQuery(query: string, options: SearchOptions): { query: string; mode: 'literal' | 'regex' } {
  if (!options.wholeWord) return { query, mode: options.regex ? 'regex' : 'literal' }
  const source = options.regex ? query : escapeRegExp(query)
  return { query: wholeTokenPattern(source), mode: 'regex' }
}

function artifactBacked(file: WorkbenchFile): boolean {
  return Boolean(file.artifactId)
}

export function clauseSpecKey(clause: RuleClause): string {
  const matcher = clause.matcher
  return [matcher.target, matcher.kind, matcher.caseSensitive ? '1' : '0', matcher.pattern].join('\u001f')
}

export function countMatcherText(value: string, clause: RuleClause): CountEvidence {
  const matcher = clause.matcher
  try {
    if (matcher.kind === 'literal') {
      const source = matcher.caseSensitive ? value : value.toLocaleLowerCase()
      const query = matcher.caseSensitive ? matcher.pattern : matcher.pattern.toLocaleLowerCase()
      if (!query) return { count: 0 }
      let count = 0
      let offset = 0
      while (offset <= source.length - query.length) {
        const found = source.indexOf(query, offset)
        if (found < 0) break
        count += 1
        offset = found + Math.max(1, query.length)
      }
      return { count }
    }
    const flags = matcher.caseSensitive ? 'g' : 'gi'
    return { count: [...value.matchAll(new RegExp(matcher.pattern, flags))].length }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid matcher' }
  }
}

export interface PrecomputedBatchResolution {
  outcomes: Record<string, ResultLabel>
  matched: number
  exceptions: number
  conflicts: number
  exceptionIds: string[]
  conflictIds: string[]
  evaluations: Record<string, DocumentEvaluation>
  appliedRules: RecipeRule[]
}

export function resolvePrecomputedBatch(
  files: readonly WorkbenchFile[],
  rules: readonly RecipeRule[],
  evidenceBySource: ReadonlyMap<string, PrecomputedDocumentEvidence>,
  confirmedDecisions: Readonly<Record<string, ResultLabel>>,
): PrecomputedBatchResolution {
  const outcomes: Record<string, ResultLabel> = {}
  let matched = 0
  let exceptions = 0
  let conflicts = 0
  const exceptionIds: string[] = []
  const conflictIds: string[] = []
  const evaluations: Record<string, DocumentEvaluation> = {}
  for (const file of files) {
    const evidence = evidenceBySource.get(file.id) ?? { sourceId: file.id, rules: [] }
    const evaluation = evaluatePrecomputedEvidence(evidence, rules)
    evaluations[file.id] = evaluation
    const savedDecision = confirmedDecisions[file.id]
    const decisionConflict = Boolean(savedDecision && evaluation.result !== 'UNKNOWN' && evaluation.result !== savedDecision)
    if (decisionConflict) {
      conflicts += 1
      conflictIds.push(file.id)
    }
    outcomes[file.id] = savedDecision ?? (decisionConflict ? 'UNKNOWN' : evaluation.result)
    const exceptional = decisionConflict || evaluation.result === 'UNKNOWN' || evaluation.exceptions.length > 0
    if (exceptional) {
      exceptions += 1
      exceptionIds.push(file.id)
    }
    else matched += 1
  }
  return { outcomes, matched, exceptions, conflicts, exceptionIds, conflictIds, evaluations, appliedRules: [...rules] }
}

function firstEvaluationLine(evaluation: DocumentEvaluation | undefined): number | undefined {
  return evaluation?.matchedRules
    .flatMap((rule) => rule.clauseEvaluations)
    .flatMap((clause) => [clause.firstOccurrence?.lineNumber, clause.lastOccurrence?.lineNumber])
    .filter((line): line is number => typeof line === 'number' && line > 0)
    .sort((left, right) => left - right)[0]
}

function exceptionLabel(code: string): string {
  const labels: Record<string, string> = {
    NO_MATCH: '일치하는 규칙 없음',
    RULE_CONFLICT: '동순위 규칙 충돌',
    INVALID_PATTERN: '잘못된 검색식',
    LOW_CONFIDENCE: '검토가 필요한 규칙',
    MISSING_EVIDENCE: '판정 근거 누락',
    EVIDENCE_ERROR: '로그 검사 실패',
    INVALID_RULE: '잘못된 규칙',
  }
  return labels[code] ?? code
}

function renderHighlightedLine(
  line: string,
  lineNumber: number,
  hits: SearchHit[],
  activeHit?: SearchHit,
) {
  if (!hits.length) return line || ' '
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const [index, hit] of hits.entries()) {
    if (hit.start < cursor) continue
    nodes.push(line.slice(cursor, hit.start))
    const active = activeHit?.line === hit.line && activeHit.start === hit.start
    nodes.push(<mark className={active ? 'is-current' : ''} key={`${lineNumber}-${hit.start}-${index}`}>{line.slice(hit.start, hit.end)}</mark>)
    cursor = hit.end
  }
  nodes.push(line.slice(cursor))
  return nodes
}

function searchHitKey(hit: SearchHit): string {
  return `${hit.fileId}:${hit.line}:${hit.start}:${hit.end}:${hit.excerpt}`
}

function draftValidationMessage(validation: DraftValidationResult): string {
  if (validation.ok) return ''
  const labels: Record<string, string> = {
    INVALID_FILE_ID: '파일을 확인하세요.',
    INVALID_LINE: '줄 번호를 확인하세요.',
    INVALID_RANGE: '검색 결과 위치가 올바르지 않습니다.',
    NEWLINE_REPLACEMENT: '바꿀 내용에는 줄바꿈을 넣을 수 없습니다.',
    EMPTY_PATTERN: '검색어를 입력하세요.',
    INVALID_REGEX: '정규식이 올바르지 않습니다.',
    ZERO_WIDTH_PATTERN: '0폭 검색 결과는 바꿀 수 없습니다.',
    EMPTY_SCOPE: '바꿀 범위가 비어 있습니다.',
    STALE_CURRENT_MATCH: '원문 검색 결과가 바뀌었습니다. 다시 검색하세요.',
  }
  return labels[validation.code] ?? '수정 초안을 적용하지 못했습니다.'
}

function draftTargetsFile(draft: LogDraft, fileId: string): boolean {
  return draft.operations.some((operation) => operation.kind === 'replace-one'
    ? operation.fileId === fileId
    : operation.fileIds.includes(fileId))
}

function optionLabel(option: keyof SearchOptions): string {
  if (option === 'caseSensitive') return '대/소문자 구분'
  if (option === 'wholeWord') return '단어 단위 일치'
  return '정규식 사용'
}

export function WorkbenchView({
  files: controlledFiles,
  durableRules,
  selectedFileId,
  onFilesChange,
  onSelectedFileChange,
  onEvidenceCountChange,
  onDecision,
  onBatchResults,
  onSaveRecipe,
  onNotify,
  projectId = 'log-workbench',
}: WorkbenchViewProps) {
  const [localFiles, setLocalFiles] = useState<WorkbenchFile[]>(() => controlledFiles ?? (electronApi() ? [] : DEMO_LOGS))
  const files = useMemo(() => dedupeWorkbenchFiles(controlledFiles ?? localFiles), [controlledFiles, localFiles])
  const [activeFileId, setActiveFileId] = useState(() => files[1]?.id ?? files[0]?.id ?? '')
  const [openFileIds, setOpenFileIds] = useState<string[]>(() => files.slice(0, 3).map((file) => file.id))
  const [expandedOrigins, setExpandedOrigins] = useState<Set<string>>(() => new Set(groupWorkbenchFiles(files).map((group) => group.key)))
  const [sideMode, setSideMode] = useState<SideMode>('files')
  const [searchScope, setSearchScope] = useState<SearchScope>('file')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS)
  const [currentHit, setCurrentHit] = useState(0)
  const [searchNavigationVersion, setSearchNavigationVersion] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [replaceMode, setReplaceMode] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [logDraft, setLogDraft] = useState<LogDraft>(() => createLogDraft(files.flatMap((file) => file.text === undefined ? [] : [{ id: file.id, text: file.text }])))
  const [draftError, setDraftError] = useState('')
  const [searchHistory, setSearchHistory] = useState<Record<string, SearchObservation[]>>({})
  const [selectedObservationIdsByFile, setSelectedObservationIdsByFile] = useState<Record<string, string[]>>({})
  const [requireMarkerOrder, setRequireMarkerOrder] = useState(false)
  const [backendHits, setBackendHits] = useState<SearchHit[]>([])
  const [backendCounts, setBackendCounts] = useState<Record<string, number>>({})
  const [backendTotal, setBackendTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [lineWindows, setLineWindows] = useState<Record<string, LoadedLineWindow>>({})
  const [windowLoading, setWindowLoading] = useState(false)
  const [evidenceByFile, setEvidenceByFile] = useState<Record<string, number[]>>({})
  const [revealedLine, setRevealedLine] = useState<{ fileId: string; lineNumber: number } | null>(null)
  const [decisions, setDecisions] = useState<Record<string, WorkbenchDecision>>(() => Object.fromEntries(files.filter((file) => file.decision).map((file) => [file.id, file.decision!])))
  const [candidateDecisions, setCandidateDecisions] = useState<Record<string, ResultLabel>>({})
  const [savedDecisions, setSavedDecisions] = useState<Record<string, ResultLabel>>({})
  const [savedRecipes, setSavedRecipes] = useState<LogWorkbenchRecipe[]>([])
  const [recipeVisible, setRecipeVisible] = useState(false)
  const [recipeSaved, setRecipeSaved] = useState(false)
  const [batchPreview, setBatchPreview] = useState<BatchPreview>({ status: 'idle', matched: 0, exceptions: 0 })
  const [showBatchExceptions, setShowBatchExceptions] = useState(false)
  const [searchOptionsOpen, setSearchOptionsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [invalidPattern, setInvalidPattern] = useState(false)
  const [patternReviewComment, setPatternReviewComment] = useState('')
  const [patternReview, setPatternReview] = useState<PatternReviewState>({ status: 'idle' })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const observationTimer = useRef<number | undefined>(undefined)
  const searchRequest = useRef(0)
  const mountedRef = useRef(false)
  const lineWindowGenerations = useRef(new Map<string, number>())
  const pendingLineWindowRequests = useRef(new Set<string>())
  const lineWindowTasks = useRef(new Map<string, Promise<void>>())
  const lineWindowEpochs = useRef(new Map<string, number>())
  const lineScrollAnchor = useRef<LineScrollAnchor | null>(null)
  const scrollFrameId = useRef<number | undefined>(undefined)
  const animationFrameIds = useRef(new Set<number>())
  const revealGeneration = useRef(0)
  const batchGeneration = useRef(0)
  const recoveryNoticeProjects = useRef(new Set<string>())
  const activeFileIdRef = useRef(activeFileId)
  const activeHitKeyRef = useRef('')
  const authorizedHitKeyRef = useRef('')
  const filesRef = useRef(files)
  const importInFlightRef = useRef(false)
  const patternReviewGeneration = useRef(0)
  const patternReviewJobIdRef = useRef('')
  const patternReviewFileIdRef = useRef('')
  const patternReviewStatusRef = useRef<PatternReviewStatus>('idle')
  const replacementInputRef = useRef<HTMLInputElement>(null)
  const lineWindowsRef = useRef<Record<string, LoadedLineWindow>>({})

  activeFileIdRef.current = activeFileId
  filesRef.current = files
  lineWindowsRef.current = lineWindows
  patternReviewStatusRef.current = patternReview.status

  const bestEffortCancelPatternReview = useCallback(() => {
    const api = electronApi()
    const jobId = patternReviewJobIdRef.current
    if (!api?.analysis || !shouldCancelAnalysisJob(patternReviewStatusRef.current, jobId)) return
    bestEffortCancelAnalysisJob(api, patternReviewStatusRef.current, jobId)
    patternReviewJobIdRef.current = ''
  }, [])

  const applyPatternReviewJob = useCallback((job: AnalysisJobSnapshot, requestGeneration: number): boolean => {
    if (!canApplyAnalysisUpdate(
      mountedRef.current,
      patternReviewGeneration.current,
      requestGeneration,
      patternReviewJobIdRef.current,
      job.id,
    )) return false
    patternReviewStatusRef.current = job.status
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      patternReviewJobIdRef.current = ''
    }
    setPatternReview({
      status: job.status,
      jobId: job.id,
      stage: job.stage,
      queuePosition: job.queuePosition,
      result: job.result,
      error: job.error,
    })
    return true
  }, [])

  const activeFile = files.find((file) => file.id === activeFileId)
  const activeWindow = activeFile ? lineWindows[activeFile.id] : undefined
  const activeSourceLines = useMemo(() => {
    if (!activeFile) return []
    if (artifactBacked(activeFile)) return activeWindow?.lines ?? []
    return (activeFile.text ?? '').split(/\r?\n/).map((text, index) => ({ lineNumber: index + 1, text, truncated: false }))
  }, [activeFile, activeWindow])
  const activeLines = useMemo(() => activeSourceLines.map((line) => ({
    ...line,
    text: activeFile ? applyLogDraftLine(logDraft, activeFile.id, line.lineNumber, line.text).text : line.text,
  })), [activeFile, activeSourceLines, logDraft])
  const searchFiles = useMemo(() => resolveSearchScopeFiles(searchScope, files, activeFileId, openFileIds), [activeFileId, files, openFileIds, searchScope])
  const searchFileIdsKey = useMemo(() => searchFiles.map((file) => file.id).join('\u0000'), [searchFiles])
  const memoryHits = useMemo(() => collectHits(searchFiles, query, options), [options, query, searchFiles])
  const hits = useMemo(() => [...memoryHits, ...backendHits], [backendHits, memoryHits])
  const activeHit = hits[currentHit]
  const activeHitKey = activeHit ? searchHitKey(activeHit) : ''
  activeHitKeyRef.current = searchOpen ? activeHitKey : ''
  const draftActiveForFile = Boolean(activeFile && draftTargetsFile(logDraft, activeFile.id))
  const activeDraftIssues = useMemo(() => activeFile
    ? activeSourceLines.flatMap((line) => applyLogDraftLine(logDraft, activeFile.id, line.lineNumber, line.text).issues)
    : [], [activeFile, activeSourceLines, logDraft])
  const displayedDraftError = draftError || (activeDraftIssues[0] ? draftValidationMessage(activeDraftIssues[0].validation) : '')
  const activeFileHits = useMemo(() => hits.filter((hit) => hit.fileId === activeFile?.id), [activeFile?.id, hits])
  const activeHitsByLine = useMemo(() => {
    const byLine = new Map<number, SearchHit[]>()
    for (const hit of activeFileHits) {
      const lineHits = byLine.get(hit.line) ?? []
      lineHits.push(hit)
      byLine.set(hit.line, lineHits)
    }
    return byLine
  }, [activeFileHits])
  const evidenceLines = evidenceByFile[activeFile?.id ?? ''] ?? []
  const decision = candidateDecisions[activeFile?.id ?? ''] ?? decisions[activeFile?.id ?? ''] ?? activeFile?.decision
  const searchTotal = memoryHits.length + backendTotal
  const activeBatchEvaluation = batchPreview.evaluations?.[activeFile?.id ?? '']
  const activeBatchConflict = batchPreview.conflictIds?.includes(activeFile?.id ?? '') ?? false
  const patternReviewBusy = patternReview.status === 'starting'
    || patternReview.status === 'queued'
    || patternReview.status === 'running'
    || patternReview.status === 'cancelling'
  const patternReviewAvailable = Boolean(activeFile?.artifactId && electronApi()?.analysis)

  const groupedFiles = useMemo(() => groupWorkbenchFiles(files.filter((file) => (
    !showBatchExceptions || batchPreview.exceptionIds?.includes(file.id)
  ))), [batchPreview.exceptionIds, files, showBatchExceptions])

  const recipeObservations = useMemo(() => {
    if (!activeFile) return []
    const observations = searchHistory[activeFile.id] ?? []
    const latest = new Map<string, SearchObservation>()
    observations.forEach((item) => latest.set(`${item.matcherKind}:${item.caseSensitive}:${item.query}`, item))
    const unique = [...latest.values()]
    return [
      ...unique.filter((item) => item.matched).slice(-4),
      ...unique.filter((item) => !item.matched).slice(-4),
    ]
  }, [activeFile, searchHistory])

  const selectedRecipeObservations = useMemo(() => {
    const selected = new Set(selectedObservationIdsByFile[activeFile?.id ?? ''] ?? [])
    return recipeObservations.filter((observation) => selected.has(observation.id))
  }, [activeFile?.id, recipeObservations, selectedObservationIdsByFile])

  const canRequireMarkerOrder = selectedRecipeObservations.length > 1
    && selectedRecipeObservations.every((observation) => observation.matched && observation.target === 'content')

  const draft = useMemo<WorkbenchRecipeDraft | null>(() => {
    if (!activeFile || !decision || decision === 'UNKNOWN') return null
    return {
      decision,
      positiveTerms: selectedRecipeObservations.filter((item) => item.matched).map((item) => item.query),
      missingTerms: selectedRecipeObservations.filter((item) => !item.matched).map((item) => item.query),
      evidenceLines,
      sourceFileId: activeFile.id,
    }
  }, [activeFile, decision, evidenceLines, selectedRecipeObservations])

  const updateFiles = useCallback((next: WorkbenchFile[]) => {
    filesRef.current = next
    if (controlledFiles === undefined) setLocalFiles(next)
    onFilesChange?.(next)
  }, [controlledFiles, onFilesChange])

  const selectFile = useCallback((fileId: string, resetSearch = true) => {
    // Any ordinary selection supersedes an in-flight search-hit reveal. An
    // explicit hit navigation starts a fresh reveal after this invalidation.
    revealGeneration.current += 1
    authorizedHitKeyRef.current = ''
    const changingFile = fileId !== activeFileIdRef.current
    if (changingFile) {
      bestEffortCancelPatternReview()
      batchGeneration.current = advanceBatchGeneration(batchGeneration.current)
      lineScrollAnchor.current = null
      activeFileIdRef.current = fileId
      lineWindowEpochs.current.set(fileId, (lineWindowEpochs.current.get(fileId) ?? 0) + 1)
      lineWindowGenerations.current = advanceFileRequestGeneration(lineWindowGenerations.current, fileId).generations
      for (const requestKey of pendingLineWindowRequests.current) {
        if (requestKey.startsWith(`${fileId}:`)) pendingLineWindowRequests.current.delete(requestKey)
      }
      lineWindowsRef.current = omitFileCacheEntry(lineWindowsRef.current, fileId)
      setLineWindows((current) => omitFileCacheEntry(current, fileId))
    }
    setActiveFileId(fileId)
    setOpenFileIds((current) => current.includes(fileId) ? current : [...current, fileId])
    if (changingFile || patternReviewFileIdRef.current !== fileId) {
      patternReviewGeneration.current += 1
      patternReviewJobIdRef.current = ''
      patternReviewFileIdRef.current = fileId
      setPatternReview({ status: 'idle' })
    }
    if (resetSearch) {
      setCurrentHit(0)
      setRevealedLine(null)
    }
    onSelectedFileChange?.(fileId)
  }, [bestEffortCancelPatternReview, onSelectedFileChange])

  const navigateToSearchHit = useCallback((index: number) => {
    const hit = hits[index]
    if (!hit) return
    setCurrentHit(index)
    selectFile(hit.fileId, false)
    authorizedHitKeyRef.current = searchHitKey(hit)
    setSearchNavigationVersion((current) => current + 1)
  }, [hits, selectFile])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      bestEffortCancelPatternReview()
      mountedRef.current = false
      searchRequest.current = advanceSearchRequestGeneration(searchRequest.current)
      batchGeneration.current = advanceBatchGeneration(batchGeneration.current)
      revealGeneration.current += 1
      patternReviewGeneration.current += 1
      patternReviewJobIdRef.current = ''
      animationFrameIds.current.forEach((frameId) => window.cancelAnimationFrame(frameId))
      animationFrameIds.current.clear()
      if (scrollFrameId.current !== undefined) window.cancelAnimationFrame(scrollFrameId.current)
      scrollFrameId.current = undefined
    }
  }, [bestEffortCancelPatternReview])

  useEffect(() => {
    const api = electronApi()
    if (!api?.analysis) return undefined
    return api.analysis.onJobUpdate((job) => {
      void applyPatternReviewJob(job, patternReviewGeneration.current)
    })
  }, [applyPatternReviewJob])

  useEffect(() => {
    if (!selectedFileId || !files.some((file) => file.id === selectedFileId)) return
    if (selectedFileId === activeFileIdRef.current) return
    selectFile(selectedFileId, false)
  }, [files, selectFile, selectedFileId])

  useEffect(() => {
    if (controlledFiles === undefined || !window.sequenceIntelligence?.evaluations) return
    setDecisions(Object.fromEntries(files.flatMap((file) => file.decision ? [[file.id, file.decision] as const] : [])))
  }, [controlledFiles, files])

  useEffect(() => {
    if (activeFile) onEvidenceCountChange?.(activeFile.id, evidenceLines.length)
  }, [activeFile, evidenceLines.length, onEvidenceCountChange])

  const loadLineWindow = useCallback(async (
    file: WorkbenchFile,
    targetLine = 1,
    edge: LineWindowEdge | 'replace' = 'replace',
  ): Promise<LoadedLineWindow | undefined> => {
    const api = electronApi()
    if (!api || !file.artifactId || !mountedRef.current) return undefined
    while (lineWindowTasks.current.has(file.id)) {
      await lineWindowTasks.current.get(file.id)
      if (!mountedRef.current || !filesRef.current.some((item) => item.id === file.id && item.artifactId === file.artifactId)) {
        return undefined
      }
    }
    const cached = lineWindowsRef.current[file.id]
    if (edge === 'replace' && cached?.lines.some((line) => line.lineNumber === targetLine)) return cached
    let releaseTask!: () => void
    const task = new Promise<void>((resolve) => { releaseTask = resolve })
    lineWindowTasks.current.set(file.id, task)
    const current = lineWindowsRef.current[file.id]
    const boundary = edge === 'before'
      ? Math.max(1, current?.startLine ?? targetLine)
      : edge === 'after'
        ? (current?.lines.at(-1)?.lineNumber ?? targetLine)
        : targetLine
    const epoch = lineWindowEpochs.current.get(file.id) ?? 0
    const edgeRequestKey = edge === 'replace' ? undefined : `${lineWindowEdgeRequestKey(file.id, edge, boundary)}:${epoch}`
    if (edgeRequestKey && pendingLineWindowRequests.current.has(edgeRequestKey)) {
      releaseTask()
      if (lineWindowTasks.current.get(file.id) === task) lineWindowTasks.current.delete(file.id)
      return undefined
    }
    if (edge === 'replace') {
      lineWindowEpochs.current.set(file.id, epoch + 1)
      const nextRequest = advanceFileRequestGeneration(lineWindowGenerations.current, file.id)
      lineWindowGenerations.current = nextRequest.generations
    }
    const requestId = lineWindowGenerations.current.get(file.id) ?? 0
    const requestKey = edgeRequestKey ?? `${file.id}:replace:${targetLine}:${requestId}`
    pendingLineWindowRequests.current.add(requestKey)
    setWindowLoading(true)
    try {
      const result = await api.artifacts.getLineWindow({
        artifactId: file.artifactId,
        startLine: edge === 'before'
          ? Math.max(1, boundary - 240)
          : edge === 'after'
            ? boundary + 1
            : Math.max(1, targetLine - 80),
        lineCount: 240,
      })
      const stillCurrent = canApplyLineWindowResult(mountedRef.current, lineWindowGenerations.current, file.id, requestId)
        && (lineWindowEpochs.current.get(file.id) ?? 0) === (edge === 'replace' ? epoch + 1 : epoch)
        && filesRef.current.some((item) => item.id === file.id && item.artifactId === file.artifactId)
      if (!stillCurrent) {
        if (lineScrollAnchor.current?.fileId === file.id) lineScrollAnchor.current = null
        return undefined
      }
      const loaded: LoadedLineWindow = {
        startLine: result.startLine,
        lines: result.lines,
        hasMoreBefore: result.hasMoreBefore,
        hasMoreAfter: result.hasMoreAfter,
        totalLines: result.totalLines,
      }
      const nextWindow = edge === 'replace'
        ? loaded
        : mergeLineWindow(lineWindowsRef.current[file.id], loaded, edge)
      lineWindowsRef.current = { ...lineWindowsRef.current, [file.id]: nextWindow }
      setLineWindows((current) => ({ ...current, [file.id]: nextWindow }))
      return nextWindow
    } catch (error) {
      if (lineScrollAnchor.current?.fileId === file.id) lineScrollAnchor.current = null
      if (canApplyLineWindowResult(mountedRef.current, lineWindowGenerations.current, file.id, requestId)
        && (lineWindowEpochs.current.get(file.id) ?? 0) === (edge === 'replace' ? epoch + 1 : epoch)) {
        onNotify?.(error instanceof Error ? error.message : '로그 구간을 열지 못했습니다.', 'error')
      }
    } finally {
      pendingLineWindowRequests.current.delete(requestKey)
      releaseTask()
      if (lineWindowTasks.current.get(file.id) === task) lineWindowTasks.current.delete(file.id)
      if (mountedRef.current) setWindowLoading(pendingLineWindowRequests.current.size > 0)
    }
  }, [onNotify])

  const scheduleAnimationFrame = useCallback((callback: () => void) => {
    if (!mountedRef.current) return
    let frameId = 0
    frameId = window.requestAnimationFrame(() => {
      animationFrameIds.current.delete(frameId)
      if (!mountedRef.current) return
      callback()
    })
    animationFrameIds.current.add(frameId)
  }, [])

  useLayoutEffect(() => {
    const anchor = lineScrollAnchor.current
    if (!anchor || anchor.fileId !== activeFileId) return
    const editor = editorRef.current
    if (!editor) return
    const line = editor.querySelector<HTMLElement>(`[data-line="${anchor.lineNumber}"]`)
    if (line) {
      const editorTop = editor.getBoundingClientRect().top
      editor.scrollTop += line.getBoundingClientRect().top - editorTop - anchor.viewportOffset
    }
    lineScrollAnchor.current = null
  }, [activeFileId, activeWindow?.startLine, activeWindow?.lines.length])

  const captureLineScrollAnchor = useCallback((editor: HTMLDivElement, fileId: string) => {
    const editorTop = editor.getBoundingClientRect().top
    const visibleLine = [...editor.querySelectorAll<HTMLElement>('.log-line[data-line]')]
      .find((line) => line.getBoundingClientRect().bottom > editorTop)
    const lineNumber = Number(visibleLine?.dataset.line)
    if (!visibleLine || !Number.isFinite(lineNumber)) return
    lineScrollAnchor.current = {
      fileId,
      lineNumber,
      viewportOffset: visibleLine.getBoundingClientRect().top - editorTop,
    }
  }, [])

  const handleEditorScroll = useCallback(() => {
    if (scrollFrameId.current !== undefined) return
    scrollFrameId.current = window.requestAnimationFrame(() => {
      scrollFrameId.current = undefined
      const editor = editorRef.current
      const file = filesRef.current.find((item) => item.id === activeFileIdRef.current)
      const windowState = lineWindowsRef.current[activeFileIdRef.current]
      if (!editor || !file?.artifactId || !windowState?.lines.length || !mountedRef.current) return
      if ([...pendingLineWindowRequests.current].some((key) => key.startsWith(`${file.id}:`))) return
      const threshold = Math.max(480, editor.clientHeight * 1.5)
      const nearTop = editor.scrollTop <= threshold
      const nearBottom = editor.scrollHeight - editor.scrollTop - editor.clientHeight <= threshold
      if (nearTop && windowState.hasMoreBefore) {
        const boundary = windowState.startLine
        const key = `${lineWindowEdgeRequestKey(file.id, 'before', boundary)}:${lineWindowEpochs.current.get(file.id) ?? 0}`
        if (!pendingLineWindowRequests.current.has(key)) {
          captureLineScrollAnchor(editor, file.id)
          void loadLineWindow(file, boundary, 'before')
        }
      } else if (nearBottom && windowState.hasMoreAfter) {
        const boundary = windowState.lines.at(-1)!.lineNumber
        const key = `${lineWindowEdgeRequestKey(file.id, 'after', boundary)}:${lineWindowEpochs.current.get(file.id) ?? 0}`
        if (!pendingLineWindowRequests.current.has(key)) {
          captureLineScrollAnchor(editor, file.id)
          void loadLineWindow(file, boundary, 'after')
        }
      }
    })
  }, [captureLineScrollAnchor, loadLineWindow])

  useEffect(() => {
    if (!activeWindow?.lines.length) return
    handleEditorScroll()
  }, [activeFileId, activeWindow?.hasMoreAfter, activeWindow?.hasMoreBefore, activeWindow?.lines.length, activeWindow?.startLine, handleEditorScroll])

  const scheduleScroll = useCallback((
    fileId: string,
    lineNumber: number,
    requestGeneration: number,
    expectedHitKey?: string,
  ) => {
    scheduleAnimationFrame(() => {
      if (!canApplyRevealRequest(
        mountedRef.current,
        revealGeneration.current,
        requestGeneration,
        expectedHitKey,
        activeHitKeyRef.current,
      )) return
      if (activeFileIdRef.current !== fileId) return
      editorRef.current?.querySelector(`[data-line="${lineNumber}"]`)?.scrollIntoView({ block: 'center' })
    })
  }, [scheduleAnimationFrame])

  const revealLine = useCallback(async (file: WorkbenchFile, lineNumber: number) => {
    selectFile(file.id, false)
    const requestGeneration = ++revealGeneration.current
    setRevealedLine({ fileId: file.id, lineNumber })
    const loaded = lineWindows[file.id]
    if (file.artifactId && !loaded?.lines.some((line) => line.lineNumber === lineNumber)) {
      const result = await loadLineWindow(file, lineNumber)
      if (!result) return
    }
    if (!canApplyRevealRequest(mountedRef.current, revealGeneration.current, requestGeneration)) return
    scheduleScroll(file.id, lineNumber, requestGeneration)
  }, [lineWindows, loadLineWindow, scheduleScroll, selectFile])

  const moveToHit = useCallback((direction: 1 | -1) => {
    if (!hits.length) return
    const next = (currentHit + direction + hits.length) % hits.length
    navigateToSearchHit(next)
  }, [currentHit, hits.length, navigateToSearchHit])

  const openSearch = useCallback((scope: SearchScope, nextReplaceMode = replaceMode) => {
    setSearchScope(scope)
    setSearchOpen(true)
    setReplaceMode(nextReplaceMode)
    setSideMode(scope === 'file' ? 'files' : 'search')
    setCurrentHit(0)
    authorizedHitKeyRef.current = ''
    scheduleAnimationFrame(() => searchInputRef.current?.select())
  }, [replaceMode, scheduleAnimationFrame])

  const replaceCurrent = useCallback(() => {
    setDraftError('')
    if (!activeFile || !activeHit) {
      setDraftError('현재 검색 결과가 없습니다.')
      return
    }
    if (activeFile.id !== activeHit.fileId) {
      setDraftError('현재 탭과 검색 결과가 다릅니다.')
      return
    }
    const sourceLine = activeSourceLines.find((line) => line.lineNumber === activeHit.line)
    if (!sourceLine) {
      setDraftError('표시 중인 원문 줄이 없습니다.')
      return
    }
    const expected = resolveCurrentReplacementText(activeFile.id, activeHit, sourceLine)
    if (!expected.ok) {
      setDraftError(expected.message)
      return
    }
    const result = addCurrentReplacement(logDraft, {
      fileId: activeHit.fileId,
      line: activeHit.line,
      expected: { start: activeHit.start, end: activeHit.end, text: expected.text },
      replacement,
    })
    if (!result.validation.ok) {
      setDraftError(draftValidationMessage(result.validation))
      return
    }
    const addedOperationIndex = result.draft.operations.length - 1
    const applied = applyLogDraftLine(result.draft, activeHit.fileId, activeHit.line, sourceLine.text)
    const stale = applied.issues.find((issue) => issue.operationIndex === addedOperationIndex)
    if (stale) {
      setDraftError(draftValidationMessage(stale.validation))
      return
    }
    setLogDraft(result.draft)
    setReplaceMode(true)
    moveToHit(1)
  }, [activeFile, activeHit, activeSourceLines, logDraft, moveToHit, replacement])

  const replaceAll = useCallback(() => {
    setDraftError('')
    if (invalidPattern || searching || Boolean(searchError)) return
    const scopeFiles = resolveSearchScopeFiles(searchScope, files, activeFileId, openFileIds)
    const result = addReplaceAll(logDraft, {
      fileIds: scopeFiles.map((file) => file.id),
      pattern: query,
      replacement,
      mode: options.regex ? 'regex' : 'literal',
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
    })
    if (!result.validation.ok) {
      setDraftError(draftValidationMessage(result.validation))
      return
    }
    setLogDraft(result.draft)
  }, [activeFileId, files, invalidPattern, logDraft, openFileIds, options.caseSensitive, options.regex, options.wholeWord, query, replacement, searchError, searching, searchScope])

  const resetDraft = useCallback(() => {
    setLogDraft(resetLogDraft(logDraft))
    setDraftError('')
  }, [logDraft])

  const startPatternReview = async () => {
    const api = electronApi()
    if (!api?.analysis || !activeFile?.artifactId || !mountedRef.current) return
    const fileId = activeFile.id
    const requestGeneration = patternReviewGeneration.current + 1
    const userComment = buildPatternReviewComment(
      patternReviewComment,
      query,
      searchHistory[fileId] ?? [],
    )
    patternReviewGeneration.current = requestGeneration
    patternReviewJobIdRef.current = ''
    patternReviewFileIdRef.current = fileId
    setPatternReview({ status: 'starting', stage: '분석 요청 중…' })
    try {
      const started = await api.analysis.start({
        artifactId: activeFile.artifactId,
        userComment,
        projectContext: clipPatternReviewText(`${activeFile.name} ${activeFile.relativePath ?? ''}`, 180),
      })
      if (!mountedRef.current || patternReviewGeneration.current !== requestGeneration || activeFileIdRef.current !== fileId) {
        bestEffortCancelAnalysisJob(api, started.status, started.id)
        return
      }
      patternReviewJobIdRef.current = started.id
      applyPatternReviewJob(started, requestGeneration)
      if (started.status === 'queued' || started.status === 'running') {
        try {
          const latest = await api.analysis.get(started.id)
          if (latest) applyPatternReviewJob(latest, requestGeneration)
        } catch {
          // The update subscription remains authoritative if the initial refresh races the job.
        }
      }
    } catch (error) {
      if (!mountedRef.current || patternReviewGeneration.current !== requestGeneration || activeFileIdRef.current !== fileId) return
      setPatternReview({
        status: 'failed',
        error: error instanceof Error ? error.message : 'AI 패턴 검토를 시작하지 못했습니다.',
      })
    }
  }

  const cancelPatternReview = async () => {
    const api = electronApi()
    const jobId = patternReviewJobIdRef.current
    const fileId = patternReviewFileIdRef.current
    if (!api?.analysis || !jobId || !mountedRef.current) return
    const cancelGeneration = patternReviewGeneration.current
    patternReviewJobIdRef.current = ''
    setPatternReview((current) => ({ ...current, status: 'cancelling', stage: '취소 중…' }))
    try {
      const cancelled = await api.analysis.cancel(jobId)
      if (!mountedRef.current || patternReviewGeneration.current !== cancelGeneration || activeFileIdRef.current !== fileId) return
      if (!cancelled) {
        patternReviewJobIdRef.current = jobId
        const latest = await api.analysis.get(jobId)
        if (latest) applyPatternReviewJob(latest, cancelGeneration)
        return
      }
      setPatternReview({ status: 'cancelled', jobId, stage: '사용자 취소' })
    } catch (error) {
      if (!mountedRef.current || patternReviewGeneration.current !== cancelGeneration || activeFileIdRef.current !== fileId) return
      patternReviewJobIdRef.current = jobId
      setPatternReview({
        status: 'failed',
        jobId,
        error: error instanceof Error ? error.message : 'AI 패턴 검토를 취소하지 못했습니다.',
      })
    }
  }

  const applySuggestedSearch = (suggestion: string) => {
    const nextQuery = clipPatternReviewText(suggestion, 96)
    if (!nextQuery) return
    setQuery(nextQuery)
    openSearch('file')
  }

  useEffect(() => {
    if (!files.length) return
    if (activeFileId && !files.some((file) => file.id === activeFileId)) {
      bestEffortCancelPatternReview()
      batchGeneration.current = advanceBatchGeneration(batchGeneration.current)
      activeFileIdRef.current = files[0].id
      patternReviewGeneration.current += 1
      patternReviewJobIdRef.current = ''
      patternReviewFileIdRef.current = files[0].id
      setPatternReview({ status: 'idle' })
      setActiveFileId(files[0].id)
      setOpenFileIds((current) => current.includes(files[0].id) ? current : [...current, files[0].id])
    }
  }, [activeFileId, bestEffortCancelPatternReview, files])

  useEffect(() => {
    if (controlledFiles !== undefined) return undefined
    const api = electronApi()
    if (!api) return undefined
    let active = true
    void api.artifacts.list().then((artifacts) => {
      if (!active) return
      const logs = dedupeWorkbenchFiles(artifacts.filter((artifact) => artifact.extension.replace(/^\./, '').toLowerCase() === 'log').flatMap(artifactFiles))
      setLocalFiles(logs)
      setExpandedOrigins(new Set(groupWorkbenchFiles(logs).map((group) => group.key)))
    }).catch((error) => {
      if (active) onNotify?.(error instanceof Error ? error.message : '저장된 로그를 불러오지 못했습니다.', 'error')
    })
    return () => { active = false }
  }, [controlledFiles, onNotify])

  useEffect(() => {
    try {
      const loadedResult = loadLogWorkbenchState(window.localStorage, projectId)
      const loaded = loadedResult.state
      const observationsBySource: Record<string, SearchObservation[]> = {}
      loaded.observations.forEach((observation) => {
        observationsBySource[observation.sourceId] = [...(observationsBySource[observation.sourceId] ?? []), observation]
      })
      setSearchHistory(observationsBySource)
      setSelectedObservationIdsByFile(Object.fromEntries(Object.entries(observationsBySource).map(([sourceId, observations]) => [
        sourceId,
        observations.filter((observation) => observation.role === 'decision_evidence').map((observation) => observation.id),
      ])))
      const loadedDecisions = Object.fromEntries(loaded.decisions.map((item) => [item.sourceId, item.result]))
      setSavedDecisions(window.sequenceIntelligence?.evaluations ? {} : loadedDecisions)
      if (!window.sequenceIntelligence?.evaluations) {
        setDecisions((current) => ({ ...current, ...loadedDecisions }))
      }
      setSavedRecipes(loaded.recipes)
      if (loadedResult.status === 'corrupt' || loadedResult.status === 'unsupported-version') {
        const key = logWorkbenchStorageKey(projectId)
        const raw = window.localStorage.getItem(key)
        if (raw) window.localStorage.setItem(`${key}:corrupt:${Date.now()}`, raw)
        if (!recoveryNoticeProjects.current.has(projectId)) {
          recoveryNoticeProjects.current.add(projectId)
          onNotify?.('저장된 분석 상태를 읽지 못해 원본을 백업하고 새 상태로 시작합니다.', 'error')
        }
      }
    } catch {
      // The Workbench remains fully functional when storage is unavailable.
    }
  }, [onNotify, projectId])

  useEffect(() => {
    if (!activeFile?.artifactId || activeWindow) return
    void loadLineWindow(activeFile, 1)
  }, [activeFile, activeWindow, loadLineWindow])

  useEffect(() => {
    setInvalidPattern(Boolean(query && !createSearchPattern(query, options)))
    setCurrentHit(0)
  }, [options, query])

  useEffect(() => {
    setCurrentHit(0)
  }, [searchFileIdsKey])

  useEffect(() => {
    setCurrentHit((index) => clampSearchHitIndex(index, hits.length))
  }, [hits.length])

  useEffect(() => {
    const api = electronApi()
    const artifactIds = [...new Set(searchFiles.flatMap((file) => file.artifactId ? [file.artifactId] : []))]
    const requestId = advanceSearchRequestGeneration(searchRequest.current)
    searchRequest.current = requestId
    setBackendHits([])
    setBackendCounts({})
    setBackendTotal(0)
    setSearchError('')
    if (!api || !query.trim() || invalidPattern || !artifactIds.length) {
      setSearching(false)
      return () => {
        if (searchRequest.current === requestId) {
          searchRequest.current = advanceSearchRequestGeneration(searchRequest.current)
        }
      }
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      const compiled = backendQuery(query, options)
      void searchArtifactsBatched(api, artifactIds, {
        query: compiled.query,
        mode: compiled.mode,
        caseSensitive: options.caseSensitive,
        maxMatches: 500,
        contextLines: 2,
      }).then((result) => {
        if (!canApplySearchResult(mountedRef.current, searchRequest.current, requestId)) return
        const rowsByArtifact = new Map<string, WorkbenchFile[]>()
        searchFiles.forEach((file) => {
          if (!file.artifactId) return
          rowsByArtifact.set(file.artifactId, [...(rowsByArtifact.get(file.artifactId) ?? []), file])
        })
        setBackendHits(result.matches.flatMap((match) => (rowsByArtifact.get(match.artifactId) ?? []).map((row) => ({
          fileId: row.id,
          line: match.lineNumber,
          start: Math.max(0, match.columnStart - 1),
          end: Math.max(match.columnStart, match.columnEnd - 1),
          excerpt: match.lineText.trim(),
        }))))
        const successfulCounts = successfulSearchCounts(searchFiles, result)
        setBackendCounts(successfulCounts)
        setBackendTotal(Object.values(successfulCounts).reduce((total, count) => total + count, 0))
        const failure = result.files.find((file) => file.error)?.error
        setSearchError(failure ?? '')
      }).catch((error) => {
        if (!canApplySearchResult(mountedRef.current, searchRequest.current, requestId)) return
        setSearchError(error instanceof Error ? error.message : '검색하지 못했습니다.')
      }).finally(() => {
        if (canApplySearchResult(mountedRef.current, searchRequest.current, requestId)) setSearching(false)
      })
    }, 280)
    return () => {
      window.clearTimeout(timer)
      if (searchRequest.current === requestId) {
        searchRequest.current = advanceSearchRequestGeneration(searchRequest.current)
      }
    }
  }, [invalidPattern, options, query, searchFiles])

  useEffect(() => {
    if (!query.trim() || invalidPattern || !activeFile || searching) return undefined
    window.clearTimeout(observationTimer.current)
    observationTimer.current = window.setTimeout(() => {
      const compiled = backendQuery(query, options)
      if (activeFile.artifactId && !Object.prototype.hasOwnProperty.call(backendCounts, activeFile.id)) return
      const count = activeFile.artifactId ? backendCounts[activeFile.id] : collectHits([activeFile], query, options).length
      setSearchHistory((current) => ({
        ...current,
        [activeFile.id]: recordObservation(current[activeFile.id] ?? [], {
          sourceId: activeFile.id,
          query: compiled.query,
          matcherKind: compiled.mode,
          caseSensitive: options.caseSensitive,
          matched: count > 0,
          matchCount: count,
          role: 'search_history',
        }),
      }))
    }, 650)
    return () => window.clearTimeout(observationTimer.current)
  }, [activeFile, backendCounts, invalidPattern, options, query, searching])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey
      if (command && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch('workspace')
        return
      }
      if (command && event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch('open')
        return
      }
      if (command && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch('file')
        return
      }
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault()
        openSearch(searchOpen ? searchScope : 'file', true)
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        if (replaceMode) {
          setReplaceMode(false)
          replacementInputRef.current?.blur()
          scheduleAnimationFrame(() => searchInputRef.current?.focus())
          return
        }
        setSearchOpen(false)
        setReplaceMode(false)
        setSideMode('files')
        searchInputRef.current?.blur()
        return
      }
      if (event.key === 'F3') {
        event.preventDefault()
        if (!searchOpen) {
          setSearchOpen(true)
          setSideMode(searchScope === 'file' ? 'files' : 'search')
        }
        moveToHit(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moveToHit, openSearch, replaceMode, scheduleAnimationFrame, searchOpen, searchScope])

  useEffect(() => {
    setRequireMarkerOrder(false)
  }, [activeFile?.id])

  useEffect(() => {
    if (!activeHit || !canRevealActiveHit(searchOpen, activeFileId, activeHit.fileId, activeHitKey, authorizedHitKeyRef.current)) return
    const requestGeneration = ++revealGeneration.current
    const expectedHitKey = activeHitKey
    const target = files.find((file) => file.id === activeHit.fileId)
    const loaded = target ? lineWindows[target.id] : undefined
    const withinWindow = loaded?.lines.some((line) => line.lineNumber === activeHit.line)
    const reveal = () => scheduleScroll(target?.id ?? activeHit.fileId, activeHit.line, requestGeneration, expectedHitKey)
    if (target?.artifactId && !withinWindow) {
      void loadLineWindow(target, activeHit.line).then((result) => {
        if (result) reveal()
      })
    } else reveal()
  }, [activeFileId, activeHit, activeHitKey, files, lineWindows, loadLineWindow, scheduleScroll, searchNavigationVersion, searchOpen])

  const importFolder = useCallback(async () => {
    const api = electronApi()
    if (!api?.artifacts?.importFolder) {
      onNotify?.('웹 미리보기에서는 예제 폴더가 열려 있습니다.', 'info')
      return
    }
    if (!canStartImport(importInFlightRef.current)) return
    importInFlightRef.current = true
    batchGeneration.current = invalidateImportBatchGeneration(batchGeneration.current)
    setImporting(true)
    try {
      const result = await api.artifacts.importFolder({ extensions: ['log'], maxFiles: 10000 })
      if (!canApplyImportContinuation(mountedRef.current)) return
      if (result.cancelled) return
      const imported = result.artifacts.flatMap(artifactFiles)
      const next = mergeWorkbenchFiles(filesRef.current, imported)
      updateFiles(next)
      setExpandedOrigins((current) => {
        const nextExpanded = new Set(current)
        groupWorkbenchFiles(imported).forEach((group) => nextExpanded.add(group.key))
        return nextExpanded
      })
      if (imported[0]) selectFile(imported[0].id)
      const limitReached = 'limitReached' in result && result.limitReached === true
      const partial = result.failures.length > 0 || result.skippedCount > 0 || limitReached
      onNotify?.(
        partial
          ? `${imported.length}개 로그를 불러왔지만 일부는 처리하지 못했습니다${result.failures.length ? ` · 실패 ${result.failures.length}` : ''}${result.skippedCount ? ` · 제외 ${result.skippedCount}` : ''}${limitReached ? ' · 10,000개 제한 도달' : ''}.`
          : `${imported.length}개 로그 메타데이터를 불러왔습니다. 내용은 열 때만 읽습니다.`,
        partial ? 'info' : 'success',
      )
    } catch (error) {
      if (!canApplyImportContinuation(mountedRef.current)) return
      onNotify?.(error instanceof Error ? error.message : '폴더를 불러오지 못했습니다.', 'error')
    } finally {
      importInFlightRef.current = false
      if (canApplyImportContinuation(mountedRef.current)) setImporting(false)
    }
  }, [onNotify, selectFile, updateFiles])

  useEffect(() => {
    const handleAppCommand = (event: Event) => {
      const command = (event as CustomEvent<RendererCommand>).detail
      if (command === 'find') openSearch('file')
      else if (command === 'find-workspace') openSearch('workspace')
      else if (command === 'open-logs') void importFolder()
    }
    window.addEventListener('sequence-control-tower:command', handleAppCommand)
    return () => window.removeEventListener('sequence-control-tower:command', handleAppCommand)
  }, [importFolder, openSearch])

  const commitEngineerDecision = async (nextDecision: WorkbenchDecision): Promise<boolean> => {
    if (!activeFile) return false
    try {
      if (!window.sequenceIntelligence?.evaluations) {
        const stored = loadLogWorkbenchState(window.localStorage, projectId).state
        const nextDecisions = [
          ...stored.decisions.filter((item) => item.sourceId !== activeFile.id),
          { sourceId: activeFile.id, result: nextDecision, decidedBy: 'engineer' as const, evidenceObservationIds: [] },
        ]
        const saved = saveLogWorkbenchState(window.localStorage, projectId, { ...stored, decisions: nextDecisions })
        if (!saved.ok) throw new Error(saved.error)
        setSavedDecisions(Object.fromEntries(saved.state.decisions.map((item) => [item.sourceId, item.result])))
      }
      await onDecision?.(activeFile, nextDecision, evidenceLines)
      setDecisions((current) => ({ ...current, [activeFile.id]: nextDecision }))
      setCandidateDecisions((current) => {
        const next = { ...current }
        delete next[activeFile.id]
        return next
      })
      return true
    } catch (error) {
      if (!window.sequenceIntelligence?.evaluations) {
        onNotify?.(error instanceof Error ? `판정을 저장하지 못했습니다: ${error.message}` : '판정을 저장하지 못했습니다.', 'error')
      }
      return false
    }
  }

  const finishDecisionInteraction = (nextDecision: WorkbenchDecision) => {
    setRecipeVisible(nextDecision !== 'UNKNOWN' && recipeObservations.length > 0)
    setRecipeSaved(false)
    setBatchPreview({ status: 'idle', matched: 0, exceptions: 0 })
    setShowBatchExceptions(false)
  }

  const chooseDecision = async (nextDecision: WorkbenchDecision) => {
    if (!activeFile) return
    const existing = savedDecisions[activeFile.id] ?? activeFile.decision
    if (existing && existing !== nextDecision) {
      setCandidateDecisions((current) => ({ ...current, [activeFile.id]: nextDecision }))
      onNotify?.(`기존 ${existing} 판정은 유지했습니다. 규칙 후보로 쓰거나 아래에서 변경을 확정할 수 있습니다.`, 'info')
      finishDecisionInteraction(nextDecision)
      return
    }
    if (await commitEngineerDecision(nextDecision)) finishDecisionInteraction(nextDecision)
  }

  const confirmDecisionRevision = async () => {
    if (!activeFile) return
    const candidate = candidateDecisions[activeFile.id]
    if (!candidate) return
    if (await commitEngineerDecision(candidate)) {
      finishDecisionInteraction(candidate)
      onNotify?.(`${candidate} 판정을 새 revision으로 저장했습니다.`, 'success')
    }
  }

  const toggleEvidence = (line: number) => {
    if (!activeFile) return
    setEvidenceByFile((current) => {
      const existing = current[activeFile.id] ?? []
      const next = existing.includes(line) ? existing.filter((item) => item !== line) : [...existing, line].sort((a, b) => a - b)
      return { ...current, [activeFile.id]: next }
    })
  }

  const toggleRecipeObservation = (observationId: string) => {
    if (!activeFile) return
    setSelectedObservationIdsByFile((current) => {
      const selected = current[activeFile.id] ?? []
      const next = selected.includes(observationId)
        ? selected.filter((id) => id !== observationId)
        : [...selected, observationId]
      return { ...current, [activeFile.id]: next }
    })
    setRequireMarkerOrder(false)
    setRecipeSaved(false)
  }

  const saveRecipe = async () => {
    if (!draft || !activeFile || !decision || decision === 'UNKNOWN') return
    const selectedIds = selectedRecipeObservations.map((observation) => observation.id)
    if (!selectedIds.length) {
      onNotify?.('판정에 사용할 검색 근거를 선택해 주세요.', 'info')
      return
    }
    const promoted = selectDecisionEvidence(searchHistory[activeFile.id] ?? [], selectedIds)
    const engineerDecision = {
      sourceId: activeFile.id,
      result: decision,
      decidedBy: 'engineer' as const,
      evidenceObservationIds: selectedIds,
    }
    const builtRule = buildCandidateRule(engineerDecision, promoted)
    const rule = builtRule && requireMarkerOrder && canRequireMarkerOrder
      ? {
          ...builtRule,
          clauses: builtRule.clauses.map((clause, index, clauses) => index === 0
            ? clause
            : { ...clause, order: { afterClauseId: clauses[index - 1].id } }),
        }
      : builtRule
    if (!rule) {
      onNotify?.('저장할 검색 근거를 먼저 확인해 주세요.', 'info')
      return
    }
    const confirmedDraft = { ...draft, rule }
    try {
      await onSaveRecipe?.(confirmedDraft)
      const stored = loadLogWorkbenchState(window.localStorage, projectId).state
      const existingRecipe = savedRecipes.find((item) => item.metadata.id === rule.id)
      const recipe: LogWorkbenchRecipe = {
        metadata: { id: rule.id, name: `${decision} 판정 규칙`, revision: (existingRecipe?.metadata.revision ?? 0) + 1, updatedAt: new Date().toISOString() },
        rules: [rule],
      }
      const existingDecision = savedDecisions[activeFile.id] ?? activeFile.decision
      const confirmedDecision = existingDecision
        ? { ...engineerDecision, result: existingDecision }
        : engineerDecision
      const nextDecisions = savedDecisions[activeFile.id]
        ? stored.decisions
        : [...stored.decisions, confirmedDecision]
      const nextRecipes = [...savedRecipes.filter((item) => item.metadata.id !== recipe.metadata.id), recipe]
      const saved = saveLogWorkbenchState(window.localStorage, projectId, {
        ...stored,
        observations: [...stored.observations, ...promoted],
        decisions: nextDecisions,
        recipes: nextRecipes,
      })
      if (!saved.ok) throw new Error(saved.error)
      setSearchHistory((current) => ({ ...current, [activeFile.id]: promoted }))
      setSavedRecipes(saved.state.recipes)
      setSavedDecisions(Object.fromEntries(saved.state.decisions.map((item) => [item.sourceId, item.result])))
      setRecipeSaved(true)
      onNotify?.(existingDecision && existingDecision !== decision
        ? `분석 규칙을 저장했습니다. 기존 ${existingDecision} 엔지니어 판정은 유지됩니다.`
        : '분석 규칙을 저장했습니다.', 'success')
    } catch (error) {
      onNotify?.(error instanceof Error ? `분석 규칙을 저장하지 못했습니다: ${error.message}` : '분석 규칙을 저장하지 못했습니다.', 'error')
    }
  }

  const applyBatch = async () => {
    if (!decision || decision === 'UNKNOWN' || !selectedRecipeObservations.length) {
      onNotify?.('일괄 적용할 검색 근거를 선택해 주세요.', 'info')
      return
    }
    if (!activeFile || !mountedRef.current) return
    const runGeneration = advanceBatchGeneration(batchGeneration.current)
    batchGeneration.current = runGeneration
    setBatchPreview({ status: 'running', matched: 0, exceptions: 0 })
    setShowBatchExceptions(false)
    try {
      const api = electronApi()
      const selectedIds = selectedRecipeObservations.map((item) => item.id)
      const promoted = selectDecisionEvidence(searchHistory[activeFile.id] ?? [], selectedIds)
      const builtCandidate = buildCandidateRule({
        sourceId: activeFile.id,
        result: decision,
        decidedBy: 'engineer',
        evidenceObservationIds: selectedIds,
      }, promoted)
      const candidate = builtCandidate && requireMarkerOrder && canRequireMarkerOrder
        ? {
            ...builtCandidate,
            clauses: builtCandidate.clauses.map((clause, index, clauses) => index === 0
              ? clause
              : { ...clause, order: { afterClauseId: clauses[index - 1].id } }),
          }
        : builtCandidate
      if (!candidate) throw new Error('미리 적용할 검색 근거가 없습니다.')
      const ruleMap = new Map<string, RecipeRule>()
      const availableRules = durableRules ?? savedRecipes.flatMap((recipe) => recipe.rules)
      availableRules.forEach((rule) => ruleMap.set(rule.id, rule))
      ruleMap.set(candidate.id, candidate)
      const rules = [...ruleMap.values()]

      const precomputed = new Map<string, PrecomputedDocumentEvidence>()
      const artifactRows = files.filter((file): file is WorkbenchFile & { artifactId: string } => Boolean(file.artifactId))
      if (artifactRows.length) {
        if (!api?.artifacts.inspectEvidence) throw new Error('데스크톱 로컬 검사 서비스를 사용할 수 없습니다.')
        const plan = buildRecipeEvidencePlan(rules)
        const inspected = await api.artifacts.inspectEvidence({
          sources: artifactRows.map((file) => ({
            sourceId: file.id,
            artifactId: file.artifactId,
            ...(file.rootId ? { rootId: file.rootId } : {}),
            ...(file.relativePath ? { relativePath: file.relativePath } : {}),
          })),
          specs: plan.specs,
        })
        if (!canApplyBatchResult(mountedRef.current, batchGeneration.current, runGeneration)) return
        inspected.sources.forEach((source) => {
          precomputed.set(source.sourceId, precomputedEvidenceFromInspection(source, rules, plan))
        })
      }
      files.filter((file) => !file.artifactId).forEach((file) => {
        precomputed.set(file.id, precomputeDocumentEvidence({
          id: file.id,
          text: file.text ?? '',
          fileName: file.name,
          path: file.relativePath,
        }, rules))
      })
      const resolved = resolvePrecomputedBatch(files, rules, precomputed, { ...decisions, ...savedDecisions })
      if (!canApplyBatchResult(mountedRef.current, batchGeneration.current, runGeneration)) return
      await onBatchResults?.(resolved)
      if (!canApplyBatchResult(mountedRef.current, batchGeneration.current, runGeneration)) return
      setBatchPreview({ status: 'done', ...resolved })
      setRecipeVisible(false)
      onNotify?.(`${resolved.matched}개 로그를 로컬 규칙으로 분류했습니다. 예외 ${resolved.exceptions}개${resolved.conflicts ? ` · 기존 판정 충돌 ${resolved.conflicts}개` : ''}`, 'info')
    } catch (error) {
      if (!canApplyBatchResult(mountedRef.current, batchGeneration.current, runGeneration)) return
      const message = error instanceof Error ? error.message : '일괄 미리 적용에 실패했습니다.'
      setBatchPreview({ status: 'error', matched: 0, exceptions: files.length, error: message })
      onNotify?.(message, 'error')
    }
  }

  const closeTab = (event: React.MouseEvent, fileId: string) => {
    event.stopPropagation()
    batchGeneration.current = advanceBatchGeneration(batchGeneration.current)
    const invalidated = advanceFileRequestGeneration(lineWindowGenerations.current, fileId)
    lineWindowGenerations.current = invalidated.generations
    lineWindowEpochs.current.set(fileId, (lineWindowEpochs.current.get(fileId) ?? 0) + 1)
    for (const requestToken of pendingLineWindowRequests.current) {
      if (requestToken.startsWith(`${fileId}:`)) pendingLineWindowRequests.current.delete(requestToken)
    }
    setLineWindows((current) => omitFileCacheEntry(current, fileId))
    setEvidenceByFile((current) => omitFileCacheEntry(current, fileId))
    setRevealedLine((current) => current?.fileId === fileId ? null : current)
    revealGeneration.current += 1
    authorizedHitKeyRef.current = ''
    if (mountedRef.current) setWindowLoading(pendingLineWindowRequests.current.size > 0)
    const closingActive = fileId === activeFileId
    if (closingActive) bestEffortCancelPatternReview()
    const nextOpenFileIds = openFileIds.filter((id) => id !== fileId)
    const nextActive = chooseNextTabId(openFileIds, fileId, activeFileId)
    setOpenFileIds(nextOpenFileIds)
    if (closingActive) {
      patternReviewGeneration.current += 1
      patternReviewJobIdRef.current = ''
      patternReviewFileIdRef.current = nextActive
      patternReviewStatusRef.current = 'idle'
      setPatternReview({ status: 'idle' })
      setActiveFileId(nextActive)
      activeFileIdRef.current = nextActive
      onSelectedFileChange?.(nextActive || null)
    }
  }

  const openBatchExceptions = () => {
    setSideMode('files')
    setShowBatchExceptions(true)
    const firstId = batchPreview.exceptionIds?.[0]
    const file = files.find((item) => item.id === firstId)
    if (!file) return
    const line = firstEvaluationLine(batchPreview.evaluations?.[file.id])
    if (line) void revealLine(file, line)
    else selectFile(file.id)
  }

  const searchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const command = event.ctrlKey || event.metaKey
    if (replaceMode && command && event.altKey && event.key === 'Enter') {
      event.preventDefault()
      replaceAll()
      return
    }
    if (replaceMode && command && event.key === 'Enter') {
      event.preventDefault()
      replaceCurrent()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      moveToHit(event.shiftKey ? -1 : 1)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (replaceMode) {
        setReplaceMode(false)
        replacementInputRef.current?.blur()
        searchInputRef.current?.focus()
      } else {
        setSearchOpen(false)
        setReplaceMode(false)
        setSideMode('files')
        event.currentTarget.blur()
      }
    }
  }

  return (
    <div className="log-workbench">
      <aside className="workbench-sidebar">
        <header>
          <div><strong>{sideMode === 'search' ? '검색 결과' : showBatchExceptions ? '예외 로그' : '로그'}</strong>{sideMode === 'search' ? null : <span>{showBatchExceptions ? `${batchPreview.exceptions}` : files.length}</span>}</div>
          <button
            onClick={() => {
              if (sideMode === 'search') setSideMode('files')
              else if (showBatchExceptions) setShowBatchExceptions(false)
              else openSearch('workspace')
            }}
            aria-label={sideMode === 'search' || showBatchExceptions ? '로그 목록으로 돌아가기' : '모든 로그 검색'}
            title={sideMode === 'search' || showBatchExceptions ? '로그 목록으로 돌아가기' : '모든 로그 검색'}
          >{sideMode === 'search' || showBatchExceptions ? <X size={18} /> : <Search size={18} />}</button>
        </header>

        {sideMode === 'files' ? (
          <div className="folder-tree">
            <button className="add-folder-row" onClick={() => void importFolder()} disabled={importing}>
              {importing ? <LoaderCircle className="wb-spin" size={18} /> : <FolderOpen size={18} />}<span>{importing ? '폴더를 읽는 중…' : '로그 폴더 열기'}</span>
            </button>
            {groupedFiles.map((group) => {
              const expanded = expandedOrigins.has(group.key)
              return (
                <section className="folder-group" key={group.key}>
                  <button className="folder-heading" onClick={() => setExpandedOrigins((current) => {
                    const next = new Set(current)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })} aria-expanded={expanded}>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span title={group.label}>{group.label}</span><small>{group.files.length}</small>
                  </button>
                  {expanded ? group.files.map((file) => (
                    <button className={`file-row ${file.id === activeFile?.id ? 'active' : ''}`} key={file.id} onClick={() => selectFile(file.id)} title={file.relativePath ?? file.name}>
                      <FileText size={13} /><span>{file.name}</span>
                      {decisions[file.id] || file.decision || batchPreview.outcomes?.[file.id] ? <i className={`file-state ${(decisions[file.id] ?? file.decision ?? batchPreview.outcomes?.[file.id])?.toLowerCase()}`} title={decisions[file.id] ?? file.decision ? '엔지니어 판정' : '규칙 미리보기'} /> : null}
                    </button>
                  )) : null}
                </section>
              )
            })}
          </div>
        ) : (
          <div className="workspace-search-results">
            {searchError ? <div className="search-error"><AlertTriangle size={13} />{searchError}</div> : null}
            {query && hits.length ? <>{hits.slice(0, 80).map((hit, index) => {
              const file = files.find((item) => item.id === hit.fileId)
              return (
                <button className={`search-result ${index === currentHit ? 'active' : ''}`} key={`${hit.fileId}-${hit.line}-${hit.start}`} onClick={() => navigateToSearchHit(index)}>
                  <span className="search-result-file"><FileText size={12} />{file?.name}</span>
                  <code className="search-result-line"><b>Ln {hit.line}</b>{hit.excerpt}</code>
                </button>
              )
            })}{searchTotal > Math.min(hits.length, 80) ? <div className="search-result-limit">상위 {Math.min(hits.length, 80)}개 표시 · 전체 {searchTotal.toLocaleString()}개</div> : null}</> : searching ? (
              <div className="empty-search"><LoaderCircle className="wb-spin" size={18} /><span>검색 중…</span></div>
            ) : (
              <div className="empty-search"><Search size={22} /><span>검색어를 입력하세요.</span></div>
            )}
          </div>
        )}
      </aside>

      <main className="workbench-editor-shell">
        <div className="editor-tabs" role="tablist" aria-label="열린 로그">
          {openFileIds.map((fileId) => {
            const file = files.find((item) => item.id === fileId)
            if (!file) return null
            return (
              <div role="tab" aria-selected={fileId === activeFile?.id} className={`editor-tab ${fileId === activeFile?.id ? 'active' : ''}`} key={fileId}>
                <button className="editor-tab-select" onClick={() => selectFile(fileId)} title={file.relativePath ?? file.name}><FileText size={13} /><span>{file.name}</span><i>{decisions[fileId] ?? file.decision ?? ''}</i></button>
                <button className="editor-tab-close" onClick={(event) => closeTab(event, fileId)} aria-label={`${file.name} 닫기`} title="탭 닫기"><X size={13} /></button>
              </div>
            )
          })}
          <span className="tab-fill" />
        </div>

        <div className="editor-context-bar">
          <span>{activeFile?.relativePath ?? activeFile?.name}</span>
          {activeFile?.truncated ? <b><AlertTriangle size={12} />미리보기 일부</b> : null}
          {logDraft.operations.length ? <span className="draft-status">
            <span id="draft-evidence-note">수정 초안 · 결과/근거는 원본 기준</span>
            <small>{logDraft.operations.length}개 작업</small>
            <button onClick={resetDraft} title="표시 중인 수정 초안을 원문으로 되돌립니다.">초안 초기화</button>
          </span> : null}
        </div>

        {searchOpen ? (
          <div className={`find-widget ${replaceMode ? 'is-replace-mode' : ''}`} role="search" aria-label="로그 검색">
            <Search size={18} />
            <select className="find-scope-select" value={searchScope} onChange={(event) => openSearch(event.target.value as SearchScope)} aria-label="검색 범위" title="검색 범위">
              <option value="file">현재 로그</option>
              <option value="open">열린 탭</option>
              <option value="workspace">전체 로그</option>
            </select>
            <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKeyDown} placeholder="검색어 입력" aria-invalid={invalidPattern} />
            <button className={searchOptionsOpen || Object.values(options).some(Boolean) ? 'active' : ''} aria-expanded={searchOptionsOpen} onClick={() => setSearchOptionsOpen((current) => !current)} aria-label="검색 옵션" title="검색 옵션"><SlidersHorizontal size={17} /></button>
            <span className={`find-match-count ${invalidPattern || searchError ? 'invalid' : ''}`} aria-live="polite">{searching ? '검색 중…' : invalidPattern ? '식 오류' : searchError ? '검색 실패' : query ? `${hits.length ? currentHit + 1 : 0}/${hits.length}${searchTotal > hits.length ? ` · 총 ${searchTotal}` : ''}` : '0 / 0'}</span>
            <button onClick={() => moveToHit(-1)} disabled={!hits.length} aria-label="이전 검색 결과" title="이전 결과 (Shift+Enter)"><ChevronsUp size={18} /></button>
            <button onClick={() => moveToHit(1)} disabled={!hits.length} aria-label="다음 검색 결과" title="다음 결과 (Enter)"><ChevronsDown size={18} /></button>
            <button onClick={() => { setSearchOpen(false); setReplaceMode(false); setSideMode('files') }} aria-label="검색 닫기" title="닫기 (Escape)"><X size={18} /></button>
            {replaceMode ? <div className="replace-row">
              <span aria-hidden="true">↳</span>
              <input ref={replacementInputRef} value={replacement} onChange={(event) => setReplacement(event.target.value)} onKeyDown={searchKeyDown} placeholder="바꿀 내용" aria-label="바꿀 내용" />
              <button onClick={replaceCurrent} disabled={!activeHit} title="현재 검색 결과를 한 번 바꿉니다. (Ctrl/Cmd+Enter)">현재 바꾸기</button>
              <button onClick={replaceAll} disabled={!query || !searchFiles.length || invalidPattern || searching || Boolean(searchError)} title="현재 검색 범위의 원문에 작업을 추가합니다. (Ctrl/Cmd+Alt+Enter)">모두 바꾸기</button>
            </div> : null}
            {replaceMode && displayedDraftError ? <div className="draft-error" role="alert"><AlertTriangle size={13} />{displayedDraftError}</div> : null}
            {searchOptionsOpen ? <div className="search-options-popover" aria-label="검색 옵션">
              {(Object.keys(options) as Array<keyof SearchOptions>).map((option) => {
                const Icon = option === 'caseSensitive' ? CaseSensitive : option === 'wholeWord' ? WholeWord : Regex
                return <button className={options[option] ? 'active' : ''} aria-pressed={options[option]} onClick={() => setOptions((current) => ({ ...current, [option]: !current[option] }))} key={option}><Icon size={16} /><span>{optionLabel(option)}</span>{options[option] ? <Check size={15} /> : null}</button>
              })}
            </div> : null}
          </div>
        ) : null}

        <div className="log-editor" ref={editorRef} onScroll={handleEditorScroll} tabIndex={0} aria-label={`${activeFile?.name ?? '로그'} 읽기 전용 편집기`}>
          {activeFile && activeLines.length ? activeLines.map((line) => {
            const lineNumber = line.lineNumber
            const isEvidence = evidenceLines.includes(lineNumber)
            const isActiveLine = !draftActiveForFile && activeHit?.fileId === activeFile.id && activeHit.line === lineNumber
            const isRevealedLine = revealedLine?.fileId === activeFile.id && revealedLine.lineNumber === lineNumber
            return (
              <div className={`log-line ${isEvidence ? 'is-evidence' : ''} ${isActiveLine ? 'is-active-hit' : ''} ${isRevealedLine ? 'is-revealed-line' : ''}`} data-line={lineNumber} key={lineNumber}>
                <button className="evidence-gutter" disabled={draftActiveForFile} aria-describedby={draftActiveForFile ? 'draft-evidence-note' : undefined} aria-label={draftActiveForFile ? '수정 초안 표시 중에는 판정 근거를 바꿀 수 없습니다.' : `${lineNumber}번 줄을 판정 근거로 ${isEvidence ? '해제' : '지정'}`} title={draftActiveForFile ? '초안 초기화 후 원문에서 판정 근거를 바꿀 수 있습니다.' : '판정 근거 표시'} onClick={() => toggleEvidence(lineNumber)}>{isEvidence ? <CircleDot size={11} /> : <Circle size={10} />}</button>
                <span className="line-number">{lineNumber}</span>
                <code>{renderHighlightedLine(line.text, lineNumber, draftActiveForFile ? [] : activeHitsByLine.get(lineNumber) ?? [], draftActiveForFile ? undefined : activeHit)}</code>
              </div>
            )
          }) : <div className="editor-empty">{windowLoading ? <LoaderCircle className="wb-spin" size={22} /> : <FolderOpen size={22} />}<span>{windowLoading ? '필요한 로그 구간을 읽고 있습니다.' : '분석할 로그 폴더를 추가하세요.'}</span></div>}
        </div>

        <footer className="editor-statusbar">
          <span className="status-spacer" />
          <button onClick={() => openSearch('file')}><Search size={14} />현재 로그 찾기 <kbd>Ctrl F</kbd></button>
          <button onClick={() => openSearch('open')}><Search size={14} />열린 탭 찾기 <kbd>Ctrl Alt F</kbd></button>
          <button onClick={() => openSearch('workspace')}><SearchCode size={14} />전체 로그 찾기 <kbd>Ctrl Shift F</kbd></button>
        </footer>
      </main>

      <aside className="decision-panel" aria-label="로그 판정">
        <header>
          <strong>판정</strong>
        </header>

        <div className="decision-content">
          {activeFile ? (
            <>
              <section className="decision-picker" aria-label="결과 선택">
                <div className="section-label"><label htmlFor="decision-select">결과</label><span>검색 {searchHistory[activeFile.id]?.length ?? 0} · 근거 {evidenceLines.length}</span></div>
                <div className={`decision-select ${DECISIONS.find((item) => item.value === decision)?.tone ?? 'unset'}`}><i /><select id="decision-select" value={decision ?? ''} onChange={(event) => { if (event.target.value) void chooseDecision(event.target.value as WorkbenchDecision) }}><option value="">결과를 선택하세요</option>{DECISIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select><ChevronDown size={18} /></div>
                {activeFile.decision && candidateDecisions[activeFile.id] && candidateDecisions[activeFile.id] !== activeFile.decision ? <button className="confirm-decision-revision" onClick={() => void confirmDecisionRevision()}>기존 {activeFile.decision} → {candidateDecisions[activeFile.id]} 변경 확정</button> : null}
              </section>

              <section className="pattern-review" aria-label="AI 패턴 검토">
                <div className="pattern-review-heading">
                  <div><strong>AI 패턴 검토</strong></div>
                  <SearchCode size={15} />
                </div>
                <textarea
                  value={patternReviewComment}
                  onChange={(event) => setPatternReviewComment(event.target.value.slice(0, 160))}
                  placeholder="검토 메모 (선택)"
                  maxLength={160}
                  rows={2}
                  disabled={patternReviewBusy}
                  aria-label="AI 패턴 검토 코멘트"
                />
                <div className="pattern-review-actions">
                  <button className="pattern-review-start" onClick={() => void startPatternReview()} disabled={!patternReviewAvailable || patternReviewBusy}>
                    {patternReviewBusy ? <LoaderCircle className="wb-spin" size={13} /> : <SearchCode size={13} />}
                    {patternReviewBusy ? '검토 중' : '검토 실행'}
                  </button>
                  {patternReviewBusy && patternReview.jobId ? <button className="pattern-review-cancel" onClick={() => void cancelPatternReview()} disabled={patternReview.status === 'cancelling'}>취소</button> : null}
                </div>
                {!patternReviewAvailable ? <small className="pattern-review-hint">가져온 로그를 선택하면 사용할 수 있습니다.</small> : null}
                {patternReviewBusy ? (
                  <div className="pattern-review-progress" role="status" aria-live="polite">
                    <span><LoaderCircle className="wb-spin" size={13} />{patternReview.stage || '분석 준비 중…'}</span>
                    {patternReview.queuePosition ? <small>대기 {patternReview.queuePosition}번</small> : null}
                  </div>
                ) : null}
                {patternReview.status === 'cancelled' ? <p className="pattern-review-note">검토를 취소했습니다.</p> : null}
                {patternReview.status === 'failed' ? <p className="pattern-review-error"><AlertTriangle size={13} />{patternReview.error || '검토에 실패했습니다.'}</p> : null}
                {patternReview.result ? (
                  <div className="pattern-review-result">
                    <div className="pattern-review-result-meta"><strong>검토 결과</strong>{patternReview.result.warnings.length ? <small>경고 {patternReview.result.warnings.length}건</small> : null}</div>
                    <p>{patternReview.result.summary}</p>
                    {patternReview.result.suggestedTags.length ? (
                      <div className="pattern-review-suggestions">
                        <span>추천 태그·검색</span>
                        <div>{patternReview.result.suggestedTags.slice(0, 6).map((suggestion) => <button key={suggestion} onClick={() => applySuggestedSearch(suggestion)} title="눌러서 현재 로그 검색에 사용">{suggestion}</button>)}</div>
                      </div>
                    ) : null}
                    {patternReview.result.warnings.length ? <ul>{patternReview.result.warnings.slice(0, 4).map((warning) => <li key={warning}><AlertTriangle size={12} />{warning}</li>)}</ul> : null}
                  </div>
                ) : null}
              </section>

              {showBatchExceptions && (activeBatchConflict || activeBatchEvaluation?.exceptions.length) ? (
                <section className="exception-detail" aria-label="예외 이유">
                  <div className="section-label"><span>검토 이유</span></div>
                  {activeBatchConflict ? <p><AlertTriangle size={14} /><span>엔지니어 판정과 규칙 결과가 다릅니다.</span></p> : null}
                  {activeBatchEvaluation?.exceptions.map((exception) => <p key={`${exception.code}-${exception.ruleIds.join('-')}`}><AlertTriangle size={14} /><span>{exceptionLabel(exception.code)}</span></p>)}
                  {firstEvaluationLine(activeBatchEvaluation) ? <button onClick={() => void revealLine(activeFile, firstEvaluationLine(activeBatchEvaluation)!)}>Ln {firstEvaluationLine(activeBatchEvaluation)} 근거로 이동</button> : null}
                </section>
              ) : null}

              {evidenceLines.length ? (
                <section className="evidence-list">
                  <div className="section-label"><span>원문 북마크</span><small>{evidenceLines.length}</small></div>
                  {evidenceLines.slice(0, 4).map((lineNumber) => <button onClick={() => void revealLine(activeFile, lineNumber)} key={lineNumber}><b>Ln {lineNumber}</b><code>{activeSourceLines.find((line) => line.lineNumber === lineNumber)?.text.trim() ?? '원문 위치로 이동'}</code></button>)}
                </section>
              ) : (
                <div className="evidence-hint"><span>줄 왼쪽을 눌러 다시 볼 원문을 표시하세요.</span></div>
              )}

              {!recipeVisible && draft && recipeObservations.length > 0 && !recipeSaved ? (
                <button className="recipe-reopen" onClick={() => setRecipeVisible(true)}><Braces size={17} /><strong>분석 규칙 저장</strong></button>
              ) : null}

              {recipeVisible && draft ? (
                <section className="recipe-suggestion">
                  <div className="recipe-title"><strong>분석 규칙</strong><button onClick={() => setRecipeVisible(false)} aria-label="제안 닫기"><X size={15} /></button></div>
                  <div className="recipe-observations" aria-label="판정에 사용할 검색 근거">
                    <span>판정에 사용할 검색을 선택하세요</span>
                    {recipeObservations.map((observation) => {
                      const selected = selectedRecipeObservations.some((item) => item.id === observation.id)
                      return <button className={selected ? 'selected' : ''} aria-pressed={selected} onClick={() => toggleRecipeObservation(observation.id)} key={observation.id}><i>{selected ? <Check size={13} /> : null}</i><code>{observation.query}</code><small>{observation.matched ? `${observation.matchCount}회` : '없음'}</small></button>
                    })}
                  </div>
                  {canRequireMarkerOrder ? <button className={requireMarkerOrder ? 'recipe-order active' : 'recipe-order'} aria-pressed={requireMarkerOrder} onClick={() => setRequireMarkerOrder((current) => !current)}><i>{requireMarkerOrder ? <Check size={12} /> : null}</i><span>표시된 순서대로 나타나야 함</span></button> : null}
                  <div className="recipe-logic">
                    {draft.positiveTerms.length ? <p><Check size={12} /><span>{draft.positiveTerms.join(' · ')}</span></p> : null}
                    {draft.missingTerms.length ? <p><X size={12} /><span>{draft.missingTerms.join(' · ')} 없음</span></p> : null}
                    <p><Play size={12} /><span>그러면 <b>{draft.decision}</b></span></p>
                  </div>
                  <div className="recipe-actions">
                    <button className="save" onClick={() => void saveRecipe()} disabled={recipeSaved || !selectedRecipeObservations.length}>{recipeSaved ? <Check size={14} /> : <Braces size={14} />}{recipeSaved ? '저장됨' : '규칙 저장'}</button>
                    <button onClick={() => void applyBatch()} disabled={batchPreview.status === 'running' || !selectedRecipeObservations.length}>{batchPreview.status === 'running' ? <LoaderCircle className="wb-spin" size={13} /> : <Play size={13} />}{batchPreview.status === 'running' ? '로컬 계산 중' : '전체에 미리 적용'}</button>
                  </div>
                </section>
              ) : null}

              {batchPreview.status === 'done' ? (
                <section className="batch-summary">
                  <div><Check size={15} /><span><strong>{batchPreview.matched}개</strong> 조건 일치 · 로컬 계산</span></div>
                  <button onClick={openBatchExceptions}><AlertTriangle size={13} /><span>예외 {batchPreview.exceptions}개 확인</span><ChevronRight size={13} /></button>
                </section>
              ) : batchPreview.status === 'error' ? <div className="batch-error"><AlertTriangle size={13} />{batchPreview.error}</div> : null}
            </>
          ) : <div className="decision-empty">로그를 선택하세요.</div>}
        </div>

      </aside>
    </div>
  )
}
