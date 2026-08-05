import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/contracts'
import { registerIpc, unregisterIpc } from './ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))

const { showOpenDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    isPackaged: false
  },
  BrowserWindow: {
    fromWebContents: () => ({ isDestroyed: () => false })
  },
  dialog: { showOpenDialog },
  ipcMain: {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  },
}))

interface PendingRequest {
  signal: AbortSignal
  resolve: (value: unknown) => void
}

interface PendingFolderImport {
  folderPaths: string[]
  options: unknown
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

function operationMock(): {
  fn: ReturnType<typeof vi.fn>
  requests: PendingRequest[]
} {
  const requests: PendingRequest[] = []
  const fn = vi.fn((_input: unknown, signal: AbortSignal) => new Promise<unknown>((resolve) => {
    requests.push({ signal, resolve })
  }))
  return { fn, requests }
}

const search = operationMock()
const evidence = operationMock()
const folderImportRequests: PendingFolderImport[] = []
const importFolders = vi.fn((folderPaths: string[], options: unknown) => new Promise<unknown>((resolve, reject) => {
  folderImportRequests.push({ folderPaths, options, resolve, reject })
}))
const saveRecipeAndBatch = vi.fn(async (input: unknown) => ({ input }))
const services = {
  artifacts: {
    search: search.fn,
    inspectEvidence: evidence.fn,
    importFolders
  },
  evaluations: { saveRecipeAndBatch }
} as unknown as Parameters<typeof registerIpc>[0]

function trustedEvent(senderId = 42): unknown {
  const frame = { url: 'file:///renderer/index.html' }
  const sender = { id: senderId, mainFrame: frame }
  return { sender, senderFrame: frame }
}

async function invoke(channel: string, input: unknown = {}, senderId = 42): Promise<unknown> {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`Missing IPC handler: ${channel}`)
  return listener(trustedEvent(senderId), input)
}

beforeEach(() => {
  showOpenDialog.mockReset()
  search.fn.mockClear()
  evidence.fn.mockClear()
  importFolders.mockClear()
  saveRecipeAndBatch.mockClear()
  search.requests.length = 0
  evidence.requests.length = 0
  folderImportRequests.length = 0
  registerIpc(services)
})

afterEach(() => {
  unregisterIpc()
})

