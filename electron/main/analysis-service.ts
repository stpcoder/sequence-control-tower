import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AnalysisInference,
  AnalysisJobSnapshot,
  AnalysisResult,
  ClarifyingQuestion,
  MetadataSuggestion,
  MetadataSuggestionField,
  SemanticChange,
  SequenceFact,
  StartAnalysisInput
} from '../shared/contracts'
import { ArtifactService } from './artifact-service'
import { AtomicJsonStore } from './json-store'
import { buildMinimalLlmEvidence, buildMinimalLlmPrompt } from './llm-evidence'
import { LlmConfigService, OpenAiCompatibleClient } from './llm-service'
import { PARSER_VERSION, parseSequence, semanticChanges } from './sequence-parser'
import { parseFilenameMetadata } from '../../src/domain/workbench/filenameMetadata'

const ANALYSIS_PROMPT_VERSION = 'intent-review-3-metadata-suggestions'

interface AnalysisCache {
  schemaVersion: 1
  entries: Record<string, AnalysisResult>
}

interface InternalJob {
  snapshot: AnalysisJobSnapshot
  input: StartAnalysisInput
  controller: AbortController
}

interface LlmAnalysisShape {
  summary?: unknown
  inferences?: unknown
  questions?: unknown
  suggestedTags?: unknown
  metadataSuggestions?: unknown
}

const METADATA_FIELDS: readonly MetadataSuggestionField[] = ['sample', 'temperature', 'mode', 'grid']

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function confidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.5
}

function safeInput(input: StartAnalysisInput): StartAnalysisInput {
  const artifactId = boundedString(input?.artifactId, 64)
  const parentArtifactId = boundedString(input?.parentArtifactId, 64) || undefined
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error('잘못된 아티팩트 ID입니다.')
  if (parentArtifactId && !/^[a-f0-9]{64}$/.test(parentArtifactId)) {
    throw new Error('잘못된 부모 아티팩트 ID입니다.')
  }
  return {
    artifactId,
    parentArtifactId,
    userComment: boundedString(input?.userComment, 2_000) || undefined,
    projectContext: boundedString(input?.projectContext, 4_000) || undefined
  }
}

function extractJsonObject(content: string): LlmAnalysisShape {
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('LLM_ANALYSIS_FORMAT')
  return JSON.parse(stripped.slice(start, end + 1)) as LlmAnalysisShape
}

function validateInferences(value: unknown): AnalysisInference[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 6).flatMap((item): AnalysisInference[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const title = boundedString(record.title, 120)
    const detail = boundedString(record.detail, 800)
    if (!title || !detail) return []
    const evidenceFactKeys = Array.isArray(record.evidenceFactKeys)
      ? record.evidenceFactKeys.map((key) => boundedString(key, 80)).filter(Boolean).slice(0, 8)
      : []
    return [
      {
        title,
        detail,
        confidence: confidence(record.confidence),
        evidenceFactKeys,
        state: 'inferred'
      }
    ]
  })
}

function validateQuestions(value: unknown): ClarifyingQuestion[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 2).flatMap((item, index): ClarifyingQuestion[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const question = boundedString(record.question, 300)
    const why = boundedString(record.why, 300)
    if (!question || !why) return []
    const choices = Array.isArray(record.choices)
      ? record.choices.map((choice) => boundedString(choice, 120)).filter(Boolean).slice(0, 5)
      : undefined
    return [{ id: `llm-${index + 1}`, question, why, choices: choices?.length ? choices : undefined }]
  })
}

function validateTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .map((item) => boundedString(item, 60).toLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean)
    )
  ].slice(0, 12)
}

/** Accept suggestions only for unresolved deterministic filename metadata. */
export function validateMetadataSuggestions(value: unknown, unresolved: ReadonlySet<MetadataSuggestionField>): MetadataSuggestion[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 8).flatMap((item): MetadataSuggestion[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const field = boundedString(record.field, 30) as MetadataSuggestionField
    const suggestion = boundedString(record.value, 180)
    const reason = boundedString(record.reason, 400)
    if (!METADATA_FIELDS.includes(field) || !unresolved.has(field) || !suggestion || !reason) return []
    return [{ field, value: suggestion, confidence: confidence(record.confidence), reason }]
  })
}

function compatibleCachedResult(result: AnalysisResult): AnalysisResult {
  return { ...result, metadataSuggestions: Array.isArray(result.metadataSuggestions) ? result.metadataSuggestions : [] }
}

function deterministicSummary(name: string, facts: SequenceFact[], changes: SemanticChange[]): string {
  if (changes.length) {
    const descriptions = changes.slice(0, 4).map((change) => {
      if (change.kind === 'added') return `${change.label} ${change.after}가 추가됨`
      if (change.kind === 'removed') return `${change.label} ${change.before}가 제거됨`
      return `${change.label}가 ${change.before} → ${change.after}로 변경됨`
    })
    return `${name}은(는) 부모 Sequence 대비 ${descriptions.join(', ')}.`
  }
  if (facts.length) {
    return `${name}에서 ${facts
      .slice(0, 5)
      .map((item) => `${item.label} ${item.value}`)
      .join(', ')} 조건을 파일에서 확인했습니다.`
  }
  return `${name}의 명령 구조는 확인했지만 평가 목적과 핵심 조건은 파일만으로 확정할 수 없습니다.`
}

