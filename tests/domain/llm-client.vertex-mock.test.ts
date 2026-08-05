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
  OpenAiCompatibleClient
} from '../../electron/main/llm-service'
import { createVertexOpenAiMock, type VertexOpenAiMock } from '../support/vertex-openai-mock'

const mocks: VertexOpenAiMock[] = []

function client(mock: VertexOpenAiMock, overrides: Partial<EffectiveLlmConfig> = {}): OpenAiCompatibleClient {
  const config: EffectiveLlmConfig = {
    baseUrl: mock.baseUrl,
    model: 'google/gemini-2.0-flash-001',
    apiKey: 'raw-test-access-token',
    requestsPerMinute: 60,
    tokensPerMinute: 100_000,
    timeoutMs: 1_000,
    maxRetries: 0,
    ...overrides
  }
  const configService = {
    effective: vi.fn(async () => config)
  } as unknown as LlmConfigService
  return new OpenAiCompatibleClient(configService)
}

async function waitForRecords(mock: VertexOpenAiMock, count: number): Promise<void> {
  while (mock.records.length < count) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(mocks.splice(0).map((mock) => mock.close()))
})

describe('Vertex OpenAI-compatible substitute verification', () => {
  it('uses the Vertex base path, chat completions route, Bearer auth, and configured model', async () => {
    const mock = await createVertexOpenAiMock({ accessToken: 'raw-test-access-token' })
    mocks.push(mock)

    const result = await client(mock).complete('minimal evidence', undefined, vi.fn())

    expect(result).toEqual({ content: 'mock vertex response', model: 'google/gemini-2.0-flash-001' })
    expect(mock.records).toHaveLength(1)
    expect(mock.records[0]).toEqual(expect.objectContaining({
      method: 'POST',
      path: mock.chatCompletionsPath,
      authorization: 'Bearer raw-test-access-token'
    }))
    expect(mock.records[0].body).toEqual(expect.objectContaining({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: 1_200
    }))
    expect(mock.records[0].receivedAt).toBeLessThanOrEqual(mock.records[0].completedAt ?? 0)
  })

  it('waits for a slow successful response and records usage metrics', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      latencyMs: 45,
      usage: { promptTokens: 21, completionTokens: 9, totalTokens: 30 }
    })
    mocks.push(mock)
    const startedAt = Date.now()

    const result = await client(mock, { timeoutMs: 500 }).complete('slow evidence', undefined, vi.fn())

    expect(result.content).toBe('mock vertex response')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35)
    expect(mock.records[0].durationMs).toBeGreaterThanOrEqual(35)
    expect(mock.metrics).toEqual(expect.objectContaining({
      totalRequests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      promptTokens: 21,
      completionTokens: 9,
      totalTokens: 30
    }))
  })

  it('retries a 429 response according to Retry-After and succeeds', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      status: [429, 200],
      retryAfter: ['0.02', undefined],
      responseContent: (_request, attempt) => attempt === 1 ? 'retryable failure' : 'recovered'
    })
    mocks.push(mock)
    const startedAt = Date.now()

    const result = await client(mock, { maxRetries: 1 }).complete('retry evidence', undefined, vi.fn())

    expect(result.content).toBe('recovered')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15)
    expect(mock.records.map((record) => record.path)).toEqual([mock.chatCompletionsPath, mock.chatCompletionsPath])
    expect(mock.records.map((record) => record.status)).toEqual([429, 200])
    expect(mock.records[0].retryAfter).toBe('0.02')
    expect(mock.metrics).toEqual(expect.objectContaining({
      totalRequests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      retryableResponses: 1,
      totalTokens: 20
    }))
  })

  it('cancels an in-flight slow request without retrying', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      latencyMs: 250
    })
    mocks.push(mock)
    const controller = new AbortController()
    const pending = client(mock, { timeoutMs: 2_000, maxRetries: 2 })
      .complete('cancel evidence', controller.signal, vi.fn())
    await mock.waitForRequests(1)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mock.records).toHaveLength(1)
  })

  it('returns the stable timeout error for a slow request', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      latencyMs: 100
    })
    mocks.push(mock)

    await expect(
      client(mock, { timeoutMs: 25 }).complete('timeout evidence', undefined, vi.fn())
    ).rejects.toThrow('LLM_REQUEST_TIMEOUT')
    expect(mock.records).toHaveLength(1)
  })

  it('retries a timeout within maxRetries and then terminates with the stable timeout error', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      latencyMs: [100, 100]
    })
    mocks.push(mock)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const pending = client(mock, { timeoutMs: 10, maxRetries: 1 })
      .complete('timeout retry policy evidence', undefined, vi.fn())
    const outcome = pending.then(
      () => new Error('request unexpectedly resolved'),
      (error) => error
    )
    await waitForRecords(mock, 1)

    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(1_000)
    await waitForRecords(mock, 2)
    await vi.advanceTimersByTimeAsync(10)

    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('LLM_REQUEST_TIMEOUT')
    expect(mock.records).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
  })

  it('cancels Retry-After waiting immediately when the caller aborts', async () => {
    const mock = await createVertexOpenAiMock({
      accessToken: 'raw-test-access-token',
      status: [429, 200],
      retryAfter: ['60', undefined]
    })
    mocks.push(mock)
    const controller = new AbortController()
    const pending = client(mock, { maxRetries: 1 })
      .complete('cancel retry-after evidence', controller.signal, vi.fn())
    await waitForRecords(mock, 1)
    while (mock.records[0].status === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(mock.records[0].status).toBe(429)

    controller.abort()

    let watchdog: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      pending.then(() => new Error('request unexpectedly resolved'), (error) => error),
      new Promise<Error>((resolve) => {
        watchdog = setTimeout(() => resolve(new Error('abort did not interrupt Retry-After')), 100)
      })
    ])
    if (watchdog) clearTimeout(watchdog)
    expect(outcome).toMatchObject({ name: 'AbortError' })
    expect(mock.records).toHaveLength(1)
  })

  it('needs no ADC, gcloud, or cloud credential file for the local substitute', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '')
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '')
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '')
    vi.stubEnv('CLOUDSDK_AUTH_ACCESS_TOKEN', '')
    const mock = await createVertexOpenAiMock({ accessToken: 'raw-test-access-token' })
    mocks.push(mock)

    await expect(client(mock).complete('local-only evidence', undefined, vi.fn())).resolves.toEqual(expect.objectContaining({
      model: 'google/gemini-2.0-flash-001'
    }))
    expect(mock.records[0].authorization).toBe('Bearer raw-test-access-token')
    expect(mock.metrics.successfulRequests).toBe(1)
  })
})
