import { mkdtemp, rm } from 'node:fs/promises'
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

import { LlmConfigService } from '../../electron/main/llm-service'

const roots: string[] = []

async function service(): Promise<LlmConfigService> {
  const root = await mkdtemp(join(tmpdir(), 'llm-discovery-'))
  roots.push(root)
  const instance = new LlmConfigService(root)
  await instance.initialize()
  return instance
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LLM model discovery', () => {
  it('makes exactly one authenticated GET with unsaved settings and caps/sanitizes model IDs', async () => {
    const config = await service()
    const token = 'unsaved-secret-token'
    const serverModels = [
      { id: ' model-with\r\n-control ' },
      ...Array.from({ length: 105 }, (_, index) => ({ id: `model-${index}` })),
      { id: token }
    ]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: serverModels }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await config.discoverModels({
      baseUrl: 'http://internal-vllm.example/v1/',
      apiKey: token
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://internal-vllm.example/v1/models',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({ authorization: `Bearer ${token}` })
      })
    )
    expect(result.models).toHaveLength(100)
    expect(result.models[0]).toBe('model-with-control')
    expect(result.truncated).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('uses the effective saved connection without changing a manually entered model', async () => {
    const config = await service()
    await config.save({
      baseUrl: 'http://saved-vllm.example/v1',
      model: 'manual-qwen-model',
      apiKey: 'saved-session-token'
    })
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ id: 'qwen-new' }, { id: 'glm-new' }, { id: 'qwen-new' }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await config.discoverModels()
    const summary = await config.summary()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://saved-vllm.example/v1/models')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer saved-session-token' })
    }))
    expect(result.models).toEqual(['qwen-new', 'glm-new'])
    expect(summary.model).toBe('manual-qwen-model')
  })

  it('never reuses a saved token for a different unsaved Base URL origin', async () => {
    const config = await service()
    await config.save({
      baseUrl: 'http://trusted-vllm.example/v1',
      model: 'manual-model',
      apiKey: 'trusted-origin-token'
    })
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ data: [{ id: 'public-model' }] }),
      { status: 200 }
    ))
    vi.stubGlobal('fetch', fetchMock)

    await config.discoverModels({ baseUrl: 'http://different-vllm.example/v1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://different-vllm.example/v1/models')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: { accept: 'application/json' }
    }))
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain('trusted-origin-token')
  })

  it('keeps a key for same-origin path changes but clears it when saved Base URL origin changes', async () => {
    const config = await service()
    await config.save({
      baseUrl: 'http://bound-vllm.example/v1',
      model: 'manual-model',
      apiKey: 'origin-bound-token'
    })

    await config.save({
      baseUrl: 'http://bound-vllm.example/openai/v1',
      model: 'manual-model'
    })
    expect((await config.effective()).apiKey).toBe('origin-bound-token')

    const changed = await config.save({
      baseUrl: 'http://replacement-vllm.example/v1',
      model: 'manual-model'
    })
    expect((await config.effective()).apiKey).toBeUndefined()
    expect(changed.apiKeyConfigured).toBe(false)
    expect(changed.apiKeyPersisted).toBe(false)
  })

  it('aborts at the strict timeout and does not retry', async () => {
    vi.useFakeTimers()
    const config = await service()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('secret-bearing network detail')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pending = config.discoverModels({ baseUrl: 'http://slow-vllm.example/v1', apiKey: 'hidden-token' })
    const rejection = expect(pending).rejects.toThrow('LLM_MODEL_DISCOVERY_TIMEOUT')
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
