import type {
  AgentAnswerValue,
  AgentActionName,
  AgentToolName,
  Candidate,
  ConversationMessage,
  ToolAction
} from '../shared/contracts'
import type { FilenameMetadata } from '../../src/domain/workbench/filenameMetadata'

export const AGENT_LIMITS = Object.freeze({
  maxLlmCompletions: 3,
  maxTools: 8,
  maxSearches: 5,
  maxInspectSpecs: 8,
  maxLineWindows: 3,
  maxLinesPerWindow: 20,
  maxCharsPerLine: 800,
  maxAggregateExcerptChars: 4_000,
  maxPromptChars: 8_000,
  maxAgentTextChars: 800,
  maxIdentifierChars: 160,
  maxDepth: 6,
  recentUserMessages: 4,
  recentAssistantMessages: 4
})

export const AGENT_TOOL_ALLOWLIST: readonly AgentToolName[] = ['search', 'lineWindow', 'inspect']
export const AGENT_ACTION_ALLOWLIST: readonly AgentActionName[] = ['ask', 'search', 'lineWindow', 'inspect', 'candidate', 'summary', 'stop']
export type AgentPolicyFailure = 'malformed-json' | 'unknown-tool' | 'budget-exceeded' | 'depth-exceeded' | 'invalid-action'

export interface AgentBudget {
  completions: number
  tools: number
  searches: number
  lineWindows: number
}

export type PolicyResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  failure: AgentPolicyFailure
}

export function emptyAgentBudget(): AgentBudget {
  return { completions: 0, tools: 0, searches: 0, lineWindows: 0 }
}

export function checkAgentBudget(budget: AgentBudget, next: 'completion' | 'tool' | 'search' | 'lineWindow'): PolicyResult<AgentBudget> {
  const value = { ...budget }
  if (next === 'completion') value.completions += 1
  if (next === 'tool') value.tools += 1
  if (next === 'search') value.searches += 1
  if (next === 'lineWindow') value.lineWindows += 1
  if (value.completions > AGENT_LIMITS.maxLlmCompletions || value.tools > AGENT_LIMITS.maxTools
    || value.searches > AGENT_LIMITS.maxSearches || value.lineWindows > AGENT_LIMITS.maxLineWindows) {
    return { ok: false, failure: 'budget-exceeded' }
  }
  return { ok: true, value }
}

export function validateDepth(depth: unknown): PolicyResult<number> {
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) return { ok: false, failure: 'depth-exceeded' }
  return depth > AGENT_LIMITS.maxDepth ? { ok: false, failure: 'depth-exceeded' } : { ok: true, value: depth }
}

export function parseAgentJson<T = unknown>(payload: string): PolicyResult<T> {
  try {
    const value: unknown = JSON.parse(payload)
    if (value === null || typeof value !== 'object') return { ok: false, failure: 'malformed-json' }
    return { ok: true, value: value as T }
  } catch {
    return { ok: false, failure: 'malformed-json' }
  }
}

