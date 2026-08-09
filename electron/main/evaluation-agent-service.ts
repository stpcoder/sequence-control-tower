import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EvaluationAgentRuntime, proposalToEvaluationMemory, type EvaluationAgentSession, type EvaluationFile, type LogReader } from '../../src/domain/evaluation-agent'
import type { AssessmentOrigin, EvidenceRecord, EvaluationNode, FailureHypothesis } from '../../src/domain/evaluation-memory'
import { parseFilenameMetadata } from '../../src/domain/workbench/filenameMetadata'
import { detectSocFilenameContext } from '../../src/domain/soc-profile'
import type { ArtifactRecord, ProjectSnapshot } from '../shared/contracts'
import type { ArtifactService } from './artifact-service'
import type { OpenAiCompatibleClient } from './llm-service'
import type { ProjectStore } from './project-store'

export interface EvaluationAgentStartInput { projectId: string; sourceIds?: string[]; intent?: string; issueId?: string }
export interface EvaluationAgentSessionStore { load?(id: string): Promise<EvaluationAgentSession | null>; save?(session: EvaluationAgentSession): Promise<void> }
export interface EvaluationAgentServiceDeps {
  artifacts: Pick<ArtifactService, 'list' | 'search' | 'lineWindow'>
  projects: Pick<ProjectStore, 'get'>
  llm: Pick<OpenAiCompatibleClient, 'complete'>
  sessions?: EvaluationAgentSessionStore
  id?: () => string
}

export interface EvaluationMemorySavePayload { hypothesis: FailureHypothesis; node: EvaluationNode; evidence: EvidenceRecord[] }

type Source = { sourceId: string; artifactId: string; fileName: string; artifact?: ArtifactRecord }

function safe(value: unknown, max = 240): string { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '' }
/** Preserve engineering tokens while removing credential-like filename values before any provider-facing metadata exists. */
function safeFilename(value: unknown): string {
  return safe(value, 240)
    .replace(/(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;_]+/gi, '<SECRET>')
}
function safeEvidence(value: string): string {
  return safe(value, 800)
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\\/\s]+[\\/])+[^\\/\s,;)]*/g, '<PATH>')
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '<SECRET>')
}
function numeric(value: string | null): number | undefined { if (!value) return undefined; const found = Number(value.replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0]); return Number.isFinite(found) ? found : undefined }
function filenameDimensions(fileName: string): EvaluationFile['metadata'] {
  const parsed = parseFilenameMetadata(fileName); const name = fileName
  const soc = detectSocFilenameContext(fileName)
  const capture = (expression: RegExp): string | undefined => expression.exec(name)?.[1]
  const numberCapture = (expression: RegExp): number | undefined => numeric(capture(expression) ?? null)
  return {
    material: capture(/(?:^|[_\-.])(?:MAT|MATERIAL)[=:_-]?([A-Z0-9-]+)/i),
    die: capture(/(?:^|[_\-.])DIE[=:_-]?([A-Z0-9-]+)/i),
    temperatureC: numeric(parsed.temperature.value),
    testMode: parsed.mode.value ?? undefined,
    bl: capture(/(?:^|[_\-.])BL[=:_-]?(\d+)/i), dq: capture(/(?:^|[_\-.])DQ[=:_-]?(\d+)/i),
    channel: capture(/(?:^|[_\-.])(?:CH|CHANNEL)[=:_-]?(\d+)/i), bank: capture(/(?:^|[_\-.])BANK[=:_-]?(\d+)/i), bankGroup: capture(/(?:^|[_\-.])(?:BG|BANKGROUP)[=:_-]?(\d+)/i),
    pattern: capture(/(?:^|[_\-.])PATTERN[=:_-]?([A-Z0-9-]+)/i), frequencyMHz: numberCapture(/(?:^|[_\-.])(?:FREQ|FREQUENCY)[=:_-]?(\d+(?:\.\d+)?)/i) ?? numberCapture(/(?:^|[_\-.])(\d{3,5})MT/i),
    vdd: numberCapture(/(?:^|[_\-.])VDD[=:_-]?(\d+(?:\.\d+)?)/i), skewPs: numberCapture(/(?:^|[_\-.])SKEW[=:_-]?(\d+(?:\.\d+)?)/i),
    ...(soc.vendor === 'unknown' ? {} : { socVendor: soc.vendor, socModel: soc.socModel, bootProfileId: soc.bootProfileId })
  }
}

