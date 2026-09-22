import { describe, expect, it, vi } from 'vitest'
import {
  NEW_AGENT_CONVERSATION_SLOT, acknowledgeAgentDraft, agentDraftKey, agentDraftRevision, readAgentDraft,
  transferNewAgentDraft, writeAgentDraft, type AgentDraftStorage,
} from './agentDrafts'

class MemoryStorage implements AgentDraftStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const newConversation = { projectId: 'project-a', evaluationScopeId: 'eval-a' }

describe('agent drafts', () => {
  it('uses a stable project, evaluation, and session key including a distinct new-conversation slot', () => {
    expect(agentDraftKey({ ...newConversation, sessionId: 'session-a' })).toBe(agentDraftKey({ ...newConversation, sessionId: 'session-a' }))
    expect(agentDraftKey(newConversation)).toContain(NEW_AGENT_CONVERSATION_SLOT)
    expect(agentDraftKey(newConversation)).not.toBe(agentDraftKey({ ...newConversation, sessionId: 'session-a' }))
    expect(agentDraftKey(newConversation)).not.toBe(agentDraftKey({ ...newConversation, evaluationScopeId: 'eval-b' }))
  })

  it('persists each scope text across a module reload and clears empty values', async () => {
    const storage = new MemoryStorage()
    const scope = { ...newConversation, sessionId: 'reload-session-a' }
    writeAgentDraft(scope, 'unsent question', storage)
    vi.resetModules()
    const reloaded = await import('./agentDrafts')
    expect(reloaded.readAgentDraft(scope, storage)).toEqual({ draft: 'unsent question', storage: { durable: true } })
    expect(reloaded.readAgentDraft({ ...newConversation, sessionId: 'reload-session-b' }, storage).draft).toBe('')
    reloaded.writeAgentDraft(scope, '', storage)
    expect(storage.values.has(reloaded.agentDraftKey(scope))).toBe(false)
  })

  it('keeps project and evaluation scopes independent', () => {
    const storage = new MemoryStorage()
    writeAgentDraft({ projectId: 'project-a', evaluationScopeId: 'eval-a', sessionId: 's' }, 'A', storage)
    writeAgentDraft({ projectId: 'project-b', evaluationScopeId: 'eval-a', sessionId: 's' }, 'B', storage)
    writeAgentDraft({ projectId: 'project-a', evaluationScopeId: 'eval-b', sessionId: 's' }, 'C', storage)
    expect(readAgentDraft({ projectId: 'project-a', evaluationScopeId: 'eval-a', sessionId: 's' }, storage).draft).toBe('A')
    expect(readAgentDraft({ projectId: 'project-b', evaluationScopeId: 'eval-a', sessionId: 's' }, storage).draft).toBe('B')
    expect(readAgentDraft({ projectId: 'project-a', evaluationScopeId: 'eval-b', sessionId: 's' }, storage).draft).toBe('C')
  })

  it('does not clear newer typing when a delayed send acknowledgement arrives', () => {
    const storage = new MemoryStorage()
    const scope = { ...newConversation, sessionId: 'session-a' }
    writeAgentDraft(scope, 'first message', storage)
    writeAgentDraft(scope, 'first message plus newer typing', storage)
    const acknowledged = acknowledgeAgentDraft(scope, 'first message', storage)
    expect(acknowledged.cleared).toBe(false)
    expect(readAgentDraft(scope, storage).draft).toBe('first message plus newer typing')
  })

  it('keeps per-key unsent drafts in memory when localStorage is unavailable', () => {
    const unavailable: AgentDraftStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    const first = { ...newConversation, sessionId: 'memory-a' }
    const second = { ...newConversation, sessionId: 'memory-b' }
    expect(writeAgentDraft(first, 'kept in memory', unavailable).storage).toMatchObject({ durable: false, reason: 'write-failed' })
    expect(readAgentDraft(first, unavailable).draft).toBe('kept in memory')
    expect(readAgentDraft(second, unavailable).draft).toBe('')
    expect(acknowledgeAgentDraft(first, 'kept in memory', unavailable)).toMatchObject({ cleared: true, storage: { durable: false, reason: 'write-failed' } })
    expect(readAgentDraft(first, unavailable).draft).toBe('')
  })

  it('does not resurrect a durable draft when clearing it fails', () => {
    const values = new Map<string, string>()
    const storage: AgentDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
    }
    const scope = { ...newConversation, sessionId: 'failed-clear' }
    writeAgentDraft(scope, 'old durable draft', storage)
    expect(acknowledgeAgentDraft(scope, 'old durable draft', storage)).toMatchObject({ cleared: true, storage: { durable: false, reason: 'write-failed' } })
    expect(values.get(agentDraftKey(scope))).toBe('old durable draft')
    expect(readAgentDraft(scope, storage)).toMatchObject({
      draft: '', storage: { durable: false, reason: 'write-failed' },
    })
  })

  it('transfers an unsent new-conversation draft without replacing a session draft', () => {
    const storage = new MemoryStorage()
    writeAgentDraft(newConversation, 'new conversation text', storage)
    expect(transferNewAgentDraft({ ...newConversation, sessionId: 'transfer-session-a' }, storage)).toMatchObject({ transferred: true, destinationOccupied: false })
    expect(readAgentDraft({ ...newConversation, sessionId: 'transfer-session-a' }, storage).draft).toBe('new conversation text')
    expect(readAgentDraft(newConversation, storage).draft).toBe('')

    writeAgentDraft(newConversation, 'do not move me', storage)
    writeAgentDraft({ ...newConversation, sessionId: 'transfer-session-b' }, 'session-owned text', storage)
    expect(transferNewAgentDraft({ ...newConversation, sessionId: 'transfer-session-b' }, storage)).toMatchObject({ transferred: false, destinationOccupied: true })
    expect(readAgentDraft({ ...newConversation, sessionId: 'transfer-session-b' }, storage).draft).toBe('session-owned text')
    expect(readAgentDraft(newConversation, storage).draft).toBe('do not move me')
  })

  it('transfers and clears the visible draft in memory-only mode', () => {
    const unavailable: AgentDraftStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    }
    writeAgentDraft({ ...newConversation, evaluationScopeId: 'memory-transfer' }, 'new text', unavailable)
    const scope = { ...newConversation, evaluationScopeId: 'memory-transfer', sessionId: 'session-memory' }
    expect(transferNewAgentDraft(scope, unavailable)).toMatchObject({ transferred: true, cleared: true, storage: { durable: false } })
    expect(readAgentDraft(scope, unavailable).draft).toBe('new text')
    expect(readAgentDraft({ ...newConversation, evaluationScopeId: 'memory-transfer' }, unavailable).draft).toBe('')
  })

  it('returns visible non-durable status when storage rejects a quota write', () => {
    const storage: AgentDraftStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
      removeItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
    }
    const result = writeAgentDraft({ ...newConversation, sessionId: 'session-a' }, 'draft', storage)
    expect(result.storage).toMatchObject({ durable: false, reason: 'write-failed', message: 'Quota exceeded' })
    expect(result.cleared).toBe(false)
  })

  it('keeps a write-failure warning while a newer in-memory draft shadows readable old storage', () => {
    const values = new Map<string, string>()
    const storage: AgentDraftStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError') },
      removeItem: () => undefined,
    }
    const scope = { ...newConversation, sessionId: 'quota-readback' }
    values.set(agentDraftKey(scope), 'old durable text')
    expect(writeAgentDraft(scope, 'new fallback text', storage).storage).toMatchObject({ durable: false, reason: 'write-failed' })
    expect(readAgentDraft(scope, storage)).toMatchObject({
      draft: 'new fallback text', storage: { durable: false, reason: 'write-failed', message: 'Quota exceeded' },
    })
  })
})


it('does not erase identical text retyped while an earlier send acknowledgement is pending', () => {
  const storage = new MemoryStorage()
  const scope = { projectId: 'repeat-project', evaluationScopeId: 'folder', sessionId: 'repeat-session' }
  writeAgentDraft(scope, 'repeat this check', storage)
  const revision = agentDraftRevision(scope)
  writeAgentDraft(scope, '', storage)
  writeAgentDraft(scope, 'repeat this check', storage)
  expect(acknowledgeAgentDraft(scope, 'repeat this check', storage, revision).cleared).toBe(false)
  expect(readAgentDraft(scope, storage).draft).toBe('repeat this check')
  expect(acknowledgeAgentDraft(scope, 'repeat this check', storage, agentDraftRevision(scope)).cleared).toBe(true)
})
