import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: {} }))
import { OpenAiCompatibleClient, type LlmToolRequest } from './llm-service'

afterEach(() => { vi.unstubAllGlobals() })
const request: LlmToolRequest = {
  messages: [{ role: 'system', content: '도구로 확인하세요.' }, { role: 'user', content: '파일을 읽어 줘' }],
  tools: [{ type: 'function', function: { name: 'source_list', description: '파일 목록', parameters: { type: 'object', properties: {} } } }],
}
const config = { effective: async () => ({ baseUrl: 'http://127.0.0.1:12345/v1', model: 'test-model', requestsPerMinute: 100, tokensPerMinute: 1_000_000, maxRetries: 0, timeoutMs: 5000 }) }
describe('OpenAI compatible tool protocol', () => {
  it('sends role-preserving tool schemas and accepts a tool-only assistant reply', async () => {
    const call = { id: 'call-1', type: 'function', function: { name: 'source_list', arguments: '{}' } }
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = new OpenAiCompatibleClient(config as never)
    await expect(client.complete('', undefined, () => {}, request)).resolves.toMatchObject({ content: '', toolCalls: [call] })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.messages).toEqual(request.messages)
    expect(body.tools).toEqual(request.tools)
    expect(body.tool_choice).toBe('auto')
  })
  it('passes tool results with the original call id back to the provider', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '확인했습니다.' } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const next: LlmToolRequest = { ...request, messages: [...request.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'source_list', arguments: '{}' } }] },
      { role: 'tool', content: '{"sources":["s1"]}', tool_call_id: 'c1' },
    ] }
    const client = new OpenAiCompatibleClient(config as never)
    await expect(client.complete('', undefined, () => {}, next)).resolves.toMatchObject({ content: '확인했습니다.' })
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })
})
