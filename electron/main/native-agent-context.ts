import type { NativeAgentMessageView } from '../shared/contracts'
import type { LlmChatMessage } from './llm-service'

/** The durable transcript is intentionally unbounded. This is only the part
 * sent to a model for one request, leaving room for tool calls and replies. */
export const MODEL_HISTORY_BUDGET = 90_000
const RECENT_HISTORY_BUDGET = 52_000
const DIGEST_BUDGET = 30_000
const MESSAGE_EXCERPT = 2_400
const CURRENT_REQUEST_BUDGET = 32_000
const PAYLOAD_OVERHEAD = 512

type ConversationMessage = Pick<NativeAgentMessageView, 'id' | 'role' | 'content' | 'createdAt' | 'evidenceSourceIds' | 'question'>

const compact = (value: string, maximum: number): string => value
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum)

function modelMessage(message: ConversationMessage, maximum = MESSAGE_EXCERPT): LlmChatMessage {
  const suffix = [
    message.evidenceSourceIds?.length ? `지정/근거 sourceIds: ${JSON.stringify(message.evidenceSourceIds)}` : '',
    message.question?.kind === 'agent' ? `질문 선택지: ${JSON.stringify(message.question.choices)}` : '',
  ].filter(Boolean).join('\n')
  const original = `${message.content}${suffix ? `\n${suffix}` : ''}`
  // User queries may contain regexes, line-oriented evidence, or deliberate
  // whitespace. Preserve the source bytes in model-visible excerpts.
  const excerpt = original.slice(0, maximum)
  const truncated = excerpt.length < original.length
  return { role: message.role, content: `${excerpt}${truncated ? `\n[이 메시지는 모델 창에서 잘렸습니다. messageId=${message.id}; conversation_history_get에 이 messageId와 contentOffset을 지정해 원문을 조회하십시오.]` : ''}` }
}

const serializedSize = (value: unknown): number => JSON.stringify(value).length
function messageWithinBudget(message: ConversationMessage, limit: number, budget: number): LlmChatMessage {
  let low = 0; let high = Math.max(0, limit); let best = modelMessage(message, 0)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = modelMessage(message, middle)
    if (serializedSize(candidate) <= budget) { best = candidate; low = middle + 1 } else high = middle - 1
  }
  return best
}

/**
 * Returns a deterministic, explicitly incomplete index of older turns plus
 * recent verbatim-ish excerpts. The complete transcript remains in the local
 * store and is reachable through conversation_history_get.
 */
export function boundedConversationContext(messages: readonly ConversationMessage[], currentRequest?: string): LlmChatMessage[] {
  const visible = messages.filter((message) => message.role !== 'tool')
  const storedCurrent = currentRequest && visible.at(-1)?.role === 'user' ? visible.at(-1) : undefined
  const current = currentRequest
    ? messageWithinBudget(storedCurrent ? { ...storedCurrent, content: currentRequest } : { id: 'current-request', role: 'user', content: currentRequest, createdAt: '' }, 32_000, CURRENT_REQUEST_BUDGET)
    : undefined
  const currentSize = current ? serializedSize(current) + 1 : 0
  const recent: ConversationMessage[] = []
  let used = 0
  const prior = storedCurrent ? visible.slice(0, -1) : visible
  const effectiveBudget = MODEL_HISTORY_BUDGET - PAYLOAD_OVERHEAD
  const recentBudget = Math.max(0, Math.min(RECENT_HISTORY_BUDGET, effectiveBudget - currentSize - DIGEST_BUDGET))
  for (const message of [...prior].reverse()) {
    const candidate = modelMessage(message)
    const size = serializedSize(candidate) + 1
    if (recent.length && used + size > recentBudget) break
    if (size > recentBudget) continue
    recent.unshift(message); used += size
  }
  const omitted = prior.slice(0, Math.max(0, prior.length - recent.length))
  const digestRows: string[] = []
  const digestBudget = Math.max(0, effectiveBudget - currentSize - used)
  for (const message of omitted) {
    const row = `${message.createdAt} | ${message.role} | id=${message.id} | ${compact(message.content, 320)}`
    const candidate = { role: 'system' as const, content: digestRows.length ? `${digestRows.join('\n')}\n${row}` : row }
    if (serializedSize(candidate) > digestBudget) break
    digestRows.push(row)
  }
  const context: LlmChatMessage[] = []
  if (omitted.length) {
    const header = [
      `대화의 전체 원문 ${visible.length}개 중 이전 ${omitted.length}개는 이 모델 요청에서 생략되었습니다.`,
      '아래는 결정론적으로 만든 불완전한 색인/발췌이며 전체 요약이 아닙니다. 생략된 내용이 없다고 추정하거나 이를 완전한 근거로 말하지 마십시오.',
      '원문이 필요하면 conversation_history_get 도구에 evaluationScopeId, sessionId, query, cursor 또는 offset을 지정해 페이지로 조회하십시오.',
      digestRows.length ? `이전 대화 발췌:\n${digestRows.join('\n')}` : '이전 대화 발췌도 모델 예산 때문에 포함하지 못했습니다. 도구로 조회하십시오.',
    ].join('\n')
    const available = Math.max(0, effectiveBudget - currentSize - used)
    context.push(messageWithinBudget({ id: 'history-index', role: 'system', content: header, createdAt: '' }, header.length, available))
  }
  context.push(...recent.map((message) => modelMessage(message)))
  if (current) {
    context.push(current)
  }
  // Array punctuation and escaped metadata are part of the actual provider
  // payload too. Enforce the exported limit against that final serialization.
  while (serializedSize(context) > MODEL_HISTORY_BUDGET && context.length > (omitted.length ? 2 : 1)) context.splice(omitted.length ? 1 : 0, 1)
  if (serializedSize(context) > MODEL_HISTORY_BUDGET && omitted.length && context[0]) {
    const reservedForOthers = serializedSize(context.slice(1)) + 2
    const notice = `대화의 전체 원문 ${visible.length}개 중 이전 ${omitted.length}개는 이 모델 요청에서 생략되었습니다. 이는 완전한 요약이 아닙니다. conversation_history_get으로 원문을 조회하십시오.`
    context[0] = messageWithinBudget({ id: 'history-index', role: 'system', content: notice, createdAt: '' }, notice.length, Math.max(1, MODEL_HISTORY_BUDGET - reservedForOthers))
  }
  if (serializedSize(context) > MODEL_HISTORY_BUDGET && context.length === 1 && context[0]) {
    const item = context[0]
    context[0] = messageWithinBudget({ id: 'context-final', role: item.role, content: item.content ?? '', createdAt: '' }, (item.content ?? '').length, MODEL_HISTORY_BUDGET)
  }
  return context
}

/** Keep runtime tool exchanges bounded as well as durable history. */
export function boundedToolResult(value: string, maximum = 8_000): string {
  const excerpt = value.slice(0, maximum)
  return excerpt.length === value.length ? excerpt : JSON.stringify({
    truncated: true,
    notice: '도구 결과가 모델 창에서 잘렸습니다. 페이지 도구나 더 좁은 범위로 원문을 다시 조회하십시오.',
    excerpt,
  })
}
