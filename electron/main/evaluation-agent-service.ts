import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EVALUATION_OUTCOMES, EvaluationAgentRuntime, proposalToEvaluationMemory, type EvaluationAgentSession, type EvaluationAgentSkillPolicy, type EvaluationFile, type EvaluationOutcome, type LogReader } from '../../src/domain/evaluation-agent'
import type { AssessmentOrigin, EvidenceRecord, EvaluationNode, FailureHypothesis } from '../../src/domain/evaluation-memory'
import { extractLpddrFilenameDimensions } from '../../src/domain/lpddr-filename-dimensions'
import type { ArtifactRecord, ProjectSnapshot } from '../shared/contracts'
import type { ArtifactService } from './artifact-service'
import type { OpenAiCompatibleClient } from './llm-service'
import type { NativeAgentStore } from './native-agent-store'
import type { ProjectStore } from './project-store'
import { classifyLpddrStatus, LPDDR_STATUS_SPECS } from './lpddr-agent-tools'

export interface EvaluationAgentStartInput { projectId: string; sourceIds?: string[]; intent?: string; issueId?: string }
export interface EvaluationAgentStoredSession { projectId: string; evaluationScopeId?: string; sourceIds: string[]; session: EvaluationAgentSession; updatedAt: string }
export interface EvaluationAgentPersistence {
  load?(id: string): Promise<EvaluationAgentStoredSession | null>
  latest?(projectId: string, evaluationScopeId?: string): Promise<EvaluationAgentStoredSession | null>
  save?(record: EvaluationAgentStoredSession): Promise<void>
}
export interface EvaluationAgentServiceDeps {
  artifacts: Pick<ArtifactService, 'list' | 'search' | 'lineWindow'> & Partial<Pick<ArtifactService, 'inspectStages' | 'inspectEvidence'>>
  projects: Pick<ProjectStore, 'get'>
  llm: Pick<OpenAiCompatibleClient, 'complete'>
  engineerMemory?: Pick<NativeAgentStore, 'workflowMemories'>
  sessions?: EvaluationAgentPersistence
  /** The packaged lpddr-failure-analysis Skill contract shared with OpenCode. */
  skillPolicy?: EvaluationAgentSkillPolicy
  id?: () => string
}

export interface EvaluationMemorySavePayload { hypothesis: FailureHypothesis; node: EvaluationNode; evidence: EvidenceRecord[] }

type Source = {
  sourceId: string
  artifactId: string
  /** Stable project folder identity used by chat, history and session restore. */
  rootId: string
  /** Physical artifact location used only for local file access. */
  artifactRootId: string
  relativePath: string
  fileName: string
  artifact?: ArtifactRecord
}

function safe(value: unknown, max = 240): string { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '' }
/** Preserve engineering tokens while removing credential-like filename values before any provider-facing metadata exists. */
function safeFilename(value: unknown): string {
  return safe(value, 240)
    .replace(/(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;_]+/gi, '<SECRET>')
}
function safeEvidence(value: string, max = 800): string {
  return safe(value, max)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\\/\s]+[\\/])+[^\\/\s,;)]*/g, '<PATH>')
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '<SECRET>')
}
function filenameDimensions(fileName: string): EvaluationFile['metadata'] {
  return extractLpddrFilenameDimensions(fileName)
}

/** Main-process boundary: only selected project sources may reach the runtime. */
export class EvaluationAgentService {
  private readonly sessions = new Map<string, EvaluationAgentSession>()
  private readonly sourceMaps = new Map<string, Source[]>()
  private readonly runners = new Map<string, Promise<void>>()
  /** Internal provenance binding; never serialized into renderer session views. */
  private readonly projectIds = new Map<string, string>()
  private readonly evaluationScopeIds = new Map<string, string | undefined>()
  private readonly id: () => string
  constructor(private readonly deps: EvaluationAgentServiceDeps) { this.id = deps.id ?? randomUUID }

