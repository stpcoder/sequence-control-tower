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
  if (typeof candidate.tool !== 'string' || !AGENT_TOOL_ALLOWLIST.includes(candidate.tool as AgentToolName)) {
    return { ok: false, failure: 'unknown-tool' }
  }
  const depthResult = validateDepth(depth)
  if (!depthResult.ok) return { ok: false, failure: depthResult.failure }
  const input = candidate.input
  if (!input || typeof input !== 'object') return { ok: false, failure: 'invalid-action' }
  if (candidate.tool === 'search') {
    const value = input as Record<string, unknown>
    if (typeof value.sourceId !== 'string' || typeof value.query !== 'string' || value.query.length === 0
      || (value.mode !== 'literal' && value.mode !== 'regex')) return { ok: false, failure: 'invalid-action' }
  } else if (candidate.tool === 'lineWindow') {
    const value = input as Record<string, unknown>
    const startLine = value.startLine
    const lineCount = value.lineCount
    if (typeof value.sourceId !== 'string' || typeof startLine !== 'number' || typeof lineCount !== 'number'
      || !Number.isInteger(startLine) || !Number.isInteger(lineCount)
      || startLine < 1 || lineCount < 1 || lineCount > AGENT_LIMITS.maxLinesPerWindow) {
      return { ok: false, failure: 'invalid-action' }
    }
  } else {
    const value = input as Record<string, unknown>
    if (typeof value.sourceId !== 'string' || (value.target !== 'metadata' && value.target !== 'observation')) {
      return { ok: false, failure: 'invalid-action' }
    }
  }
  return { ok: true, value: action as ToolAction }
}

/** Validates the complete model envelope before the service dispatches it. */
export function authorizeAgentAction(action: unknown, depth = 0): PolicyResult<Record<string, unknown>> {
  if (!action || typeof action !== 'object') return { ok: false, failure: 'invalid-action' }
  const value = action as Record<string, unknown>
  const name = typeof value.action === 'string' ? value.action : value.tool
  if (typeof name !== 'string' || !AGENT_ACTION_ALLOWLIST.includes(name as AgentActionName)) return { ok: false, failure: 'unknown-tool' }
  if (name === 'search' || name === 'lineWindow' || name === 'inspect') return authorizeToolAction({ tool: name, input: value.input }, depth) as PolicyResult<Record<string, unknown>>
  if (name === 'summary' || name === 'stop') return { ok: true, value }
  const payload = value[name === 'ask' ? 'question' : 'candidate'] ?? value.input
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, failure: 'invalid-action' }
  if (name === 'ask') {
    const question = payload as Record<string, unknown>
    if (typeof question.id !== 'string' || typeof question.prompt !== 'string' || question.prompt.length > 800) return { ok: false, failure: 'invalid-action' }
  } else {
    const candidate = payload as Record<string, unknown>
    if (!['metadata', 'result', 'question', 'action'].includes(String(candidate.kind)) || !['candidate', 'approved', 'unknown'].includes(String(candidate.status)) || !Array.isArray(candidate.observationIds) || candidate.observationIds.length > AGENT_LIMITS.maxTools) return { ok: false, failure: 'invalid-action' }
  }
  return { ok: true, value }
}

export function boundLine(line: string): string {
  return line.length <= AGENT_LIMITS.maxCharsPerLine ? line : `${line.slice(0, AGENT_LIMITS.maxCharsPerLine - 1)}…`
}

export function recentConversation(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const users = messages.filter((message) => message.role === 'user').slice(-AGENT_LIMITS.recentUserMessages)
  const assistants = messages.filter((message) => message.role === 'assistant').slice(-AGENT_LIMITS.recentAssistantMessages)
  return [...users, ...assistants].sort((left, right) => left.turn - right.turn)
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
  if (typeof value === 'string') return redactAgentText(value)
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAgentText(String(item)))
  return value
}

export function redactAgentText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    .replace(/\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi, '<SECRET>')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[^\r\n]*/gi, '<SECRET>')
    .replace(/\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{6,}(?:\.[a-z0-9_-]{6,})?\b/gi, '<SECRET>')
    .replace(/([A-Za-z]:[\\/]|\\\\|\/(?:[^\/\s]+\/){2,})[^\s,;)'\"]*/g, '<ABS_PATH>')
}
