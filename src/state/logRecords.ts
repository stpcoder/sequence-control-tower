import type { ResultLabel } from '../domain/workbench'
import type { MetadataFieldDefinition } from '../domain/workbench/records'
import { parseFilenameMetadata } from '../domain/workbench/filenameMetadata'
import type { WorkbenchFile } from '../views/WorkbenchView'
import { detectSocFilenameContext } from '../domain/soc-profile'

export type CandidateState = 'candidate' | 'approved' | 'rejected' | 'missing' | 'malformed'
export type ReviewState = 'confirmed' | 'needs_review'
export type ResultSource = 'engineer' | 'candidate' | 'unreviewed'
export type PatternAxis = 'sample' | 'temperature' | 'mode' | 'grid'
export type EvaluationStage = 'power' | 'pbl' | 'xbl' | 'abl' | 'uefi' | 'lk' | 'lk2' | 'boot' | 'training' | 'diag' | 'hdiag' | 'test' | 'os'
export type EvaluationStageStatus = 'pass' | 'fail' | 'reached'
export type ResultStageGroup = 'firmware' | 'os' | 'test'

export interface EvaluationStageResult {
  stage: EvaluationStage
  status: EvaluationStageStatus
  evidenceCount: number
}

export interface ResultStageCheckpoint {
  group: ResultStageGroup
  label: string
  status: EvaluationStageStatus
  evidenceCount: number
}

export interface CandidateValue {
  value: string | null
  state: CandidateState
}

export interface MetadataApprovalValue {
  approval: 'approved' | 'rejected' | 'reset'
  candidateValue?: string
  approvedValue?: string
}

export type MetadataApprovalsBySource = Readonly<Record<string, Readonly<Record<string, MetadataApprovalValue>>>>
export type StageResultsBySource = Readonly<Record<string, readonly EvaluationStageResult[]>>

export interface LogResultRecord {
  id: string
  fileName: string
  folder: string
  relativePath: string
  artifactId?: string
  sourceKey?: string
  run?: string
  sample: CandidateValue
  temperature: CandidateValue
  mode: CandidateValue
  grid: CandidateValue
  result: ResultLabel
  resultSource: ResultSource
  /** Independent checkpoints found in one log; a log may contain several passes before its final result. */
  stageResults: readonly EvaluationStageResult[]
  review: ReviewState
  evidenceCount: number
  selectedEvidenceCount: number
}

export interface LogRecordFilters {
  query: string
  result: ResultLabel | 'all'
  review: ReviewState | 'all'
  folder?: string | 'all'
}

export type PivotDimension = 'sample' | 'temperature' | 'mode' | 'grid' | 'result' | 'review' | 'folder' | 'run'
export type PivotAggregation = 'count' | 'fail_count' | 'evidence_count'

/** Configuration for the results pivot. Axis lists are intentionally bounded to two dimensions. */
export interface PivotConfig {
  rows: readonly PivotDimension[]
  columns: readonly PivotDimension[]
  aggregation: PivotAggregation
  filters: LogRecordFilters
}

export interface PivotHeader {
  key: string
  values: readonly string[]
  label: string
}

export interface PivotCell {
  value: number
  sourceIds: readonly string[]
}

export interface PivotGrid {
  rows: readonly PivotHeader[]
  columns: readonly PivotHeader[]
  cells: readonly (readonly PivotCell[])[]
  total: number
  sourceIds: readonly string[]
}

/** Returns whether a renderer's selected pivot cell still exists in its current scope. */
export function isPivotSelectionValid(
  selectedCellKey: string | null,
  selectedSourceIds: ReadonlySet<string> | null,
  grid: PivotGrid,
  scopedRecords: readonly LogResultRecord[],
): boolean {
  if (selectedCellKey === null || selectedSourceIds === null) return true
  const selectedCell = grid.rows.flatMap((row, rowIndex) => grid.columns.map((column, columnIndex) => ({
    rowIndex,
    columnIndex,
    key: `${row.key}-${column.key}`,
  }))).find((cell) => cell.key === selectedCellKey)
  const rowIndex = selectedCell?.rowIndex ?? -1
  const columnIndex = selectedCell?.columnIndex ?? -1
  if (rowIndex < 0 || columnIndex < 0 || !grid.cells[rowIndex]?.[columnIndex]) return false
  const availableIds = new Set(scopedRecords.map((row) => row.id))
  return [...selectedSourceIds].every((sourceId) => availableIds.has(sourceId))
}

export type LogRecordSortKey = 'fileName' | 'folder' | 'sample' | 'temperature' | 'mode' | 'grid' | 'stageResults' | 'result' | 'review' | 'evidenceCount'
export type SortDirection = 'asc' | 'desc'

export interface PatternMatrixRow {
  value: string
  total: number
  counts: Partial<Record<ResultLabel, number>>
}

export type TrendOutcome = 'fail' | 'reboot' | 'halt' | 'majority'

export interface AggregateTrend {
  dimension: PatternAxis | 'folder' | 'run'
  value: string
  outcome: TrendOutcome
  count: number
  total: number
  percentage: number
  result?: ResultLabel
}

export interface AggregateTrendSummary {
  total: number
  trends: readonly AggregateTrend[]
}

const TREND_MIN_TOTAL = 5
const TREND_MIN_COUNT = 3
const TREND_MIN_SHARE = 0.6
const TREND_MIN_LIFT = 0.2
const TREND_DIMENSIONS: readonly (PatternAxis | 'folder' | 'run')[] = [
  'sample',
  'temperature',
  'mode',
  'grid',
  'folder',
  'run',
]
const TREND_OUTCOMES: readonly TrendOutcome[] = ['fail', 'reboot', 'halt', 'majority']

