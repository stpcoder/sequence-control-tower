import {
  useCallback,
  useEffect,
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

type SearchScope = 'file' | 'workspace'
type SideMode = 'files' | 'search'

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

interface CountEvidence {
  count?: number
  error?: string
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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function createSearchPattern(query: string, options: SearchOptions, global = true): RegExp | null {
  if (!query) return null
  const source = options.regex ? query : escapeRegExp(query)
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source
  try {
    return new RegExp(bounded, `${global ? 'g' : ''}${options.caseSensitive ? '' : 'i'}`)
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
          end: match.index + Math.max(match[0].length, 1),
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
  return { query: `\\b(?:${source})\\b`, mode: 'regex' }
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
  const [expandedOrigins, setExpandedOrigins] = useState<Set<string>>(() => new Set(files.map((file) => file.origin ?? 'Logs')))
  const [sideMode, setSideMode] = useState<SideMode>('files')
  const [searchScope, setSearchScope] = useState<SearchScope>('file')
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS)
  const [currentHit, setCurrentHit] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const observationTimer = useRef<number | undefined>(undefined)
  const searchRequest = useRef(0)
  const windowRequest = useRef(0)

  const activeFile = files.find((file) => file.id === activeFileId)
  const activeWindow = activeFile ? lineWindows[activeFile.id] : undefined
  const activeLines = useMemo(() => {
    if (!activeFile) return []
    if (artifactBacked(activeFile)) return activeWindow?.lines ?? []
    return (activeFile.text ?? '').split(/\r?\n/).map((text, index) => ({ lineNumber: index + 1, text, truncated: false }))
  }, [activeFile, activeWindow])
  const searchFiles = useMemo(() => searchScope === 'workspace' ? files : activeFile ? [activeFile] : [], [activeFile, files, searchScope])
  const memoryHits = useMemo(() => collectHits(searchFiles, query, options), [options, query, searchFiles])
  const hits = useMemo(() => [...memoryHits, ...backendHits], [backendHits, memoryHits])
  const activeHit = hits[currentHit]
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

  const groupedFiles = useMemo(() => {
    const groups = new Map<string, WorkbenchFile[]>()
    for (const file of files) {
      if (showBatchExceptions && !batchPreview.exceptionIds?.includes(file.id)) continue
      const origin = file.origin || file.relativePath?.split(/[\\/]/)[0] || 'Imported logs'
      const current = groups.get(origin) ?? []
      current.push(file)
      groups.set(origin, current)
    }
    return [...groups.entries()]
  }, [batchPreview.exceptionIds, files, showBatchExceptions])

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
    if (controlledFiles === undefined) setLocalFiles(next)
    onFilesChange?.(next)
  }, [controlledFiles, onFilesChange])

  const selectFile = useCallback((fileId: string, resetSearch = true) => {
    setActiveFileId(fileId)
    setOpenFileIds((current) => current.includes(fileId) ? current : [...current, fileId])
    if (resetSearch) {
      setCurrentHit(0)
      setRevealedLine(null)
    }
    onSelectedFileChange?.(fileId)
  }, [onSelectedFileChange])

  useEffect(() => {
    if (!selectedFileId || !files.some((file) => file.id === selectedFileId)) return
    selectFile(selectedFileId, false)
  }, [files, selectFile, selectedFileId])

  useEffect(() => {
    if (controlledFiles === undefined || !window.sequenceIntelligence?.evaluations) return
    setDecisions(Object.fromEntries(files.flatMap((file) => file.decision ? [[file.id, file.decision] as const] : [])))
  }, [controlledFiles, files])

  useEffect(() => {
    if (activeFile) onEvidenceCountChange?.(activeFile.id, evidenceLines.length)
  }, [activeFile, evidenceLines.length, onEvidenceCountChange])

  const loadLineWindow = useCallback(async (file: WorkbenchFile, targetLine = 1) => {
    const api = electronApi()
    if (!api || !file.artifactId) return
    const requestId = ++windowRequest.current
    setWindowLoading(true)
    try {
      const result = await api.artifacts.getLineWindow({
        artifactId: file.artifactId,
        startLine: Math.max(1, targetLine - 80),
        lineCount: 240,
      })
      if (requestId !== windowRequest.current) return
      setLineWindows((current) => ({
        ...current,
        [file.id]: {
          startLine: result.startLine,
          lines: result.lines,
          hasMoreBefore: result.hasMoreBefore,
          hasMoreAfter: result.hasMoreAfter,
          totalLines: result.totalLines,
        },
      }))
    } catch (error) {
      if (requestId === windowRequest.current) onNotify?.(error instanceof Error ? error.message : '로그 구간을 열지 못했습니다.', 'error')
    } finally {
      if (requestId === windowRequest.current) setWindowLoading(false)
    }
  }, [onNotify])

  const revealLine = useCallback(async (file: WorkbenchFile, lineNumber: number) => {
    setRevealedLine({ fileId: file.id, lineNumber })
    selectFile(file.id, false)
    const loaded = lineWindows[file.id]
    if (file.artifactId && !loaded?.lines.some((line) => line.lineNumber === lineNumber)) {
      await loadLineWindow(file, lineNumber)
    }
    window.requestAnimationFrame(() => {
      editorRef.current?.querySelector(`[data-line="${lineNumber}"]`)?.scrollIntoView({ block: 'center' })
    })
  }, [lineWindows, loadLineWindow, selectFile])

  const moveToHit = useCallback((direction: 1 | -1) => {
    if (!hits.length) return
    const next = (currentHit + direction + hits.length) % hits.length
    const hit = hits[next]
    setCurrentHit(next)
    if (hit.fileId !== activeFileId) selectFile(hit.fileId, false)
    window.requestAnimationFrame(() => {
      editorRef.current?.querySelector(`[data-line="${hit.line}"]`)?.scrollIntoView({ block: 'center' })
    })
  }, [activeFileId, currentHit, hits, selectFile])

  const openSearch = useCallback((scope: SearchScope) => {
    setSearchScope(scope)
    setSearchOpen(true)
    setSideMode(scope === 'workspace' ? 'search' : 'files')
    setCurrentHit(0)
    window.requestAnimationFrame(() => searchInputRef.current?.select())
  }, [])

  useEffect(() => {
    if (!files.length) return
    if (activeFileId && !files.some((file) => file.id === activeFileId)) {
      setActiveFileId(files[0].id)
      setOpenFileIds((current) => current.includes(files[0].id) ? current : [...current, files[0].id])
    }
  }, [activeFileId, files])

  useEffect(() => {
    if (controlledFiles !== undefined) return undefined
    const api = electronApi()
    if (!api) return undefined
    let active = true
    void api.artifacts.list().then((artifacts) => {
      if (!active) return
      const logs = dedupeWorkbenchFiles(artifacts.filter((artifact) => artifact.extension.replace(/^\./, '').toLowerCase() === 'log').flatMap(artifactFiles))
      setLocalFiles(logs)
      setExpandedOrigins(new Set(logs.map((file) => file.origin ?? 'Imported logs')))
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
        onNotify?.('저장된 분석 상태를 읽지 못해 원본을 백업하고 새 상태로 시작합니다.', 'error')
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
    const api = electronApi()
    const artifactIds = [...new Set(searchFiles.flatMap((file) => file.artifactId ? [file.artifactId] : []))]
    const requestId = ++searchRequest.current
    setBackendHits([])
    setBackendCounts({})
    setBackendTotal(0)
    setSearchError('')
    if (!api || !query.trim() || invalidPattern || !artifactIds.length) {
      setSearching(false)
      return undefined
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
        if (requestId !== searchRequest.current) return
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
        if (requestId !== searchRequest.current) return
        setSearchError(error instanceof Error ? error.message : '검색하지 못했습니다.')
      }).finally(() => {
        if (requestId === searchRequest.current) setSearching(false)
      })
    }, 280)
    return () => window.clearTimeout(timer)
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
      if (command && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openSearch('file')
        return
      }
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
        setSideMode('files')
        searchInputRef.current?.blur()
        return
      }
      if (event.key === 'F3') {
        event.preventDefault()
        if (!searchOpen) {
          setSearchOpen(true)
          setSideMode(searchScope === 'workspace' ? 'search' : 'files')
        }
        moveToHit(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moveToHit, openSearch, searchOpen, searchScope])

  useEffect(() => {
    setRequireMarkerOrder(false)
  }, [activeFile?.id])

  useEffect(() => {
    if (!activeHit || !searchOpen) return
    if (activeHit.fileId !== activeFileId) selectFile(activeHit.fileId, false)
    const target = files.find((file) => file.id === activeHit.fileId)
    const loaded = target ? lineWindows[target.id] : undefined
    const withinWindow = loaded?.lines.some((line) => line.lineNumber === activeHit.line)
    const reveal = () => window.requestAnimationFrame(() => {
      editorRef.current?.querySelector(`[data-line="${activeHit.line}"]`)?.scrollIntoView({ block: 'center' })
    })
    if (target?.artifactId && !withinWindow) void loadLineWindow(target, activeHit.line).then(reveal)
    else reveal()
  }, [activeFileId, activeHit, files, lineWindows, loadLineWindow, searchOpen, selectFile])

  const importFolder = async () => {
    const api = electronApi()
    if (!api?.artifacts?.importFolder) {
      onNotify?.('웹 미리보기에서는 예제 폴더가 열려 있습니다.', 'info')
      return
    }
    setImporting(true)
    try {
      const result = await api.artifacts.importFolder({ extensions: ['log'], maxFiles: 10000 })
      if (result.cancelled) return
      const imported = result.artifacts.flatMap(artifactFiles)
      const next = dedupeWorkbenchFiles([...files, ...imported])
      updateFiles(next)
      setExpandedOrigins((current) => new Set([...current, ...imported.map((file) => file.origin ?? 'Imported logs')]))
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
      onNotify?.(error instanceof Error ? error.message : '폴더를 불러오지 못했습니다.', 'error')
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    const handleAppCommand = (event: Event) => {
      const command = (event as CustomEvent<RendererCommand>).detail
      if (command === 'find') openSearch('file')
      else if (command === 'find-workspace') openSearch('workspace')
      else if (command === 'open-logs' && !importing) void importFolder()
    }
    window.addEventListener('sequence-control-tower:command', handleAppCommand)
    return () => window.removeEventListener('sequence-control-tower:command', handleAppCommand)
  }, [importing, openSearch, importFolder])

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
    setBatchPreview({ status: 'running', matched: 0, exceptions: 0 })
    setShowBatchExceptions(false)
    try {
      if (!activeFile) return
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
      await onBatchResults?.(resolved)
      setBatchPreview({ status: 'done', ...resolved })
      setRecipeVisible(false)
      onNotify?.(`${resolved.matched}개 로그를 로컬 규칙으로 분류했습니다. 예외 ${resolved.exceptions}개${resolved.conflicts ? ` · 기존 판정 충돌 ${resolved.conflicts}개` : ''}`, 'info')
    } catch (error) {
      const message = error instanceof Error ? error.message : '일괄 미리 적용에 실패했습니다.'
      setBatchPreview({ status: 'error', matched: 0, exceptions: files.length, error: message })
      onNotify?.(message, 'error')
    }
  }

  const closeTab = (event: React.MouseEvent, fileId: string) => {
    event.stopPropagation()
    setOpenFileIds((current) => {
      const next = current.filter((id) => id !== fileId)
      if (fileId === activeFileId) {
        const nextActive = next.at(-1) ?? ''
        setActiveFileId(nextActive)
        onSelectedFileChange?.(nextActive || null)
      }
      return next
    })
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
    if (event.key === 'Enter') {
      event.preventDefault()
      moveToHit(event.shiftKey ? -1 : 1)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setSearchOpen(false)
      event.currentTarget.blur()
    }
  }

  return (
    <div className="log-workbench">
      <aside className="workbench-sidebar">
        <header>
          <div><strong>{sideMode === 'search' ? '전체 검색' : showBatchExceptions ? '예외 로그' : '로그'}</strong><span>{showBatchExceptions ? `${batchPreview.exceptions}` : files.length}</span></div>
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
            {groupedFiles.map(([origin, group]) => {
              const expanded = expandedOrigins.has(origin)
              return (
                <section className="folder-group" key={origin}>
                  <button className="folder-heading" onClick={() => setExpandedOrigins((current) => {
                    const next = new Set(current)
                    if (next.has(origin)) next.delete(origin)
                    else next.add(origin)
                    return next
                  })} aria-expanded={expanded}>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                    <span title={origin}>{origin}</span><small>{group.length}</small>
                  </button>
                  {expanded ? group.map((file) => (
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
            <div className="side-search-summary">
              <strong>{query ? searchTotal : 0}</strong><span>{searching ? '로컬 로그 검색 중…' : query ? `'${query}' 일치` : '검색어를 입력하세요'}</span>
            </div>
            {searchError ? <div className="search-error"><AlertTriangle size={13} />{searchError}</div> : null}
            {query && hits.length ? <>{hits.slice(0, 80).map((hit, index) => {
              const file = files.find((item) => item.id === hit.fileId)
              return (
                <button className={index === currentHit ? 'active' : ''} key={`${hit.fileId}-${hit.line}-${hit.start}`} onClick={() => { setCurrentHit(index); selectFile(hit.fileId, false) }}>
                  <span><FileText size={12} />{file?.name}</span>
                  <code><b>{hit.line}</b>{hit.excerpt}</code>
                </button>
              )
            })}{searchTotal > Math.min(hits.length, 80) ? <div className="search-result-limit">상위 {Math.min(hits.length, 80)}개 표시 · 전체 {searchTotal.toLocaleString()}개</div> : null}</> : searching ? (
              <div className="empty-search"><LoaderCircle className="wb-spin" size={18} /><span>전체 원본을 로컬에서 검색하고 있습니다.</span></div>
            ) : (
              <div className="empty-search"><Search size={22} /><span><kbd>Ctrl Shift F</kbd>로 모든 로그에서 찾습니다.</span></div>
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
        </div>

        {searchOpen ? (
          <div className="find-widget" role="search" aria-label={searchScope === 'file' ? '현재 로그 검색' : '모든 로그 검색'}>
            <Search size={18} />
            <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKeyDown} placeholder={searchScope === 'file' ? '현재 로그에서 찾기' : `${files.length}개 로그에서 찾기`} aria-invalid={invalidPattern} />
            <button className={searchOptionsOpen || Object.values(options).some(Boolean) ? 'active' : ''} aria-expanded={searchOptionsOpen} onClick={() => setSearchOptionsOpen((current) => !current)} aria-label="검색 옵션" title="검색 옵션"><SlidersHorizontal size={17} /></button>
            <span className={invalidPattern || searchError ? 'invalid' : ''}>{searching ? '검색 중' : invalidPattern ? '식 오류' : searchError ? '검색 실패' : query ? `${hits.length ? currentHit + 1 : 0}/${hits.length}${searchTotal > hits.length ? ` · 총 ${searchTotal}` : ''}` : '0 / 0'}</span>
            <button onClick={() => moveToHit(-1)} disabled={!hits.length} aria-label="이전 검색 결과" title="이전 결과 (Shift+Enter)"><ChevronsUp size={18} /></button>
            <button onClick={() => moveToHit(1)} disabled={!hits.length} aria-label="다음 검색 결과" title="다음 결과 (Enter)"><ChevronsDown size={18} /></button>
            <button onClick={() => setSearchOpen(false)} aria-label="검색 닫기" title="닫기 (Escape)"><X size={18} /></button>
            {searchOptionsOpen ? <div className="search-options-popover" aria-label="검색 옵션">
              {(Object.keys(options) as Array<keyof SearchOptions>).map((option) => {
                const Icon = option === 'caseSensitive' ? CaseSensitive : option === 'wholeWord' ? WholeWord : Regex
                return <button className={options[option] ? 'active' : ''} aria-pressed={options[option]} onClick={() => setOptions((current) => ({ ...current, [option]: !current[option] }))} key={option}><Icon size={16} /><span>{optionLabel(option)}</span>{options[option] ? <Check size={15} /> : null}</button>
              })}
            </div> : null}
          </div>
        ) : null}

        <div className="log-editor" ref={editorRef} tabIndex={0} aria-label={`${activeFile?.name ?? '로그'} 읽기 전용 편집기`}>
          {activeFile?.artifactId && activeWindow?.hasMoreBefore ? <button className="window-boundary" onClick={() => void loadLineWindow(activeFile, Math.max(1, activeWindow.startLine - 160))}><ChevronsUp size={13} />이전 구간 · Ln {Math.max(1, activeWindow.startLine - 240)}</button> : null}
          {activeFile && activeLines.length ? activeLines.map((line) => {
            const lineNumber = line.lineNumber
            const isEvidence = evidenceLines.includes(lineNumber)
            const isActiveLine = activeHit?.fileId === activeFile.id && activeHit.line === lineNumber
            const isRevealedLine = revealedLine?.fileId === activeFile.id && revealedLine.lineNumber === lineNumber
            return (
              <div className={`log-line ${isEvidence ? 'is-evidence' : ''} ${isActiveLine ? 'is-active-hit' : ''} ${isRevealedLine ? 'is-revealed-line' : ''}`} data-line={lineNumber} key={lineNumber}>
                <button className="evidence-gutter" aria-label={`${lineNumber}번 줄을 판정 근거로 ${isEvidence ? '해제' : '지정'}`} title="판정 근거 표시" onClick={() => toggleEvidence(lineNumber)}>{isEvidence ? <CircleDot size={11} /> : <Circle size={10} />}</button>
                <span className="line-number">{lineNumber}</span>
                <code>{renderHighlightedLine(line.text, lineNumber, activeHitsByLine.get(lineNumber) ?? [], activeHit)}</code>
              </div>
            )
          }) : <div className="editor-empty">{windowLoading ? <LoaderCircle className="wb-spin" size={22} /> : <FolderOpen size={22} />}<span>{windowLoading ? '필요한 로그 구간을 읽고 있습니다.' : '분석할 로그 폴더를 추가하세요.'}</span></div>}
          {activeFile?.artifactId && activeWindow?.hasMoreAfter ? <button className="window-boundary" onClick={() => void loadLineWindow(activeFile, (activeWindow.lines.at(-1)?.lineNumber ?? 1) + 81)}>다음 구간 · Ln {(activeWindow.lines.at(-1)?.lineNumber ?? 1) + 1}<ChevronsDown size={13} /></button> : null}
        </div>

        <footer className="editor-statusbar">
          <span className="status-spacer" />
          <button onClick={() => openSearch('file')}><Search size={14} />현재 로그 찾기 <kbd>Ctrl F</kbd></button>
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
                  {evidenceLines.slice(0, 4).map((lineNumber) => <button onClick={() => void revealLine(activeFile, lineNumber)} key={lineNumber}><b>Ln {lineNumber}</b><code>{activeLines.find((line) => line.lineNumber === lineNumber)?.text.trim() ?? '원문 위치로 이동'}</code></button>)}
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
