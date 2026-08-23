import type { ResultLabel } from '../domain/workbench'
import type { MetadataFieldDefinition } from '../domain/workbench/records'
import { parseFilenameMetadata } from '../domain/workbench/filenameMetadata'
import type { WorkbenchFile } from '../views/WorkbenchView'
import { detectSocFilenameContext } from '../domain/soc-profile'
import { extractLpddrFilenameDimensions, extractLpddrFilenameOutcome, parsePositionalLabFilename } from '../domain/lpddr-filename-dimensions'
import type { ArtifactFailureAddressEvent, ArtifactFailureAddressFields, ProjectEvaluationDimensions } from '../../electron/shared/contracts'

export type CandidateState = 'candidate' | 'approved' | 'rejected' | 'missing' | 'malformed'
export type ReviewState = 'confirmed' | 'needs_review'
export type ResultSource = 'engineer' | 'rule' | 'candidate' | 'unreviewed'
export type PatternAxis = 'sample' | 'temperature' | 'vdd' | 'grid'
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
export type FailureAddressEventsBySource = Record<string, { events: readonly ArtifactFailureAddressEvent[]; truncated: boolean }>

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
  vdd: CandidateValue
  grid: CandidateValue
  /** Deterministic filename dimensions shared with the native LPDDR Agent. */
  dimensions?: ProjectEvaluationDimensions
  result: ResultLabel
  resultSource: ResultSource
  /** Independent checkpoints found in one log; a log may contain several passes before its final result. */
  stageResults: readonly EvaluationStageResult[]
  /** Explicit fail-address events extracted from log lines, never filename metadata. */
  failureAddressEvents?: readonly ArtifactFailureAddressEvent[]
  failureAddressTruncated?: boolean
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

export type EngineeringPivotDimension = 'skew' | 'lot' | 'material' | 'die' | 'socModel' | 'equipmentChannel' | 'eccMode' | 'customCondition' | 'evaluationStep' | 'frequencyMHz' | 'temperatureCorner' | 'vdd' | 'vddCorner' | 'conditionCorner' | 'testMode' | 'pattern'
  | 'dq' | 'bl' | 'channel' | 'subChannel' | 'chipSelect' | 'rank' | 'bankGroup' | 'bank' | 'row' | 'column' | 'writeData' | 'readData' | 'timingSkewPs'
export type PivotDimension = 'sample' | 'temperature' | 'grid' | 'result' | 'review' | 'folder' | 'run' | EngineeringPivotDimension
export type PivotAggregation = 'count' | 'sample_count' | 'grid_count' | 'pass_count' | 'fail_count' | 'pass_fail' | 'fail_rate' | 'evidence_count'
  | 'fail_event_count' | 'fail_source_count' | 'fail_event_share'

/** Configuration for the results pivot. Axis lists are intentionally bounded to three dimensions. */
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
  breakdown?: PivotOutcomeBreakdown
  failureAddress?: PivotFailureAddressBreakdown
}

export interface PivotOutcomeBreakdown {
  passCount: number
  failCount: number
  definitiveCount: number
  topFailureSignature?: string
}

export interface PivotFailureAddressBreakdown {
  eventCount: number
  sourceCount: number
  totalEventCount: number
  eventShare: number
  topSignature?: string
}

