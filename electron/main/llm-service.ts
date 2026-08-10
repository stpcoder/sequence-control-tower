import { safeStorage } from 'electron'
import { join } from 'node:path'
import type {
  LlmConfigInput,
  LlmConfigSummary,
  LlmModelDiscoveryInput,
  LlmModelDiscoveryResult
} from '../shared/contracts'
import { AtomicJsonStore } from './json-store'
import { isVertexOpenAiBaseUrl, vertexAccessTokenProvider, type VertexAccessTokenProvider } from './vertex-auth'

interface SavedLlmConfig {
  schemaVersion: 1
  baseUrl: string
  model: string
  encryptedApiKey?: string
  apiKeyOrigin?: string
  updatedAt?: string
  requestsPerMinute?: number
  tokensPerMinute?: number
  timeoutSeconds?: number
  maxRetries?: number
}

export interface EffectiveLlmConfig {
  baseUrl: string
  model: string
  apiKey?: string
  requestsPerMinute: number
  tokensPerMinute: number
  timeoutMs: number
  maxRetries: number
}

export const LLM_COMPLETION_TOKEN_BUDGET = 1_200
export const GEMINI_3_COMPLETION_TOKEN_BUDGET = 4_096
const MIN_NON_EMPTY_PROMPT_TOKENS = 1
export const MIN_LLM_TOKENS_PER_MINUTE = LLM_COMPLETION_TOKEN_BUDGET + MIN_NON_EMPTY_PROMPT_TOKENS

const LLM_LIMIT_DEFAULTS = {
  requestsPerMinute: 8,
  tokensPerMinute: 80_000,
  timeoutSeconds: 60,
  maxRetries: 2
} as const

const LLM_LIMIT_RANGES = {
  requestsPerMinute: { min: 1, max: 10_000 },
  tokensPerMinute: { min: MIN_LLM_TOKENS_PER_MINUTE, max: 10_000_000 },
  timeoutSeconds: { min: 5, max: 300 },
  maxRetries: { min: 0, max: 5 }
} as const

function boundedInteger(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), min), max) : fallback
}

function integerEnvironment(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback
}

function environmentApiKey(): string | undefined {
  const value = process.env.SEQ_LLM_API_KEY?.trim()
  return value || undefined
}

function validateBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/$/, '')
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('LLM Base URL이 올바른 URL이 아닙니다.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('LLM Base URL은 HTTP 또는 HTTPS만 사용할 수 있습니다.')
  }
  if (url.username || url.password) {
    throw new Error('LLM Base URL에 인증 정보를 포함하지 마세요. API key 항목을 사용하세요.')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

function cleanModel(value: string): string {
  const model = value.trim()
  if (model.length > 200) throw new Error('모델 이름이 너무 깁니다.')
  return model
}

function urlOrigin(value: string): string {
  return value ? new URL(validateBaseUrl(value)).origin : ''
}

function canPersistApiKeySecurely(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // Electron's Linux `basic_text` backend is obfuscation, not secret storage.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return false
  }
  return true
}

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000
const MAX_DISCOVERED_MODELS = 100
const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024

async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
  tooLargeError = 'LLM_MODELS_RESPONSE_TOO_LARGE'
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(tooLargeError)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(tooLargeError)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function sanitizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  return cleaned || null
}

export class LlmConfigService {
  private readonly store: AtomicJsonStore<SavedLlmConfig>
  private sessionApiKey: string | undefined
  private sessionApiKeyOrigin: string | undefined

  constructor(dataRoot: string) {
    this.store = new AtomicJsonStore(join(dataRoot, 'config', 'llm.json'), {
      schemaVersion: 1,
      baseUrl: '',
      model: ''
    })
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
  }

