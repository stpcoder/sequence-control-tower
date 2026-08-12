import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasRequiredOpenCodeSkill, isolatedOpenCodePaths, latestRunToolNames, vertexOpenCodeTarget } from './opencode-host'

describe('isolatedOpenCodePaths', () => {
  it('keeps embedded OpenCode state below the application data root', () => {
    const paths = isolatedOpenCodePaths('/app/data')
    const root = join('/app/data', 'opencode-runtime')

    expect(paths).toEqual({
      home: join(root, 'home'),
      configHome: join(root, 'config'),
      dataHome: join(root, 'data'),
      cacheHome: join(root, 'cache'),
      stateHome: join(root, 'state'),
      configDir: join(root, 'config', 'opencode')
    })
    expect(Object.values(paths).every((value) => value.startsWith(`${root}${sep}`))).toBe(true)
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

  it('recognizes the packaged LPDDR skill by name or path-derived id', () => {
    expect(hasRequiredOpenCodeSkill([{ name: 'lpddr-failure-analysis', location: '/app/agent-skills/lpddr-failure-analysis/SKILL.md' }])).toBe(true)
    expect(hasRequiredOpenCodeSkill([{ name: 'LPDDR Failure Analysis', location: 'C:\\app\\agent-skills\\lpddr-failure-analysis\\SKILL.md' }])).toBe(true)
    expect(hasRequiredOpenCodeSkill([{ name: 'generic-analysis', location: '/app/generic/SKILL.md' }])).toBe(false)
  })
})