export class AnalysisService {
  private readonly jobs = new Map<string, InternalJob>()
  private readonly pending: string[] = []
  private readonly cache: AtomicJsonStore<AnalysisCache>
  private running = false

  constructor(
    dataRoot: string,
    private readonly artifacts: ArtifactService,
    private readonly llmConfig: LlmConfigService,
    private readonly llm: OpenAiCompatibleClient,
    private readonly onUpdate: (job: AnalysisJobSnapshot) => void
  ) {
    this.cache = new AtomicJsonStore(join(dataRoot, 'cache', 'analysis.json'), {
      schemaVersion: 1,
      entries: {}
    })
  }

  async initialize(): Promise<void> {
    await this.cache.initialize()
  }

  start(rawInput: StartAnalysisInput): AnalysisJobSnapshot {
    const input = safeInput(rawInput)
    if (this.jobs.size >= 500) {
      for (const [id, existing] of this.jobs) {
        if (['completed', 'failed', 'cancelled'].includes(existing.snapshot.status)) this.jobs.delete(id)
        if (this.jobs.size < 400) break
      }
    }
    const now = new Date().toISOString()
    const job: InternalJob = {
      input,
      controller: new AbortController(),
      snapshot: {
        id: randomUUID(),
        status: 'queued',
        stage: '분석 대기열',
        queuePosition: this.pending.length + 1,
        createdAt: now,
        updatedAt: now
      }
    }
    this.jobs.set(job.snapshot.id, job)
    this.pending.push(job.snapshot.id)
    this.emitAllPositions()
    void this.drain()
    return this.snapshot(job)
  }

