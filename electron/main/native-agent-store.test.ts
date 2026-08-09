import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

  it('migrates v1 chats and searches without clearing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-native-agent-v1-'))
    await mkdir(join(root, 'metadata'), { recursive: true })
    await writeFile(join(root, 'metadata', 'native-agent.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {},
      searches: { p: [{ id: 'old', projectId: 'p', sourceIds: ['s'], query: '@PASS', mode: 'literal', caseSensitive: false, scope: 'current', matchCount: 1, occurredAt: new Date().toISOString() }] },
    }))
    const store = new NativeAgentStore(root)
    await store.initialize()
    expect(await store.searchHistory('p')).toEqual([expect.objectContaining({ id: 'old', query: '@PASS' })])
    expect(await store.workflowMemories('p')).toEqual([])
  })

  it('promotes an ordered search procedure only after confirmation and reuses it without asking again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-workflow-memory-'))
    const store = new NativeAgentStore(root, (() => { let count = 0; return () => `id-${++count}` })())
    await store.initialize()
    const search = async (query: string, activeMatchCount: number) => store.recordSearch({
      projectId: 'p', sourceIds: ['s1'], activeSourceId: 's1', matchedSourceIds: activeMatchCount ? ['s1'] : [],
      query, mode: 'literal', caseSensitive: false, scope: 'current', matchCount: activeMatchCount, activeMatchCount,
    })
    await search('UEFI', 1); await search('TRAINING_FAIL', 0); await search('@PASS', 1)
    const first = await store.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'PASS', evidenceLines: [8, 12] })
    expect(first.kind).toBe('review')
    if (first.kind !== 'review') throw new Error('review expected')
    expect(first.review.stages).toEqual(['uefi', 'training', 'memory-test'])
    const memory = await store.confirmWorkflow('p', first.review.id, '부팅 후 OS Memory Test 확인')
    expect(memory).toMatchObject({ purpose: '부팅 후 OS Memory Test 확인', confirmedCount: 1, appliedCount: 0 })

    await search('UEFI', 1); await search('TRAINING_FAIL', 0); await search('@PASS', 1)
    const repeated = await store.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'PASS' })
    expect(repeated).toMatchObject({ kind: 'applied', memory: { purpose: '부팅 후 OS Memory Test 확인', appliedCount: 1 } })
    expect(await store.workflowMemories('p')).toHaveLength(1)
  })
})
