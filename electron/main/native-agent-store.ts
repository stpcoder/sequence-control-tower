import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  NativeAgentBackend, NativeAgentMessageView, NativeAgentSearchEventInput,
  NativeAgentSessionStatus, NativeAgentSessionSummary, NativeAgentSessionView,
  NativeAgentToolTraceView
} from '../shared/contracts'
import { AtomicJsonStore } from './json-store'

export interface StoredNativeAgentSession extends NativeAgentSessionView {
  externalSessionId?: string
  lastRequest?: { content: string; sourceIds: string[] }
}

interface SearchEvent extends NativeAgentSearchEventInput { id: string; occurredAt: string }
interface NativeAgentDatabase {
  schemaVersion: 1
  sessions: Record<string, StoredNativeAgentSession>
  searches: Record<string, SearchEvent[]>
}

const MAX_SESSIONS_PER_PROJECT = 100
const MAX_MESSAGES = 500
const MAX_TOOLS = 300
const MAX_SEARCHES = 500
const clean = (value: unknown, max: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''
const now = (): string => new Date().toISOString()

export class NativeAgentStore {
  private readonly store: AtomicJsonStore<NativeAgentDatabase>

  constructor(dataRoot: string, private readonly id: () => string = randomUUID) {
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'native-agent.json'), {
      schemaVersion: 1,
      sessions: {},
      searches: {}
    })
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    await this.store.update((database) => {
      if (database.schemaVersion !== 1 || !database.sessions || !database.searches) {
        return { schemaVersion: 1, sessions: {}, searches: {} }
      }
      for (const session of Object.values(database.sessions)) {
        if (session.status === 'queued' || session.status === 'running') {
          session.status = 'paused'
          session.failure = '앱이 종료되어 대기 중이던 분석을 멈췄습니다. 재시도할 수 있습니다.'
          session.updatedAt = now()
        }
      }
    })
  }

  async create(projectId: string, title: string, backend: NativeAgentBackend): Promise<StoredNativeAgentSession> {
    const stamp = now()
    const session: StoredNativeAgentSession = {
      id: this.id(), projectId: clean(projectId, 160), title: clean(title, 160) || '새 분석', backend,
      status: 'idle', createdAt: stamp, updatedAt: stamp, messages: [], tools: []
    }
    if (!session.projectId) throw new Error('프로젝트를 선택해 주세요.')
    await this.store.update((database) => {
      database.sessions[session.id] = session
      const all = Object.values(database.sessions)
        .filter((item) => item.projectId === session.projectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      all.slice(MAX_SESSIONS_PER_PROJECT).forEach((item) => { delete database.sessions[item.id] })
    })
    return structuredClone(session)
  }

  async list(projectId: string): Promise<NativeAgentSessionSummary[]> {
    const wanted = clean(projectId, 160)
    const database = await this.store.read()
    return Object.values(database.sessions)
      .filter((session) => session.projectId === wanted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ messages, tools, externalSessionId, lastRequest, ...summary }) => summary)
  }

  async get(sessionId: string): Promise<StoredNativeAgentSession | null> {
    const value = (await this.store.read()).sessions[clean(sessionId, 160)]
    return value ? structuredClone(value) : null
  }

  async update(
    sessionId: string,
    change: (session: StoredNativeAgentSession) => void
  ): Promise<StoredNativeAgentSession> {
    let result: StoredNativeAgentSession | undefined
    await this.store.update((database) => {
      const session = database.sessions[clean(sessionId, 160)]
      if (!session) throw new Error('에이전트 대화를 찾을 수 없습니다.')
      change(session)
      session.title = clean(session.title, 160) || '새 분석'
      session.failure = session.failure ? clean(session.failure, 500) : undefined
      session.messages = session.messages.slice(-MAX_MESSAGES).map(this.message)
      session.tools = session.tools.slice(-MAX_TOOLS).map(this.tool)
      session.updatedAt = now()
      session.lastMessage = [...session.messages].reverse().find((item) => item.role !== 'tool')?.content.slice(0, 160)
      result = structuredClone(session)
    })
    return result!
  }

  async appendMessage(sessionId: string, message: Omit<NativeAgentMessageView, 'id' | 'createdAt'>): Promise<StoredNativeAgentSession> {
    return this.update(sessionId, (session) => {
      session.messages.push(this.message({ ...message, id: this.id(), createdAt: now() }))
    })
  }

  async setStatus(sessionId: string, status: NativeAgentSessionStatus, failure?: string): Promise<StoredNativeAgentSession> {
    return this.update(sessionId, (session) => {
      session.status = status
      session.failure = failure ? clean(failure, 500) : undefined
    })
  }

  async recordSearch(input: NativeAgentSearchEventInput): Promise<void> {
    const projectId = clean(input.projectId, 160)
    const query = clean(input.query, 500)
    if (!projectId || !query || !Array.isArray(input.sourceIds)) return
    const sourceIds = [...new Set(input.sourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100)
    const event: SearchEvent = {
      id: this.id(), projectId, sourceIds, query,
      mode: input.mode === 'regex' ? 'regex' : 'literal', caseSensitive: input.caseSensitive === true,
      scope: input.scope === 'open' || input.scope === 'project' ? input.scope : 'current',
      matchCount: Number.isSafeInteger(input.matchCount) && input.matchCount >= 0 ? input.matchCount : 0,
      occurredAt: now()
    }
    await this.store.update((database) => {
      const previous = database.searches[projectId] ?? []
      const last = previous[previous.length - 1]
      if (last && last.query === event.query && last.mode === event.mode && last.caseSensitive === event.caseSensitive
        && last.scope === event.scope && last.matchCount === event.matchCount
        && Date.parse(event.occurredAt) - Date.parse(last.occurredAt) < 10_000) return
      database.searches[projectId] = [...previous, event].slice(-MAX_SEARCHES)
    })
  }

  async searchHistory(projectId: string, limit = 30): Promise<SearchEvent[]> {
    const rows = (await this.store.read()).searches[clean(projectId, 160)] ?? []
    return rows.slice(-Math.min(Math.max(limit, 1), 100)).reverse()
  }

  public(session: StoredNativeAgentSession): NativeAgentSessionView {
    const { externalSessionId, lastRequest, ...view } = structuredClone(session)
    return view
  }

  private message = (message: NativeAgentMessageView): NativeAgentMessageView => ({
    id: clean(message.id, 160), role: message.role, content: clean(message.content, 12_000),
    createdAt: clean(message.createdAt, 80),
    ...(message.toolTraceId ? { toolTraceId: clean(message.toolTraceId, 160) } : {}),
    ...(message.evidenceSourceIds?.length ? { evidenceSourceIds: [...new Set(message.evidenceSourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100) } : {})
  })

  private tool = (tool: NativeAgentToolTraceView): NativeAgentToolTraceView => ({
    id: clean(tool.id, 160), name: clean(tool.name, 100), label: clean(tool.label, 160), state: tool.state,
    startedAt: clean(tool.startedAt, 80), ...(tool.completedAt ? { completedAt: clean(tool.completedAt, 80) } : {}),
    ...(tool.summary ? { summary: clean(tool.summary, 1_000) } : {}),
    ...(tool.evidenceSourceIds?.length ? { evidenceSourceIds: [...new Set(tool.evidenceSourceIds.map((item) => clean(item, 160)).filter(Boolean))].slice(0, 100) } : {})
  })
}
