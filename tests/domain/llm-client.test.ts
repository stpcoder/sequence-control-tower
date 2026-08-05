import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import {
  type EffectiveLlmConfig,
  LlmConfigService,
  MIN_LLM_TOKENS_PER_MINUTE,
  OpenAiCompatibleClient
} from '../../electron/main/llm-service'

interface RequestRecord {
  method?: string
  url?: string
  authorization?: string
  body: string
}

const servers: Server[] = []
const roots: string[] = []

function effective(overrides: Partial<EffectiveLlmConfig> = {}): EffectiveLlmConfig {
  return {
    baseUrl: '',
    model: 'qwen-internal',
    apiKey: 'internal-token',
    requestsPerMinute: 60,
    tokensPerMinute: 100_000,
    timeoutMs: 1_000,
    maxRetries: 0,
    ...overrides
  }
}

function client(config: EffectiveLlmConfig): OpenAiCompatibleClient {
  const configService = {
    effective: vi.fn(async () => config)
  } as unknown as LlmConfigService
  return new OpenAiCompatibleClient(configService)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function mockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; records: RequestRecord[] }> {
  const records: RequestRecord[] = []
  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    records.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body
    })
    await handler(request, response)
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server address unavailable')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, records }
}

function completion(response: ServerResponse, content = '{"summary":"ok"}'): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content } }] }))
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
})

describe('OpenAI-compatible chat client', () => {
  it('posts once to Base URL /v1/chat/completions with Bearer auth and the configured model', async () => {
    const server = await mockServer((_request, response) => completion(response))
    const result = await client(effective({ baseUrl: server.baseUrl })).complete('minimal evidence', undefined, vi.fn())

    expect(result).toEqual({ content: '{"summary":"ok"}', model: 'qwen-internal' })
    expect(server.records).toHaveLength(1)
    expect(server.records[0]).toEqual(expect.objectContaining({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer internal-token'
    }))
    expect(JSON.parse(server.records[0].body)).toEqual(expect.objectContaining({
      model: 'qwen-internal',
      max_tokens: 1_200
    }))
  })

  it.each([401, 403, 404])('does not retry permanent HTTP %s errors', async (status) => {
    const server = await mockServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end('{"detail":"must never be reflected"}')
    })
    const request = client(effective({ baseUrl: server.baseUrl, maxRetries: 3 }))

    await expect(request.complete('minimal evidence', undefined, vi.fn())).rejects.toThrow(`LLM_HTTP_${status}`)
    expect(server.records).toHaveLength(1)
  })

  it('retries 429 and 5xx, honoring numeric and HTTP-date Retry-After without exposing response bodies', async () => {
    let count = 0
    const retryAfterValues = ['0', new Date(Date.now() - 1_000).toUTCString()]
    const server = await mockServer((_request, response) => {
      count += 1
      if (count <= 2) {
        response.writeHead(count === 1 ? 429 : 503, {
          'content-type': 'application/json',
          'retry-after': retryAfterValues[count - 1]
        })
        response.end('{"secret":"server-internal-detail"}')
        return
      }
      completion(response, 'recovered')
    })

    const result = await client(effective({ baseUrl: server.baseUrl, maxRetries: 2 }))
      .complete('minimal evidence', undefined, vi.fn())

    expect(result.content).toBe('recovered')
    expect(server.records).toHaveLength(3)
  })

  it.each([
    ['malformed JSON', 'not-json', 'LLM_INVALID_JSON_RESPONSE'],
    ['missing choices', '{}', 'LLM_EMPTY_RESPONSE'],
    ['empty content', '{"choices":[{"message":{"content":"   "}}]}', 'LLM_EMPTY_RESPONSE']
  ])('rejects %s without retrying', async (_label, body, errorCode) => {
    const server = await mockServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    const request = client(effective({ baseUrl: server.baseUrl, maxRetries: 2 }))

    await expect(request.complete('minimal evidence', undefined, vi.fn())).rejects.toThrow(errorCode)
    expect(server.records).toHaveLength(1)
  })

  it('returns a stable timeout error and does not leak low-level network details', async () => {
    const server = await mockServer(() => new Promise<void>(() => undefined))
    const request = client(effective({ baseUrl: server.baseUrl, timeoutMs: 30 }))

    await expect(request.complete('minimal evidence', undefined, vi.fn())).rejects.toThrow('LLM_REQUEST_TIMEOUT')
    expect(server.records).toHaveLength(1)
  })

  it('cancels an in-flight request immediately without retrying', async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const server = await mockServer(() => {
      markStarted?.()
      return new Promise<void>(() => undefined)
    })
    const controller = new AbortController()
    const request = client(effective({ baseUrl: server.baseUrl, timeoutMs: 2_000, maxRetries: 2 }))
    const pending = request.complete('minimal evidence', controller.signal, vi.fn())
    await started
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(server.records).toHaveLength(1)
  })

  it('rejects a completion body larger than the local safety cap', async () => {
    const server = await mockServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(2 * 1024 * 1024 + 1)
      })
      response.end()
    })

    await expect(
      client(effective({ baseUrl: server.baseUrl })).complete('minimal evidence', undefined, vi.fn())
    ).rejects.toThrow('LLM_RESPONSE_TOO_LARGE')
  })

  it('fails locally when one request cannot fit the configured TPM budget', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const request = client(effective({ baseUrl: 'http://vllm.invalid/v1', tokensPerMinute: MIN_LLM_TOKENS_PER_MINUTE - 1 }))

    await expect(request.complete('x', undefined, vi.fn())).rejects.toThrow('LLM_TPM_REQUEST_TOO_LARGE')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('normalizes saved TPM settings to the safe minimum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llm-client-config-'))
    roots.push(root)
    const config = new LlmConfigService(root)
    await config.initialize()
    await config.save({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'qwen-internal',
      tokensPerMinute: 1
    })

    expect((await config.effective()).tokensPerMinute).toBe(MIN_LLM_TOKENS_PER_MINUTE)
    expect((await config.summary()).limits.tokensPerMinute).toBe(MIN_LLM_TOKENS_PER_MINUTE)
  })

  it('queues subsequent calls until the RPM window has capacity', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stages: string[] = []
    const request = client(effective({
      baseUrl: 'http://vllm.invalid/v1',
      requestsPerMinute: 1,
      tokensPerMinute: 100_000,
      timeoutMs: 1_000
    }))

    await request.complete('first', undefined, (stage) => stages.push(stage))
    const second = request.complete('second', undefined, (stage) => stages.push(stage))
    await vi.advanceTimersByTimeAsync(60_100)
    await second

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stages.some((stage) => stage.startsWith('LLM 사용량 대기'))).toBe(true)
  })

  it('queues subsequent calls until the TPM window has capacity', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stages: string[] = []
    const request = client(effective({
      baseUrl: 'http://vllm.invalid/v1',
      requestsPerMinute: 100,
      tokensPerMinute: 1_500,
      timeoutMs: 1_000
    }))

    await request.complete('first', undefined, (stage) => stages.push(stage))
    const second = request.complete('second', undefined, (stage) => stages.push(stage))
    await vi.advanceTimersByTimeAsync(60_100)
    await second

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stages.some((stage) => stage.startsWith('LLM 사용량 대기'))).toBe(true)
  })
})
