import { describe, expect, it } from 'vitest'
import { isolatedOpenCodePaths, latestRunToolNames, vertexOpenCodeTarget } from './opencode-host'

describe('isolatedOpenCodePaths', () => {
  it('keeps embedded OpenCode state below the application data root', () => {
    const paths = isolatedOpenCodePaths('/app/data')

    expect(paths).toEqual({
      home: '/app/data/opencode-runtime/home',
      configHome: '/app/data/opencode-runtime/config',
      dataHome: '/app/data/opencode-runtime/data',
      cacheHome: '/app/data/opencode-runtime/cache',
      stateHome: '/app/data/opencode-runtime/state',
      configDir: '/app/data/opencode-runtime/config/opencode'
    })
    expect(Object.values(paths).every((value) => value.startsWith('/app/data/opencode-runtime/'))).toBe(true)
  })

  it('maps a Vertex OpenAI-compatible URL to the native Vertex provider target', () => {
    expect(vertexOpenCodeTarget(
      'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi',
      'google/gemini-3.5-flash'
    )).toEqual({ project: 'demo', location: 'global', modelID: 'gemini-3.5-flash' })
    expect(vertexOpenCodeTarget('https://llm.example/v1', 'qwen')).toBeNull()
  })

  it('keeps every tool call made after the latest user turn', () => {
    expect(latestRunToolNames([
      { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text' }] },
      { info: { role: 'assistant', time: { created: 2 } }, parts: [{ type: 'tool', tool: 'old_tool' }] },
      { info: { role: 'user', time: { created: 10 } }, parts: [{ type: 'text' }] },
      { info: { role: 'assistant', time: { created: 12 } }, parts: [{ type: 'tool', tool: 'project_context_get' }] },
      { info: { role: 'assistant', time: { created: 11 } }, parts: [{ type: 'tool', tool: 'project_history_get' }] },
      { info: { role: 'assistant', time: { created: 13 } }, parts: [{ type: 'tool', tool: 'project_context_get' }] }
    ])).toEqual(['project_history_get', 'project_context_get'])
  })
})
