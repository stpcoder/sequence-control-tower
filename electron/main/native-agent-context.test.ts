import { describe, expect, it } from 'vitest'
import { boundedConversationContext, MODEL_HISTORY_BUDGET } from './native-agent-context'

describe('boundedConversationContext', () => {
  it('keeps durable long history out of the model request with an explicit retrieval notice', () => {
    const messages = Array.from({ length: 260 }, (_, index) => ({
      id: `m-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `${index}: ${'evidence '.repeat(900)}`, createdAt: new Date(index * 1_000).toISOString(),
    }))
    const context = boundedConversationContext(messages, 'latest request')
    const encoded = JSON.stringify(context)
    expect(encoded.length).toBeLessThan(120_000)
    expect(encoded).toMatch(/이전 \d+개는 이 모델 요청에서 생략되었습니다/)
    expect(encoded).toContain('conversation_history_get')
    expect(context.at(-1)).toMatchObject({ role: 'user' })
    expect(context.at(-1)?.content).toContain('latest request')
  })

  it('preserves exact newline and regex content in the current request', () => {
    const request = 'line 1\n\n^ERR\\s+CODE$\n  intentional spaces'
    const context = boundedConversationContext([], request)
    expect(context.at(-1)).toEqual({ role: 'user', content: request })
  })

  it('identifies a truncated stored request by its durable message id', () => {
    const request = 'q'.repeat(40_000)
    const context = boundedConversationContext([{ id: 'durable-request', role: 'user', content: request, createdAt: '' }], request)
    expect(context.at(-1)?.content).toContain('messageId=durable-request')
    expect(context.at(-1)?.content).toContain('contentOffset')
  })

  it('budgets escaped whitespace-heavy messages by their serialized model size', () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({
      id: `escape-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `${'\n\t\\"'.repeat(2_000)}${index}`, createdAt: new Date(index * 1_000).toISOString(),
      evidenceSourceIds: [`source-${index}`],
    }))
    const context = boundedConversationContext(messages, `${'\n\\'.repeat(30_000)}request`)
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MODEL_HISTORY_BUDGET)
    expect(context.at(-1)?.content).toContain('request')
    expect(JSON.stringify(context)).toMatch(/이전 \d+개는 이 모델 요청에서 생략되었습니다/)
  })

  it('keeps a prior user turn when a stored current request follows it', () => {
    const context = boundedConversationContext([
      { id: 'prior-user', role: 'user', content: 'prior question', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'current-user', role: 'user', content: 'current question', createdAt: '2026-01-01T00:01:00.000Z' },
    ], 'current question')
    expect(context.map((item) => item.content)).toEqual(['prior question', 'current question'])
  })
})