  get(id: string): AnalysisJobSnapshot | null {
    const job = this.jobs.get(id)
    return job ? this.snapshot(job) : null
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.snapshot.status)) return false
    job.controller.abort()
    const pendingIndex = this.pending.indexOf(id)
    if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1)
    this.update(job, { status: 'cancelled', stage: '사용자가 분석을 취소함', queuePosition: 0 })
    this.emitAllPositions()
    return true
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending.length) {
        const id = this.pending.shift()!
        const job = this.jobs.get(id)
        if (!job || job.snapshot.status === 'cancelled') continue
        this.emitAllPositions()
        this.update(job, { status: 'running', stage: '파일 구조 분석', queuePosition: 0 })
        try {
          const result = await this.analyze(job)
          if (job.controller.signal.aborted) continue
          this.update(job, { status: 'completed', stage: '분석 완료', result })
        } catch (error) {
          if (job.controller.signal.aborted) continue
          this.update(job, {
            status: 'failed',
            stage: '분석 실패',
            error: error instanceof Error ? error.message.slice(0, 300) : '알 수 없는 분석 오류'
          })
        }
      }
    } finally {
      this.running = false
    }
  }

  private async analyze(job: InternalJob): Promise<AnalysisResult> {
    const input = job.input
    const artifact = await this.artifacts.require(input.artifactId)
    const currentText = await this.artifacts.readText(input.artifactId)
    const current =
      artifact.fingerprint ?? parseSequence(currentText.text, artifact.originalNames[0] ?? 'artifact.seq')
    const parent = input.parentArtifactId
      ? await this.artifacts.require(input.parentArtifactId)
      : undefined
    const parentText = parent ? await this.artifacts.readText(parent.id) : undefined
    const parentFingerprint = parent
      ? parent.fingerprint ?? parseSequence(parentText!.text, parent.originalNames[0] ?? 'parent.seq')
      : undefined
    const changes = semanticChanges(parentFingerprint, current)
    const llmSummary = await this.llmConfig.summary()
    const filenameMetadata = parseFilenameMetadata(artifact.originalNames[0] ?? 'artifact.seq')
    const unresolvedMetadata = new Set<MetadataSuggestionField>(
      METADATA_FIELDS.filter((field) => filenameMetadata[field].state === 'unknown' || filenameMetadata[field].state === 'conflict')
    )
    // LLM calls are deliberately selective. With neither a human hint nor a
    // parent diff, a model has no reliable basis for intent and would only
    // consume shared TPM/RPM while increasing hallucination risk.
    const shouldUseLlm =
      llmSummary.configured &&
      Boolean(input.userComment || (input.parentArtifactId && changes.length > 0) || unresolvedMetadata.size > 0)
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify({
          version: ANALYSIS_PROMPT_VERSION,
          parser: PARSER_VERSION,
          artifact: input.artifactId,
          parent: input.parentArtifactId,
          comment: input.userComment,
          context: input.projectContext,
          filenameMetadata: METADATA_FIELDS.map((field) => [field, filenameMetadata[field].state, filenameMetadata[field].candidates]),
          llm: llmSummary.configured ? `${llmSummary.baseUrl}|${llmSummary.model}` : 'fallback'
        })
      )
      .digest('hex')
    const cached = (await this.cache.read()).entries[cacheKey]
    if (cached) return { ...compatibleCachedResult(cached), cached: true }

    const warnings: string[] = []
    if (currentText.truncated) {
      warnings.push('파일이 커서 앞부분 8 MB 범위에서 구조를 분석했습니다.')
    }
    let source: AnalysisResult['source'] = 'deterministic-fallback'
    let model: string | undefined
    let summary = deterministicSummary(artifact.originalNames[0] ?? artifact.id, current.facts, changes)
    let inferences: AnalysisInference[] = []
    let questions: ClarifyingQuestion[] = []
    let suggestedTags = current.facts.map((item) => item.key)
    let metadataSuggestions: MetadataSuggestion[] = []

    if (input.userComment) {
      inferences.push({
        title: '엔지니어 코멘트 기반 맥락',
        detail: input.userComment,
        confidence: 0.75,
        evidenceFactKeys: [],
        state: 'inferred'
      })
    }

    if (shouldUseLlm) {
      try {
        const evidence = buildMinimalLlmEvidence({
          request: input,
          fileName: artifact.originalNames[0] ?? 'artifact.seq',
          fingerprint: current,
          changes
        })
        const prompt = buildMinimalLlmPrompt(evidence)
        const completion = await this.llm.complete(prompt, job.controller.signal, (stage) => {
          this.update(job, { stage })
        })
        const parsed = extractJsonObject(completion.content)
        summary = boundedString(parsed.summary, 1_200) || summary
        inferences = [...inferences, ...validateInferences(parsed.inferences)].slice(0, 6)
        questions = validateQuestions(parsed.questions)
        suggestedTags = validateTags(parsed.suggestedTags)
        metadataSuggestions = validateMetadataSuggestions(parsed.metadataSuggestions, unresolvedMetadata)
        source = 'llm'
        model = completion.model
      } catch (error) {
        if (job.controller.signal.aborted) throw error
        warnings.push(
          'LLM 응답을 사용할 수 없어 파일 구조와 사용자 코멘트만으로 요약했습니다.'
        )
      }
    } else if (!llmSummary.configured) {
      warnings.push('LLM이 설정되지 않아 결정적 파서로 분석했습니다.')
    } else {
      warnings.push(
        '평가 의도를 추론할 근거가 부족해 공유 LLM 사용량을 소모하지 않고 로컬 분석만 수행했습니다.'
      )
    }

    if (!input.parentArtifactId) {
      const similar = await this.artifacts.findSimilar(input.artifactId, 3)
      if (similar[0]?.score >= 0.72) {
        questions.unshift({
          id: 'confirm-parent',
          question: `이 Sequence의 부모가 '${similar[0].artifact.originalNames[0]}'인가요?`,
          why: '부모를 확인하면 변경 목적과 계보를 정확히 저장할 수 있습니다.',
          choices: [
            ...similar.slice(0, 3).map((item) => item.artifact.originalNames[0] ?? item.artifact.id),
            '알려진 부모 없음'
          ]
        })
      }
    }
    // Do not turn intake into another mandatory form. Ask for purpose only
    // when neither lineage/diff nor a higher-value model question can fill the
    // gap. A clear parent + meaningful changes can be reviewed without a
    // question on every upload.
    if (
      !input.userComment &&
      questions.length === 0 &&
      (!input.parentArtifactId || changes.length === 0)
    ) {
      questions.push({
        id: 'evaluation-purpose',
        question: '이 Sequence로 확인하려던 핵심 평가 목적은 무엇인가요?',
        why: '명령과 조건은 추출했지만 업로드된 파일만으로는 평가 의도를 확정할 수 없습니다.'
      })
    }
    questions = questions.slice(0, 2)

    const result: AnalysisResult = {
      artifactId: input.artifactId,
      parentArtifactId: input.parentArtifactId,
      generatedAt: new Date().toISOString(),
      parserVersion: PARSER_VERSION,
      source,
      model,
      cached: false,
      summary,
      facts: current.facts,
      changes,
      inferences,
      questions,
      suggestedTags,
      metadataSuggestions,
      warnings
    }

    // Cache intentional deterministic results, but not a fallback caused by a
    // transient LLM outage: the latter should be retried next time.
    if (source === 'llm' || !shouldUseLlm) {
      await this.cache.update((draft) => {
        draft.entries[cacheKey] = result
        const keys = Object.keys(draft.entries)
        if (keys.length > 2_000) keys.slice(0, keys.length - 2_000).forEach((key) => delete draft.entries[key])
      })
    }
    return result
  }

  private update(job: InternalJob, patch: Partial<AnalysisJobSnapshot>): void {
    job.snapshot = { ...job.snapshot, ...patch, updatedAt: new Date().toISOString() }
    this.onUpdate(this.snapshot(job))
  }

  private snapshot(job: InternalJob): AnalysisJobSnapshot {
    return structuredClone(job.snapshot)
  }

  private emitAllPositions(): void {
    this.pending.forEach((id, index) => {
      const job = this.jobs.get(id)
      if (job) this.update(job, { queuePosition: index + 1 })
    })
  }
}