function trendValue(row: LogResultRecord, dimension: PatternAxis | 'folder' | 'run'): string | null {
  if (dimension === 'folder') return row.folder || null
  if (dimension === 'run') return row.run || null
  return row[dimension].value
}

function hasTrendOutcome(row: LogResultRecord, outcome: TrendOutcome): boolean {
  if (outcome === 'fail') return row.result === 'DIAG_FAIL' || row.result === 'TEST_FAIL' || row.result === 'TRAINING_FAIL'
  if (outcome === 'reboot') return row.result === 'SYSTEM_REBOOT'
  if (outcome === 'halt') return row.result === 'SYSTEM_HALT'
  return true
}

/**
 * Finds only scoped, deterministic concentrations. Missing dimensions are ignored;
 * no stage/channel meaning is inferred from filenames or evidence.
 */
export function aggregateRecordTrends(rows: readonly LogResultRecord[]): AggregateTrendSummary {
  const trends: AggregateTrend[] = []
  const total = rows.length
  if (total < TREND_MIN_TOTAL) return { total, trends }

  for (const dimension of TREND_DIMENSIONS) {
    const groups = new Map<string, LogResultRecord[]>()
    for (const row of rows) {
      const value = trendValue(row, dimension)
      if (value === null) continue
      const group = groups.get(value) ?? []
      group.push(row)
      groups.set(value, group)
    }
    if (groups.size < 2) continue

    for (const outcome of TREND_OUTCOMES) {
      for (const [value, group] of groups) {
        if (group.length < TREND_MIN_TOTAL) continue
        const resultCounts = RESULT_ORDER.map((result) => ({ result, count: group.filter((row) => row.result === result).length }))
        const dominant = resultCounts.reduce((left, right) => right.count > left.count ? right : left)
        const count = outcome === 'majority' ? dominant.count : group.filter((row) => hasTrendOutcome(row, outcome)).length
        const percentage = count / group.length
        const baseline = outcome === 'majority'
          ? Math.max(...RESULT_ORDER.map((result) => rows.filter((row) => row.result === result).length)) / total
          : rows.filter((row) => hasTrendOutcome(row, outcome)).length / total
        if (count < TREND_MIN_COUNT || percentage < TREND_MIN_SHARE || percentage - baseline < TREND_MIN_LIFT) continue
        trends.push({ dimension, value, outcome, count, total: group.length, percentage, ...(outcome === 'majority' ? { result: dominant.result } : {}) })
      }
    }
  }

  return {
    total,
    trends: trends
      .sort((left, right) => right.percentage - left.percentage || right.count - left.count || left.dimension.localeCompare(right.dimension) || left.value.localeCompare(right.value, 'ko-KR', { numeric: true }))
      .slice(0, 4),
  }
}

/** These patterns are visible product defaults, never silently confirmed metadata. */
export const DEFAULT_METADATA_FIELDS: readonly MetadataFieldDefinition[] = [
  { key: 'sample', label: 'Sample', target: 'file_name', pattern: '(?:^|[_.-])(?:SAMPLE|SMP|S)[=_-]?(?:(?:SAMPLE|SMP)[=_-])?(?<value>[A-Z0-9-]+?)(?=[_.-])', captureGroup: 'value' },
  { key: 'temperature', label: 'Temperature', target: 'file_name', pattern: '(?:TEMP[=_-]?)?(?<value>-?\\d+(?:[p.]\\d+)?)C(?=[_.-]|$)', captureGroup: 'value' },
  { key: 'mode', label: 'Mode', target: 'file_name', pattern: '(?:MODE[=_-]?)?(?<value>DIAG|TEST|TRAINING|STRESS|NORMAL|UEFI)(?=[_.-]|$)', captureGroup: 'value' },
  { key: 'grid', label: 'Grid', target: 'file_name', pattern: '(?:^|[_.+@-])(?:(?:GRID|MATRIX)[=_-]?|G[=_-])(?<value>[A-Z0-9][A-Z0-9xX*-]*?)(?=[_.-]|$)', captureGroup: 'value' },
] as const

const RESULT_ORDER: readonly ResultLabel[] = [
  'PASS',
  'DIAG_FAIL',
  'TEST_FAIL',
  'TRAINING_FAIL',
  'SYSTEM_HALT',
  'SYSTEM_REBOOT',
  'INCOMPLETE',
  'UNKNOWN',
  'EXCLUDED',
]

export const RESULT_LABEL_KO: Record<ResultLabel, string> = {
  PASS: 'Pass',
  DIAG_FAIL: 'Diag fail',
  TEST_FAIL: 'Test fail',
  TRAINING_FAIL: 'Training fail',
  SYSTEM_HALT: 'System halt',
  SYSTEM_REBOOT: 'System reboot',
  INCOMPLETE: 'Incomplete',
  UNKNOWN: 'Unknown',
  EXCLUDED: 'Excluded',
}

export const STAGE_LABEL_KO: Record<EvaluationStage, string> = {
  power: 'Power', pbl: 'PBL', xbl: 'XBL', abl: 'ABL', uefi: 'UEFI', lk: 'LK', lk2: 'LK2', boot: 'Boot', training: 'Training', diag: 'Diag', hdiag: 'HDiag', test: 'Test', os: 'OS',
}

export const RESULT_STAGE_GROUP_LABEL: Record<ResultStageGroup, string> = {
  firmware: '펌웨어',
  os: 'OS',
  test: '테스트',
}

const statusPriority: Record<EvaluationStageStatus, number> = { fail: 3, pass: 2, reached: 1 }

/**
 * Converts verbose boot traces into the checkpoints an engineer actually scans.
 * The last reached firmware stage is platform-aware; OS and a real test are
 * optional, so a boot-only log never receives a fabricated test checkpoint.
 */
