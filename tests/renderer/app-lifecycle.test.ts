import { describe, expect, it } from 'vitest'
import {
  isAppLifecycleActive,
  reconcileListedFiles,
  setupAppCommandListener,
  setupAppLifecycle,
  type AppLifecycle,
} from '../../src/App'
import type { ArtifactRecord, ArtifactSourceLocation, RendererCommand } from '../../electron/shared/contracts'
import { artifactFiles, type WorkbenchFile } from '../../src/views/WorkbenchView'

function lifecycle(): AppLifecycle {
  return { mounted: false, generation: 0 }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function artifact(id: string, lastSeenAt: string, rootId: string, folderLabel: string): ArtifactRecord {
  return {
    id,
    sha256: id,
    size: 42,
    extension: '.log',
    originalNames: ['sample.log'],
    importedAt: lastSeenAt,
    lastSeenAt,
    importCount: 1,
    sources: [{ rootId, folderLabel, relativePath: 'lot-01/sample.log' } as ArtifactSourceLocation],
  }
}

function commandHarness() {
  let listener: ((command: RendererCommand) => void) | undefined
  const scheduled: Array<{ id: number; callback: () => void }> = []
  const cancelled: number[] = []
  const dispatched: RendererCommand[] = []
  const navigated: string[] = []
  let nextFrameId = 1

  return {
    subscribe(next: (command: RendererCommand) => void) {
      listener = next
      return () => {
        if (listener === next) listener = undefined
      }
    },
    emit(command: RendererCommand) {
      listener?.(command)
    },
    schedule(callback: () => void) {
      const id = nextFrameId++
      scheduled.push({ id, callback })
      return id
    },
    cancel(id: number) {
      cancelled.push(id)
    },
    run(index: number) {
      scheduled[index]?.callback()
    },
    dispatched,
    cancelled,
    navigated,
    navigate(page: string) {
      navigated.push(page)
    },
  }
}

describe('App renderer lifecycle', () => {
  it('reactivates on StrictMode effect replay and ignores stale cleanup', () => {
    const current = lifecycle()
    const firstCleanup = setupAppLifecycle(current)

    expect(isAppLifecycleActive(current, 0)).toBe(true)
    firstCleanup()
    expect(isAppLifecycleActive(current, 0)).toBe(false)

    const replayCleanup = setupAppLifecycle(current)
    expect(isAppLifecycleActive(current, 1)).toBe(true)
    firstCleanup()
    expect(isAppLifecycleActive(current, 1)).toBe(true)

    replayCleanup()
    expect(isAppLifecycleActive(current, 1)).toBe(false)
  })

  it('rejects deferred resolve and reject completions after final unmount', async () => {
    const current = lifecycle()
    const cleanup = setupAppLifecycle(current)
    const generation = current.generation
    const resolved = deferred<string>()
    const rejected = deferred<string>()
    const applied: string[] = []

    const resolveCompletion = resolved.promise.then((value) => {
      if (isAppLifecycleActive(current, generation)) applied.push(`resolve:${value}`)
    })
    const rejectCompletion = rejected.promise.catch((error: string) => {
      if (isAppLifecycleActive(current, generation)) applied.push(`reject:${error}`)
    })

    cleanup()
    resolved.resolve('late success')
    rejected.reject('late failure')
    await Promise.all([resolveCompletion, rejectCompletion])

    expect(applied).toEqual([])
    expect(isAppLifecycleActive(current, generation)).toBe(false)
  })

  it('cancels and ignores a queued command RAF after final cleanup', () => {
    const current = lifecycle()
    const lifecycleCleanup = setupAppLifecycle(current)
    const harness = commandHarness()
    const commandCleanup = setupAppCommandListener(
      current,
      harness.subscribe,
      harness.navigate,
      harness.schedule,
      harness.cancel,
      (command) => harness.dispatched.push(command),
    )

    harness.emit('find')
    lifecycleCleanup()
    commandCleanup()
    harness.run(0)

    expect(harness.cancelled).toEqual([1])
    expect(harness.dispatched).toEqual([])
  })

  it('rejects a stale RAF from StrictMode setup replay while allowing the replayed listener', () => {
    const current = lifecycle()
    const firstLifecycleCleanup = setupAppLifecycle(current)
    const firstHarness = commandHarness()
    const firstCommandCleanup = setupAppCommandListener(
      current,
      firstHarness.subscribe,
      firstHarness.navigate,
      firstHarness.schedule,
      firstHarness.cancel,
      (command) => firstHarness.dispatched.push(command),
    )

    firstHarness.emit('find')
    firstLifecycleCleanup()
    firstCommandCleanup()

    const replayLifecycleCleanup = setupAppLifecycle(current)
    const replayHarness = commandHarness()
    const replayCommandCleanup = setupAppCommandListener(
      current,
      replayHarness.subscribe,
      replayHarness.navigate,
      replayHarness.schedule,
      replayHarness.cancel,
      (command) => replayHarness.dispatched.push(command),
    )

    firstHarness.run(0)
    replayHarness.emit('find-workspace')
    replayHarness.run(0)

    expect(firstHarness.dispatched).toEqual([])
    expect(replayHarness.dispatched).toEqual(['find-workspace'])

    replayCommandCleanup()
    replayLifecycleCleanup()
  })

  it('reconciles a stale initial list after folder import without dropping the import or selection', () => {
    const imported = artifactFiles(artifact('b'.repeat(64), '2026-08-05T00:00:00.000Z', 'root-imported', 'imported-folder'))[0]
    const existing: WorkbenchFile = {
      id: 'existing-row',
      sourceKey: 'root:root-existing\u001flog.log',
      rootId: 'root-existing',
      artifactId: 'existing-artifact',
      name: 'log.log',
      lastSeenAt: '2026-08-04T00:00:00.000Z',
    }
    const staleList = [artifact('a'.repeat(64), '2026-08-04T00:00:00.000Z', 'root-imported', 'imported-folder')]

    const reconciled = reconcileListedFiles([existing, imported], staleList)

    expect(reconciled).toEqual([existing, imported])
    expect(reconciled.some((file) => file.id === imported.id)).toBe(true)
  })
})