  get(sessionId: string): EvaluationAgentSession | null { return this.sessions.get(safe(sessionId)) ?? null }

  async start(input: EvaluationAgentStartInput): Promise<EvaluationAgentSession> {
    const project = await this.project(input.projectId)
    const sources = await this.authorize(project, input.sourceIds)
    const id = this.id(); this.sourceMaps.set(id, sources); this.projectIds.set(id, project.id)
    const roots = [...new Set(sources.map((source) => source.rootId))]
    const evaluationScopeId = roots.length === 1 ? roots[0] : undefined
    this.evaluationScopeIds.set(id, evaluationScopeId)
    const runtime = this.runtime(sources)
    const requestedIntent = safe(input.intent, 400)
    const evaluationIntent = /^(?:failure[- ]?trend|analysis)$/i.test(requestedIntent) ? '' : requestedIntent
    const session = await runtime.prepare(id, {
      ...(evaluationIntent ? { evaluationIntent } : {}),
      priorContext: await this.priorContext(project, evaluationScopeId),
    })
    // Intent/issue are deliberately transcript labels only; neither can alter tool authority.
    if (safe(input.intent) || safe(input.issueId)) session.transcript.unshift({ at: new Date().toISOString(), role: 'user', type: 'request', detail: `intent=${safe(input.intent)} issue=${safe(input.issueId)}`.trim() })
    await this.remember(session)
    if (session.status === 'running') this.schedule(id, runtime)
    return session
  }

  /** Restores only a still-authorized project/folder session after renderer or app restart. */
  async restoreLatest(projectId: string, evaluationScopeId?: string): Promise<EvaluationAgentSession | null> {
    const record = await this.deps.sessions?.latest?.(safe(projectId), safe(evaluationScopeId) || undefined) ?? null
    if (!record) return null
    return this.hydrate(record, safe(evaluationScopeId) || undefined)
  }

  async resume(sessionId: string, input?: { answer?: string; confirm?: 'accept' | 'reject' }): Promise<EvaluationAgentSession> {
    const id = safe(sessionId)
    let session = this.sessions.get(id) ?? null
    if (!session) {
      const record = await this.deps.sessions?.load?.(id) ?? null
      session = record ? await this.hydrate(record) : null
    }
    if (!session) throw new Error('evaluation agent session not found')
    const sources = this.sourceMaps.get(id)
    if (!sources) throw new Error('evaluation agent source scope is unavailable; start a new session')
    if (session.status === 'running' && this.runners.has(id)) return session
    const runtime = this.runtime(sources)
    session = runtime.transition(session, input)
    await this.remember(session)
    if (session.status === 'running') this.schedule(id, runtime)
    return session
  }

  /** Returns a caller-owned payload; this service intentionally performs no memory/project writes. */
  memorySavePayload(sessionId: string, input: { projectId: string; hypothesisId: string; nodeId: string; evidenceId: (agentEvidenceId: string) => string; origin?: AssessmentOrigin }): EvaluationMemorySavePayload | null {
    const id = safe(sessionId); const session = this.get(id); if (!session) return null
    if (this.projectIds.get(id) !== safe(input.projectId)) throw new Error('evaluation agent project scope mismatch')
    return proposalToEvaluationMemory(session, input)
  }