  async save(input: LlmConfigInput): Promise<LlmConfigSummary> {
    const baseUrl = validateBaseUrl(input.baseUrl)
    const model = cleanModel(input.model)
    const apiKey = input.apiKey?.trim()
    const managedApiKey = environmentApiKey()

    await this.store.update((draft) => {
      const previousOrigin = urlOrigin(draft.baseUrl)
      const nextOrigin = urlOrigin(baseUrl)
      draft.baseUrl = baseUrl
      draft.model = model
      draft.updatedAt = new Date().toISOString()
      if (input.requestsPerMinute !== undefined) {
        draft.requestsPerMinute = boundedInteger(
          input.requestsPerMinute,
          LLM_LIMIT_DEFAULTS.requestsPerMinute,
          LLM_LIMIT_RANGES.requestsPerMinute.min,
          LLM_LIMIT_RANGES.requestsPerMinute.max
        )
      }
      if (input.tokensPerMinute !== undefined) {
        draft.tokensPerMinute = boundedInteger(
          input.tokensPerMinute,
          LLM_LIMIT_DEFAULTS.tokensPerMinute,
          LLM_LIMIT_RANGES.tokensPerMinute.min,
          LLM_LIMIT_RANGES.tokensPerMinute.max
        )
      }
      if (input.timeoutSeconds !== undefined) {
        draft.timeoutSeconds = boundedInteger(
          input.timeoutSeconds,
          LLM_LIMIT_DEFAULTS.timeoutSeconds,
          LLM_LIMIT_RANGES.timeoutSeconds.min,
          LLM_LIMIT_RANGES.timeoutSeconds.max
        )
      }
      if (input.maxRetries !== undefined) {
        draft.maxRetries = boundedInteger(
          input.maxRetries,
          LLM_LIMIT_DEFAULTS.maxRetries,
          LLM_LIMIT_RANGES.maxRetries.min,
          LLM_LIMIT_RANGES.maxRetries.max
        )
      }
      if (managedApiKey) {
        // Environment-managed credentials always win. Do not persist a typed
        // key, and remove any stale app-owned credential while saving settings.
        delete draft.encryptedApiKey
        delete draft.apiKeyOrigin
        this.sessionApiKey = undefined
        this.sessionApiKeyOrigin = undefined
      } else if (input.clearApiKey) {
        delete draft.encryptedApiKey
        delete draft.apiKeyOrigin
        this.sessionApiKey = undefined
        this.sessionApiKeyOrigin = undefined
      } else if (apiKey) {
        if (canPersistApiKeySecurely()) {
          draft.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64')
          draft.apiKeyOrigin = nextOrigin || undefined
          this.sessionApiKey = undefined
          this.sessionApiKeyOrigin = undefined
        } else {
          // Never degrade to plaintext. Keep it for this process only.
          delete draft.encryptedApiKey
          delete draft.apiKeyOrigin
          this.sessionApiKey = apiKey
          this.sessionApiKeyOrigin = nextOrigin || undefined
        }
      } else if (previousOrigin !== nextOrigin) {
        // A secret is scoped to the host where it was entered. Changing hosts
        // without entering a new key must never carry the old credential over.
        delete draft.encryptedApiKey
        delete draft.apiKeyOrigin
        this.sessionApiKey = undefined
        this.sessionApiKeyOrigin = undefined
      } else if (draft.encryptedApiKey && !draft.apiKeyOrigin && nextOrigin) {
        // Safe migration for configs written before key-origin binding existed.
        draft.apiKeyOrigin = nextOrigin
      }
    })
    return this.summary()
  }

