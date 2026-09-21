import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

// Drafts belong to a project + evaluation folder, not the mounted page.
// Bounded, session-only state; original log contents are never stored here.
const drafts = new Map<string, unknown>()
export function readViewDraft<T>(key: string, fallback: T): T {
  return drafts.has(key) ? drafts.get(key) as T : fallback
}
export function writeViewDraft<T>(key: string, value: T): void {
  drafts.delete(key)
  drafts.set(key, value)
  while (drafts.size > 200) drafts.delete(drafts.keys().next().value!)
}
export function useViewDraft<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [entry, setEntry] = useState(() => ({ key, value: readViewDraft(key, fallback) }))
  if (entry.key !== key) setEntry({ key, value: readViewDraft(key, fallback) })
  const update: Dispatch<SetStateAction<T>> = useCallback((value: SetStateAction<T>) => setEntry((current) => {
    if (current.key !== key) return current
    const next = typeof value === 'function' ? (value as (previous: T) => T)(current.value) : value
    if (Object.is(current.value, next)) return current
    writeViewDraft(key, next)
    return { key, value: next }
  }), [key])
  return [entry.key === key ? entry.value : readViewDraft(key, fallback), update]
}

/** Async completion must belong to the same mounted view and folder visit. */
export function useViewScopeGuard(key: string): () => () => boolean {
  const scope = useRef({ key, generation: 0, mounted: true })
  if (scope.current.key !== key) { scope.current.key = key; scope.current.generation += 1 }
  useEffect(() => {
    scope.current.mounted = true
    return () => { scope.current.mounted = false; scope.current.generation += 1 }
  }, [])
  return () => {
    const generation = scope.current.generation
    return () => scope.current.mounted && scope.current.generation === generation
  }
}
