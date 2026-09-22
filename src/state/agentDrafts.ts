import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/** A stable slot for a composer before the native Agent has created a session. */
export const NEW_AGENT_CONVERSATION_SLOT = '__new-conversation__'

const STORAGE_PREFIX = 'sequence-control-tower:agent-draft:v1:'

// Keeps unsent text usable for this renderer lifetime when durable storage is
// blocked. Tombstones prevent an older durable value from reappearing after a
// failed removeItem call. These maps deliberately have no eviction policy.
const memoryDrafts = new Map<string, string>()
const clearedDrafts = new Set<string>()
const dirtyStorage = new Map<string, AgentDraftStorageStatus>()
const draftRevisions = new Map<string, number>()

export function agentDraftRevision(scope: AgentDraftScope): number {
  return draftRevisions.get(agentDraftKey(scope)) ?? 0
}

export interface AgentDraftScope {
  projectId: string
  evaluationScopeId?: string | null
  /** Omit this only for the explicit new-conversation composer slot. */
  sessionId?: string | null
}

export interface AgentDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AgentDraftStorageStatus {
  /** True only when this operation successfully used durable local storage. */
  durable: boolean
  reason?: 'unavailable' | 'read-failed' | 'write-failed'
  message?: string
}

export interface AgentDraftRead {
  draft: string
  storage: AgentDraftStorageStatus
}

export interface AgentDraftWrite {
  storage: AgentDraftStorageStatus
  cleared: boolean
}

export interface AgentDraftTransfer extends AgentDraftWrite {
  transferred: boolean
  /** A different session draft already owns the destination. */
  destinationOccupied: boolean
}

const unavailable = (): AgentDraftStorageStatus => ({
  durable: false,
  reason: 'unavailable',
  message: 'Draft storage is unavailable in this window.',
})

function failure(reason: 'read-failed' | 'write-failed', error: unknown): AgentDraftStorageStatus {
  return {
    durable: false,
    reason,
    message: error instanceof Error && error.message ? error.message : 'Draft storage could not be updated.',
  }
}

function browserStorage(): AgentDraftStorage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage }
  catch { return null }
}

function storageFor(storage?: AgentDraftStorage): AgentDraftStorage | null {
  return storage ?? browserStorage()
}

/**
 * Produces a collision-safe localStorage key. Only the composer text is ever
 * persisted; callers must never put log content or other context in a draft.
 */
export function agentDraftKey({ projectId, evaluationScopeId, sessionId }: AgentDraftScope): string {
  return `${STORAGE_PREFIX}${JSON.stringify([
    projectId,
    evaluationScopeId ?? '',
    sessionId ?? NEW_AGENT_CONVERSATION_SLOT,
  ])}`
}

/** Reads one composer draft synchronously, without sharing it with another scope. */
export function readAgentDraft(scope: AgentDraftScope, storage?: AgentDraftStorage): AgentDraftRead {
  const key = agentDraftKey(scope)
  const dirty = dirtyStorage.get(key)
  const target = storageFor(storage)
  if (!target) return { draft: clearedDrafts.has(key) ? '' : memoryDrafts.get(key) ?? '', storage: dirty ?? unavailable() }
  try {
    const durableDraft = target.getItem(key) ?? ''
    return {
      draft: clearedDrafts.has(key) ? '' : memoryDrafts.get(key) ?? durableDraft,
      // A readable store does not prove a newer fallback write/remove persisted.
      storage: dirty ?? { durable: true },
    }
  } catch (error) {
    return { draft: clearedDrafts.has(key) ? '' : memoryDrafts.get(key) ?? '', storage: dirty ?? failure('read-failed', error) }
  }
}

/** Writes one text draft synchronously. An empty draft removes its durable entry. */
export function writeAgentDraft(scope: AgentDraftScope, draft: string, storage?: AgentDraftStorage): AgentDraftWrite {
  const key = agentDraftKey(scope)
  draftRevisions.set(key, agentDraftRevision(scope) + 1)
  if (draft.length === 0) {
    memoryDrafts.delete(key)
    clearedDrafts.add(key)
  } else {
    memoryDrafts.set(key, draft)
    clearedDrafts.delete(key)
  }
  const target = storageFor(storage)
  if (!target) {
    const status = unavailable()
    dirtyStorage.set(key, status)
    return { storage: status, cleared: draft.length === 0 }
  }
  try {
    if (draft.length === 0) {
      target.removeItem(key)
      clearedDrafts.delete(key)
    } else target.setItem(key, draft)
    dirtyStorage.delete(key)
    return { storage: { durable: true }, cleared: draft.length === 0 }
  } catch (error) {
    const status = failure('write-failed', error)
    dirtyStorage.set(key, status)
    return { storage: status, cleared: draft.length === 0 }
  }
}

