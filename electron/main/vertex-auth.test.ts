import { describe, expect, it, vi } from 'vitest'
import { isVertexOpenAiBaseUrl, VertexAccessTokenProvider } from './vertex-auth'

const VERTEX_URL = 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/endpoints/openapi'

describe('Vertex gcloud authentication', () => {
  it('recognizes only the official Vertex OpenAI-compatible endpoint shape', () => {
    expect(isVertexOpenAiBaseUrl(VERTEX_URL)).toBe(true)
    expect(isVertexOpenAiBaseUrl('https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/models')).toBe(false)
    expect(isVertexOpenAiBaseUrl('http://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo/locations/us-central1/endpoints/openapi')).toBe(false)
    expect(isVertexOpenAiBaseUrl('https://llm.internal.example/v1')).toBe(false)
  })

  it('uses application-default credentials and caches without exposing the token', async () => {
    let now = 1_000
    const runner = vi.fn(async (_executable: string, _args: string[]) => 'adc-access-token\n')
    const provider = new VertexAccessTokenProvider(runner, () => now)

    await expect(provider.token(VERTEX_URL)).resolves.toBe('adc-access-token')
    await expect(provider.token(VERTEX_URL)).resolves.toBe('adc-access-token')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[1]).toEqual([
      'auth', 'application-default', 'print-access-token', '--quiet'
    ])

    now += 36 * 60 * 1_000
    await expect(provider.token(VERTEX_URL)).resolves.toBe('adc-access-token')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('never runs gcloud for an internal OpenAI-compatible endpoint', async () => {
    const runner = vi.fn(async (_executable: string, _args: string[]) => 'must-not-run')
    const provider = new VertexAccessTokenProvider(runner)

    await expect(provider.token('https://llm.internal.example/v1')).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('falls back to the active gcloud account when ADC is not configured', async () => {
    const runner = vi.fn(async (_executable: string, args: string[]) => {
      if (args.includes('application-default')) throw new Error('ADC missing')
      return 'active-account-token\n'
    })
    const provider = new VertexAccessTokenProvider(runner)

    await expect(provider.token(VERTEX_URL)).resolves.toBe('active-account-token')
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ['auth', 'application-default', 'print-access-token', '--quiet'],
      ['auth', 'print-access-token', '--quiet'],
    ])
  })

  it('returns one stable error when gcloud or ADC is unavailable', async () => {
    const provider = new VertexAccessTokenProvider(vi.fn(async (_executable: string, _args: string[]) => {
      throw new Error('local path and account details')
    }))

    await expect(provider.token(VERTEX_URL)).rejects.toThrow('LLM_VERTEX_AUTH_UNAVAILABLE')
  })
})