export interface PivotGrid {
  rows: readonly PivotHeader[]
  columns: readonly PivotHeader[]
  cells: readonly (readonly PivotCell[])[]
  total: number
  sourceIds: readonly string[]
  breakdown?: PivotOutcomeBreakdown
  failureAddress?: PivotFailureAddressBreakdown
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

export type LogRecordSortKey = 'fileName' | 'folder' | 'sample' | 'temperature' | 'vdd' | 'grid' | 'stageResults' | 'result' | 'review' | 'evidenceCount'
export type SortDirection = 'asc' | 'desc'

export interface PatternMatrixRow {
  value: string
  total: number
  counts: Partial<Record<ResultLabel, number>>
}

export type TrendOutcome = 'fail' | 'reboot' | 'halt' | 'majority'

export interface AggregateTrend {
  dimension: PivotDimension
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

export interface FailureAddressDistribution {
  dimension: keyof ArtifactFailureAddressFields
  value: string
  eventCount: number
  sourceCount: number
  eventShare: number
}

export interface FailureAddressSummary {
  eventCount: number
  sourceCount: number
  truncated: boolean
  distribution: readonly FailureAddressDistribution[]
}

const FAILURE_ADDRESS_DISPLAY_ORDER: Record<keyof ArtifactFailureAddressFields, number> = {
  dq: 0,
  bl: 1,
  channel: 2,
  subChannel: 3,
  bankGroup: 4,
  bank: 5,
  chipSelect: 6,
  rank: 7,
  row: 8,
  column: 9,
  writeData: 10,
  readData: 11,
}

/** Summarizes explicit log-body events without mixing filename dimensions. */
export function summarizeFailureAddressEvents(rows: readonly LogResultRecord[]): FailureAddressSummary {
  const buckets = new Map<string, { dimension: keyof ArtifactFailureAddressFields; value: string; eventCount: number; sourceIds: Set<string> }>()
  let eventCount = 0
  const sourceIds = new Set<string>()
  for (const row of rows) {
    for (const event of row.failureAddressEvents ?? []) {
      eventCount += 1
      sourceIds.add(row.id)
      for (const [dimension, raw] of Object.entries(event.fields) as Array<[keyof ArtifactFailureAddressFields, string | undefined]>) {
        if (raw === undefined || raw === '') continue
        const key = `${dimension}\u0000${raw}`
        const bucket = buckets.get(key) ?? { dimension, value: raw, eventCount: 0, sourceIds: new Set<string>() }
        bucket.eventCount += 1
        bucket.sourceIds.add(row.id)
        buckets.set(key, bucket)
      }
    }
  }
  return {
    eventCount,
    sourceCount: sourceIds.size,
    truncated: rows.some((row) => row.failureAddressTruncated),
    distribution: [...buckets.values()].map((item) => ({
      dimension: item.dimension,
      value: item.value,
      eventCount: item.eventCount,
      sourceCount: item.sourceIds.size,
      eventShare: eventCount ? item.eventCount / eventCount : 0,
    })).sort((left, right) => right.eventCount - left.eventCount
      || right.sourceCount - left.sourceCount
      || FAILURE_ADDRESS_DISPLAY_ORDER[left.dimension] - FAILURE_ADDRESS_DISPLAY_ORDER[right.dimension]
      || left.value.localeCompare(right.value, 'ko-KR', { numeric: true })),
  }
}

const TREND_MIN_TOTAL = 5
const TREND_MIN_COUNT = 3
const TREND_MIN_SHARE = 0.6
const TREND_MIN_LIFT = 0.2
const TREND_DIMENSIONS: readonly PivotDimension[] = [
  'sample',
  'temperature',
  'temperatureCorner',
  'testMode',
  'skew',
  'frequencyMHz',
  'vdd',
  'vddCorner',
  'conditionCorner',
  'pattern',
  'equipmentChannel',
  'eccMode',
  'customCondition',
  'evaluationStep',
  'dq',
  'bl',
  'channel',
  'subChannel',
  'chipSelect',
  'bankGroup',
  'bank',
  'row',
  'column',
  'writeData',
  'readData',
]
const TREND_OUTCOMES: readonly TrendOutcome[] = ['fail', 'reboot', 'halt', 'majority']

function trendValue(row: LogResultRecord, dimension: PivotDimension): string | null {
  const value = pivotDimensionValue(row, dimension)
  return value === PIVOT_UNKNOWN ? null : value
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
  INCOMPLETE: '미완료',
  UNKNOWN: '미확인',
  EXCLUDED: '제외',
}

export const STAGE_LABEL_KO: Record<EvaluationStage, string> = {
  power: 'Power', pbl: 'PBL', xbl: 'XBL', abl: 'ABL', uefi: 'UEFI', lk: 'LK', lk2: 'LK2', boot: 'Boot', training: 'Training', diag: 'Diag', hdiag: 'HDiag', test: 'Test', os: 'OS',
}

export const RESULT_STAGE_GROUP_LABEL: Record<ResultStageGroup, string> = {
  firmware: '부팅',
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
  const platformFirmware = firmwareOrder.map((stage) => byStage.get(stage)).find(Boolean)
  const training = byStage.get('training')
  const firmware = training?.status === 'fail' ? training : platformFirmware
  let os = byStage.get('os')
  const testCandidates = ['test', 'hdiag', 'diag']
    .map((stage) => byStage.get(stage as EvaluationStage))
    .filter((item): item is EvaluationStageResult => Boolean(item))
    .sort((left, right) => statusPriority[right.status] - statusPriority[left.status])
  let test = testCandidates.find((item) => item.status === 'fail')
    ?? (finalResult === 'PASS' ? testCandidates.find((item) => item.status === 'pass') : undefined)
    ?? (finalResult !== 'TRAINING_FAIL' ? testCandidates.find((item) => item.status === 'reached') : undefined)
  const interrupted = finalResult === 'SYSTEM_REBOOT' || finalResult === 'SYSTEM_HALT'
  if (interrupted) {
    if (test) test = { ...test, status: 'fail' }
    else if (os) os = { ...os, status: 'fail' }
  }
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
    : key === 'vdd'
      ? /\bvdd\s*[:=]\s*(?<value>\d+(?:\.\d+)?)\s*V?\b/giu
      : key === 'grid'
        ? /(?:grid|matrix|test\s+grid)\s*[:=]\s*(?<value>[A-Z0-9][A-Z0-9xX*-]*)/giu
        : /sample\s*[:=]\s*(?<value>[A-Z0-9_-]+)/giu
  const values = uniqueMatches(text, pattern)
  return values.length === 1 ? { value: values[0], state: 'candidate' } : { value: null, state: values.length > 1 ? 'malformed' : 'missing' }
}

function metadataCandidate(file: WorkbenchFile, key: PatternAxis): CandidateValue {
  if (isMalformedName(file.name)) return { value: null, state: 'malformed' }
  if (key === 'vdd') {
    const parsedVdd = extractLpddrFilenameDimensions(file.relativePath ?? file.name).vdd
    return parsedVdd !== undefined
      ? { value: String(parsedVdd), state: 'candidate' }
      : fallbackFromContent(file, key)
  }
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
  const failureCandidates: Array<{ result: ResultLabel; pattern: RegExp }> = [
    { result: 'SYSTEM_REBOOT', pattern: /reboot_reason|WATCHDOG_RESET|session recovery detected|\bTERMINAL_RESULT=SYSTEM_REBOOT\b/i },
    { result: 'SYSTEM_HALT', pattern: /\b(?:TERMINAL_RESULT=)?SYSTEM_HALT\b/i },
    { result: 'TRAINING_FAIL', pattern: /TRAINING_FAIL|training:\s*.+timeout/i },
    { result: 'DIAG_FAIL', pattern: /DIAG_FAIL|hidag[^\n]*(?:fail|error)/i },
    { result: 'TEST_FAIL', pattern: /TEST_FAIL|@FAIL/i },
  ]
  for (const candidate of failureCandidates) {
    if (candidate.pattern.test(text)) {
      candidate.pattern.lastIndex = 0
      return { result: candidate.result, evidenceCount: matchingLineCount(text, candidate.pattern) }
    }
  }
  const filenameOutcome = extractLpddrFilenameOutcome(file.relativePath ?? file.name)
  if (filenameOutcome) return { result: filenameOutcome, evidenceCount: 1 }
  const passPattern = /(?:@PASS\b|\bTERMINAL_RESULT=PASS\b)/i
  if (passPattern.test(text)) return { result: 'PASS', evidenceCount: matchingLineCount(text, passPattern) }
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
    { stage: 'test', status: 'reached', pattern: /(?:\bTEST[^\n]*(?:START|BEGIN)\b|\bSTRESSAPP[^\n]*(?:START|BEGIN)\b)/i },
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
  failureAddressEventsBySource: FailureAddressEventsBySource = {},
): LogResultRecord[] {
  const folderLabels = rootAwareFolderLabels(files)
  return files.map((file) => {
    const approvals = metadataApprovals[file.id] ?? {}
    const fileName = file.relativePath ?? file.name
    const positionalFilename = parsePositionalLabFilename(fileName)
    const filenameDimensions = extractLpddrFilenameDimensions(fileName)
    const sampleCandidate = positionalFilename && filenameDimensions.sample !== undefined
      ? { value: String(filenameDimensions.sample), state: 'candidate' as const }
      : metadataCandidate(file, 'sample')
    const temperatureCandidate = positionalFilename && filenameDimensions.temperatureC !== undefined
      ? { value: String(filenameDimensions.temperatureC), state: 'candidate' as const }
      : metadataCandidate(file, 'temperature')
    const vddCandidate = filenameDimensions.vdd !== undefined
      ? { value: String(filenameDimensions.vdd), state: 'candidate' as const }
      : metadataCandidate(file, 'vdd')
    const sample = applyMetadataApproval(sampleCandidate, approvals.sample)
    const temperature = applyMetadataApproval(temperatureCandidate, approvals.temperature)
    const vdd = applyMetadataApproval(vddCandidate, approvals.vdd)
    const gridCandidate = positionalFilename && filenameDimensions.gridId !== undefined
      ? { value: String(filenameDimensions.gridId), state: 'candidate' as const }
      : metadataCandidate(file, 'grid')
    const grid = applyMetadataApproval(gridCandidate, approvals.grid)
    const inferred = inferResultCandidate(file)
    const stageResults = stageResultsBySource[file.id] ?? inferStageResults(file)
    const result = file.decision ?? file.ruleResult ?? inferred.result
    const failureAddress = failureAddressEventsBySource[file.id]
    const resultSource: ResultSource = file.decision
      ? 'engineer'
      : file.ruleResult && file.ruleResult !== 'UNKNOWN'
        ? 'rule'
        : inferred.result !== 'UNKNOWN'
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
      vdd,
      grid,
      dimensions: {
        ...filenameDimensions,
        // Material and Sample are one canonical identifier in this product.
        // A user correction in Results must update both legacy contract aliases.
        ...(sample.value !== null ? { sample: sample.value, material: sample.value } : {}),
        ...(temperature.value !== null && Number.isFinite(Number(temperature.value)) ? { temperatureC: Number(temperature.value) } : {}),
        ...(vdd.value !== null && Number.isFinite(Number(vdd.value)) ? { vdd: Number(vdd.value) } : {}),
      },
      result,
      resultSource,
      stageResults,
      ...(pivotFailureResult(result) && failureAddress?.events.length ? { failureAddressEvents: failureAddress.events } : {}),
      ...(pivotFailureResult(result) && failureAddress?.truncated ? { failureAddressTruncated: true } : {}),
      review: (file.decision || (file.ruleResult && file.ruleResult !== 'UNKNOWN')) && !file.ruleNeedsReview ? 'confirmed' : 'needs_review',
      evidenceCount: hasSelectedEvidence ? selectedEvidenceCount : inferred.evidenceCount,
      selectedEvidenceCount,
    }
  })
}

function pivotFailureResult(result: ResultLabel): boolean {
  return result !== 'PASS' && result !== 'UNKNOWN' && result !== 'INCOMPLETE' && result !== 'EXCLUDED'
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
    return [row.fileName, row.folder, row.relativePath, row.sample.value, row.temperature.value, row.vdd.value, row.grid.value, ...Object.values(row.dimensions ?? {}), row.result, row.stageResults.map((item) => `${STAGE_LABEL_KO[item.stage]} ${item.status}`).join(' ')]
      .some((value) => normalized(value).includes(query))
  })
}

