import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EvaluationAgentSession } from '../../src/domain/evaluation-agent'
import { EvaluationAgentSessionStore } from './evaluation-agent-session-store'

const session = (id: string, status: EvaluationAgentSession['status'] = 'waiting_confirmation'): EvaluationAgentSession => ({
  schemaVersion: 1, id, status, depth: 1, calls: 1, searches: 0,
  files: [{ id: 'source-1', name: 'sample.log' }], evidence: [], transcript: [], context: { dimensions: {}, aggregate: '' },
})

describe('EvaluationAgentSessionStore', () => {
  it('restores only the latest session in the same project and evaluation folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evaluation-agent-store-'))
    const store = new EvaluationAgentSessionStore(root); await store.initialize()
    await store.save({ projectId: 'p', evaluationScopeId: 'root-a', sourceIds: ['source-1'], session: session('older'), updatedAt: '2026-01-01T00:00:00.000Z' })
    await store.save({ projectId: 'p', evaluationScopeId: 'root-b', sourceIds: ['source-1'], session: session('other'), updatedAt: '2026-01-03T00:00:00.000Z' })
    await store.save({ projectId: 'p', evaluationScopeId: 'root-a', sourceIds: ['source-1'], session: session('latest'), updatedAt: '2026-01-02T00:00:00.000Z' })
    expect((await store.latest('p', 'root-a'))?.session.id).toBe('latest')
    expect((await store.latest('p', 'root-b'))?.session.id).toBe('other')
  })

  it('pauses an interrupted provider run when the app restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evaluation-agent-restart-'))
    const store = new EvaluationAgentSessionStore(root); await store.initialize()
    await store.save({ projectId: 'p', evaluationScopeId: 'root-a', sourceIds: ['source-1'], session: session('running', 'running'), updatedAt: new Date().toISOString() })
    const reopened = new EvaluationAgentSessionStore(root); await reopened.initialize()
    expect((await reopened.load('running'))?.session).toMatchObject({ status: 'paused', failure: expect.stringContaining('이어서 다시 시도') })
  })
})
