import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS } from '../shared/contracts'
import { registerIpc, unregisterIpc } from './ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))

const { showOpenDialog } = vi.hoisted(() => ({
  showOpenDialog: vi.fn()
}))

const { agentUpdate } = vi.hoisted(() => ({
  agentUpdate: { current: null as ((run: unknown) => void) | null, unsubscribe: null as ReturnType<typeof vi.fn> | null }
}))

const { owner } = vi.hoisted(() => ({
  owner: { current: { isDestroyed: () => false } as { isDestroyed: () => boolean } | null }
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    isPackaged: false
  },
  BrowserWindow: {
    fromWebContents: () => owner.current
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
const archiveRecipe = vi.fn(async (input: unknown) => ({ input }))
const lineWindow = vi.fn(async () => ({}))
const saveLlm = vi.fn(async () => ({}))
const agentStart = vi.fn(async () => ({ id: 'run-1', status: 'queued' }))
const agentGet = vi.fn(() => ({ id: 'run-1', status: 'running' }))
const agentCancel = vi.fn(async () => ({ id: 'run-1', status: 'cancelled' }))
const agentCancelAll = vi.fn()
const agentOnUpdate = vi.fn((listener: (run: unknown) => void) => {
  agentUpdate.current = listener
  agentUpdate.unsubscribe = vi.fn()
  return agentUpdate.unsubscribe
})
const evaluationAgentStart = vi.fn(async () => ({ id: 'eval-1', status: 'paused', schemaVersion: 1, files: [], evidence: [], transcript: [], context: { dimensions: {} }, depth: 0, calls: 0, searches: 0 }))
const evaluationAgentGet = vi.fn(() => ({ id: 'eval-1', status: 'paused', schemaVersion: 1, files: [], evidence: [], transcript: [], context: { dimensions: {} }, depth: 0, calls: 0, searches: 0 }))
const evaluationAgentResume = vi.fn(async () => ({ id: 'eval-1', status: 'completed', schemaVersion: 1, files: [], evidence: [], transcript: [], context: { dimensions: {} }, depth: 0, calls: 1, searches: 0 }))
const evaluationAgentMemory = vi.fn(() => null)
const services = {
  artifacts: {
    search: search.fn,
    inspectEvidence: evidence.fn,
    importFolders,
    lineWindow
  },
  evaluations: { saveRecipeAndBatch, archiveRecipe },
  llmConfig: { summary: vi.fn(), save: saveLlm, discoverModels: vi.fn() },
  agent: { start: agentStart, get: agentGet, answer: vi.fn(), message: vi.fn(), confirm: vi.fn(), cancel: agentCancel, onUpdate: agentOnUpdate, cancelAll: agentCancelAll },
  evaluationAgent: { start: evaluationAgentStart, get: evaluationAgentGet, resume: evaluationAgentResume, memorySavePayload: evaluationAgentMemory }
} as unknown as Parameters<typeof registerIpc>[0]

function trustedEvent(senderId = 42): unknown {
  const frame = { url: `${process.env.ELECTRON_RENDERER_URL}?screen=settings#llm` }
  const sender = Object.assign(new EventEmitter(), { id: senderId, mainFrame: frame, isDestroyed: () => false, send: vi.fn() })
  return { sender, senderFrame: frame }
}

function eventWithUrl(url: string, senderFrame = true): unknown {
  const frame = { url }
  const sender = Object.assign(new EventEmitter(), { id: 42, mainFrame: frame, isDestroyed: () => false, send: vi.fn() })
  return { sender, senderFrame: senderFrame ? frame : { url } }
}

async function invoke(channel: string, input: unknown = {}, senderId = 42): Promise<unknown> {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`Missing IPC handler: ${channel}`)
  return listener(trustedEvent(senderId), input)
}

async function invokeEvent(channel: string, event: unknown, input: unknown = {}): Promise<unknown> {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`Missing IPC handler: ${channel}`)
  return listener(event, input)
}

beforeEach(() => {
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173/index.html'
  owner.current = { isDestroyed: () => false }
  showOpenDialog.mockReset()
  search.fn.mockClear()
  evidence.fn.mockClear()
  importFolders.mockClear()
  saveRecipeAndBatch.mockClear()
  archiveRecipe.mockClear()
  lineWindow.mockClear()
  saveLlm.mockClear()
  agentStart.mockClear()
  agentGet.mockClear()
  agentCancel.mockClear()
  agentCancelAll.mockClear()
  agentOnUpdate.mockClear()
  evaluationAgentStart.mockClear(); evaluationAgentGet.mockClear(); evaluationAgentResume.mockClear(); evaluationAgentMemory.mockClear()
  agentUpdate.current = null
  agentUpdate.unsubscribe = null
  search.requests.length = 0
  evidence.requests.length = 0
  folderImportRequests.length = 0
  registerIpc(services)
})

afterEach(() => {
  unregisterIpc()
  delete process.env.ELECTRON_RENDERER_URL
})

describe('IPC sender URL policy', () => {
  it.each([
    IPC_CHANNELS.settingsSaveLlm,
    IPC_CHANNELS.artifactLineWindow,
    IPC_CHANNELS.artifactSearch,
  ])('accepts query/hash navigation for %s', async (channel) => {
    if (channel === IPC_CHANNELS.artifactSearch) {
      const request = invokeEvent(channel, eventWithUrl('http://localhost:5173/index.html?screen=settings#llm'))
      await vi.waitFor(() => expect(search.fn).toHaveBeenCalledTimes(1))
      search.requests[0].resolve({ results: [] })
      await expect(request).resolves.toEqual({ results: [] })
      return
    }
    if (channel === IPC_CHANNELS.artifactLineWindow) {
      await expect(invokeEvent(channel, eventWithUrl('http://localhost:5173/index.html?screen=workbench#log'), {}))
        .resolves.toEqual({})
      return
    }
    await expect(invokeEvent(channel, eventWithUrl('http://localhost:5173/index.html?screen=settings#llm'), {}))
      .resolves.toEqual({})
  })

  it.each([
    'file:///unrelated.html',
    'http://localhost:5173/other.html',
    'http://127.0.0.1:5173/index.html',
  ])('rejects unrelated sender URL %s', async (url) => {
    await expect(invokeEvent(IPC_CHANNELS.settingsSaveLlm, eventWithUrl(url))).rejects.toThrow('IPC 요청이 차단되었습니다.')
  })

  it('rejects subframes and destroyed senders', async () => {
    await expect(invokeEvent(
      IPC_CHANNELS.settingsSaveLlm,
      eventWithUrl('http://localhost:5173/index.html?screen=settings', false),
    )).rejects.toThrow('IPC 요청이 차단되었습니다.')

    const frame = { url: 'http://localhost:5173/index.html' }
    await expect(invokeEvent(IPC_CHANNELS.settingsSaveLlm, {
      sender: { id: 42, mainFrame: frame, isDestroyed: () => true },
      senderFrame: frame,
    })).rejects.toThrow('IPC 요청이 차단되었습니다.')

    owner.current = null
    await expect(invokeEvent(
      IPC_CHANNELS.settingsSaveLlm,
      eventWithUrl('http://localhost:5173/index.html?screen=settings'),
    )).rejects.toThrow('IPC 요청이 차단되었습니다.')
  })
})

describe('agent IPC ownership', () => {
  it('delivers updates only to the originating sender and preserves the start snapshot', async () => {
    const first = trustedEvent(11) as { sender: EventEmitter & { send: ReturnType<typeof vi.fn> } }
    const second = trustedEvent(22)
    const started = await invokeEvent(IPC_CHANNELS.agentStart, first, { projectId: 'p1' })

    expect(first.sender.send).toHaveBeenCalledWith(IPC_CHANNELS.agentUpdate, started)
    agentUpdate.current?.({ id: 'run-1', status: 'running' })
    expect(first.sender.send).toHaveBeenCalledWith(IPC_CHANNELS.agentUpdate, { id: 'run-1', status: 'running' })

    await expect(invokeEvent(IPC_CHANNELS.agentGet, second, 'run-1')).rejects.toThrow('agent run을 찾을 수 없습니다.')
    expect(agentGet).not.toHaveBeenCalled()
  })

  it('cancels active runs and drops ownership when the sender is destroyed', async () => {
    const event = trustedEvent(11) as { sender: EventEmitter & { send: ReturnType<typeof vi.fn> } }
    await invokeEvent(IPC_CHANNELS.agentStart, event, { projectId: 'p1' })

    event.sender.emit('destroyed')

    expect(agentCancel).toHaveBeenCalledWith({ runId: 'run-1' })
    await expect(invokeEvent(IPC_CHANNELS.agentGet, trustedEvent(11), 'run-1')).rejects.toThrow('agent run을 찾을 수 없습니다.')
  })

  it('unsubscribes updates and cancels all agent runs during IPC teardown', () => {
    unregisterIpc()

    expect(agentCancelAll).toHaveBeenCalledOnce()
    expect(agentUpdate.unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('evaluation-agent IPC ownership and projection', () => {
  it('rejects cross-renderer session access and routes only the safe API', async () => {
    const first = trustedEvent(11)
    await invokeEvent(IPC_CHANNELS.evaluationAgentStart, first, { projectId: 'p1', sourceIds: ['s1'] })
    await expect(invokeEvent(IPC_CHANNELS.evaluationAgentGet, trustedEvent(22), 'eval-1')).rejects.toThrow('evaluation agent session not found')
    await expect(invokeEvent(IPC_CHANNELS.evaluationAgentResume, first, { sessionId: 'eval-1', confirm: 'accept' })).resolves.toMatchObject({ id: 'eval-1', status: 'completed' })
    expect(evaluationAgentResume).toHaveBeenCalledWith('eval-1', { answer: undefined, confirm: 'accept' })
  })

  it('strips raw excerpts and transcript detail from renderer responses', async () => {
    evaluationAgentStart.mockResolvedValueOnce({ id: 'eval-safe', status: 'paused', schemaVersion: 1, depth: 0, calls: 0, searches: 0, files: [{ id: 's1', name: 'safe.log', metadata: {} }], evidence: [{ id: 'e1', kind: 'window', fileId: 's1', detail: 'lines 1-2', excerpt: '/Users/private/token=secret' }, { id: 'e2', kind: 'search', fileId: 's1', detail: 'query=@FAIL matches=2', excerpt: 'L123: @FAIL\nL991: @FAIL' }], transcript: [{ at: 'now', role: 'provider', type: 'planner-action', detail: '/Users/private/token=secret' }], context: { dimensions: {}, aggregate: '/Users/private/token=secret' } } as never)
    const view = await invokeEvent(IPC_CHANNELS.evaluationAgentStart, trustedEvent(33), { projectId: 'p1' }) as Record<string, unknown>
    expect(JSON.stringify(view)).not.toContain('/Users/private'); expect(JSON.stringify(view)).not.toContain('token=secret')
    expect((view.transcript as Array<Record<string, unknown>>)[0].detail).toBeUndefined()
    expect((view.evidence as Array<{ id: string; lineNumbers: number[] }>).find((item) => item.id === 'e2')?.lineNumbers).toEqual([123, 991])
  })

  it('projects durable source IDs and a sanitized bounded evidence summary', async () => {
    await invokeEvent(IPC_CHANNELS.evaluationAgentStart, trustedEvent(44), { projectId: 'p1' })
    evaluationAgentMemory.mockReturnValueOnce({ hypothesis: { id: 'h', projectId: 'p1', title: 'x', origin: 'ai-proposed' }, node: { id: 'n', projectId: 'p1', name: 'x', dimensions: {} }, evidence: [{ id: 'e', projectId: 'p1', evaluationNodeId: 'n', status: 'fail', logRef: 'source-a', note: '/Users/private/token=secret useful line', origin: 'ai-proposed' }] } as never)
    const payload = await invokeEvent(IPC_CHANNELS.evaluationAgentMemorySavePayload, trustedEvent(44), { sessionId: 'eval-1', projectId: 'p1', hypothesisId: 'h', nodeId: 'n', evidenceIdPrefix: 'e' }) as { evidence: Array<{ sourceIds: string[]; summary?: string }> }
    expect(payload.evidence[0].sourceIds).toEqual(['source-a'])
    expect(payload.evidence[0].summary).toContain('<PATH>')
    expect(payload.evidence[0].summary).not.toContain('secret')
  })
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

  it('routes archiveRecipe through its dedicated allow-listed channel', async () => {
    const input = { projectId: 'project', expectedRevision: 4, recipeId: 'recipe' }
    await expect(invoke(IPC_CHANNELS.evaluationArchiveRecipe, input)).resolves.toEqual({ input })
    expect(archiveRecipe).toHaveBeenCalledOnce()
    expect(archiveRecipe).toHaveBeenCalledWith(input)
    expect(handlers.has('evaluation:archive-recipe-unknown')).toBe(false)
  })
})