  private async remember(session: EvaluationAgentSession): Promise<EvaluationAgentSession> {
    this.sessions.set(session.id, session)
    const projectId = this.projectIds.get(session.id)
    const sources = this.sourceMaps.get(session.id)
    if (projectId && sources) {
      await this.deps.sessions?.save?.({ projectId, evaluationScopeId: this.evaluationScopeIds.get(session.id), sourceIds: sources.map((source) => source.sourceId), session, updatedAt: new Date().toISOString() })
    }
    return session
  }
  private async hydrate(record: EvaluationAgentStoredSession, requiredScopeId?: string): Promise<EvaluationAgentSession> {
    const project = await this.project(record.projectId)
    const sources = await this.authorize(project, record.sourceIds)
    const scopeIds = [...new Set(sources.map((source) => source.rootId))]
    const scopeId = record.evaluationScopeId ?? (scopeIds.length === 1 ? scopeIds[0] : undefined)
    if (requiredScopeId && scopeId !== requiredScopeId) throw new Error('evaluation agent source scope mismatch')
    if (scopeId && sources.some((source) => source.rootId !== scopeId)) throw new Error('evaluation agent source scope mismatch')
    this.sessions.set(record.session.id, record.session)
    this.sourceMaps.set(record.session.id, sources)
    this.projectIds.set(record.session.id, project.id)
    this.evaluationScopeIds.set(record.session.id, scopeId)
    return record.session
  }
  private schedule(id: string, runtime: EvaluationAgentRuntime): void {
    const previous = this.runners.get(id)
    if (previous) {
      void previous.finally(() => {
        if (this.sessions.get(id)?.status === 'running') this.schedule(id, runtime)
      })
      return
    }
    const task = runtime.run(this.sessions.get(id)!).then(async (session) => { await this.remember(session) }).catch(async (error) => {
      const session = this.sessions.get(id)
      if (!session) return
      session.status = 'paused'
      session.failure = `agent failed: ${safe(error instanceof Error ? error.message : String(error), 300)}`
      await this.remember(session)
    }).finally(() => { this.runners.delete(id) })
    this.runners.set(id, task)
  }
  private async project(id: string): Promise<ProjectSnapshot> { const project = await this.deps.projects.get(safe(id)); if (!project) throw new Error('project not found'); return project }
  private async priorContext(project: ProjectSnapshot, evaluationScopeId?: string): Promise<string> {
    const workflows = await this.deps.engineerMemory?.workflowMemories(project.id, 12).catch(() => []) ?? []
    const nodeById = new Map((project.evaluationNodes ?? []).map((node) => [node.id, node]))
    const hypothesisById = new Map((project.failureHypotheses ?? []).map((hypothesis) => [hypothesis.id, hypothesis]))
    const nodes = [...(project.evaluationNodes ?? [])]
      .sort((left, right) => Number(left.evaluationScopeId === evaluationScopeId) - Number(right.evaluationScopeId === evaluationScopeId))
      .slice(-8)
      .map((node) => ({
        name: safeEvidence(node.name, 160), purpose: node.purpose, status: node.status,
        issue: safeEvidence(hypothesisById.get(node.hypothesisId ?? '')?.title ?? '', 160),
        relation: node.relation,
        previousEvaluation: safeEvidence(node.parentId ? nodeById.get(node.parentId)?.name ?? '' : '', 160),
        sameFolder: Boolean(evaluationScopeId && node.evaluationScopeId === evaluationScopeId),
        interpretation: safeEvidence(node.interpretation ?? '', 300), dimensions: node.dimensions,
      }))
    const procedures = workflows.slice(0, 8).map((workflow) => ({
      purpose: safeEvidence(workflow.purpose, 160), result: workflow.result, stages: workflow.stages,
      sameFolder: Boolean(evaluationScopeId && workflow.evaluationScopeId === evaluationScopeId),
      dimensions: workflow.dimensions,
      checks: workflow.checks.slice(0, 8).map((check) => ({
        query: safeEvidence(check.query, 120), expected: check.expected, stage: check.stage, order: check.order,
      })),
    }))
    return safeEvidence(JSON.stringify({
      projectTarget: safeEvidence(project.onboardingAnswers?.evaluationTarget ?? project.description ?? '', 300),
      priorEvaluations: nodes,
      confirmedSearchProcedures: procedures,
    }), 2_400)
  }
  private async authorize(project: ProjectSnapshot, requested?: string[]): Promise<Source[]> {
    const requestedIds = requested?.map((id) => safe(id)).filter(Boolean)
    if (requestedIds && (new Set(requestedIds).size !== requestedIds.length || requestedIds.length > 32)) throw new Error('invalid source selection')
    const allowed = project.artifacts.filter((source) => !requestedIds || requestedIds.includes(source.sourceId)).slice(0, 32)
    if (requestedIds && allowed.length !== requestedIds.length) throw new Error('source is not authorized for this project')
    if (!allowed.length) throw new Error('no authorized sources')
    const artifacts = new Map((await this.deps.artifacts.list()).map((artifact) => [artifact.id, artifact]))
    return allowed.map((source) => ({
      sourceId: source.sourceId,
      artifactId: source.artifactId,
      rootId: source.rootId,
      artifactRootId: source.artifactRootId ?? source.rootId,
      relativePath: source.relativePath,
      fileName: safeFilename(basename(source.relativePath)),
      artifact: artifacts.get(source.artifactId),
    }))
  }
  private runtime(sources: Source[]): EvaluationAgentRuntime {
    const bySource = new Map(sources.map((source) => [source.sourceId, source]))
    const reader: LogReader = {
      listFiles: async () => {
        const sourceInput = sources.map((source) => ({
          sourceId: source.sourceId,
          artifactId: source.artifactId,
          rootId: source.artifactRootId,
          relativePath: source.relativePath,
        }))
        const [inspected, statusInspected] = await Promise.all([
          this.deps.artifacts.inspectStages
          ? this.deps.artifacts.inspectStages({
              sources: sourceInput,
            }).catch(() => null)
          : null,
          this.deps.artifacts.inspectEvidence
            ? this.deps.artifacts.inspectEvidence({ sources: sourceInput, specs: LPDDR_STATUS_SPECS }).catch(() => null)
            : null,
        ])
        const stagesBySource = new Map(inspected?.sources.map((item) => [item.sourceId, item.stages]) ?? [])
        const outcomesBySource = new Map(statusInspected?.sources.flatMap((item) => {
          if (item.error) return []
          const counts = Object.fromEntries(LPDDR_STATUS_SPECS.map((spec) => [spec.id, item.evidence.find((entry) => entry.specId === spec.id)?.occurrenceCount ?? 0]))
          const classified = classifyLpddrStatus(counts)
          return EVALUATION_OUTCOMES.includes(classified.status as EvaluationOutcome)
            ? [[item.sourceId, { outcome: classified.status as EvaluationOutcome, reason: classified.reason }] as const]
            : []
        }) ?? [])
        return sources.map((source) => ({
          id: source.sourceId,
          name: source.fileName,
          size: source.artifact?.size,
          lineCount: source.artifact?.fingerprint?.lineCount,
          metadata: filenameDimensions(source.fileName),
          stages: stagesBySource.get(source.sourceId),
          ...(outcomesBySource.get(source.sourceId) ? {
            deterministicOutcome: outcomesBySource.get(source.sourceId)!.outcome,
            deterministicReason: outcomesBySource.get(source.sourceId)!.reason,
          } : {}),
        }))
      },
      search: async (sourceId, query, options) => {
        const source = bySource.get(sourceId); if (!source) throw new Error('unauthorized source')
        const result = await this.deps.artifacts.search({ artifactIds: [source.artifactId], query, mode: 'literal', caseSensitive: false, maxMatches: Math.min(options.maxMatches, 6), contextLines: 0 })
        return result.matches.slice(0, 6).map((match) => ({ line: match.lineNumber, text: safeEvidence(match.lineText) }))
      },
      lineWindow: async (sourceId, startLine, lineCount) => {
        const source = bySource.get(sourceId); if (!source) throw new Error('unauthorized source')
        const result = await this.deps.artifacts.lineWindow({ artifactId: source.artifactId, startLine, lineCount: Math.min(lineCount, 24) })
        return result.lines.slice(0, 24).map((line) => safeEvidence(line.text))
      }
    }
    return new EvaluationAgentRuntime(
      reader,
      { complete: (prompt, signal) => this.deps.llm.complete(prompt, signal, () => undefined) },
      undefined,
      this.deps.skillPolicy,
    )
  }
}
