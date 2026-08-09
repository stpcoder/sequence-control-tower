import { describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ exposed: null as Record<string, unknown> | null, invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { bridge.exposed = api } }, ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.removeListener } }))

describe('preload evaluation agent API', () => {
  it('exposes only the four allow-listed evaluation-agent methods', async () => {
    await import('./index')
    const api = bridge.exposed?.evaluationAgent as Record<string, (input: unknown) => unknown>
    expect(Object.keys(api)).toEqual(['start', 'get', 'resume', 'memorySavePayload'])
    api.start({ projectId: 'p1' }); api.get('s1'); api.resume({ sessionId: 's1' }); api.memorySavePayload({ sessionId: 's1' })
    expect(bridge.invoke.mock.calls.map((call) => call[0])).toEqual(['evaluation-agent:start', 'evaluation-agent:get', 'evaluation-agent:resume', 'evaluation-agent:memory-save-payload'])
  })
})