  async effective(): Promise<EffectiveLlmConfig> {
    const saved = await this.store.read()
    const encryptedKey = this.decrypt(saved.encryptedApiKey)
    const managedApiKey = environmentApiKey()
    const baseUrl = validateBaseUrl(process.env.SEQ_LLM_BASE_URL ?? saved.baseUrl)
    const effectiveOrigin = urlOrigin(baseUrl)
    const savedKeyOrigin = saved.apiKeyOrigin ?? urlOrigin(saved.baseUrl)
    const originBoundEncryptedKey = savedKeyOrigin === effectiveOrigin ? encryptedKey : undefined
    const originBoundSessionKey = this.sessionApiKeyOrigin === effectiveOrigin ? this.sessionApiKey : undefined
    const savedRequestsPerMinute = boundedInteger(
      saved.requestsPerMinute,
      LLM_LIMIT_DEFAULTS.requestsPerMinute,
      LLM_LIMIT_RANGES.requestsPerMinute.min,
      LLM_LIMIT_RANGES.requestsPerMinute.max
    )
    const savedTokensPerMinute = boundedInteger(
      saved.tokensPerMinute,
      LLM_LIMIT_DEFAULTS.tokensPerMinute,
      LLM_LIMIT_RANGES.tokensPerMinute.min,
      LLM_LIMIT_RANGES.tokensPerMinute.max
    )
    const savedTimeoutSeconds = boundedInteger(
      saved.timeoutSeconds,
      LLM_LIMIT_DEFAULTS.timeoutSeconds,
      LLM_LIMIT_RANGES.timeoutSeconds.min,
      LLM_LIMIT_RANGES.timeoutSeconds.max
    )
    const savedMaxRetries = boundedInteger(
      saved.maxRetries,
      LLM_LIMIT_DEFAULTS.maxRetries,
      LLM_LIMIT_RANGES.maxRetries.min,
      LLM_LIMIT_RANGES.maxRetries.max
    )
    return {
      baseUrl,
      model: cleanModel(process.env.SEQ_LLM_MODEL ?? saved.model),
      apiKey: managedApiKey ?? originBoundEncryptedKey ?? originBoundSessionKey,
      requestsPerMinute: integerEnvironment(
        'SEQ_LLM_RPM',
        savedRequestsPerMinute,
        LLM_LIMIT_RANGES.requestsPerMinute.min,
        LLM_LIMIT_RANGES.requestsPerMinute.max
      ),
      tokensPerMinute: integerEnvironment(
        'SEQ_LLM_TPM',
        savedTokensPerMinute,
        LLM_LIMIT_RANGES.tokensPerMinute.min,
        LLM_LIMIT_RANGES.tokensPerMinute.max
      ),
      timeoutMs: integerEnvironment(
        'SEQ_LLM_TIMEOUT_MS',
        savedTimeoutSeconds * 1_000,
        LLM_LIMIT_RANGES.timeoutSeconds.min * 1_000,
        LLM_LIMIT_RANGES.timeoutSeconds.max * 1_000
      ),
      maxRetries: integerEnvironment(
        'SEQ_LLM_MAX_RETRIES',
        savedMaxRetries,
        LLM_LIMIT_RANGES.maxRetries.min,
        LLM_LIMIT_RANGES.maxRetries.max
      )
    }
  }