export function resultStageCheckpoints(
  stages: readonly EvaluationStageResult[],
  fileName = '',
  finalResult?: ResultLabel,
): ResultStageCheckpoint[] {
  const byStage = new Map(stages.map((item) => [item.stage, item]))
  const vendor = detectSocFilenameContext(fileName).vendor
  const firmwareOrder: readonly EvaluationStage[] = vendor === 'mediatek'
    ? ['lk2', 'lk', 'pbl']
    : vendor === 'qualcomm'
      ? ['uefi', 'abl', 'xbl', 'pbl']
      : ['uefi', 'lk2', 'lk', 'abl', 'xbl', 'pbl']
  const firmware = firmwareOrder.map((stage) => byStage.get(stage)).find(Boolean)
  const os = byStage.get('os')
  const testCandidates = ['test', 'hdiag', 'diag']
    .map((stage) => byStage.get(stage as EvaluationStage))
    .filter((item): item is EvaluationStageResult => Boolean(item))
    .sort((left, right) => statusPriority[right.status] - statusPriority[left.status])
  const test = testCandidates.find((item) => item.status === 'fail')
    ?? (finalResult === 'PASS' ? testCandidates.find((item) => item.status === 'pass') : undefined)
    ?? (finalResult !== 'TRAINING_FAIL' ? testCandidates.find((item) => item.status === 'reached') : undefined)
  const checkpoints: ResultStageCheckpoint[] = [
    ...(firmware ? [{ group: 'firmware' as const, label: STAGE_LABEL_KO[firmware.stage], status: firmware.status, evidenceCount: firmware.evidenceCount }] : []),
    ...(os ? [{ group: 'os' as const, label: 'OS', status: os.status, evidenceCount: os.evidenceCount }] : []),
    ...(test ? [{ group: 'test' as const, label: '테스트', status: test.status, evidenceCount: test.evidenceCount }] : []),
  ]
  const firmwareFailure = checkpoints.findIndex((item) => item.group === 'firmware' && item.status === 'fail')
  return firmwareFailure >= 0 ? checkpoints.slice(0, firmwareFailure + 1) : checkpoints
}

function isMalformedName(name: string): boolean {
  return !name.trim() || /[\u0000-\u001f\u007f]/.test(name) || !/\.log$/i.test(name)
}