const PIVOT_UNKNOWN = '미확인'
const FAILURE_ADDRESS_DIMENSIONS = new Set<PivotDimension>([
  'channel', 'subChannel', 'chipSelect', 'rank', 'bankGroup', 'bank', 'row', 'column', 'writeData', 'readData', 'dq', 'bl',
])
const FAILURE_ADDRESS_LABELS: ReadonlyArray<[keyof ArtifactFailureAddressFields, string]> = [
  ['dq', 'DQ'], ['bl', 'BL'], ['channel', 'Channel'], ['subChannel', 'Sub Channel'],
  ['bankGroup', 'Bank Group'], ['bank', 'Bank'], ['row', 'Row'], ['column', 'Column'],
]

function pivotDimensionValue(row: LogResultRecord, dimension: PivotDimension, event?: ArtifactFailureAddressEvent): string {
  if (event && FAILURE_ADDRESS_DIMENSIONS.has(dimension)) {
    const value = event.fields[dimension as keyof ArtifactFailureAddressFields]
    return value === undefined || value === null || value === '' ? PIVOT_UNKNOWN : String(value)
  }
  if (dimension === 'sample' || dimension === 'temperature' || dimension === 'vdd' || dimension === 'grid') {
    return row[dimension].value ?? PIVOT_UNKNOWN
  }
  if (dimension === 'run') return row.run ?? PIVOT_UNKNOWN
  if (row.dimensions && dimension in row.dimensions) {
    const value = row.dimensions[dimension as keyof ProjectEvaluationDimensions]
    return value === undefined || value === null || value === '' ? PIVOT_UNKNOWN : String(value)
  }
  if (dimension === 'result') return row.result
  if (dimension === 'review') return row.review
  if (dimension === 'folder') return row.folder || PIVOT_UNKNOWN
  return PIVOT_UNKNOWN
}