export function authorizeToolAction(action: unknown, depth = 0): PolicyResult<ToolAction> {
  if (!action || typeof action !== 'object') return { ok: false, failure: 'invalid-action' }
  const candidate = action as Record<string, unknown>
  if (!hasOnlyKeys(candidate, ['tool', 'input', 'reason']) || (candidate.reason !== undefined && !boundedAgentText(candidate.reason))) return { ok: false, failure: 'invalid-action' }
  if (typeof candidate.tool !== 'string' || !AGENT_TOOL_ALLOWLIST.includes(candidate.tool as AgentToolName)) {
    return { ok: false, failure: 'unknown-tool' }
  }
  const depthResult = validateDepth(depth)
  if (!depthResult.ok) return { ok: false, failure: depthResult.failure }
  const input = candidate.input
  if (!input || typeof input !== 'object') return { ok: false, failure: 'invalid-action' }
  const inputValue = input as Record<string, unknown>
  const sourceId = boundedAgentText(inputValue.sourceId)
  const observationId = inputValue.observationId === undefined ? undefined : boundedAgentText(inputValue.observationId)
  if (!sourceId || (inputValue.observationId !== undefined && !observationId)) return { ok: false, failure: 'invalid-action' }
  if (candidate.tool === 'search') {
    const value = inputValue
    if (typeof value.query !== 'string' || !boundedAgentText(value.query) || (value.mode !== 'literal' && value.mode !== 'regex')
      || typeof value.caseSensitive !== 'boolean' || !hasOnlyKeys(value, ['sourceId', 'query', 'mode', 'caseSensitive', 'observationId'])) return { ok: false, failure: 'invalid-action' }
    return { ok: true, value: { tool: 'search', input: { sourceId, query: boundedAgentText(value.query)!, mode: value.mode, caseSensitive: value.caseSensitive, ...(observationId ? { observationId } : {}) }, ...(candidate.reason === undefined ? {} : { reason: boundedAgentText(candidate.reason)! }) } }
  } else if (candidate.tool === 'lineWindow') {
    const value = inputValue
    const startLine = value.startLine
    const lineCount = value.lineCount
    if (typeof startLine !== 'number' || typeof lineCount !== 'number'
      || !Number.isInteger(startLine) || !Number.isInteger(lineCount)
      || startLine < 1 || lineCount < 1 || lineCount > AGENT_LIMITS.maxLinesPerWindow
      || !hasOnlyKeys(value, ['sourceId', 'startLine', 'lineCount', 'observationId'])) {
      return { ok: false, failure: 'invalid-action' }
    }
    return { ok: true, value: { tool: 'lineWindow', input: { sourceId, startLine, lineCount, ...(observationId ? { observationId } : {}) }, ...(candidate.reason === undefined ? {} : { reason: boundedAgentText(candidate.reason)! }) } }
  } else {
    const value = inputValue
    if ((value.target !== 'metadata' && value.target !== 'observation') || !hasOnlyKeys(value, ['sourceId', 'target', 'observationId'])) {
      return { ok: false, failure: 'invalid-action' }
    }
    return { ok: true, value: { tool: 'inspect', input: { sourceId, target: value.target, ...(observationId ? { observationId } : {}) }, ...(candidate.reason === undefined ? {} : { reason: boundedAgentText(candidate.reason)! }) } }
  }
}

/** Validates the complete model envelope before the service dispatches it. */
export function authorizeAgentAction(action: unknown, depth = 0): PolicyResult<Record<string, unknown>> {
  if (!action || typeof action !== 'object') return { ok: false, failure: 'invalid-action' }
  const value = action as Record<string, unknown>
  const name = typeof value.action === 'string' ? value.action : value.tool
  if (typeof name !== 'string' || !AGENT_ACTION_ALLOWLIST.includes(name as AgentActionName)) return { ok: false, failure: 'unknown-tool' }
  if (name === 'search' || name === 'lineWindow' || name === 'inspect') return authorizeToolAction({ tool: name, input: value.input }, depth) as PolicyResult<Record<string, unknown>>
  if (name === 'summary' || name === 'stop') return hasOnlyKeys(value, ['action', 'tool']) ? { ok: true, value: { action: name } } : { ok: false, failure: 'invalid-action' }
  const payload = value[name === 'ask' ? 'question' : 'candidate'] ?? value.input
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, failure: 'invalid-action' }
  if (name === 'ask') {
    const question = payload as Record<string, unknown>
    if (typeof question.id !== 'string' || typeof question.prompt !== 'string' || !boundedAgentText(question.id) || !boundedAgentText(question.prompt)
      || (question.kind !== undefined && question.kind !== 'clarification' && question.kind !== 'approval')
      || (question.choices !== undefined && (!Array.isArray(question.choices) || question.choices.length > 8 || question.choices.some((choice) => !boundedAgentText(choice))))
      || !hasOnlyKeys(question, ['id', 'kind', 'prompt', 'choices'])) return { ok: false, failure: 'invalid-action' }
  } else {
    if (!validateCandidateShape(payload)) return { ok: false, failure: 'invalid-action' }
  }
  return { ok: true, value }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

export function boundedAgentText(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const safe = redactAgentText(value)
  return safe.length <= AGENT_LIMITS.maxAgentTextChars ? safe : `${safe.slice(0, AGENT_LIMITS.maxAgentTextChars - 1)}…`
}