  async summary(): Promise<LlmConfigSummary> {
    const saved = await this.store.read()
    const managedApiKey = environmentApiKey()
    const environmentFields = {
      baseUrl: Boolean(process.env.SEQ_LLM_BASE_URL),
      model: Boolean(process.env.SEQ_LLM_MODEL),
      apiKey: Boolean(managedApiKey)
    }
    const environmentCount = Object.values(environmentFields).filter(Boolean).length
    const savedAny = Boolean(saved.baseUrl || saved.model || saved.encryptedApiKey || this.sessionApiKey)
    const source: LlmConfigSummary['source'] =
      environmentCount === 3
        ? 'environment'
        : environmentCount > 0 && savedAny
          ? 'mixed'
          : environmentCount > 0
            ? 'environment'
            : savedAny
              ? 'saved'
              : 'none'

    let effective: EffectiveLlmConfig
    try {
      effective = await this.effective()
    } catch {
      // A malformed centrally managed environment value must not prevent the
      // deterministic local engine or the rest of the app from starting.
      effective = {
        baseUrl: '',
        model: '',
        requestsPerMinute: integerEnvironment(
          'SEQ_LLM_RPM',
          boundedInteger(
            saved.requestsPerMinute,
            LLM_LIMIT_DEFAULTS.requestsPerMinute,
            LLM_LIMIT_RANGES.requestsPerMinute.min,
            LLM_LIMIT_RANGES.requestsPerMinute.max
          ),
          LLM_LIMIT_RANGES.requestsPerMinute.min,
          LLM_LIMIT_RANGES.requestsPerMinute.max
        ),
        tokensPerMinute: integerEnvironment(
          'SEQ_LLM_TPM',
          boundedInteger(
            saved.tokensPerMinute,
            LLM_LIMIT_DEFAULTS.tokensPerMinute,
            LLM_LIMIT_RANGES.tokensPerMinute.min,
            LLM_LIMIT_RANGES.tokensPerMinute.max
          ),
          LLM_LIMIT_RANGES.tokensPerMinute.min,
          LLM_LIMIT_RANGES.tokensPerMinute.max
        ),
        timeoutMs: integerEnvironment(
          'SEQ_LLM_TIMEOUT_MS',
          boundedInteger(
            saved.timeoutSeconds,
            LLM_LIMIT_DEFAULTS.timeoutSeconds,
            LLM_LIMIT_RANGES.timeoutSeconds.min,
            LLM_LIMIT_RANGES.timeoutSeconds.max
          ) * 1_000,
          LLM_LIMIT_RANGES.timeoutSeconds.min * 1_000,
          LLM_LIMIT_RANGES.timeoutSeconds.max * 1_000
        ),
        maxRetries: integerEnvironment(
          'SEQ_LLM_MAX_RETRIES',
          boundedInteger(
            saved.maxRetries,
            LLM_LIMIT_DEFAULTS.maxRetries,
            LLM_LIMIT_RANGES.maxRetries.min,
            LLM_LIMIT_RANGES.maxRetries.max
          ),
          LLM_LIMIT_RANGES.maxRetries.min,
          LLM_LIMIT_RANGES.maxRetries.max
        )
      }
    }

    return {
      baseUrl: effective.baseUrl,
      model: effective.model,
      configured: Boolean(effective.baseUrl && effective.model),
      apiKeyConfigured: Boolean(effective.apiKey),
      apiKeyPersisted: Boolean(saved.encryptedApiKey),
      source,
      managedByEnvironment: environmentFields,
      limits: {
        requestsPerMinute: effective.requestsPerMinute,
        tokensPerMinute: effective.tokensPerMinute,
        timeoutMs: effective.timeoutMs,
        timeoutSeconds: Math.round(effective.timeoutMs / 1_000),
        maxRetries: effective.maxRetries
      }
    }
  }

  /**
   * One explicit, user-triggered compatibility request. This deliberately does
   * not share the analysis limiter/retry path and never saves or returns a key.
   */
  async discoverModels(input: LlmModelDiscoveryInput = {}): Promise<LlmModelDiscoveryResult> {
    const effective = await this.effective()
    const providedBaseUrl = input.baseUrl?.trim()
    const baseUrl = validateBaseUrl(providedBaseUrl || effective.baseUrl)
    if (!baseUrl) throw new Error('LLM Base URL을 입력해 주세요.')
    const providedApiKey = input.apiKey?.trim()
    const mayReuseEffectiveKey = !providedBaseUrl || (
      Boolean(effective.baseUrl) && new URL(baseUrl).origin === new URL(effective.baseUrl).origin
    )
    // A saved secret belongs to its configured origin. Never silently send it
    // to a newly typed host just because the token field was left blank.
    const apiKey = providedApiKey || (mayReuseEffectiveKey ? effective.apiKey : undefined) ||
      await vertexAccessTokenProvider.token(baseUrl)
    const endpoint = `${baseUrl}/models`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS)
    const startedAt = performance.now()
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`LLM_MODELS_HTTP_${response.status}`)
      }
      const bodyText = await readResponseTextCapped(response, MAX_MODELS_RESPONSE_BYTES)
      let parsed: { data?: Array<{ id?: unknown }> }
      try {
        parsed = JSON.parse(bodyText) as { data?: Array<{ id?: unknown }> }
      } catch {
        throw new Error('LLM_MODELS_INVALID_JSON_RESPONSE')
      }
      if (!Array.isArray(parsed.data)) throw new Error('LLM_MODELS_INVALID_RESPONSE')
      const allModels = parsed.data
        .map((item) => sanitizeModelId(item?.id))
        .filter((model): model is string => Boolean(model))
        .filter((model) => !apiKey || (model !== apiKey && (apiKey.length < 4 || !model.includes(apiKey))))
      const uniqueModels = [...new Set(allModels)]
      return {
        models: uniqueModels.slice(0, MAX_DISCOVERED_MODELS),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        truncated: uniqueModels.length > MAX_DISCOVERED_MODELS
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('LLM_MODEL_DISCOVERY_TIMEOUT')
      const message = error instanceof Error ? error.message : ''
      if (/^LLM_MODELS_(?:HTTP_\d{3}|RESPONSE_TOO_LARGE|INVALID_JSON_RESPONSE|INVALID_RESPONSE)$/.test(message)) {
        throw error
      }
      // Native networking errors can contain implementation details. Keep the
      // IPC error stable and ensure an auth token can never be reflected back.
      throw new Error('LLM_MODEL_DISCOVERY_FAILED')
    } finally {
      clearTimeout(timeout)
    }
  }

  private decrypt(encrypted?: string): string | undefined {
    if (!encrypted || !canPersistApiKeySecurely()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return undefined
    }
  }
}

