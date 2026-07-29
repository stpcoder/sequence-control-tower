import { safeStorage } from 'electron'
import { join } from 'node:path'
import type { LlmConfigInput, LlmConfigSummary } from '../shared/contracts'
import { AtomicJsonStore } from './json-store'

interface SavedLlmConfig {
  schemaVersion: 1
  baseUrl: string
  model: string
  encryptedApiKey?: string
  updatedAt?: string
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

function integerEnvironment(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback
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

function canPersistApiKeySecurely(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // Electron's Linux `basic_text` backend is obfuscation, not secret storage.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return false
  }
  return true
}

export class LlmConfigService {
  private readonly store: AtomicJsonStore<SavedLlmConfig>
  private sessionApiKey: string | undefined

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

    await this.store.update((draft) => {
      draft.baseUrl = baseUrl
      draft.model = model
      draft.updatedAt = new Date().toISOString()
      if (input.clearApiKey) {
        delete draft.encryptedApiKey
        this.sessionApiKey = undefined
      } else if (apiKey) {
        if (canPersistApiKeySecurely()) {
          draft.encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64')
          this.sessionApiKey = undefined
        } else {
          // Never degrade to plaintext. Keep it for this process only.
          delete draft.encryptedApiKey
          this.sessionApiKey = apiKey
        }
      }
    })
    return this.summary()
  }

  async effective(): Promise<EffectiveLlmConfig> {
    const saved = await this.store.read()
    const encryptedKey = this.decrypt(saved.encryptedApiKey)
    return {
      baseUrl: validateBaseUrl(process.env.SEQ_LLM_BASE_URL ?? saved.baseUrl),
      model: cleanModel(process.env.SEQ_LLM_MODEL ?? saved.model),
      apiKey: process.env.SEQ_LLM_API_KEY ?? encryptedKey ?? this.sessionApiKey,
      requestsPerMinute: integerEnvironment('SEQ_LLM_RPM', 8, 1, 10_000),
      tokensPerMinute: integerEnvironment('SEQ_LLM_TPM', 80_000, 1_000, 10_000_000),
      timeoutMs: integerEnvironment('SEQ_LLM_TIMEOUT_MS', 60_000, 5_000, 300_000),
      maxRetries: integerEnvironment('SEQ_LLM_MAX_RETRIES', 2, 0, 5)
    }
  }

  async summary(): Promise<LlmConfigSummary> {
    const saved = await this.store.read()
    const environmentFields = {
      baseUrl: Boolean(process.env.SEQ_LLM_BASE_URL),
      model: Boolean(process.env.SEQ_LLM_MODEL),
      apiKey: Boolean(process.env.SEQ_LLM_API_KEY)
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
        requestsPerMinute: integerEnvironment('SEQ_LLM_RPM', 8, 1, 10_000),
        tokensPerMinute: integerEnvironment('SEQ_LLM_TPM', 80_000, 1_000, 10_000_000),
        timeoutMs: integerEnvironment('SEQ_LLM_TIMEOUT_MS', 60_000, 5_000, 300_000),
        maxRetries: integerEnvironment('SEQ_LLM_MAX_RETRIES', 2, 0, 5)
      }
    }

    return {
      baseUrl: effective.baseUrl,
      model: effective.model,
      configured: Boolean(effective.baseUrl && effective.model),
      apiKeyConfigured: Boolean(effective.apiKey),
      apiKeyPersisted: Boolean(process.env.SEQ_LLM_API_KEY || saved.encryptedApiKey),
      source,
      managedByEnvironment: environmentFields,
      limits: {
        requestsPerMinute: effective.requestsPerMinute,
        tokensPerMinute: effective.tokensPerMinute,
        timeoutMs: effective.timeoutMs
      }
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
    const timer = setTimeout(resolve, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (!signal) return
    // Avoid retaining listeners after ordinary completion.
    setTimeout(() => signal.removeEventListener('abort', onAbort), milliseconds + 1)
  })
}

class SlidingWindowLimiter {
  private events: UsageEvent[] = []

  async reserve(
    estimatedTokens: number,
    config: Pick<EffectiveLlmConfig, 'requestsPerMinute' | 'tokensPerMinute'>,
    signal: AbortSignal | undefined,
    onWait: (milliseconds: number) => void
  ): Promise<void> {
    const tokens = Math.min(Math.max(estimatedTokens, 1), config.tokensPerMinute)
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
  choices?: Array<{ message?: { content?: string } }>
}

export class OpenAiCompatibleClient {
  private readonly limiter = new SlidingWindowLimiter()

  constructor(private readonly configService: LlmConfigService) {}

  async complete(
    prompt: string,
    signal: AbortSignal | undefined,
    onStage: (stage: string) => void
  ): Promise<{ content: string; model: string }> {
    const config = await this.configService.effective()
    if (!config.baseUrl || !config.model) throw new Error('LLM_UNAVAILABLE')
    const estimatedTokens = Math.ceil(prompt.length / 4) + 1_200
    const endpoint = config.baseUrl.endsWith('/chat/completions')
      ? config.baseUrl
      : `${config.baseUrl}/chat/completions`
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
      const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
      const onAbort = (): void => timeoutController.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
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
            temperature: 0.1,
            max_tokens: 1_200
          }),
          signal: timeoutController.signal
        })
        const bodyText = await response.text()
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500
          const error = new Error(`LLM_HTTP_${response.status}`)
          if (!retryable || attempt >= config.maxRetries) throw error
          const retryAfter = Number(response.headers.get('retry-after'))
          const backoff = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1_000, 60_000)
            : Math.min(1_000 * 2 ** attempt + Math.random() * 500, 15_000)
          lastError = error
          await delay(backoff, signal)
          continue
        }
        let parsed: ChatCompletionResponse
        try {
          parsed = JSON.parse(bodyText) as ChatCompletionResponse
        } catch {
          throw new Error('LLM_INVALID_JSON_RESPONSE')
        }
        const content = parsed.choices?.[0]?.message?.content
        if (!content) throw new Error('LLM_EMPTY_RESPONSE')
        return { content, model: config.model }
      } catch (error) {
        if (signal?.aborted) throw abortError()
        const current = error instanceof Error ? error : new Error('LLM_REQUEST_FAILED')
        lastError = current
        const retryable =
          current.name === 'AbortError' ||
          /fetch|network|timeout|LLM_HTTP_5/i.test(current.message)
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