export function validateCandidateShape(value: unknown): value is Candidate {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!candidate || !['metadata', 'result', 'question', 'action'].includes(String(candidate.kind))
    || !['candidate', 'approved', 'unknown'].includes(String(candidate.status)) || !Array.isArray(candidate.observationIds)
    || candidate.observationIds.length > AGENT_LIMITS.maxTools || new Set(candidate.observationIds).size !== candidate.observationIds.length
    || candidate.observationIds.some((id) => !boundedAgentText(id))) return false
  const kind = candidate.kind
  if (kind === 'metadata') return (candidate.field === 'sample' || candidate.field === 'temperature' || candidate.field === 'mode' || candidate.field === 'grid')
    && (candidate.value === undefined || boundedAgentText(candidate.value) !== null) && hasOnlyKeys(candidate, ['kind', 'field', 'value', 'status', 'observationIds'])
  if (kind === 'result') return ['PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'UNKNOWN'].includes(String(candidate.result))
    && hasOnlyKeys(candidate, ['kind', 'result', 'status', 'observationIds'])
  if (kind === 'question') {
    const question = candidate.question as Record<string, unknown> | undefined
    return authorizeQuestion(question) && hasOnlyKeys(candidate, ['kind', 'question', 'status', 'observationIds'])
  }
  return authorizeToolAction(candidate.action, 0).ok && hasOnlyKeys(candidate, ['kind', 'action', 'status', 'observationIds'])
}

function authorizeQuestion(question: unknown): question is Record<string, unknown> {
  const value = asRecord(question)
  return !!value && boundedAgentText(value.id) !== null && boundedAgentText(value.prompt) !== null
    && (value.kind === 'clarification' || value.kind === 'approval')
    && (value.choices === undefined || (Array.isArray(value.choices) && value.choices.length <= 8 && value.choices.every((choice) => boundedAgentText(choice) !== null)))
    && hasOnlyKeys(value, ['id', 'kind', 'prompt', 'choices'])
}

function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }

export function boundLine(line: string): string {
  return line.length <= AGENT_LIMITS.maxCharsPerLine ? line : `${line.slice(0, AGENT_LIMITS.maxCharsPerLine - 1)}…`
}

export function recentConversation(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const users = messages.filter((message) => message.role === 'user').slice(-AGENT_LIMITS.recentUserMessages)
  const assistants = messages.filter((message) => message.role === 'assistant').slice(-AGENT_LIMITS.recentAssistantMessages)
  return [...users, ...assistants].sort((left, right) => left.turn - right.turn).map((message) => ({ ...message, content: boundedAgentText(message.content) ?? '' }))
}

export function boundedPrompt(prompt: string): string | null {
  return prompt.length <= AGENT_LIMITS.maxPromptChars ? prompt : null
}

/** LLM metadata is advisory only. Deterministically extracted/approved values win. */
export function protectFilenameCandidate(
  candidate: Candidate,
  metadata: FilenameMetadata,
  approved: Partial<Record<'sample' | 'temperature' | 'mode' | 'grid', string>> = {}
): Candidate {
  if (candidate.kind !== 'metadata' || !candidate.field) return candidate
  const field = metadata[candidate.field]
  if (field.state === 'extracted' || approved[candidate.field] !== undefined) {
    return { ...candidate, value: approved[candidate.field] ?? field.value ?? undefined, status: 'approved' }
  }
  if (field.state !== 'unknown' && field.state !== 'conflict') return { ...candidate, status: 'unknown' }
  return { ...candidate, status: candidate.observationIds.length ? 'candidate' : 'unknown' }
}

export function sanitizeAnswer(value: AgentAnswerValue): AgentAnswerValue {
  if (typeof value === 'string') return boundedAgentText(value) ?? ''
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedAgentText(String(item)) ?? '')
  return value
}

export function redactAgentText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    .replace(/\b(?:api[_-]?key|token|password|passwd|secret|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '<SECRET>')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]{8,}\b/gi, '<SECRET>')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[^\r\n]*/gi, '<SECRET>')
    .replace(/\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{6,}(?:\.[a-z0-9_-]{6,})?\b/gi, '<SECRET>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\\/\s]+[\\/])+[^\\/\s,;)'\"]*/g, '<ABS_PATH>')
}
