import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'

export interface VertexUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface VertexMockRequest {
  attempt: number
  method: string | undefined
  path: string
  authorization: string | undefined
  body: unknown
  receivedAt: number
}

export interface VertexMockRequestRecord extends VertexMockRequest {
  completedAt?: number
  durationMs?: number
  status?: number
  retryAfter?: string
  usage?: VertexUsage
}

export interface VertexMockMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  retryableResponses: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  firstRequestAt?: number
  lastRequestAt?: number
  totalLatencyMs: number
}

type Configurable<T> =
  | T
  | readonly (T | undefined)[]
  | ((request: VertexMockRequest, attempt: number) => T | undefined)

export interface VertexOpenAiMockOptions {
  project?: string
  location?: string
  apiVersion?: 'v1' | 'v1beta1'
  accessToken?: string
  latencyMs?: Configurable<number>
  status?: Configurable<number>
  retryAfter?: Configurable<string>
  responseContent?: Configurable<string>
  usage?: Configurable<VertexUsage>
}

export interface VertexOpenAiMock {
  readonly baseUrl: string
  readonly basePath: string
  readonly chatCompletionsPath: string
  readonly records: VertexMockRequestRecord[]
  readonly metrics: VertexMockMetrics
  configure(options: Partial<VertexOpenAiMockOptions>): void
  waitForRequests(count: number, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

const DEFAULT_USAGE: VertexUsage = {
  promptTokens: 12,
  completionTokens: 8,
  totalTokens: 20
}

function resolve<T>(
  value: Configurable<T> | undefined,
  fallback: T,
  request: VertexMockRequest,
  attempt: number
): T | undefined {
  if (value === undefined) return fallback
  if (Array.isArray(value)) {
    return (value as readonly (T | undefined)[])[Math.min(attempt - 1, value.length - 1)] ?? fallback
  }
  if (typeof value === 'function') {
    return (value as (request: VertexMockRequest, attempt: number) => T | undefined)(request, attempt) ?? fallback
  }
  return value as T
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function parseBody(raw: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}

function openAiUsage(usage: VertexUsage): Record<string, number> {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens
  }
}

export async function createVertexOpenAiMock(
  initialOptions: VertexOpenAiMockOptions = {}
): Promise<VertexOpenAiMock> {
  const project = initialOptions.project ?? 'luna-verification-project'
  const location = initialOptions.location ?? 'us-central1'
  const apiVersion = initialOptions.apiVersion ?? 'v1'
  const basePath = `/${apiVersion}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/endpoints/openapi`
  const chatCompletionsPath = `${basePath}/chat/completions`
  let options = { ...initialOptions }
  const records: VertexMockRequestRecord[] = []
  const metrics: VertexMockMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    retryableResponses: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      response.destroy()
    })
  })

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const receivedAt = Date.now()
    const body = parseBody(await readBody(request))
    const path = new URL(request.url ?? '/', 'http://vertex-openai-mock').pathname
    const attempt = records.length + 1
    const requestInfo: VertexMockRequest = {
      attempt,
      method: request.method,
      path,
      authorization: request.headers.authorization,
      body,
      receivedAt
    }
    const record: VertexMockRequestRecord = { ...requestInfo }
    records.push(record)
    metrics.totalRequests += 1
    metrics.firstRequestAt ??= receivedAt
    metrics.lastRequestAt = receivedAt

    const expectedAuthorization = options.accessToken
      ? `Bearer ${options.accessToken}`
      : undefined
    const validRoute = request.method === 'POST' && path === chatCompletionsPath
    const authenticated = !expectedAuthorization || request.headers.authorization === expectedAuthorization
    let status = validRoute ? (authenticated ? resolve(options.status, 200, requestInfo, attempt) : 401) : 404
    status ??= 200
    let retryAfter = resolve(options.retryAfter, undefined, requestInfo, attempt)
    const latencyMs = resolve(options.latencyMs, 0, requestInfo, attempt) ?? 0
    const usage = resolve(options.usage, DEFAULT_USAGE, requestInfo, attempt) ?? DEFAULT_USAGE
    const responseContent = resolve(options.responseContent, 'mock vertex response', requestInfo, attempt)

    await sleep(latencyMs)
    record.completedAt = Date.now()
    record.durationMs = record.completedAt - record.receivedAt
    record.status = status
    record.retryAfter = retryAfter
    record.usage = status >= 200 && status < 300 ? usage : undefined
    metrics.totalLatencyMs += record.durationMs
    if (status >= 200 && status < 300) {
      metrics.successfulRequests += 1
      metrics.promptTokens += usage.promptTokens
      metrics.completionTokens += usage.completionTokens
      metrics.totalTokens += usage.totalTokens
    } else {
      metrics.failedRequests += 1
      if (status === 429 || status >= 500) metrics.retryableResponses += 1
    }

    if (response.destroyed || response.writableEnded) return
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (retryAfter !== undefined) headers['retry-after'] = retryAfter
    const bodyText = status >= 200 && status < 300
      ? JSON.stringify({
          id: `vertex-mock-${attempt}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: responseContent ?? '' }, finish_reason: 'stop' }],
          usage: openAiUsage(usage)
        })
      : JSON.stringify({ error: { message: 'vertex-openai-mock response', code: status } })
    response.writeHead(status, headers)
    response.end(bodyText)
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    throw new Error('Vertex OpenAI mock address unavailable')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    basePath,
    chatCompletionsPath,
    records,
    metrics,
    configure(nextOptions) {
      options = { ...options, ...nextOptions }
    },
    async waitForRequests(count, timeoutMs = 1_000) {
      const deadline = Date.now() + timeoutMs
      while (records.length < count && Date.now() < deadline) await sleep(1)
      if (records.length < count) {
        throw new Error(`Vertex OpenAI mock did not receive ${count} request(s)`)
      }
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  }
}
