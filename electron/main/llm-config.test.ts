import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text'
  }
}))

import { LlmConfigService } from './llm-service'

const roots: string[] = []
let latestRoot = ''

async function service(): Promise<LlmConfigService> {
  const root = await mkdtemp(join(tmpdir(), 'llm-config-'))
  roots.push(root)
  latestRoot = root
  const instance = new LlmConfigService(root)
  await instance.initialize()
  return instance
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function clearLimitEnvironment(): void {
  vi.stubEnv('SEQ_LLM_RPM', '')
  vi.stubEnv('SEQ_LLM_TPM', '')
  vi.stubEnv('SEQ_LLM_TIMEOUT_MS', '')
  vi.stubEnv('SEQ_LLM_MAX_RETRIES', '')
}

describe('LLM saved limits', () => {
  it('uses the documented defaults and exposes all four settings', async () => {
    clearLimitEnvironment()
    const config = await service()

    await expect(config.effective()).resolves.toMatchObject({
      requestsPerMinute: 8,
      tokensPerMinute: 80_000,
      timeoutMs: 60_000,
      maxRetries: 2
    })
    await expect(config.summary()).resolves.toMatchObject({
      limits: {
        requestsPerMinute: 8,
        tokensPerMinute: 80_000,
        timeoutSeconds: 60,
        maxRetries: 2
      }
    })
  })

  it('resolves environment values over saved values and clamps saved values to range', async () => {
    clearLimitEnvironment()
    const config = await service()
    await config.save({
      baseUrl: 'http://llm.example/v1',
      model: 'qwen-internal',
      requestsPerMinute: 0,
      tokensPerMinute: 20_000_000,
      timeoutSeconds: 1,
      maxRetries: 9
    })

    await expect(config.effective()).resolves.toMatchObject({
      requestsPerMinute: 1,
      tokensPerMinute: 10_000_000,
      timeoutMs: 5_000,
      maxRetries: 5
    })

    vi.stubEnv('SEQ_LLM_RPM', '17')
    vi.stubEnv('SEQ_LLM_TPM', '17000')
    vi.stubEnv('SEQ_LLM_TIMEOUT_MS', '17000')
    vi.stubEnv('SEQ_LLM_MAX_RETRIES', '3')

    await expect(config.effective()).resolves.toMatchObject({
      requestsPerMinute: 17,
      tokensPerMinute: 17_000,
      timeoutMs: 17_000,
      maxRetries: 3
    })
  })

  it('does not persist a typed key when SEQ_LLM_API_KEY is managed by the environment', async () => {
    clearLimitEnvironment()
    const root = await mkdtemp(join(tmpdir(), 'llm-config-env-key-'))
    roots.push(root)
    latestRoot = root
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config', 'llm.json'), JSON.stringify({
      schemaVersion: 1,
      baseUrl: 'http://llm.example/v1',
      model: 'qwen-internal',
      encryptedApiKey: 'stale-encrypted-key',
      apiKeyOrigin: 'http://llm.example'
    }))
    const config = new LlmConfigService(root)
    await config.initialize()
    vi.stubEnv('SEQ_LLM_API_KEY', ' managed-environment-key ')

    const summary = await config.save({
      baseUrl: 'http://llm.example/v1',
      model: 'qwen-internal',
      apiKey: 'typed-key-must-not-be-stored',
      requestsPerMinute: 12
    })
    const saved = JSON.parse(await readFile(join(latestRoot, 'config', 'llm.json'), 'utf8')) as Record<string, unknown>

    expect(saved).not.toHaveProperty('encryptedApiKey')
    expect(saved).not.toHaveProperty('apiKeyOrigin')
    expect(summary).toMatchObject({
      apiKeyConfigured: true,
      apiKeyPersisted: false,
      managedByEnvironment: { apiKey: true }
    })
    await expect(config.effective()).resolves.toMatchObject({ apiKey: 'managed-environment-key' })

    // A typed key must not survive in the process either after the env key is removed.
    vi.stubEnv('SEQ_LLM_API_KEY', '')
    await expect(config.effective()).resolves.toMatchObject({ apiKey: undefined })
  })
})
