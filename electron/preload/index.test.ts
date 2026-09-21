import { describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ exposed: null as Record<string, unknown> | null, invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { bridge.exposed = api } }, ipcRenderer: { invoke: bridge.invoke, on: bridge.on, removeListener: bridge.removeListener } }))

describe('preload Agent API', () => {
  it('exposes one OpenCode-centered Agent surface and retires the legacy evaluation Agent bridge', async () => {
    await import('./index')
    expect(bridge.exposed).not.toHaveProperty('evaluationAgent')
    expect(bridge.exposed).toHaveProperty('nativeAgent')
  })

  it('exposes bounded native workflow-memory operations without raw file access', async () => {
    await import('./index')
    bridge.invoke.mockClear()
    const api = bridge.exposed?.nativeAgent as Record<string, (input: unknown) => unknown>
    expect(Object.keys(api)).toEqual([
      'backendStatus', 'create', 'list', 'get', 'send', 'retry', 'cancel', 'recordSearch',
      'completeEvaluation', 'confirmWorkflow', 'dismissWorkflow', 'listWorkflows', 'reuseConfirmedKnowledge', 'onUpdate',
    ])
    api.completeEvaluation({ projectId: 'p', sourceId: 's', result: 'PASS' })
    api.confirmWorkflow({ projectId: 'p', reviewId: 'r', purpose: '부팅 확인' })
    api.dismissWorkflow({ projectId: 'p', reviewId: 'r' })
    api.listWorkflows({ projectId: 'p' })
    api.reuseConfirmedKnowledge({ sourceProjectId: 'p', targetProjectId: 'next' })
    expect(bridge.invoke.mock.calls.map((call) => call[0])).toEqual([
      'native-agent:complete-evaluation', 'native-agent:confirm-workflow',
      'native-agent:dismiss-workflow', 'native-agent:list-workflows', 'native-agent:reuse-knowledge',
    ])
  })
})
