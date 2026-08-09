import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { NativeAgentStore } from './native-agent-store'

describe('NativeAgentStore', () => {
  it('persists project chat, tool traces and pauses interrupted work after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-native-agent-'))
    const store = new NativeAgentStore(root, (() => { let count = 0; return () => `id-${++count}` })())
    await store.initialize()
    const created = await store.create('project-a', 'VPERI 분석', 'internal')
    await store.appendMessage(created.id, { role: 'user', content: 'DQ9 경향을 확인해줘' })
    await store.update(created.id, (session) => {
      session.status = 'running'
      session.lastRequest = { content: 'DQ9 경향을 확인해줘', sourceIds: ['source-a'] }
      session.tools.push({ id: 'tool-1', name: 'failure_trends_get', label: '조건별 경향', state: 'completed', startedAt: new Date().toISOString(), summary: 'DQ9 2/2 fail' })
    })

    const reopened = new NativeAgentStore(root)
    await reopened.initialize()
    const session = await reopened.get(created.id)
    expect(session).toMatchObject({ status: 'paused', backend: 'internal' })
    expect(session?.messages.at(-1)?.content).toBe('DQ9 경향을 확인해줘')
    expect(session?.tools[0].summary).toContain('DQ9')
  })

  it('deduplicates rapid identical Ctrl-F observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-search-history-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    const input = { projectId: 'p', sourceIds: ['s'], query: '@FAIL', mode: 'literal' as const, caseSensitive: false, scope: 'project' as const, matchCount: 3 }
    await store.recordSearch(input); await store.recordSearch(input)
    expect(await store.searchHistory('p')).toHaveLength(1)
  })
})