/** Main-process boundary: only selected project sources may reach the runtime. */
export class EvaluationAgentService {
  private readonly sessions = new Map<string, EvaluationAgentSession>()
  private readonly sourceMaps = new Map<string, Source[]>()
  /** Internal provenance binding; never serialized into renderer session views. */
  private readonly projectIds = new Map<string, string>()
  private readonly id: () => string
  constructor(private readonly deps: EvaluationAgentServiceDeps) { this.id = deps.id ?? randomUUID }

  get(sessionId: string): EvaluationAgentSession | null { return this.sessions.get(safe(sessionId)) ?? null }

  async start(input: EvaluationAgentStartInput): Promise<EvaluationAgentSession> {
    const project = await this.project(input.projectId)
    const sources = await this.authorize(project, input.sourceIds)
    const id = this.id(); this.sourceMaps.set(id, sources); this.projectIds.set(id, project.id)
    const session = await this.runtime(sources).start(id)
    // Intent/issue are deliberately transcript labels only; neither can alter tool authority.
    if (safe(input.intent) || safe(input.issueId)) session.transcript.unshift({ at: new Date().toISOString(), role: 'user', type: 'request', detail: `intent=${safe(input.intent)} issue=${safe(input.issueId)}`.trim() })
    return this.remember(session)
  }

  async resume(sessionId: string, input?: { answer?: string; confirm?: 'accept' | 'reject' }): Promise<EvaluationAgentSession> {
    const id = safe(sessionId); let session = this.sessions.get(id) ?? await this.deps.sessions?.load?.(id) ?? null
    if (!session) throw new Error('evaluation agent session not found')
    const sources = this.sourceMaps.get(id)
    if (!sources) throw new Error('evaluation agent source scope is unavailable; start a new session')
    session = await this.runtime(sources).resume(session, input)
    return this.remember(session)
  }

  /** Returns a caller-owned payload; this service intentionally performs no memory/project writes. */
  memorySavePayload(sessionId: string, input: { projectId: string; hypothesisId: string; nodeId: string; evidenceId: (agentEvidenceId: string) => string; origin?: AssessmentOrigin }): EvaluationMemorySavePayload | null {
    const id = safe(sessionId); const session = this.get(id); if (!session) return null
    if (this.projectIds.get(id) !== safe(input.projectId)) throw new Error('evaluation agent project scope mismatch')
    return proposalToEvaluationMemory(session, input)
  }

  private async remember(session: EvaluationAgentSession): Promise<EvaluationAgentSession> { this.sessions.set(session.id, session); await this.deps.sessions?.save?.(session); return session }
  private async project(id: string): Promise<ProjectSnapshot> { const project = await this.deps.projects.get(safe(id)); if (!project) throw new Error('project not found'); return project }
  private async authorize(project: ProjectSnapshot, requested?: string[]): Promise<Source[]> {
    const requestedIds = requested?.map((id) => safe(id)).filter(Boolean)
    if (requestedIds && (new Set(requestedIds).size !== requestedIds.length || requestedIds.length > 32)) throw new Error('invalid source selection')
    const allowed = project.artifacts.filter((source) => !requestedIds || requestedIds.includes(source.sourceId)).slice(0, 32)
    if (requestedIds && allowed.length !== requestedIds.length) throw new Error('source is not authorized for this project')
    if (!allowed.length) throw new Error('no authorized sources')
    const artifacts = new Map((await this.deps.artifacts.list()).map((artifact) => [artifact.id, artifact]))
    return allowed.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, fileName: safeFilename(basename(source.relativePath)), artifact: artifacts.get(source.artifactId) }))
  }
  private runtime(sources: Source[]): EvaluationAgentRuntime {
    const bySource = new Map(sources.map((source) => [source.sourceId, source]))
    const reader: LogReader = {
      listFiles: async () => sources.map((source) => ({ id: source.sourceId, name: source.fileName, size: source.artifact?.size, lineCount: source.artifact?.fingerprint?.lineCount, metadata: filenameDimensions(source.fileName) })),
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
    return new EvaluationAgentRuntime(reader, { complete: (prompt, signal) => this.deps.llm.complete(prompt, signal, () => undefined) })
  }
}