function pivotKey(values: readonly string[]): string {
  return JSON.stringify(values)
}

function comparePivotHeaders(left: PivotHeader, right: PivotHeader): number {
  return left.label.localeCompare(right.label, 'ko-KR', { numeric: true, sensitivity: 'base' })
}

function pivotFailure(row: LogResultRecord): boolean {
  return pivotFailureResult(row.result)
}

type PivotAccumulator = {
  recordCount: number
  definitiveCount: number
  passCount: number
  failCount: number
  evidenceCount: number
  sampleIds: Set<string>
  gridIds: Set<string>
  sourceIds: string[]
  failureEventCount: number
  signatureCounts: Map<string, number>
  failureSourceIds: Set<string>
}

function freshPivotAccumulator(): PivotAccumulator {
  return { recordCount: 0, definitiveCount: 0, passCount: 0, failCount: 0, evidenceCount: 0, sampleIds: new Set(), gridIds: new Set(), sourceIds: [], failureEventCount: 0, signatureCounts: new Map(), failureSourceIds: new Set() }
}

function failureSignature(fields: ArtifactFailureAddressFields): string | undefined {
  const parts = FAILURE_ADDRESS_LABELS.flatMap(([key, label]) => {
    const value = fields[key]
    return value === undefined || value === null || value === '' ? [] : [`${label} ${value}`]
  })
  return parts.slice(0, 2).join(' · ') || undefined
}

function addFailureEvent(value: PivotAccumulator, event: ArtifactFailureAddressEvent, sourceId: string): void {
  value.failureEventCount += 1
  value.failureSourceIds.add(sourceId)
  const signature = failureSignature(event.fields)
  if (signature) value.signatureCounts.set(signature, (value.signatureCounts.get(signature) ?? 0) + 1)
}