function uniqueMatches(text: string, pattern: RegExp, normalize: (value: string) => string = (value) => value): string[] {
  const values: string[] = []
  for (const match of text.matchAll(pattern)) {
    const captured = match.groups?.value ?? match[1]
    const value = captured ? normalize(captured) : undefined
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

function canonicalFilenameCandidate(key: string, value: string): string {
  const upper = value.toUpperCase()
  if (key === 'sample') return upper.replace(/^(?:SMP|SAMPLE)[=_-]/, '')
  if (key === 'mode') return upper
  return value
}

function candidateFromName(fileName: string, definition: MetadataFieldDefinition): CandidateValue {
  if (isMalformedName(fileName)) return { value: null, state: 'malformed' }
  try {
    const flags = definition.caseSensitive ? 'gu' : 'giu'
    const values = uniqueMatches(fileName, new RegExp(definition.pattern, flags), (value) => canonicalFilenameCandidate(definition.key, value))
    if (values.length !== 1) return { value: null, state: values.length > 1 ? 'malformed' : 'missing' }
    return { value: values[0], state: 'candidate' }
  } catch {
    return { value: null, state: 'malformed' }
  }
}

function fallbackFromContent(file: WorkbenchFile, key: PatternAxis): CandidateValue {
  const text = file.text ?? ''
  if (!text) return { value: null, state: 'missing' }
  const pattern = key === 'temperature'
    ? /temperature\s*=\s*(?<value>-?\d+(?:\.\d+)?)\s*C/giu
    : key === 'mode'
      ? /mode\s*:\s*(?<value>[A-Z][A-Z0-9_-]*)/giu
      : key === 'grid'
        ? /(?:grid|matrix|test\s+grid)\s*[:=]\s*(?<value>[A-Z0-9][A-Z0-9xX*-]*)/giu
        : /sample\s*[:=]\s*(?<value>[A-Z0-9_-]+)/giu
  const values = uniqueMatches(text, pattern)
  return values.length === 1 ? { value: values[0], state: 'candidate' } : { value: null, state: values.length > 1 ? 'malformed' : 'missing' }
}

function metadataCandidate(file: WorkbenchFile, key: PatternAxis): CandidateValue {
  const parsed = parseFilenameMetadata(file.name)[key]
  if (parsed.state === 'extracted') return { value: parsed.value, state: 'candidate' }
  if (parsed.state === 'conflict') return { value: null, state: 'malformed' }
  const definition = DEFAULT_METADATA_FIELDS.find((field) => field.key === key)
  if (!definition) return { value: null, state: 'missing' }
  const fromName = candidateFromName(file.name, definition)
  return fromName.state === 'missing' ? fallbackFromContent(file, key) : fromName
}

function applyMetadataApproval(candidate: CandidateValue, approval: MetadataApprovalValue | undefined): CandidateValue {
  if (!approval) return candidate
  if (approval.approval === 'reset') return candidate
  if (approval.approval === 'rejected') return { ...candidate, state: 'rejected' }
  return {
    value: approval.approvedValue ?? approval.candidateValue ?? candidate.value,
    state: 'approved',
  }
}

function runFromPath(path: string): string | undefined {
  return path.match(/(?:^|[\\/_.-])run(?:[=_-]?)(?<run>\d+)(?=[_.-]|$)/i)?.groups?.run
}

const SOURCE_KEY_SEPARATOR = '\u001f'

function rootGroupKey(file: Pick<WorkbenchFile, 'origin' | 'relativePath' | 'sourceKey' | 'rootId' | 'name'>): string {
  if (file.rootId) return `root:${file.rootId}`
  const sourceKeyRoot = file.sourceKey?.split(SOURCE_KEY_SEPARATOR, 1)[0]
  if (sourceKeyRoot) return sourceKeyRoot
  const relativeRoot = file.relativePath?.replace(/\\/g, '/').split('/')[0]
  return `legacy:${file.origin ?? ''}${SOURCE_KEY_SEPARATOR}${relativeRoot ?? ''}`
}

function rootLabel(file: Pick<WorkbenchFile, 'origin' | 'relativePath'>): string {
  return file.origin || file.relativePath?.split(/[\\/]/)[0] || 'Imported logs'
}

/** Mirrors Workbench's stable duplicate-root labels for Results filters and exports. */
function rootAwareFolderLabels(files: readonly WorkbenchFile[]): Map<string, string> {
  const groups = new Map<string, { label: string }>()
  for (const file of files) {
    const key = rootGroupKey(file)
    if (!groups.has(key)) groups.set(key, { label: rootLabel(file) })
  }

  const labelCounts = new Map<string, number>()
  for (const group of groups.values()) labelCounts.set(group.label, (labelCounts.get(group.label) ?? 0) + 1)

  const keysByLabel = new Map<string, string[]>()
  for (const [key, group] of groups) {
    if ((labelCounts.get(group.label) ?? 0) <= 1) continue
    const keys = keysByLabel.get(group.label) ?? []
    keys.push(key)
    keysByLabel.set(group.label, keys)
  }

  const ordinals = new Map<string, number>()
  for (const keys of keysByLabel.values()) {
    keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    keys.forEach((key, index) => ordinals.set(key, index + 1))
  }

  return new Map(files.map((file) => {
    const key = rootGroupKey(file)
    const group = groups.get(key)!
    const count = labelCounts.get(group.label) ?? 0
    return [file.id, count > 1 ? `${group.label} · ${ordinals.get(key) ?? 1}` : group.label] as const
  }))
}

function matchingLineCount(text: string, pattern: RegExp): number {
  return text.split(/\r?\n/).reduce((count, line) => {
    pattern.lastIndex = 0
    return count + (pattern.test(line) ? 1 : 0)
  }, 0)
}

export function inferResultCandidate(file: WorkbenchFile): { result: ResultLabel; evidenceCount: number } {
  const text = file.text ?? ''
  const candidates: Array<{ result: ResultLabel; pattern: RegExp }> = [
    { result: 'SYSTEM_REBOOT', pattern: /reboot_reason|WATCHDOG_RESET|session recovery detected|\bTERMINAL_RESULT=SYSTEM_REBOOT\b/i },
    { result: 'SYSTEM_HALT', pattern: /\b(?:TERMINAL_RESULT=)?SYSTEM_HALT\b/i },
    { result: 'TRAINING_FAIL', pattern: /TRAINING_FAIL|training:\s*.+timeout/i },
    { result: 'DIAG_FAIL', pattern: /DIAG_FAIL|hidag[^\n]*(?:fail|error)/i },
    { result: 'TEST_FAIL', pattern: /TEST_FAIL|@FAIL/i },
    { result: 'PASS', pattern: /(?:@PASS\b|\bTERMINAL_RESULT=PASS\b)/i },
  ]
  for (const candidate of candidates) {
    if (candidate.pattern.test(text)) {
      candidate.pattern.lastIndex = 0
      return { result: candidate.result, evidenceCount: matchingLineCount(text, candidate.pattern) }
    }
  }
  const started = /stressapp:\s*start|hidag:\s*start/i.test(text)
  const ended = /@PASS|@FAIL|normal_end:\s*true/i.test(text)
  if (started && !ended) {
    return { result: 'SYSTEM_HALT', evidenceCount: matchingLineCount(text, /watchdog|timeout|hidag:\s*start/i) }
  }
  return { result: text ? 'INCOMPLETE' : 'UNKNOWN', evidenceCount: 0 }
}

/** Finds explicit stage outcomes without collapsing them into one final PASS/FAIL label. */
export function inferStageResults(file: WorkbenchFile): EvaluationStageResult[] {
  const text = file.text ?? ''
  if (!text) return []
  const runtimeText = text.split(/\r?\n/).filter((line) => !/\bFLOW_CONVENTION\b/i.test(line)).join('\n')
  const definitions: Array<{ stage: EvaluationStage; status: EvaluationStageStatus; pattern: RegExp }> = [
    { stage: 'power', status: 'reached', pattern: /\b(?:(?:SYN_)?POWER[_ ]?ON|PWR[_ ]?ON)\b/i },
    { stage: 'pbl', status: 'reached', pattern: /(?:\b(?:SYN_)?PBL[_ ]?(?:ENTER|START)\b|\bPBL\s*:)/i },
    { stage: 'pbl', status: 'pass', pattern: /\b(?:SYN_)?PBL[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b/i },
    { stage: 'pbl', status: 'fail', pattern: /\b(?:SYN_)?PBL[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'xbl', status: 'reached', pattern: /(?:\b(?:SYN_)?XBL[_ ]?(?:ENTER|START)\b|\bXBL\s*:)/i },
    { stage: 'xbl', status: 'pass', pattern: /\b(?:SYN_)?XBL[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b/i },
    { stage: 'xbl', status: 'fail', pattern: /\b(?:SYN_)?XBL[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'abl', status: 'reached', pattern: /(?:\b(?:SYN_)?ABL[_ ]?(?:ENTER|START)\b|\bABL\s*:)/i },
    { stage: 'abl', status: 'pass', pattern: /\b(?:SYN_)?ABL[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b/i },
    { stage: 'abl', status: 'fail', pattern: /\b(?:SYN_)?ABL[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'uefi', status: 'reached', pattern: /(?:\b(?:SYN_)?UEFI[_ ]?(?:ENTER|START)\b|\bUEFI\s*:)/i },
    { stage: 'uefi', status: 'pass', pattern: /(?:\b(?:SYN_)?UEFI[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b|\bUEFI[^\n]*ExitBootServices\b)/i },
    { stage: 'uefi', status: 'fail', pattern: /\b(?:SYN_)?UEFI[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'lk', status: 'reached', pattern: /(?:\b(?:SYN_)?LK[_ ]?(?:ENTER|START)\b|\bLK\s*:)/i },
    { stage: 'lk', status: 'pass', pattern: /\b(?:SYN_)?LK[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b/i },
    { stage: 'lk', status: 'fail', pattern: /\b(?:SYN_)?LK[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'lk2', status: 'reached', pattern: /(?:\b(?:SYN_)?LK2[_ ]?(?:ENTER|START)\b|\bLK2\s*:)/i },
    { stage: 'lk2', status: 'pass', pattern: /\b(?:SYN_)?LK2[_ ]?(?:EXIT|PASS|DONE|COMPLETE|SUCCESS)\b/i },
    { stage: 'lk2', status: 'fail', pattern: /\b(?:SYN_)?LK2[_ ]?(?:FAIL|ERROR|TIMEOUT)\b/i },
    { stage: 'boot', status: 'pass', pattern: /\b(?:BOOT[_ ]?PASS|BOOT\s+(?:COMPLETE|SUCCESS))\b/i },
    { stage: 'boot', status: 'fail', pattern: /\b(?:BOOT[_ ]?FAIL|BOOT\s+(?:ERROR|TIMEOUT))\b/i },
    { stage: 'training', status: 'reached', pattern: /\bTRAINING[^\n]*(?:START|BEGIN)\b/i },
    { stage: 'training', status: 'pass', pattern: /\b(?:TRAINING[_ ]?PASS|TRAINING\s+(?:COMPLETE|SUCCESS))\b/i },
    { stage: 'training', status: 'fail', pattern: /\b(?:TRAINING[_ ]?FAIL|TRAINING\s+[^\n]*(?:ERROR|TIMEOUT))\b/i },
    { stage: 'hdiag', status: 'reached', pattern: /\b(?:HIDAG|HDIAG)[^\n]*(?:START|BEGIN)\b/i },
    { stage: 'hdiag', status: 'pass', pattern: /\b(?:HIDAG|HDIAG)[^\n]*(?:@?PASS|SUCCESS)\b/i },
    { stage: 'hdiag', status: 'fail', pattern: /\b(?:HIDAG|HDIAG)[^\n]*(?:@?FAIL|ERROR)\b/i },
    { stage: 'diag', status: 'reached', pattern: /\bDIAG(?:NOSTIC)?[^\n]*(?:START|BEGIN)\b/i },
    { stage: 'diag', status: 'pass', pattern: /\bDIAG(?:NOSTIC)?[^\n]*(?:@?PASS|SUCCESS)\b/i },
    { stage: 'diag', status: 'fail', pattern: /\bDIAG(?:NOSTIC)?[^\n]*(?:@?FAIL|ERROR)\b/i },
    { stage: 'test', status: 'pass', pattern: /(?:\bTEST[_ ]?PASS\b|\bSTRESSAPP[^\n]*(?:@?PASS|SUCCESS)\b|\bTERMINAL_RESULT=PASS\b|@PASS\b)/i },
    { stage: 'test', status: 'fail', pattern: /(?:\bTEST[_ ]?FAIL\b|\bSTRESSAPP[^\n]*(?:@?FAIL|ERROR)\b|@FAIL\b)/i },
    { stage: 'os', status: 'reached', pattern: /(?:\b(?:SYN_)?OS[_ ]?(?:READY|BOOTED|BOOT_START)\b|Linux\s+(?:boot\s+)?complete|\bExitBootServices\b)/i },
  ]
  const found: EvaluationStageResult[] = []
  for (const definition of definitions) {
    if (!definition.pattern.test(runtimeText)) continue
    const existing = found.find((item) => item.stage === definition.stage)
    const evidenceCount = matchingLineCount(runtimeText, definition.pattern)
    if (!existing) found.push({ stage: definition.stage, status: definition.status, evidenceCount })
    else if (definition.status === 'fail' || existing.status !== 'fail') Object.assign(existing, { status: definition.status, evidenceCount })
  }
  return found
}

export function projectLogRecords(
  files: readonly WorkbenchFile[],
  selectedEvidence: Readonly<Record<string, number>> = {},
  metadataApprovals: MetadataApprovalsBySource = {},
  stageResultsBySource: StageResultsBySource = {},
): LogResultRecord[] {
  const folderLabels = rootAwareFolderLabels(files)
  return files.map((file) => {
    const approvals = metadataApprovals[file.id] ?? {}
    const sample = applyMetadataApproval(metadataCandidate(file, 'sample'), approvals.sample)
    const temperature = applyMetadataApproval(metadataCandidate(file, 'temperature'), approvals.temperature)
    const mode = applyMetadataApproval(metadataCandidate(file, 'mode'), approvals.mode)
    const grid = applyMetadataApproval(metadataCandidate(file, 'grid'), approvals.grid)
    const inferred = inferResultCandidate(file)
    const stageResults = stageResultsBySource[file.id] ?? inferStageResults(file)
    const result = file.decision ?? file.ruleResult ?? inferred.result
    const resultSource: ResultSource = file.decision
      ? 'engineer'
      : file.ruleResult || inferred.result !== 'UNKNOWN'
        ? 'candidate'
        : 'unreviewed'
    const hasSelectedEvidence = Object.prototype.hasOwnProperty.call(selectedEvidence, file.id)
    const selectedEvidenceCount = hasSelectedEvidence ? selectedEvidence[file.id] : 0
    const run = runFromPath(file.relativePath ?? '') ?? runFromPath(file.name)
    return {
      id: file.id,
      fileName: file.name,
      folder: folderLabels.get(file.id) ?? rootLabel(file),
      relativePath: file.relativePath ?? file.name,
      ...(file.artifactId ? { artifactId: file.artifactId } : {}),
      ...(file.sourceKey ? { sourceKey: file.sourceKey } : {}),
      ...(run ? { run } : {}),
      sample,
      temperature,
      mode,
      grid,
      result,
      resultSource,
      stageResults,
      review: file.decision && !file.ruleNeedsReview ? 'confirmed' : 'needs_review',
      evidenceCount: hasSelectedEvidence ? selectedEvidenceCount : inferred.evidenceCount,
      selectedEvidenceCount,
    }
  })
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase('ko-KR')
}

export function filterLogRecords(rows: readonly LogResultRecord[], filters: LogRecordFilters): LogResultRecord[] {
  const query = normalized(filters.query.trim())
  return rows.filter((row) => {
    if (filters.folder && filters.folder !== 'all' && row.folder !== filters.folder) return false
    if (filters.result !== 'all' && row.result !== filters.result) return false
    if (filters.review !== 'all' && row.review !== filters.review) return false
    if (!query) return true
    return [row.fileName, row.folder, row.relativePath, row.sample.value, row.temperature.value, row.mode.value, row.grid.value, row.result, row.stageResults.map((item) => `${STAGE_LABEL_KO[item.stage]} ${item.status}`).join(' ')]
      .some((value) => normalized(value).includes(query))
  })
}

const PIVOT_UNKNOWN = '미확인'

function pivotDimensionValue(row: LogResultRecord, dimension: PivotDimension): string {
  if (dimension === 'sample' || dimension === 'temperature' || dimension === 'mode' || dimension === 'grid') {
    return row[dimension].value ?? PIVOT_UNKNOWN
  }
  if (dimension === 'run') return row.run ?? PIVOT_UNKNOWN
  return String(row[dimension] || PIVOT_UNKNOWN)
}

function pivotKey(values: readonly string[]): string {
  return JSON.stringify(values)
}

function comparePivotHeaders(left: PivotHeader, right: PivotHeader): number {
  return left.label.localeCompare(right.label, 'ko-KR', { numeric: true, sensitivity: 'base' })
}

function pivotAmount(row: LogResultRecord, aggregation: PivotAggregation): number {
  if (aggregation === 'evidence_count') return row.evidenceCount
  if (aggregation === 'count') return 1
  return row.result !== 'PASS' && row.result !== 'UNKNOWN' && row.result !== 'INCOMPLETE' && row.result !== 'EXCLUDED' ? 1 : 0
}

function validatePivotAxes(axis: readonly PivotDimension[], name: string): void {
  if (axis.length > 2) throw new RangeError(`Pivot ${name} may contain at most two dimensions`)
  if (new Set(axis).size !== axis.length) throw new RangeError(`Pivot ${name} may not contain duplicate dimensions`)
}

/** Builds a deterministic, source-traceable pivot without mutating records or configuration. */
export function buildPivotGrid(rows: readonly LogResultRecord[], config: PivotConfig): PivotGrid {
  validatePivotAxes(config.rows, 'rows')
  validatePivotAxes(config.columns, 'columns')
  const filtered = filterLogRecords(rows, config.filters)
  const rowMap = new Map<string, PivotHeader>()
  const columnMap = new Map<string, PivotHeader>()
  const values = new Map<string, { value: number; sourceIds: string[] }>()
  const allSourceIds: string[] = []

  for (const row of filtered) {
    const rowValues = config.rows.map((dimension) => pivotDimensionValue(row, dimension))
    const columnValues = config.columns.map((dimension) => pivotDimensionValue(row, dimension))
    const rowHeader: PivotHeader = { key: pivotKey(rowValues), values: [...rowValues], label: rowValues.join(' / ') || '전체' }
    const columnHeader: PivotHeader = { key: pivotKey(columnValues), values: [...columnValues], label: columnValues.join(' / ') || '전체' }
    rowMap.set(rowHeader.key, rowHeader)
    columnMap.set(columnHeader.key, columnHeader)
    const cellKey = `${rowHeader.key}\u0000${columnHeader.key}`
    const cell = values.get(cellKey) ?? { value: 0, sourceIds: [] }
    const amount = pivotAmount(row, config.aggregation)
    cell.value += amount
    if (amount !== 0 && !cell.sourceIds.includes(row.id)) cell.sourceIds.push(row.id)
    values.set(cellKey, cell)
    if (!allSourceIds.includes(row.id)) allSourceIds.push(row.id)
  }

  const pivotRows = [...rowMap.values()].sort(comparePivotHeaders)
  const pivotColumns = [...columnMap.values()].sort(comparePivotHeaders)
  const cells = pivotRows.map((rowHeader) => pivotColumns.map((columnHeader) => {
    const cell = values.get(`${rowHeader.key}\u0000${columnHeader.key}`)
    return { value: cell?.value ?? 0, sourceIds: Object.freeze([...(cell?.sourceIds ?? [])]) }
  }))
  return {
    rows: Object.freeze(pivotRows.map((header) => ({ ...header, values: Object.freeze([...header.values]) }))),
    columns: Object.freeze(pivotColumns.map((header) => ({ ...header, values: Object.freeze([...header.values]) }))),
    cells: Object.freeze(cells.map((row) => Object.freeze(row))),
    total: filtered.reduce((sum, row) => sum + pivotAmount(row, config.aggregation), 0),
    sourceIds: Object.freeze(allSourceIds),
  }
}

function sortableValue(row: LogResultRecord, key: LogRecordSortKey): string | number {
  if (key === 'sample' || key === 'temperature' || key === 'mode' || key === 'grid') return row[key].value ?? ''
  if (key === 'stageResults') return row.stageResults.map((item) => `${item.stage}:${item.status}`).join('|')
  return row[key]
}

export function sortLogRecords(rows: readonly LogResultRecord[], key: LogRecordSortKey, direction: SortDirection): LogResultRecord[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const a = sortableValue(left, key)
    const b = sortableValue(right, key)
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * factor
    return String(a).localeCompare(String(b), 'ko-KR', { numeric: true, sensitivity: 'base' }) * factor
  })
}

export function patternMatrix(rows: readonly LogResultRecord[], axis: PatternAxis): PatternMatrixRow[] {
  const matrix = new Map<string, PatternMatrixRow>()
  for (const row of rows) {
    const value = row[axis].value ?? '미확인'
    const current = matrix.get(value) ?? { value, total: 0, counts: {} }
    current.total += 1
    current.counts[row.result] = (current.counts[row.result] ?? 0) + 1
    matrix.set(value, current)
  }
  return [...matrix.values()].sort((a, b) => a.value.localeCompare(b.value, 'ko-KR', { numeric: true }))
}

export function visibleResults(rows: readonly LogResultRecord[]): ResultLabel[] {
  const present = new Set(rows.map((row) => row.result))
  return RESULT_ORDER.filter((result) => present.has(result))
}

export function toggleLogRecordSelection(selectedIds: ReadonlySet<string>, rowId: string): Set<string> {
  const next = new Set(selectedIds)
  if (next.has(rowId)) next.delete(rowId)
  else next.add(rowId)
  return next
}

export function selectAllFilteredLogRecords(
  selectedIds: ReadonlySet<string>,
  filteredRows: readonly LogResultRecord[],
  selected: boolean,
): Set<string> {
  const next = new Set(selectedIds)
  for (const row of filteredRows) {
    if (selected) next.add(row.id)
    else next.delete(row.id)
  }
  return next
}

export function selectedLogRecords(rows: readonly LogResultRecord[], selectedIds: ReadonlySet<string>): LogResultRecord[] {
  return rows.filter((row) => selectedIds.has(row.id))
}

/** Selection is retained across filters, but exports are always bounded by the current scope. */
export function exportableLogRecords(rows: readonly LogResultRecord[], selectedIds: ReadonlySet<string>): LogResultRecord[] {
  return selectedIds.size ? selectedLogRecords(rows, selectedIds) : [...rows]
}

function safeSpreadsheetCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  return /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw
}

function pathBaseName(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? ''
}

function safeExportPath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const isAbsolute = normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)
  const hasParentTraversal = normalized.split('/').includes('..')
  if (isAbsolute || hasParentTraversal) return pathBaseName(normalized)
  return normalized.replace(/^\.\//, '')
}

function safeExportIdentity(value: string | undefined): string {
  if (!value) return ''
  const separator = '\u001f'
  const separatorIndex = value.indexOf(separator)
  if (separatorIndex < 0) return safeExportPath(value)
  const rootPrefix = safeExportPath(value.slice(0, separatorIndex))
  const pathPart = value.slice(separatorIndex + separator.length)
  return `${rootPrefix}${separator}${safeExportPath(pathPart)}`
}

const BASE_EXPORT_HEADER = [
  'source_id',
  'artifact_id',
  'source_key',
  'relative_path',
  'run',
  'filename',
  'folder',
  'sample_value',
  'sample_state',
  'temperature_value',
  'temperature_state',
  'mode_value',
  'mode_state',
  'grid_value',
  'grid_state',
  'result',
  'result_source',
  'review',
  'stage_results',
] as const

export const EVIDENCE_EXPORT_COLUMNS = ['evidence_count', 'selected_evidence_count'] as const
export type LogRecordExportColumn = typeof BASE_EXPORT_HEADER[number] | typeof EVIDENCE_EXPORT_COLUMNS[number]

/** Shared default: metadata and result columns only; evidence is opt-in as a group. */
export const DEFAULT_EXPORT_COLUMNS: readonly LogRecordExportColumn[] = [...BASE_EXPORT_HEADER]

export const EXPORT_COLUMN_DEFINITIONS: ReadonlyArray<{
  key: LogRecordExportColumn
  label: string
  group?: 'evidence'
}> = [
  { key: 'source_id', label: 'Source ID' },
  { key: 'artifact_id', label: 'Artifact ID' },
  { key: 'source_key', label: 'Source key' },
  { key: 'relative_path', label: 'Relative path' },
  { key: 'run', label: 'Run' },
  { key: 'filename', label: '파일명' },
  { key: 'folder', label: '폴더' },
  { key: 'sample_value', label: 'Sample 값' },
  { key: 'sample_state', label: 'Sample 상태' },
  { key: 'temperature_value', label: '온도 값' },
  { key: 'temperature_state', label: '온도 상태' },
  { key: 'mode_value', label: 'Mode 값' },
  { key: 'mode_state', label: 'Mode 상태' },
  { key: 'grid_value', label: 'Grid 값' },
  { key: 'grid_state', label: 'Grid 상태' },
  { key: 'result', label: '결과' },
  { key: 'result_source', label: '결과 출처' },
  { key: 'review', label: '검토' },
  { key: 'stage_results', label: '단계별 결과' },
  { key: 'evidence_count', label: '근거 수', group: 'evidence' },
  { key: 'selected_evidence_count', label: '선택 근거 수', group: 'evidence' },
]

export function normalizeExportColumns(columns: readonly LogRecordExportColumn[]): LogRecordExportColumn[] {
  const valid = new Set<LogRecordExportColumn>(EXPORT_COLUMN_DEFINITIONS.map((column) => column.key))
  return [...new Set(columns)].filter((column): column is LogRecordExportColumn => valid.has(column))
}

function exportRowValues(row: LogResultRecord): Record<LogRecordExportColumn, unknown> {
  return {
    source_id: row.id,
    artifact_id: row.artifactId ?? '',
    source_key: safeExportIdentity(row.sourceKey),
    relative_path: safeExportPath(row.relativePath),
    run: row.run ?? runFromPath(row.relativePath) ?? runFromPath(row.fileName) ?? '',
    filename: pathBaseName(row.fileName),
    folder: safeExportPath(row.folder),
    sample_value: row.sample.value ?? '',
    sample_state: row.sample.state,
    temperature_value: row.temperature.value ?? '',
    temperature_state: row.temperature.state,
    mode_value: row.mode.value ?? '',
    mode_state: row.mode.state,
    grid_value: row.grid.value ?? '',
    grid_state: row.grid.state,
    result: row.result,
    result_source: row.resultSource,
    review: row.review,
    stage_results: row.stageResults.map((item) => `${STAGE_LABEL_KO[item.stage]}:${item.status.toUpperCase()}`).join(' | '),
    evidence_count: row.evidenceCount,
    selected_evidence_count: row.selectedEvidenceCount,
  }
}

function exportRows(rows: readonly LogResultRecord[], columns: readonly LogRecordExportColumn[]): unknown[][] {
  return [
    [...columns],
    ...rows.map((row) => {
      const values = exportRowValues(row)
      return columns.map((column) => values[column])
    }),
  ]
}

export function normalizedExportCell(value: unknown): string {
  return safeSpreadsheetCell(value).replace(/[\t\r\n]+/g, ' ')
}

/** The exact logical cell value emitted by either export serializer. */
export function exportCellValue(row: LogResultRecord, column: LogRecordExportColumn): string {
  return normalizedExportCell(exportRowValues(row)[column])
}

function csvExportCell(value: unknown): string {
  return `"${normalizedExportCell(value).replace(/"/g, '""')}"`
}

export function serializeLogRecordsTsv(
  rows: readonly LogResultRecord[],
  columns: readonly LogRecordExportColumn[] = DEFAULT_EXPORT_COLUMNS,
): string {
  const selectedColumns = normalizeExportColumns(columns)
  return `\uFEFF${exportRows(rows, selectedColumns).map((record) => record.map(normalizedExportCell).join('\t')).join('\r\n')}`
}

export function serializeLogRecordsCsv(
  rows: readonly LogResultRecord[],
  columns: readonly LogRecordExportColumn[] = DEFAULT_EXPORT_COLUMNS,
): string {
  const selectedColumns = normalizeExportColumns(columns)
  return `\uFEFF${exportRows(rows, selectedColumns).map((record) => record.map(csvExportCell).join(',')).join('\r\n')}`
}

export type LogRecordExportFormat = 'csv' | 'tsv'

export interface LogRecordExportPreviewInit {
  readonly phase: 'init'
  readonly rows: readonly LogResultRecord[]
  readonly columns: readonly LogRecordExportColumn[]
}

export interface LogRecordExportPreview {
  readonly phase: 'preview'
  readonly rows: readonly LogResultRecord[]
  readonly columns: readonly LogRecordExportColumn[]
  readonly format: LogRecordExportFormat
  readonly serialized: string
  readonly csv: string
  readonly tsv: string
}

/** Creates the immutable input snapshot used by an export init → preview flow. */
export function initLogRecordExportPreview(
  rows: readonly LogResultRecord[],
  selectedIds: ReadonlySet<string> = new Set(),
  columns: readonly LogRecordExportColumn[] = DEFAULT_EXPORT_COLUMNS,
): LogRecordExportPreviewInit {
  const snapshotRows = exportableLogRecords(rows, selectedIds).map((row) => Object.freeze({
    ...row,
    sample: Object.freeze({ ...row.sample }),
    temperature: Object.freeze({ ...row.temperature }),
    mode: Object.freeze({ ...row.mode }),
    grid: Object.freeze({ ...row.grid }),
  }))
  return Object.freeze({
    phase: 'init' as const,
    rows: Object.freeze(snapshotRows),
    columns: Object.freeze(normalizeExportColumns(columns)),
  })
}

/** Purely materializes both supported serializers so a UI can show a preview before confirmation. */
export function previewLogRecordExport(
  init: LogRecordExportPreviewInit,
  format: LogRecordExportFormat = 'csv',
): LogRecordExportPreview {
  const csv = serializeLogRecordsCsv(init.rows, init.columns)
  const tsv = serializeLogRecordsTsv(init.rows, init.columns)
  return Object.freeze({
    phase: 'preview' as const,
    rows: init.rows,
    columns: init.columns,
    format,
    serialized: format === 'csv' ? csv : tsv,
    csv,
    tsv,
  })
}

/** Confirmation remains side-effect free; the caller owns the actual download/write operation. */
export function confirmLogRecordExport(preview: LogRecordExportPreview): string {
  return preview.serialized
}

export function buildLogRecordExportPreview(
  rows: readonly LogResultRecord[],
  selectedIds: ReadonlySet<string> = new Set(),
  columns: readonly LogRecordExportColumn[] = DEFAULT_EXPORT_COLUMNS,
  format: LogRecordExportFormat = 'csv',
): LogRecordExportPreview {
  return previewLogRecordExport(initLogRecordExportPreview(rows, selectedIds, columns), format)
}