interface UsageEvent {
  at: number
  tokens: number
}

function abortError(): Error {
  const error = new Error('요청이 취소되었습니다.')
  error.name = 'AbortError'
  return error
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, milliseconds))
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterMilliseconds(raw: string | null, now = Date.now()): number | null {
  if (!raw?.trim()) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60_000)
  }
  const retryAt = Date.parse(raw)
  if (!Number.isFinite(retryAt)) return null
  return Math.min(Math.max(0, retryAt - now), 60_000)
}

class SlidingWindowLimiter {
  private events: UsageEvent[] = []

  async reserve(
    estimatedTokens: number,
    config: Pick<EffectiveLlmConfig, 'requestsPerMinute' | 'tokensPerMinute'>,
    signal: AbortSignal | undefined,
    onWait: (milliseconds: number) => void
  ): Promise<void> {
    const tokens = Math.max(estimatedTokens, 1)
    if (tokens > config.tokensPerMinute) {
      // Capping the reservation would make a request that is larger than the
      // configured TPM budget look valid. Fail locally instead of violating a
      // centrally shared quota or waiting forever for impossible capacity.
      throw new Error('LLM_TPM_REQUEST_TOO_LARGE')
    }
    while (true) {
      const now = Date.now()
      this.events = this.events.filter((event) => now - event.at < 60_000)
      const usedTokens = this.events.reduce((sum, event) => sum + event.tokens, 0)
      if (
        this.events.length < config.requestsPerMinute &&
        usedTokens + tokens <= config.tokensPerMinute
      ) {
        this.events.push({ at: now, tokens })
        return
      }
      const oldest = this.events[0]
      const waitMs = oldest ? Math.max(250, 60_050 - (now - oldest.at)) : 1_000
      onWait(waitMs)
      await delay(Math.min(waitMs, 60_000), signal)
    }
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

const MAX_CHAT_RESPONSE_BYTES = 2 * 1024 * 1024

function isGemini3Model(model: string): boolean {
  return /(?:^|\/)gemini-3(?:\.\d+)?-/i.test(model.trim())
}

export class OpenAiCompatibleClient {
  private readonly limiter = new SlidingWindowLimiter()

  constructor(
    private readonly configService: LlmConfigService,
    private readonly vertexAuth: Pick<VertexAccessTokenProvider, 'token'> = vertexAccessTokenProvider
  ) {}

  async complete(
    prompt: string,
    signal: AbortSignal | undefined,
    onStage: (stage: string) => void
  ): Promise<{ content: string; model: string }> {
    const config = await this.configService.effective()
    if (!config.baseUrl || !config.model) throw new Error('LLM_UNAVAILABLE')
    const gemini3 = isGemini3Model(config.model)
    const completionTokenBudget = gemini3
      ? GEMINI_3_COMPLETION_TOKEN_BUDGET
      : LLM_COMPLETION_TOKEN_BUDGET
    // UTF-8 bytes / 3 is intentionally conservative for Korean while still
    // remaining close enough for English-heavy structured JSON evidence.
    const estimatedTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3) + completionTokenBudget
    const endpoint = config.baseUrl.endsWith('/chat/completions')
      ? config.baseUrl
      : `${config.baseUrl}/chat/completions`
    const automaticVertexAuth = !config.apiKey && isVertexOpenAiBaseUrl(config.baseUrl)
    const accessToken = config.apiKey ?? await this.vertexAuth.token(config.baseUrl)
    if (automaticVertexAuth && !accessToken) throw new Error('LLM_VERTEX_AUTH_UNAVAILABLE')
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      if (signal?.aborted) throw abortError()
      // Retries are real API calls as well, so each attempt reserves RPM/TPM.
      await this.limiter.reserve(estimatedTokens, config, signal, (waitMs) => {
        onStage(`LLM 사용량 대기 · 약 ${Math.ceil(waitMs / 1_000)}초`)
      })
      if (attempt > 0) onStage(`LLM 재시도 ${attempt}/${config.maxRetries}`)
      else onStage('사내 LLM 응답 대기')

      const timeoutController = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        timeoutController.abort()
      }, config.timeoutMs)
      const onAbort = (): void => timeoutController.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (accessToken) headers.authorization = `Bearer ${accessToken}`
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: [
              {
                role: 'system',
                content:
                  '당신은 반도체 평가 Sequence 아카이브 에이전트입니다. 파일에서 확인되지 않은 사실을 만들지 마십시오.'
              },
              { role: 'user', content: prompt }
            ],
            ...(gemini3 ? { reasoning_effort: 'low' } : { temperature: 0.1 }),
            max_tokens: completionTokenBudget
          }),
          redirect: 'error',
          signal: timeoutController.signal
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          const retryable = response.status === 429 || response.status >= 500
          const error = new Error(`LLM_HTTP_${response.status}`)
          if (!retryable || attempt >= config.maxRetries) throw error
          const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'))
          const backoff = retryAfter !== null
            ? retryAfter
            : Math.min(1_000 * 2 ** attempt + Math.random() * 500, 15_000)
          lastError = error
          await delay(backoff, signal)
          continue
        }
        const bodyText = await readResponseTextCapped(
          response,
          MAX_CHAT_RESPONSE_BYTES,
          'LLM_RESPONSE_TOO_LARGE'
        )
        let parsed: ChatCompletionResponse
        try {
          parsed = JSON.parse(bodyText) as ChatCompletionResponse
        } catch {
          throw new Error('LLM_INVALID_JSON_RESPONSE')
        }
        const content = parsed.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) throw new Error('LLM_EMPTY_RESPONSE')
        return { content, model: config.model }
      } catch (error) {
        if (signal?.aborted) throw abortError()
        const original = error instanceof Error ? error : undefined
        const current = timedOut
          ? new Error('LLM_REQUEST_TIMEOUT')
          : original && /^LLM_(?:HTTP_\d{3}|INVALID_JSON_RESPONSE|EMPTY_RESPONSE|RESPONSE_TOO_LARGE|TPM_REQUEST_TOO_LARGE)$/.test(original.message)
            ? original
            : new Error('LLM_REQUEST_FAILED')
        lastError = current
        const retryable =
          current.message === 'LLM_REQUEST_TIMEOUT' ||
          current.message === 'LLM_REQUEST_FAILED' ||
          /^LLM_HTTP_(?:408|429|5\d{2})$/.test(current.message)
        if (!retryable || attempt >= config.maxRetries) throw current
        await delay(Math.min(1_000 * 2 ** attempt + Math.random() * 500, 15_000), signal)
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    throw lastError ?? new Error('LLM_REQUEST_FAILED')
  }
}
