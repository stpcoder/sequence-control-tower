export interface LogDraftSource {
  id: string
  text: string
}

export interface ExpectedOccurrence {
  start: number
  end: number
  text: string
}

export interface ReplaceCurrentRequest {
  fileId: string
  line: number
  expected: ExpectedOccurrence
  replacement: string
}

export type ReplaceAllMode = 'literal' | 'regex'

export interface ReplaceAllRequest {
  fileIds: readonly string[]
  pattern: string
  replacement: string
  mode?: ReplaceAllMode
  /** `false` makes the matcher case-insensitive. */
  caseSensitive?: boolean
  wholeWord?: boolean
}

export interface ReplaceCurrentOperation extends ReplaceCurrentRequest {
  kind: 'replace-one'
}

export interface ReplaceAllOperation {
  kind: 'replace-all'
  fileIds: readonly string[]
  pattern: string
  replacement: string
  mode: ReplaceAllMode
  caseSensitive: boolean
  wholeWord: boolean
}

export type LogReplacementOperation = ReplaceCurrentOperation | ReplaceAllOperation

export interface LogDraft {
  readonly sources: readonly LogDraftSource[]
  readonly operations: readonly LogReplacementOperation[]
}

export type DraftValidationCode =
  | 'OK'
  | 'INVALID_FILE_ID'
  | 'INVALID_LINE'
  | 'INVALID_RANGE'
  | 'NEWLINE_REPLACEMENT'
  | 'EMPTY_PATTERN'
  | 'INVALID_REGEX'
  | 'UNSAFE_REGEX'
  | 'ZERO_WIDTH_PATTERN'
  | 'EMPTY_SCOPE'
  | 'STALE_CURRENT_MATCH'

export interface DraftValidationSuccess {
  ok: true
  code: 'OK'
  message: string
}

export interface DraftValidationFailure {
  ok: false
  code: Exclude<DraftValidationCode, 'OK'>
  message: string
}

export type DraftValidationResult = DraftValidationSuccess | DraftValidationFailure

export interface DraftEditResult {
  draft: LogDraft
  validation: DraftValidationResult
  operation?: LogReplacementOperation
}

export interface DraftLineResult {
  text: string
  issues: readonly DraftApplyIssue[]
}

export interface DraftApplyIssue {
  operationIndex: number
  fileId: string
  line?: number
  validation: DraftValidationFailure
}

export interface DraftTextResult extends DraftLineResult {
  fileId: string
}

const OK: DraftValidationSuccess = {
  ok: true,
  code: 'OK',
  message: 'Replacement operation accepted.',
}

function failure(code: Exclude<DraftValidationCode, 'OK'>, message: string): DraftValidationFailure {
  return { ok: false, code, message }
}

function withOperation(draft: LogDraft, operation: LogReplacementOperation, validation: DraftValidationResult = OK): DraftEditResult {
  return {
    draft: {
      sources: draft.sources,
      operations: [...draft.operations, operation],
    },
    validation,
    operation,
  }
}

function rejected(draft: LogDraft, validation: DraftValidationFailure): DraftEditResult {
  return { draft, validation }
}

function hasNewline(value: string): boolean {
  return /[\r\n]/u.test(value)
}

function validateCurrentRequest(request: ReplaceCurrentRequest): DraftValidationResult {
  if (!request.fileId.trim()) return failure('INVALID_FILE_ID', 'A current replacement requires a file id.')
  if (!Number.isInteger(request.line) || request.line < 1) {
    return failure('INVALID_LINE', 'Line numbers are one-based positive integers.')
  }
  if (!Number.isInteger(request.expected.start) || !Number.isInteger(request.expected.end)
    || request.expected.start < 0 || request.expected.end < request.expected.start
    || request.expected.text.length !== request.expected.end - request.expected.start) {
    return failure('INVALID_RANGE', 'The expected occurrence range does not match its text.')
  }
  if (request.expected.start === request.expected.end) {
    return failure('ZERO_WIDTH_PATTERN', 'A current replacement cannot target a zero-width occurrence.')
  }
  if (hasNewline(request.replacement)) {
    return failure('NEWLINE_REPLACEMENT', 'Replacement text must stay on the selected line.')
  }
  return OK
}

