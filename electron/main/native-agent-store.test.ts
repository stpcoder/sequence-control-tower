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

  it('does not leak a late-arriving pre-decision search into the next evaluation cycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-search-boundary-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    const search = (query: string, observedAt?: string) => store.recordSearch({
      projectId: 'p', sourceIds: ['s'], activeSourceId: 's', query, mode: 'literal', caseSensitive: false,
      scope: 'current', matchCount: 1, activeMatchCount: 1, ...(observedAt ? { observedAt } : {}),
    })
    await search('UEFI'); await search('@PASS')
    const first = await store.completeEvaluation({ projectId: 'p', sourceId: 's', result: 'PASS' })
    expect(first.kind).toBe('review')
    if (first.kind !== 'review') throw new Error('review expected')
    await search('late old marker', new Date(Date.parse(first.review.createdAt) - 500).toISOString())
    await search('new marker', new Date(Date.parse(first.review.createdAt) + 2_000).toISOString())
    const next = await store.completeEvaluation({ projectId: 'p', sourceId: 's', result: 'PASS' })
    expect(next.kind).toBe('ignored')
  })

  it('returns search history by engineer action time even when IPC writes arrive out of order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-search-order-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    const base = Date.now() - 5_000
    const input = (query: string, observedAt: number) => ({
      projectId: 'p', sourceIds: ['s'], activeSourceId: 's', query, mode: 'literal' as const,
      caseSensitive: false, scope: 'current' as const, matchCount: 1, activeMatchCount: 1,
      observedAt: new Date(observedAt).toISOString(),
    })
    await store.recordSearch(input('second', base + 2_000))
    await store.recordSearch(input('first', base + 1_000))
    expect((await store.searchHistory('p')).map((item) => item.query)).toEqual(['second', 'first'])
    const completed = await store.completeEvaluation({ projectId: 'p', sourceId: 's', result: 'PASS' })
    expect(completed.kind).toBe('review')
    if (completed.kind !== 'review') throw new Error('review expected')
    expect(completed.review.checks.map((item) => item.query)).toEqual(['first', 'second'])
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
      observedAt: new Date().toISOString(),
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

  it('stores only the engineer-selected checks in the exact confirmed order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-workflow-selection-'))
    const store = new NativeAgentStore(root, (() => { let count = 0; return () => `id-${++count}` })())
    await store.initialize()
    for (const [query, count] of [['POST_PBL', 1], ['obsolete marker', 0], ['LK:', 1], ['@PASS', 1]] as const) {
      await store.recordSearch({ projectId: 'p', sourceIds: ['s1'], activeSourceId: 's1', query, mode: 'literal', caseSensitive: false, scope: 'current', matchCount: count, activeMatchCount: count })
    }
    const completed = await store.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'PASS' })
    expect(completed.kind).toBe('review')
    if (completed.kind !== 'review') throw new Error('review expected')
    const pick = [completed.review.checks[2], completed.review.checks[0], completed.review.checks[3]]
    const memory = await store.confirmWorkflow('p', completed.review.id, 'MTK 부팅 후 테스트 확인', pick)
    expect(memory.checks.map((item) => [item.query, item.order])).toEqual([['LK:', 1], ['POST_PBL', 2], ['@PASS', 3]])
    expect(memory.checks.some((item) => item.query === 'obsolete marker')).toBe(false)
  })

  it('reuses only confirmed procedures and knowledge across projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-workflow-reuse-'))
    const store = new NativeAgentStore(root, (() => { let count = 0; return () => `id-${++count}` })())
    await store.initialize()
    const chat = await store.create('source', 'source chat', 'internal')
    await store.appendMessage(chat.id, { role: 'user', content: 'DQ9를 확인해줘' })
    for (const query of ['UEFI', '@PASS']) await store.recordSearch({ projectId: 'source', sourceIds: ['s1'], activeSourceId: 's1', query, mode: 'literal', caseSensitive: false, scope: 'current', matchCount: 1, activeMatchCount: 1 })
    const completed = await store.completeEvaluation({ projectId: 'source', sourceId: 's1', result: 'PASS' })
    if (completed.kind !== 'review') throw new Error('review expected')
    await store.confirmWorkflow('source', completed.review.id, '부팅 완료 확인')
    await store.confirmCommandKnowledge({ projectId: 'source', command: 'sleep 20', purpose: '안정화 대기' })
    await store.confirmConsolePromptRule({ projectId: 'source', promptSignature: 'root-hash', promptKind: 'bare-root', role: 'input' })
    await store.confirmProfileBinding({ projectId: 'source', sourceIds: ['s1'], vendor: 'qualcomm', profileId: 'qualcomm-default' })

    await expect(store.reuseConfirmedKnowledge('source', 'target')).resolves.toEqual({ workflows: 1, commandKnowledge: 1, consolePromptRules: 1 })
    const copied = await store.workflowMemories('target')
    expect(copied[0]).toMatchObject({ purpose: '부팅 완료 확인', sourceIds: [], evidenceLines: [], appliedCount: 0 })
    expect(await store.commandKnowledge('target')).toEqual([expect.objectContaining({ command: 'sleep 20', purpose: '안정화 대기' })])
    expect(await store.consolePromptRules('target')).toEqual([expect.objectContaining({ promptSignature: 'root-hash', role: 'input' })])
    expect(await store.searchHistory('target')).toEqual([])
    expect(await store.conversationHistory('target')).toEqual([])
    expect(await store.attemptHistory('target')).toEqual([])
    expect(await store.profileBindings('target')).toEqual([])
    await expect(store.reuseConfirmedKnowledge('source', 'target')).resolves.toEqual({ workflows: 0, commandKnowledge: 0, consolePromptRules: 0 })
  })

  it('stores RT as a same-sample same-sequence attempt relation after FAIL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-attempt-memory-'))
    const store = new NativeAgentStore(root, (() => { let count = 0; return () => `id-${++count}` })())
    await store.initialize()
    const first = await store.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'TEST_FAIL', dimensions: { sample: 'A', skew: 'SS', die: '03' }, sequenceSignature: 'seq:same' })
    const second = await store.completeEvaluation({ projectId: 'p', sourceId: 's2', result: 'PASS', dimensions: { sample: 'A', skew: 'SS', die: '03' }, sequenceSignature: 'seq:same' })
    expect(first.attempt).toMatchObject({ relation: 'initial', attemptNo: 1 })
    expect(second.attempt).toMatchObject({ relation: 'retest', attemptNo: 2, retestOf: first.attempt?.id })
    const unrelated = await store.completeEvaluation({ projectId: 'p', sourceId: 's3', result: 'PASS', dimensions: { sample: 'B' }, sequenceSignature: 'seq:same', explicitRetest: true, filenameAttemptNo: 2 })
    expect(unrelated.attempt).toMatchObject({ relation: 'unresolved-retest', attemptNo: 2 })
  })

  it('persists engineer-confirmed command purpose in SoC scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-command-memory-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    await store.confirmCommandKnowledge({ projectId: 'p', command: 'voltage-control:set_rail', purpose: 'VDD 경계 확인', bootProfileId: 'mediatek-default', socModel: 'MTK-24D' })
    expect(await store.commandKnowledge('p')).toEqual([expect.objectContaining({ command: 'voltage-control:set_rail', purpose: 'VDD 경계 확인', socModel: 'MTK-24D' })])
  })

  it('stores an engineer-confirmed boot profile only for the questioned sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-profile-binding-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    await store.confirmProfileBinding({ projectId: 'p', sourceIds: ['s1', 's2'], vendor: 'mediatek', profileId: 'mediatek-default' })
    expect(await store.profileBindings('p')).toEqual([expect.objectContaining({ vendor: 'mediatek', profileId: 'mediatek-default', sourceIds: ['s1', 's2'] })])
  })

  it('persists a project console prompt decision and updates it by signature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-console-prompt-rule-'))
    const store = new NativeAgentStore(root)
    await store.initialize()
    await store.confirmConsolePromptRule({ projectId: 'p', promptSignature: 'bare-root-hash', promptKind: 'bare-root', role: 'input' })
    await store.confirmConsolePromptRule({ projectId: 'p', promptSignature: 'bare-root-hash', promptKind: 'bare-root', role: 'output' })
    expect(await store.consolePromptRules('p')).toEqual([expect.objectContaining({ promptSignature: 'bare-root-hash', role: 'output', confirmedCount: 2 })])
  })
})
