import type { ResultLabel } from '../domain/workbench'
import type { MetadataFieldDefinition } from '../domain/workbench/records'
import type { WorkbenchFile } from '../views/WorkbenchView'

export type CandidateState = 'candidate' | 'approved' | 'rejected' | 'missing' | 'malformed'
export type ReviewState = 'confirmed' | 'needs_review'
export type ResultSource = 'engineer' | 'candidate' | 'unreviewed'
export type PatternAxis = 'sample' | 'temperature' | 'mode'

export interface CandidateValue {
  value: string | null
  state: CandidateState
}

export interface MetadataApprovalValue {
  approval: 'approved' | 'rejected'
  candidateValue?: string
  approvedValue?: string
}

export type MetadataApprovalsBySource = Readonly<Record<string, Readonly<Record<string, MetadataApprovalValue>>>>

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
  result: ResultLabel
  resultSource: ResultSource
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

export type LogRecordSortKey = 'fileName' | 'folder' | 'sample' | 'temperature' | 'mode' | 'result' | 'review' | 'evidenceCount'
export type SortDirection = 'asc' | 'desc'

export interface PatternMatrixRow {
  value: string
  total: number
  counts: Partial<Record<ResultLabel, number>>
}

/** These patterns are visible product defaults, never silently confirmed metadata. */
export const DEFAULT_METADATA_FIELDS: readonly MetadataFieldDefinition[] = [
  { key: 'sample', label: 'Sample', target: 'file_name', pattern: '(?:^|[_.-])(?:SAMPLE|SMP|S)[=_-]?(?:(?:SAMPLE|SMP)[=_-])?(?<value>[A-Z0-9-]+?)(?=[_.-])', captureGroup: 'value' },
  { key: 'temperature', label: 'Temperature', target: 'file_name', pattern: '(?:TEMP[=_-]?)?(?<value>-?\\d+(?:[p.]\\d+)?)C(?=[_.-]|$)', captureGroup: 'value' },
  { key: 'mode', label: 'Mode', target: 'file_name', pattern: '(?:MODE[=_-]?)?(?<value>DIAG|TEST|TRAINING|STRESS|NORMAL|UEFI)(?=[_.-]|$)', captureGroup: 'value' },
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
      : /sample\s*[:=]\s*(?<value>[A-Z0-9_-]+)/giu
  const values = uniqueMatches(text, pattern)
  return values.length === 1 ? { value: values[0], state: 'candidate' } : { value: null, state: values.length > 1 ? 'malformed' : 'missing' }
}

function metadataCandidate(file: WorkbenchFile, key: PatternAxis): CandidateValue {
  const definition = DEFAULT_METADATA_FIELDS.find((field) => field.key === key)
  if (!definition) return { value: null, state: 'missing' }
  const fromName = candidateFromName(file.name, definition)
  return fromName.state === 'missing' ? fallbackFromContent(file, key) : fromName
}

function applyMetadataApproval(candidate: CandidateValue, approval: MetadataApprovalValue | undefined): CandidateValue {
  if (!approval) return candidate
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
    { result: 'SYSTEM_REBOOT', pattern: /reboot_reason|WATCHDOG_RESET|session recovery detected/i },
    { result: 'TRAINING_FAIL', pattern: /TRAINING_FAIL|training:\s*.+timeout/i },
    { result: 'DIAG_FAIL', pattern: /DIAG_FAIL|hidag[^\n]*(?:fail|error)/i },
    { result: 'TEST_FAIL', pattern: /TEST_FAIL|@FAIL/i },
    { result: 'PASS', pattern: /@PASS\b/i },
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

export function projectLogRecords(
  files: readonly WorkbenchFile[],
  selectedEvidence: Readonly<Record<string, number>> = {},
  metadataApprovals: MetadataApprovalsBySource = {},
): LogResultRecord[] {
  const folderLabels = rootAwareFolderLabels(files)
  return files.map((file) => {
    const approvals = metadataApprovals[file.id] ?? {}
    const sample = applyMetadataApproval(metadataCandidate(file, 'sample'), approvals.sample)
    const temperature = applyMetadataApproval(metadataCandidate(file, 'temperature'), approvals.temperature)
    const mode = applyMetadataApproval(metadataCandidate(file, 'mode'), approvals.mode)
    const inferred = inferResultCandidate(file)
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
      result,
      resultSource,
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
    return [row.fileName, row.folder, row.relativePath, row.sample.value, row.temperature.value, row.mode.value, row.result]
      .some((value) => normalized(value).includes(query))
  })
}

function sortableValue(row: LogResultRecord, key: LogRecordSortKey): string | number {
  if (key === 'sample' || key === 'temperature' || key === 'mode') return row[key].value ?? ''
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
  'result',
  'result_source',
  'review',
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
  { key: 'result', label: '결과' },
  { key: 'result_source', label: '결과 출처' },
  { key: 'review', label: '검토' },
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
    result: row.result,
    result_source: row.resultSource,
    review: row.review,
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

function normalizedExportCell(value: unknown): string {
  return safeSpreadsheetCell(value).replace(/[\t\r\n]+/g, ' ')
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
