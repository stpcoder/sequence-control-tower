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
  { key: 'sample', label: 'Sample', target: 'file_name', pattern: '(?:^|[_-])S(?:AMPLE[_-]?)?(?<value>[A-Z0-9-]+?)(?=[_.-])', captureGroup: 'value' },
  { key: 'temperature', label: 'Temperature', target: 'file_name', pattern: '(?:TEMP[=_-]?)?(?<value>-?\\d+(?:[p.]\\d+)?)C(?=[_.-]|$)', captureGroup: 'value' },
  { key: 'mode', label: 'Mode', target: 'file_name', pattern: '(?:MODE[=_-]?)?(?<value>DIAG|TEST|TRAINING|STRESS)(?=[_.-]|$)', captureGroup: 'value' },
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

function uniqueMatches(text: string, pattern: RegExp): string[] {
  const values: string[] = []
  for (const match of text.matchAll(pattern)) {
    const value = match.groups?.value ?? match[1]
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

function candidateFromName(fileName: string, definition: MetadataFieldDefinition): CandidateValue {
  if (isMalformedName(fileName)) return { value: null, state: 'malformed' }
  try {
    const flags = definition.caseSensitive ? 'gu' : 'giu'
    const values = uniqueMatches(fileName, new RegExp(definition.pattern, flags))
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
    const selectedEvidenceCount = selectedEvidence[file.id] ?? 0
    return {
      id: file.id,
      fileName: file.name,
      folder: file.origin ?? file.relativePath?.split(/[\\/]/)[0] ?? 'Imported logs',
      relativePath: file.relativePath ?? file.name,
      sample,
      temperature,
      mode,
      result,
      resultSource,
      review: file.decision && !file.ruleNeedsReview ? 'confirmed' : 'needs_review',
      evidenceCount: selectedEvidenceCount || inferred.evidenceCount,
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

function safeSpreadsheetCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  return /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw
}

export function serializeLogRecordsTsv(rows: readonly LogResultRecord[]): string {
  const header = ['filename', 'folder', 'sample_candidate', 'temperature_candidate', 'mode_candidate', 'result', 'result_source', 'review', 'evidence_count']
  const records = rows.map((row) => [
    row.fileName,
    row.folder,
    row.sample.value ?? '',
    row.temperature.value ?? '',
    row.mode.value ?? '',
    row.result,
    row.resultSource,
    row.review,
    row.evidenceCount,
  ])
  return [header, ...records].map((record) => record.map((cell) => safeSpreadsheetCell(cell).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n')
}

export function serializeLogRecordsCsv(rows: readonly LogResultRecord[]): string {
  return serializeLogRecordsTsv(rows).split('\r\n').map((line) => line.split('\t').map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n')
}