export function canMatchZeroWidth(pattern: RegExp): boolean {
  const probes = ['', 'a', '0', 'text', 'text text']
  for (const probe of probes) {
    pattern.lastIndex = 0
    const match = pattern.exec(probe)
    if (match?.[0].length === 0) return true
  }
  return false
}

/** Keep renderer/draft regex safety aligned with artifact-service. */
export function isUnsafeRegex(pattern: string): boolean {
  const safetyPattern = pattern.replace(/\(\?(?:[:=!]|<[=!])/g, '(')
  const nestedQuantifier = /\((?:[^()\\]|\\.)*(?:[+*?]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)\s*(?:[+*?]|\{\d+(?:,\d*)?\})/
  const repeatedWildcard = /\.\s*[+*][^|)]{0,32}\.\s*[+*]/
  return nestedQuantifier.test(safetyPattern) || repeatedWildcard.test(pattern) || /\\[1-9]/.test(pattern)
}

export function wholeTokenPattern(source: string): string {
  return `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
}

function buildMatcher(operation: ReplaceAllOperation): RegExp | DraftValidationFailure {
  const source = operation.mode === 'literal'
    ? operation.pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    : operation.pattern
  if (operation.mode === 'regex' && isUnsafeRegex(source)) {
    return failure('UNSAFE_REGEX', 'This regular expression is unsafe for replacement.')
  }
  const wordWrapped = operation.wholeWord ? wholeTokenPattern(source) : source
  const flags = operation.caseSensitive ? 'gu' : 'giu'

  try {
    const matcher = new RegExp(wordWrapped, flags)
    if (canMatchZeroWidth(matcher)) {
      return failure('ZERO_WIDTH_PATTERN', 'Replace-all patterns must match at least one character.')
    }
    return matcher
  } catch {
    return failure('INVALID_REGEX', 'The replace-all pattern is not a valid regular expression.')
  }
}

function validateReplaceAllRequest(request: ReplaceAllRequest): DraftValidationResult {
  if (request.fileIds.length === 0) return failure('EMPTY_SCOPE', 'Select at least one file for replace-all.')
  if (request.fileIds.some((fileId) => !fileId.trim())) {
    return failure('INVALID_FILE_ID', 'Replace-all scope contains an empty file id.')
  }
  if (hasNewline(request.replacement)) {
    return failure('NEWLINE_REPLACEMENT', 'Replacement text must stay on the selected line.')
  }
  if (!request.pattern) return failure('EMPTY_PATTERN', 'Replace-all requires a non-empty pattern.')

  const operation: ReplaceAllOperation = {
    kind: 'replace-all',
    fileIds: [...new Set(request.fileIds)],
    pattern: request.pattern,
    replacement: request.replacement,
    mode: request.mode ?? 'literal',
    caseSensitive: request.caseSensitive ?? true,
    wholeWord: request.wholeWord ?? false,
  }
  const matcher = buildMatcher(operation)
  return matcher instanceof RegExp ? OK : matcher
}

export function createLogDraft(sources: readonly LogDraftSource[] = []): LogDraft {
  return {
    sources: sources.map((source) => ({ id: source.id, text: source.text })),
    operations: [],
  }
}

export function addCurrentReplacement(draft: LogDraft, request: ReplaceCurrentRequest): DraftEditResult {
  const validation = validateCurrentRequest(request)
  if (!validation.ok) return rejected(draft, validation)
  return withOperation(draft, { kind: 'replace-one', ...request })
}

export function addReplaceAll(draft: LogDraft, request: ReplaceAllRequest): DraftEditResult {
  const validation = validateReplaceAllRequest(request)
  if (!validation.ok) return rejected(draft, validation)
  const operation: ReplaceAllOperation = {
    kind: 'replace-all',
    fileIds: [...new Set(request.fileIds)],
    pattern: request.pattern,
    replacement: request.replacement,
    mode: request.mode ?? 'literal',
    caseSensitive: request.caseSensitive ?? true,
    wholeWord: request.wholeWord ?? false,
  }
  return withOperation(draft, operation)
}

function issue(
  operationIndex: number,
  fileId: string,
  validation: DraftValidationFailure,
  line?: number,
): DraftApplyIssue {
  return { operationIndex, fileId, ...(line === undefined ? {} : { line }), validation }
}

function applyOperationToLine(
  operation: LogReplacementOperation,
  operationIndex: number,
  fileId: string,
  line: number,
  text: string,
): { text: string; issue?: DraftApplyIssue } {
  if (operation.kind === 'replace-one') {
    if (operation.fileId !== fileId || operation.line !== line) return { text }
    const { start, end, text: expectedText } = operation.expected
    if (text.slice(start, end) !== expectedText) {
      return {
        text,
        issue: issue(
          operationIndex,
          fileId,
          failure('STALE_CURRENT_MATCH', 'The current match changed before this replacement was applied.'),
          line,
        ),
      }
    }
    return { text: `${text.slice(0, start)}${operation.replacement}${text.slice(end)}` }
  }

  if (!operation.fileIds.includes(fileId)) return { text }
  const matcher = buildMatcher(operation)
  if (!(matcher instanceof RegExp)) {
    return { text, issue: issue(operationIndex, fileId, matcher) }
  }
  const replaced = operation.mode === 'regex'
    ? text.replace(matcher, operation.replacement)
    : text.replace(matcher, () => operation.replacement)
  return { text: replaced }
}

export function applyLogDraftLine(draft: LogDraft, fileId: string, line: number, sourceLine: string): DraftLineResult {
  let text = sourceLine
  const issues: DraftApplyIssue[] = []
  draft.operations.forEach((operation, operationIndex) => {
    const applied = applyOperationToLine(operation, operationIndex, fileId, line, text)
    text = applied.text
    if (applied.issue) issues.push(applied.issue)
  })
  return { text, issues }
}

export function applyLogDraftToText(draft: LogDraft, fileId: string, sourceText: string): DraftTextResult {
  const parts = sourceText.split(/(\r\n|\n|\r)/u)
  const output: string[] = []
  const issues: DraftApplyIssue[] = []
  let line = 1

  for (const [index, part] of parts.entries()) {
    if (index % 2 === 1) {
      output.push(part)
      line += 1
      continue
    }
    const applied = applyLogDraftLine(draft, fileId, line, part)
    output.push(applied.text)
    issues.push(...applied.issues)
  }

  return { fileId, text: output.join(''), issues }
}

export function applyLogDraftToSources(
  draft: LogDraft,
  sources: readonly LogDraftSource[] = draft.sources,
): readonly DraftTextResult[] {
  return sources.map((source) => applyLogDraftToText(draft, source.id, source.text))
}

export function resetLogDraft(draft: LogDraft): LogDraft {
  return { sources: draft.sources, operations: [] }
}

export function filterLogDraftByFileIds(draft: LogDraft, fileIds: readonly string[]): LogDraft {
  const allowed = new Set(fileIds)
  const operations: LogReplacementOperation[] = []
  for (const operation of draft.operations) {
    if (operation.kind === 'replace-one') {
      if (allowed.has(operation.fileId)) operations.push(operation)
      continue
    }
    const scopedFileIds = operation.fileIds.filter((fileId) => allowed.has(fileId))
    if (scopedFileIds.length > 0) operations.push({ ...operation, fileIds: scopedFileIds })
  }
  return {
    sources: draft.sources,
    operations,
  }
}

export const replaceCurrent = addCurrentReplacement
export const replaceAll = addReplaceAll
export const applyDraftLine = applyLogDraftLine
export const applyDraftToText = applyLogDraftToText
