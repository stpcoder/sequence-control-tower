import { join } from 'node:path'
import type { EvaluationAgentSession } from '../../src/domain/evaluation-agent'
import { AtomicJsonStore } from './json-store'
import type { EvaluationAgentStoredSession } from './evaluation-agent-service'

interface EvaluationAgentSessionDatabase {
  schemaVersion: 1
  sessions: Record<string, EvaluationAgentStoredSession>
}

const MAX_SESSIONS_PER_PROJECT = 50
const clean = (value: unknown, max = 160): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''

function validSession(value: unknown): value is EvaluationAgentSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<EvaluationAgentSession>
  return session.schemaVersion === 1 && Boolean(clean(session.id)) && Array.isArray(session.files) && Array.isArray(session.evidence) && Array.isArray(session.transcript)
}

function normalizeRecord(value: EvaluationAgentStoredSession): EvaluationAgentStoredSession | null {
  const projectId = clean(value.projectId)
  const evaluationScopeId = clean(value.evaluationScopeId)
  const sourceIds = [...new Set((value.sourceIds ?? []).map((item) => clean(item, 300)).filter(Boolean))].slice(0, 32)
  if (!projectId || !sourceIds.length || !validSession(value.session)) return null
  return {
    projectId,
    ...(evaluationScopeId ? { evaluationScopeId } : {}),
    sourceIds,
    session: structuredClone(value.session),
    updatedAt: Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString(),
  }
}

/** Durable, bounded store for resumable evidence-bound Evaluation Agent proposals. */
export class EvaluationAgentSessionStore {
  private readonly store: AtomicJsonStore<EvaluationAgentSessionDatabase>

  constructor(dataRoot: string) {
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'evaluation-agent.json'), { schemaVersion: 1, sessions: {} })
  }

  async initialize(): Promise<void> {
    await this.store.initialize()
    await this.store.update((database) => {
      if (database.schemaVersion !== 1 || !database.sessions || typeof database.sessions !== 'object') return { schemaVersion: 1, sessions: {} }
      database.sessions = Object.fromEntries(Object.entries(database.sessions).flatMap(([id, record]) => {
        const normalized = normalizeRecord(record)
        if (!normalized || normalized.session.id !== id) return []
        if (normalized.session.status === 'running') {
          normalized.session.status = 'paused'
          normalized.session.failure = '앱이 종료되어 분석을 멈췄습니다. 이어서 다시 시도할 수 있습니다.'
          normalized.updatedAt = new Date().toISOString()
        }
        return [[id, normalized]]
      }))
    })
  }

  async save(record: EvaluationAgentStoredSession): Promise<void> {
    const normalized = normalizeRecord(record)
    if (!normalized) throw new Error('invalid evaluation agent session')
    await this.store.update((database) => {
      database.sessions[normalized.session.id] = normalized
      const projectRecords = Object.values(database.sessions)
        .filter((item) => item.projectId === normalized.projectId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      projectRecords.slice(MAX_SESSIONS_PER_PROJECT).forEach((item) => { delete database.sessions[item.session.id] })
    })
  }

  async load(id: string): Promise<EvaluationAgentStoredSession | null> {
    const record = (await this.store.read()).sessions[clean(id)]
    return record ? structuredClone(record) : null
  }

  async latest(projectId: string, evaluationScopeId?: string): Promise<EvaluationAgentStoredSession | null> {
    const wantedProject = clean(projectId)
    const wantedScope = clean(evaluationScopeId)
    const record = Object.values((await this.store.read()).sessions)
      .filter((item) => item.projectId === wantedProject && (wantedScope ? item.evaluationScopeId === wantedScope : !item.evaluationScopeId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    return record ? structuredClone(record) : null
  }
}