/**
 * Clears an acknowledged submission only when the durable value is still the
 * submitted text. This leaves text typed while an async send was pending alone.
 */
export function acknowledgeAgentDraft(scope: AgentDraftScope, submittedText: string, storage?: AgentDraftStorage, expectedRevision?: number): AgentDraftWrite {
  const current = readAgentDraft(scope, storage)
  if (current.draft !== submittedText || (expectedRevision !== undefined && agentDraftRevision(scope) !== expectedRevision)) return { storage: current.storage, cleared: false }
  return writeAgentDraft(scope, '', storage)
}

/**
 * Moves the unsent new-conversation draft to the created session. A draft that
 * already belongs to that session always wins, so no conversation is overwritten.
 */
export function transferNewAgentDraft(
  scope: Omit<AgentDraftScope, 'sessionId'> & { sessionId: string },
  storage?: AgentDraftStorage,
): AgentDraftTransfer {
  const from: AgentDraftScope = { projectId: scope.projectId, evaluationScopeId: scope.evaluationScopeId }
  const source = readAgentDraft(from, storage)
  if (!source.draft) return { storage: source.storage, cleared: false, transferred: false, destinationOccupied: false }

  const destination = readAgentDraft(scope, storage)
  if (destination.draft && destination.draft !== source.draft) {
    return { storage: destination.storage, cleared: false, transferred: false, destinationOccupied: true }
  }
  if (!destination.draft) {
    const copied = writeAgentDraft(scope, source.draft, storage)
    if (!copied.storage.durable) {
      const cleared = writeAgentDraft(from, '', storage)
      return { ...cleared, transferred: cleared.cleared, destinationOccupied: false }
    }
  }
  const cleared = writeAgentDraft(from, '', storage)
  return { ...cleared, transferred: cleared.storage.durable, destinationOccupied: false }
}

interface AgentDraftEntry {
  key: string
  draft: string
  storage: AgentDraftStorageStatus
}

export interface UseAgentDraftResult {
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  storage: AgentDraftStorageStatus
  /** Use after a send acknowledgement; it cannot erase newer typing. */
  acknowledge(submittedText: string, expectedRevision?: number): void
}

/**
 * React integration for one composer. The key check discards stale async
 * updaters after project/session navigation, rather than writing into a new key.
 */
export function useAgentDraft(scope: AgentDraftScope): UseAgentDraftResult {
  const key = agentDraftKey(scope)
  const [entry, setEntry] = useState<AgentDraftEntry>(() => {
    const read = readAgentDraft(scope)
    return { key, ...read }
  })
  const entryRef = useRef(entry)
  if (entry.key !== key) {
    const read = readAgentDraft(scope)
    const next = { key, ...read }
    entryRef.current = next
    setEntry(next)
  }

  const setDraft: Dispatch<SetStateAction<string>> = useCallback((update) => {
    const current = entryRef.current
    if (current.key !== key) return
    const nextDraft = typeof update === 'function' ? (update as (previous: string) => string)(current.draft) : update
    if (Object.is(current.draft, nextDraft)) return
    const written = writeAgentDraft(scope, nextDraft)
    const next = { key, draft: nextDraft, storage: written.storage }
    entryRef.current = next
    setEntry(next)
  }, [key, scope.projectId, scope.evaluationScopeId, scope.sessionId])

  const acknowledge = useCallback((submittedText: string, expectedRevision?: number) => {
    const current = entryRef.current
    if (current.key !== key || current.draft !== submittedText) return
    const written = acknowledgeAgentDraft(scope, submittedText, undefined, expectedRevision)
    const next = written.cleared ? { key, draft: '', storage: written.storage } : { ...current, storage: written.storage }
    entryRef.current = next
    setEntry(next)
  }, [key, scope.projectId, scope.evaluationScopeId, scope.sessionId])

  if (entry.key !== key) {
    const read = readAgentDraft(scope)
    return { draft: read.draft, setDraft, storage: read.storage, acknowledge }
  }
  return { draft: entry.draft, setDraft, storage: entry.storage, acknowledge }
}