describe('artifact IPC cancellation', () => {
  it('returns limitReached false when file import is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(invoke(IPC_CHANNELS.artifactImportFiles)).resolves.toEqual({
      cancelled: true,
      limitReached: false,
      artifacts: [],
      failures: [],
      skippedCount: 0
    })
  })

  it('returns limitReached false when folder import is cancelled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

    await expect(invoke(IPC_CHANNELS.artifactImportFolder)).resolves.toEqual({
      cancelled: true,
      limitReached: false,
      artifacts: [],
      failures: [],
      skippedCount: 0
    })
  })

  it('rejects a second folder import in the same window without starting another copy', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/selected-folder'] })

    const firstImport = invoke(IPC_CHANNELS.artifactImportFolder, { extensions: ['log'] })
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(1))

    const secondImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await expect(secondImport).rejects.toThrow(
      '폴더 가져오기가 이미 진행 중입니다. 현재 작업이 끝난 후 다시 시도해 주세요.'
    )
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(importFolders).toHaveBeenCalledTimes(1)

    folderImportRequests[0].resolve({ cancelled: false })
    await firstImport
  })

  it('releases the folder import lock after completion', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/selected-folder'] })

    const firstImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(1))
    folderImportRequests[0].resolve({ cancelled: false, artifacts: [] })
    await firstImport

    const secondImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(2))
    folderImportRequests[1].resolve({ cancelled: false, artifacts: [] })
    await secondImport

    expect(showOpenDialog).toHaveBeenCalledTimes(2)
    expect(importFolders).toHaveBeenCalledTimes(2)
  })

  it('releases the folder import lock after picker cancellation', async () => {
    showOpenDialog
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/private/selected-folder'] })

    await expect(invoke(IPC_CHANNELS.artifactImportFolder)).resolves.toMatchObject({ cancelled: true })

    const secondImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(1))
    folderImportRequests[0].resolve({ cancelled: false, artifacts: [] })
    await secondImport

    expect(showOpenDialog).toHaveBeenCalledTimes(2)
    expect(importFolders).toHaveBeenCalledTimes(1)
  })

  it('releases the folder import lock after an import error', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/selected-folder'] })

    const firstImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(1))
    folderImportRequests[0].reject(new Error('import failed'))
    await expect(firstImport).rejects.toThrow('import failed')

    const secondImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => expect(folderImportRequests).toHaveLength(2))
    folderImportRequests[1].resolve({ cancelled: false, artifacts: [] })
    await secondImport
  })

  it('does not mix the folder import lock with search or evidence cancellation', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/selected-folder'] })

    const pendingSearch = invoke(IPC_CHANNELS.artifactSearch)
    const pendingEvidence = invoke(IPC_CHANNELS.artifactInspectEvidence)
    const pendingImport = invoke(IPC_CHANNELS.artifactImportFolder)
    await vi.waitFor(() => {
      expect(folderImportRequests).toHaveLength(1)
      expect(search.requests).toHaveLength(1)
      expect(evidence.requests).toHaveLength(1)
    })

    expect(search.requests[0].signal.aborted).toBe(false)
    expect(evidence.requests[0].signal.aborted).toBe(false)
    folderImportRequests[0].resolve({ cancelled: false, artifacts: [] })
    search.requests[0].resolve({ kind: 'search' })
    evidence.requests[0].resolve({ kind: 'evidence' })
    await Promise.all([pendingImport, pendingSearch, pendingEvidence])
  })

  it('does not cross-cancel overlapping search and evidence inspection', async () => {
    const pendingSearch = invoke(IPC_CHANNELS.artifactSearch)
    const pendingEvidence = invoke(IPC_CHANNELS.artifactInspectEvidence)

    expect(search.requests[0].signal.aborted).toBe(false)
    expect(evidence.requests[0].signal.aborted).toBe(false)

    search.requests[0].resolve({ kind: 'search' })
    evidence.requests[0].resolve({ kind: 'evidence' })
    await Promise.all([pendingSearch, pendingEvidence])
  })

  it('keeps only the latest search and evidence request active per operation', async () => {
    const firstSearch = invoke(IPC_CHANNELS.artifactSearch)
    const secondSearch = invoke(IPC_CHANNELS.artifactSearch)
    expect(search.requests[0].signal.aborted).toBe(true)
    expect(search.requests[1].signal.aborted).toBe(false)

    const firstEvidence = invoke(IPC_CHANNELS.artifactInspectEvidence)
    const secondEvidence = invoke(IPC_CHANNELS.artifactInspectEvidence)
    expect(evidence.requests[0].signal.aborted).toBe(true)
    expect(evidence.requests[1].signal.aborted).toBe(false)

    search.requests[0].resolve({ kind: 'first-search' })
    evidence.requests[0].resolve({ kind: 'first-evidence' })
    await Promise.all([firstSearch, firstEvidence])
    expect(search.requests[1].signal.aborted).toBe(false)
    expect(evidence.requests[1].signal.aborted).toBe(false)

    search.requests[1].resolve({ kind: 'second-search' })
    evidence.requests[1].resolve({ kind: 'second-evidence' })
    await Promise.all([secondSearch, secondEvidence])
  })

  it('aborts all active artifact operations when IPC is unregistered', async () => {
    const pendingSearch = invoke(IPC_CHANNELS.artifactSearch)
    const pendingEvidence = invoke(IPC_CHANNELS.artifactInspectEvidence)

    unregisterIpc()

    expect(search.requests[0].signal.aborted).toBe(true)
    expect(evidence.requests[0].signal.aborted).toBe(true)

    search.requests[0].resolve({})
    evidence.requests[0].resolve({})
    await Promise.all([pendingSearch, pendingEvidence])
  })
})

describe('evaluation IPC persistence', () => {
  it('routes the atomic recipe-and-batch operation as one main-process call', async () => {
    const input = { projectId: 'project', expectedRevision: 3, recipe: {}, batch: {} }
    await expect(invoke(IPC_CHANNELS.evaluationSaveRecipeAndBatch, input)).resolves.toEqual({ input })
    expect(saveRecipeAndBatch).toHaveBeenCalledOnce()
    expect(saveRecipeAndBatch).toHaveBeenCalledWith(input)
  })
})