function topFailureSignature(value: PivotAccumulator | undefined): string | undefined {
  return value ? [...value.signatureCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ko-KR', { numeric: true }))
    .at(0)?.[0] : undefined
}

export function isFailureAddressAggregation(aggregation: PivotAggregation): boolean {
  return aggregation === 'fail_event_count' || aggregation === 'fail_source_count' || aggregation === 'fail_event_share'
}

function pivotAccumulatorValue(value: PivotAccumulator, aggregation: PivotAggregation, totalFailureEvents = value.failureEventCount): number {
  if (aggregation === 'evidence_count') return value.evidenceCount
  if (aggregation === 'sample_count') return value.sampleIds.size
  if (aggregation === 'grid_count') return value.gridIds.size
  if (aggregation === 'pass_count') return value.passCount
  if (aggregation === 'fail_count') return value.failCount
  if (aggregation === 'pass_fail') return value.definitiveCount
  if (aggregation === 'fail_rate') return value.definitiveCount ? Math.round((value.failCount / value.definitiveCount) * 1_000) / 10 : 0
  if (aggregation === 'fail_event_count') return value.failureEventCount
  if (aggregation === 'fail_source_count') return value.failureSourceIds.size
  if (aggregation === 'fail_event_share') return totalFailureEvents ? Math.round((value.failureEventCount / totalFailureEvents) * 1_000) / 10 : 0
  return value.recordCount
}

function validatePivotAxes(axis: readonly PivotDimension[], name: string): void {
  if (axis.length > 3) throw new RangeError(`Pivot ${name} may contain at most three dimensions`)
  if (new Set(axis).size !== axis.length) throw new RangeError(`Pivot ${name} may not contain duplicate dimensions`)
}

/** Builds a deterministic, source-traceable pivot without mutating records or configuration. */
export function buildPivotGrid(rows: readonly LogResultRecord[], config: PivotConfig): PivotGrid {
  validatePivotAxes(config.rows, 'rows')
  validatePivotAxes(config.columns, 'columns')
  const filtered = filterLogRecords(rows, config.filters)
  const rowMap = new Map<string, PivotHeader>()
  const columnMap = new Map<string, PivotHeader>()
  const values = new Map<string, PivotAccumulator>()
  const allSourceIds: string[] = []
  const total = freshPivotAccumulator()
  const failureAddressMode = isFailureAddressAggregation(config.aggregation)

  for (const row of filtered) {
    const failed = pivotFailure(row)
    const passed = row.result === 'PASS'
    const definitive = passed || failed
    const sampleId = row.sample.value ?? row.dimensions?.sample
    const gridId = row.grid.value ?? row.dimensions?.gridId
    const gridKey = gridId === undefined || gridId === null || String(gridId).trim() === ''
      ? undefined
      : JSON.stringify([row.folder, sampleId ?? '', String(gridId).trim(), row.run ?? ''])
    const events = failureAddressMode ? [...(row.failureAddressEvents ?? [])] : [undefined]
    for (const event of events) {
      const rowValues = config.rows.map((dimension) => pivotDimensionValue(row, dimension, event))
      const columnValues = config.columns.map((dimension) => pivotDimensionValue(row, dimension, event))
      const rowHeader: PivotHeader = { key: pivotKey(rowValues), values: [...rowValues], label: rowValues.join(' / ') || '전체' }
      const columnHeader: PivotHeader = { key: pivotKey(columnValues), values: [...columnValues], label: columnValues.join(' / ') || '전체' }
      rowMap.set(rowHeader.key, rowHeader)
      columnMap.set(columnHeader.key, columnHeader)
      const cellKey = `${rowHeader.key}\u0000${columnHeader.key}`
      const cell = values.get(cellKey) ?? freshPivotAccumulator()
      cell.recordCount += 1
      total.recordCount += 1
      if (failureAddressMode && event) {
        addFailureEvent(cell, event, row.id)
        addFailureEvent(total, event, row.id)
      } else {
        cell.definitiveCount += definitive ? 1 : 0
        cell.passCount += passed ? 1 : 0
        cell.failCount += failed ? 1 : 0
        cell.evidenceCount += row.evidenceCount
        total.definitiveCount += definitive ? 1 : 0
        total.passCount += passed ? 1 : 0
        total.failCount += failed ? 1 : 0
        total.evidenceCount += row.evidenceCount
        for (const addressEvent of row.failureAddressEvents ?? []) {
          addFailureEvent(cell, addressEvent, row.id)
          addFailureEvent(total, addressEvent, row.id)
        }
      }
      if (sampleId !== undefined && sampleId !== null && String(sampleId).trim()) {
        cell.sampleIds.add(String(sampleId).trim())
        total.sampleIds.add(String(sampleId).trim())
      }
      if (gridKey) { cell.gridIds.add(gridKey); total.gridIds.add(gridKey) }
      const includeSource = failureAddressMode
        || config.aggregation === 'count'
        || (config.aggregation === 'sample_count' && sampleId !== undefined && sampleId !== null && String(sampleId).trim() !== '')
        || (config.aggregation === 'grid_count' && Boolean(gridKey))
        || (config.aggregation === 'pass_count' && passed)
        || (config.aggregation === 'pass_fail' && definitive)
        || (config.aggregation === 'fail_rate' && definitive)
        || (config.aggregation === 'fail_count' && failed)
        || (config.aggregation === 'evidence_count' && row.evidenceCount > 0)
      if (includeSource && !cell.sourceIds.includes(row.id)) cell.sourceIds.push(row.id)
      if (includeSource && !total.sourceIds.includes(row.id)) total.sourceIds.push(row.id)
      values.set(cellKey, cell)
      if (includeSource && !allSourceIds.includes(row.id)) allSourceIds.push(row.id)
    }
  }

  const pivotRows = [...rowMap.values()].sort(comparePivotHeaders)
  const pivotColumns = [...columnMap.values()].sort(comparePivotHeaders)
  const cells = pivotRows.map((rowHeader) => pivotColumns.map((columnHeader) => {
    const cell = values.get(`${rowHeader.key}\u0000${columnHeader.key}`)
    return {
      value: cell ? pivotAccumulatorValue(cell, config.aggregation, total.failureEventCount) : 0,
      sourceIds: Object.freeze([...(cell?.sourceIds ?? [])]),
      ...(['pass_fail', 'fail_rate'].includes(config.aggregation) ? { breakdown: {
        passCount: cell?.passCount ?? 0,
        failCount: cell?.failCount ?? 0,
        definitiveCount: cell?.definitiveCount ?? 0,
        ...(topFailureSignature(cell) ? { topFailureSignature: topFailureSignature(cell) } : {}),
      } } : {}),
      ...(cell?.failureEventCount ? { failureAddress: {
        eventCount: cell.failureEventCount,
        sourceCount: cell.failureSourceIds.size,
        totalEventCount: total.failureEventCount,
        eventShare: total.failureEventCount ? cell.failureEventCount / total.failureEventCount : 0,
        ...(topFailureSignature(cell) ? { topSignature: topFailureSignature(cell) } : {}),
      } } : {}),
    }
  }))
  return {
    rows: Object.freeze(pivotRows.map((header) => ({ ...header, values: Object.freeze([...header.values]) }))),
    columns: Object.freeze(pivotColumns.map((header) => ({ ...header, values: Object.freeze([...header.values]) }))),
    cells: Object.freeze(cells.map((row) => Object.freeze(row))),
    total: pivotAccumulatorValue(total, config.aggregation, total.failureEventCount),
    sourceIds: Object.freeze(allSourceIds),
    ...(['pass_fail', 'fail_rate'].includes(config.aggregation) ? { breakdown: {
      passCount: total.passCount,
      failCount: total.failCount,
      definitiveCount: total.definitiveCount,
      ...(topFailureSignature(total) ? { topFailureSignature: topFailureSignature(total) } : {}),
    } } : {}),
    ...(total.failureEventCount ? { failureAddress: {
      eventCount: total.failureEventCount,
      sourceCount: total.failureSourceIds.size,
      totalEventCount: total.failureEventCount,
      eventShare: 1,
      ...(topFailureSignature(total) ? { topSignature: topFailureSignature(total) } : {}),
    } } : {}),
  }
}

function sortableValue(row: LogResultRecord, key: LogRecordSortKey): string | number {
  if (key === 'sample' || key === 'temperature' || key === 'vdd' || key === 'grid') return row[key].value ?? ''
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
  'vdd',
  'vdd_state',
  'grid_value',
  'grid_state',
  'result',
  'result_source',
  'review',
  'stage_results',
] as const

export const ENGINEERING_EXPORT_COLUMNS = [
  'skew', 'lot', 'material', 'die', 'soc_model', 'equipment_channel', 'ecc_mode', 'custom_condition', 'evaluation_step', 'temperature_corner', 'frequency_mhz', 'vdd_corner', 'condition_corner', 'test_mode', 'pattern', 'dq', 'bl', 'channel', 'sub_channel',
  'chip_select', 'rank', 'bank_group', 'bank', 'row', 'column', 'write_data', 'read_data', 'timing_skew_ps',
] as const
export const EVIDENCE_EXPORT_COLUMNS = ['evidence_count', 'selected_evidence_count'] as const
export type LogRecordExportColumn = typeof BASE_EXPORT_HEADER[number] | typeof ENGINEERING_EXPORT_COLUMNS[number] | typeof EVIDENCE_EXPORT_COLUMNS[number]

/** Shared default: metadata and result columns only; evidence is opt-in as a group. */
export const DEFAULT_EXPORT_COLUMNS: readonly LogRecordExportColumn[] = [...BASE_EXPORT_HEADER]

export const EXPORT_COLUMN_DEFINITIONS: ReadonlyArray<{
  key: LogRecordExportColumn
  label: string
  group?: 'evidence'
  section: 'identity' | 'condition' | 'result' | 'evidence'
}> = [
  { key: 'source_id', label: 'Source ID', section: 'identity' },
  { key: 'artifact_id', label: 'Artifact ID', section: 'identity' },
  { key: 'source_key', label: 'Source key', section: 'identity' },
  { key: 'relative_path', label: '상대 경로', section: 'identity' },
  { key: 'run', label: 'Run', section: 'identity' },
  { key: 'filename', label: '파일명', section: 'identity' },
  { key: 'folder', label: '폴더', section: 'identity' },
  { key: 'skew', label: 'SKEW', section: 'condition' },
  { key: 'lot', label: 'Lot', section: 'condition' },
  { key: 'die', label: 'Die', section: 'condition' },
  { key: 'soc_model', label: 'SoC', section: 'condition' },
  { key: 'equipment_channel', label: '실장기 채널', section: 'condition' },
  { key: 'ecc_mode', label: 'ECC', section: 'condition' },
  { key: 'custom_condition', label: '사용자 조건', section: 'condition' },
  { key: 'evaluation_step', label: '평가 Step', section: 'condition' },
  { key: 'sample_value', label: '자재 (Sample)', section: 'condition' },
  { key: 'temperature_value', label: '온도 (°C)', section: 'condition' },
  { key: 'temperature_corner', label: '온도 조건', section: 'condition' },
  { key: 'test_mode', label: 'Test Mode', section: 'condition' },
  { key: 'frequency_mhz', label: '주파수 (MHz)', section: 'condition' },
  { key: 'vdd', label: 'VDD (V)', section: 'condition' },
  { key: 'vdd_corner', label: 'VDD 조건', section: 'condition' },
  { key: 'condition_corner', label: '4-Corner', section: 'condition' },
  { key: 'pattern', label: 'Pattern', section: 'condition' },
  { key: 'dq', label: 'DQ', section: 'condition' },
  { key: 'bl', label: 'BL', section: 'condition' },
  { key: 'channel', label: 'Channel', section: 'condition' },
  { key: 'sub_channel', label: 'Sub Channel', section: 'condition' },
  { key: 'chip_select', label: 'CS', section: 'condition' },
  { key: 'rank', label: 'Rank', section: 'condition' },
  { key: 'bank_group', label: 'Bank Group', section: 'condition' },
  { key: 'bank', label: 'Bank', section: 'condition' },
  { key: 'row', label: 'Row', section: 'condition' },
  { key: 'column', label: 'Column', section: 'condition' },
  { key: 'write_data', label: 'WR', section: 'condition' },
  { key: 'read_data', label: 'RD', section: 'condition' },
  { key: 'timing_skew_ps', label: 'Timing SKEW (ps)', section: 'condition' },
  { key: 'grid_value', label: 'Grid', section: 'condition' },
  { key: 'sample_state', label: 'Sample 상태', section: 'result' },
  { key: 'temperature_state', label: '온도 상태', section: 'result' },
  { key: 'vdd_state', label: 'VDD 상태', section: 'result' },
  { key: 'grid_state', label: 'Grid 상태', section: 'result' },
  { key: 'result', label: '결과', section: 'result' },
  { key: 'result_source', label: '결과 출처', section: 'result' },
  { key: 'review', label: '검토', section: 'result' },
  { key: 'stage_results', label: '단계별 결과', section: 'result' },
  { key: 'evidence_count', label: '자동 판정 신호 수', group: 'evidence', section: 'evidence' },
  { key: 'selected_evidence_count', label: '직접 선택한 근거 줄 수', group: 'evidence', section: 'evidence' },
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
    skew: row.dimensions?.skew ?? '',
    lot: row.dimensions?.lot ?? '',
    material: row.dimensions?.material ?? '',
    die: row.dimensions?.die ?? '',
    soc_model: row.dimensions?.socModel ?? '',
    equipment_channel: row.dimensions?.equipmentChannel ?? '',
    ecc_mode: row.dimensions?.eccMode ?? '',
    custom_condition: row.dimensions?.customCondition ?? '',
    evaluation_step: row.dimensions?.evaluationStep ?? '',
    temperature_corner: row.dimensions?.temperatureCorner ?? '',
    frequency_mhz: row.dimensions?.frequencyMHz ?? '',
    vdd: row.dimensions?.vdd ?? '',
    vdd_corner: row.dimensions?.vddCorner ?? '',
    condition_corner: row.dimensions?.conditionCorner ?? '',
    test_mode: row.dimensions?.testMode ?? '',
    pattern: row.dimensions?.pattern ?? '',
    dq: row.dimensions?.dq ?? '',
    bl: row.dimensions?.bl ?? '',
    channel: row.dimensions?.channel ?? '',
    sub_channel: row.dimensions?.subChannel ?? '',
    chip_select: row.dimensions?.chipSelect ?? '',
    rank: row.dimensions?.rank ?? '',
    bank_group: row.dimensions?.bankGroup ?? '',
    bank: row.dimensions?.bank ?? '',
    row: row.dimensions?.row ?? '',
    column: row.dimensions?.column ?? '',
    write_data: row.dimensions?.writeData ?? '',
    read_data: row.dimensions?.readData ?? '',
    timing_skew_ps: row.dimensions?.timingSkewPs ?? '',
    sample_value: row.sample.value ?? '',
    sample_state: row.sample.state,
    temperature_value: row.temperature.value ?? '',
    temperature_state: row.temperature.state,
    vdd_state: row.vdd.state,
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

const FAILURE_ADDRESS_EXPORT_COLUMNS = [
  'source_id', 'artifact_id', 'filename', 'folder', 'line_number', 'result',
  'sample', 'skew', 'lot', 'die', 'grid', 'run', 'temperature_c', 'temperature_corner',
  'vdd', 'vdd_corner', 'frequency_mhz', 'test_mode', 'pattern', 'soc_model', 'equipment_channel', 'ecc_mode', 'custom_condition', 'evaluation_step',
  'channel', 'sub_channel', 'chip_select', 'rank', 'bank_group', 'bank', 'row', 'column', 'dq', 'bl', 'write_data', 'read_data',
] as const

/** Exports one explicit fail-address event per row for Spotfire/Excel joins. */
export function serializeFailureAddressEventsCsv(rows: readonly LogResultRecord[]): string {
  const records: unknown[][] = [
    [...FAILURE_ADDRESS_EXPORT_COLUMNS],
    ...rows.flatMap((record) => (record.failureAddressEvents ?? []).map((event) => {
      const fields = event.fields
      const values: Record<(typeof FAILURE_ADDRESS_EXPORT_COLUMNS)[number], unknown> = {
        source_id: record.id,
        artifact_id: record.artifactId ?? '',
        filename: pathBaseName(record.fileName),
        folder: safeExportPath(record.folder),
        line_number: event.lineNumber,
        result: record.result,
        sample: record.sample.value ?? record.dimensions?.sample ?? '',
        skew: record.dimensions?.skew ?? '',
        lot: record.dimensions?.lot ?? '',
        die: record.dimensions?.die ?? '',
        grid: record.grid.value ?? record.dimensions?.gridId ?? '',
        run: record.run ?? '',
        temperature_c: record.temperature.value ?? record.dimensions?.temperatureC ?? '',
        temperature_corner: record.dimensions?.temperatureCorner ?? '',
        vdd: record.dimensions?.vdd ?? '',
        vdd_corner: record.dimensions?.vddCorner ?? '',
        frequency_mhz: record.dimensions?.frequencyMHz ?? '',
        test_mode: record.dimensions?.testMode ?? '',
        pattern: record.dimensions?.pattern ?? '',
        soc_model: record.dimensions?.socModel ?? '',
        equipment_channel: record.dimensions?.equipmentChannel ?? '',
        ecc_mode: record.dimensions?.eccMode ?? '',
        custom_condition: record.dimensions?.customCondition ?? '',
        evaluation_step: record.dimensions?.evaluationStep ?? '',
        channel: fields.channel ?? '', sub_channel: fields.subChannel ?? '', chip_select: fields.chipSelect ?? '', rank: fields.rank ?? '',
        bank_group: fields.bankGroup ?? '', bank: fields.bank ?? '', row: fields.row ?? '', column: fields.column ?? '',
        dq: fields.dq ?? '', bl: fields.bl ?? '', write_data: fields.writeData ?? '', read_data: fields.readData ?? '',
      }
      return FAILURE_ADDRESS_EXPORT_COLUMNS.map((column) => values[column])
    })),
  ]
  const escape = (value: unknown) => `"${normalizedExportCell(value).replace(/"/g, '""')}"`
  return `\uFEFF${records.map((record) => record.map(escape).join(',')).join('\r\n')}`
}

/** Exports the visible n×m pivot exactly as arranged on screen. */
export type PivotGridExportOptions = {
  rowTotals?: readonly (number | string)[]
  columnTotals?: readonly (number | string)[]
  grandTotal?: number | string
  totalLabel?: string
  formatValue?: (value: number) => string | number
  formatCell?: (cell: PivotCell, rowIndex: number, columnIndex: number) => string | number
}

function pivotGridExportRows(grid: PivotGrid, rowHeader: string | readonly string[], options: PivotGridExportOptions = {}): unknown[][] {
  const rowHeaders = typeof rowHeader === 'string' ? [rowHeader] : [...rowHeader]
  const useSeparateRowValues = typeof rowHeader !== 'string'
  const format = options.formatValue ?? ((value: number) => value)
  const formatTotal = (value: number | string) => typeof value === 'number' ? format(value) : value
  const includeTotals = Boolean(options.rowTotals && options.columnTotals)
  const rows: unknown[][] = [
    [...rowHeaders, ...grid.columns.map((column) => column.label), ...(includeTotals ? [options.totalLabel ?? '합계'] : [])],
    ...grid.rows.map((row, rowIndex) => [
      ...(useSeparateRowValues ? row.values : [row.label]),
      ...grid.cells[rowIndex].map((cell, columnIndex) => options.formatCell?.(cell, rowIndex, columnIndex) ?? format(cell.value)),
      ...(includeTotals ? [formatTotal(options.rowTotals?.[rowIndex] ?? 0)] : []),
    ]),
  ]
  if (includeTotals) rows.push([
    options.totalLabel ?? '합계',
    ...Array.from({ length: Math.max(0, rowHeaders.length - 1) }, () => ''),
    ...(options.columnTotals ?? []).map(formatTotal),
    formatTotal(options.grandTotal ?? grid.total),
  ])
  return rows
}

export function serializePivotGridCsv(grid: PivotGrid, rowHeader: string | readonly string[] = '세로 / 가로', options: PivotGridExportOptions = {}): string {
  const escape = (value: unknown) => `"${normalizedExportCell(value).replace(/"/g, '""')}"`
  const rows = pivotGridExportRows(grid, rowHeader, options)
  return `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`
}

/** Copies the arranged pivot directly into Excel, Teams, or a spreadsheet editor. */
export function serializePivotGridTsv(grid: PivotGrid, rowHeader: string | readonly string[] = '세로 / 가로', options: PivotGridExportOptions = {}): string {
  return `\uFEFF${pivotGridExportRows(grid, rowHeader, options).map((row) => row.map(normalizedExportCell).join('\t')).join('\r\n')}`
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
    vdd: Object.freeze({ ...row.vdd }),
    grid: Object.freeze({ ...row.grid }),
    ...(row.dimensions ? { dimensions: Object.freeze({ ...row.dimensions }) } : {}),
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
