import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  EvaluationApproveMetadataInput,
  EvaluationArchiveRecipeInput,
  EvaluationBatchOutcome,
  EvaluationBatchOutcomeInput,
  EvaluationBatchRun,
  EvaluationBatchSaveResult,
  EvaluationDecisionRevision,
  EvaluationDecisionSaveResult,
  EvaluationEvidenceRef,
  EvaluationMetadataApprovalRevision,
  EvaluationMetadataSaveResult,
  EvaluationProjectSnapshot,
  EvaluationRecipeClause,
  EvaluationRecipeRevision,
  EvaluationRecipeRule,
  EvaluationRecipeSaveResult,
  EvaluationRecipeAndBatchSaveResult,
  EvaluationResultLabel,
  EvaluationSaveBatchInput,
  EvaluationSaveRecipeAndBatchInput,
  EvaluationSaveDecisionInput,
  EvaluationSaveRecipeInput,
  EvaluationSourceInput,
  EvaluationSourceRef,
  EvaluationStorageNotice
} from '../shared/contracts'
import { AtomicJsonStore } from './json-store'

interface StoredEvaluationProject {
  revision: number
  decisions: EvaluationDecisionRevision[]
  recipes: EvaluationRecipeRevision[]
  batches: EvaluationBatchRun[]
  metadataApprovals: EvaluationMetadataApprovalRevision[]
}

interface EvaluationDatabase {
  schemaVersion: 1
  projects: Record<string, StoredEvaluationProject>
}

interface EvaluationStoreOptions {
  now?: () => Date
  id?: () => string
}

const RESULT_LABELS = new Set<EvaluationResultLabel>([
  'PASS',
  'DIAG_FAIL',
  'TEST_FAIL',
  'TRAINING_FAIL',
  'SYSTEM_HALT',
  'SYSTEM_REBOOT',
  'INCOMPLETE',
  'UNKNOWN',
  'EXCLUDED'
])
const RECIPE_LABELS = new Set([...RESULT_LABELS].filter((label) => label !== 'UNKNOWN'))
const BATCH_EXCEPTION_CODES = new Set([
  'NO_MATCH',
  'SEARCH_ERROR',
  'RULE_CONFLICT',
  'INVALID_METADATA',
  'CANCELLED',
  'OTHER'
])
const MAX_BATCH_OUTCOMES = 100_000
const MAX_RULES_PER_RECIPE = 2_000
const MAX_CLAUSES_PER_RULE = 1_000
const MAX_EVIDENCE_REFS = 2_000
const FORBIDDEN_KEYS = new Set([
  'rawlog',
  'rawlogtext',
  'excerpt',
  'excerpts',
  'linetext',
  'absolutepath',
  'apikey',
  'authorization',
  'bearertoken',
  'token',
  'secret'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resemblesSecret(value: string): boolean {
  return (
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
    /\bsk-[A-Za-z0-9._-]{12,}\b/i.test(value) ||
    /\b(?:api[_ -]?key|token)\s*[:=-]\s*[A-Za-z0-9._~+/=-]{12,}\b/i.test(value)
  )
}

function isAbsolutePath(value: string): boolean {
  let probe = value.trim()
  // Match paths pasted into literal rules as well as common anchored/wrapped regex forms.
  for (let index = 0; index < 8; index += 1) {
    const next = probe
      .replace(/^\^/, '')
      .replace(/^\\A/, '')
      .replace(/^\\b/, '')
      .replace(/^\(\?:/, '')
      .replace(/^\(\?[dgimsuvy-]+:/i, '')
      .replace(/^\(+/, '')
    if (next === probe) break
    probe = next
  }
  const slashNormalized = probe.replace(/^\\\//, '/')
  return /^[a-zA-Z]:(?:[\\/]|\\{2,})/.test(probe) || /^\\{2,}[^\\]+\\/.test(probe) || slashNormalized.startsWith('/')
}

interface SensitivePayloadOptions {
  allowAbsolutePath?: boolean
}

function rejectSensitivePayload(value: unknown, key = '', options: SensitivePayloadOptions = {}): void {
  const normalizedKey = key.replace(/[^a-z]/gi, '').toLocaleLowerCase()
  if (FORBIDDEN_KEYS.has(normalizedKey)) throw new Error(`저장할 수 없는 필드입니다: ${key}`)
  if (typeof value === 'string') {
    if (resemblesSecret(value)) throw new Error('비밀정보가 포함된 값은 저장할 수 없습니다.')
    if (!options.allowAbsolutePath && isAbsolutePath(value)) throw new Error('절대 경로는 저장할 수 없습니다.')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => rejectSensitivePayload(item, key, options))
    return
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([childKey, child]) => rejectSensitivePayload(
      child,
      childKey,
      normalizedKey === 'matcher' && childKey.replace(/[^a-z]/gi, '').toLocaleLowerCase() === 'pattern'
        ? { ...options, allowAbsolutePath: true }
        : options
    ))
  }
}

function safeIdentifier(value: unknown, name: string, maximum = 220): string {
  if (typeof value !== 'string') throw new Error(`${name}이(가) 올바르지 않습니다.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${name}이(가) 올바르지 않습니다.`)
  }
  if (isAbsolutePath(trimmed) || resemblesSecret(trimmed)) throw new Error(`${name}에 민감정보를 사용할 수 없습니다.`)
  return trimmed
}

function safeText(value: unknown, name: string, maximum = 512, options: SensitivePayloadOptions = {}): string {
  if (typeof value !== 'string') throw new Error(`${name}이(가) 올바르지 않습니다.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum || /[\r\n\u0000]/.test(trimmed)) {
    throw new Error(`${name}이(가) 올바르지 않습니다.`)
  }
  if ((!options.allowAbsolutePath && isAbsolutePath(trimmed)) || resemblesSecret(trimmed)) {
    throw new Error(`${name}에 민감정보를 사용할 수 없습니다.`)
  }
  return trimmed
}

function safeOptionalText(value: unknown, name: string, maximum = 256): string | undefined {
  return value === undefined ? undefined : safeText(value, name, maximum)
}

function safeInteger(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name}이(가) 올바르지 않습니다.`)
  }
  return value as number
}

function safeNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name}이(가) 올바르지 않습니다.`)
  }
  return value
}

function safeArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('artifactId가 올바르지 않습니다.')
  return value
}

function stableHash(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex')
}

function projectKey(projectId: unknown): string {
  const safeProjectId = safeText(projectId, 'projectId', 240)
  return stableHash('sequence-control-tower-project-v1', safeProjectId)
}

function sourceRef(value: EvaluationSourceInput): EvaluationSourceRef {
  if (!isRecord(value)) throw new Error('source가 올바르지 않습니다.')
  const sourceId = safeIdentifier(value.sourceId, 'sourceId')
  const artifactId = safeArtifactId(value.artifactId)
  if (typeof value.sourceKey !== 'string' || !value.sourceKey || value.sourceKey.length > 2_048) {
    throw new Error('sourceKey가 올바르지 않습니다.')
  }
  if (isAbsolutePath(value.sourceKey) || resemblesSecret(value.sourceKey)) {
    throw new Error('sourceKey에 민감정보를 사용할 수 없습니다.')
  }
  return {
    sourceId,
    artifactId,
    sourceKeyHash: stableHash('sequence-control-tower-source-v1', value.sourceKey)
  }
}

function evidenceRef(value: EvaluationEvidenceRef): EvaluationEvidenceRef {
  if (!isRecord(value)) throw new Error('근거 참조가 올바르지 않습니다.')
  const lineNumber = value.lineNumber === undefined ? undefined : safeInteger(value.lineNumber, 'lineNumber', 1)
  const columnStart = value.columnStart === undefined ? undefined : safeInteger(value.columnStart, 'columnStart', 1)
  const columnEnd = value.columnEnd === undefined ? undefined : safeInteger(value.columnEnd, 'columnEnd', 1)
  if (columnStart !== undefined && columnEnd !== undefined && columnEnd < columnStart) {
    throw new Error('근거 열 범위가 올바르지 않습니다.')
  }
  const matcherId = value.matcherId === undefined ? undefined : safeIdentifier(value.matcherId, 'matcherId')
  return {
    artifactId: safeArtifactId(value.artifactId),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(columnStart === undefined ? {} : { columnStart }),
    ...(columnEnd === undefined ? {} : { columnEnd }),
    ...(matcherId === undefined ? {} : { matcherId })
  }
}

function evidenceRefs(value: unknown): EvaluationEvidenceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) throw new Error('근거 참조 개수가 올바르지 않습니다.')
  return value.map((item) => evidenceRef(item as EvaluationEvidenceRef))
}

function recipeClause(value: EvaluationRecipeClause): EvaluationRecipeClause {
  if (!isRecord(value) || !isRecord(value.matcher)) throw new Error('규칙 절이 올바르지 않습니다.')
  if (value.presence !== 'present' && value.presence !== 'absent') throw new Error('규칙 presence가 올바르지 않습니다.')
  if (value.matcher.kind !== 'literal' && value.matcher.kind !== 'regex') throw new Error('matcher kind가 올바르지 않습니다.')
  if (!['content', 'file_name', 'path'].includes(String(value.matcher.target))) throw new Error('matcher target이 올바르지 않습니다.')
  if (typeof value.matcher.caseSensitive !== 'boolean') throw new Error('caseSensitive가 올바르지 않습니다.')
  const occurrence = value.occurrence === undefined
    ? undefined
    : isRecord(value.occurrence) && (value.occurrence.kind === 'exact' || value.occurrence.kind === 'atLeast')
      ? { kind: value.occurrence.kind, count: safeInteger(value.occurrence.count, 'occurrence count', value.occurrence.kind === 'atLeast' ? 1 : 0) }
      : (() => { throw new Error('occurrence 조건이 올바르지 않습니다.') })()
  const order = value.order === undefined
    ? undefined
    : { afterClauseId: safeIdentifier(value.order.afterClauseId, 'afterClauseId') }
  return {
    id: safeIdentifier(value.id, 'clauseId'),
    presence: value.presence,
    ...(occurrence ? { occurrence } : {}),
    matcher: {
      kind: value.matcher.kind,
      pattern: safeText(value.matcher.pattern, 'matcher pattern', 1_000, { allowAbsolutePath: true }),
      caseSensitive: value.matcher.caseSensitive,
      target: value.matcher.target
    },
    ...(value.sourceObservationId === undefined
      ? {}
      : { sourceObservationId: safeIdentifier(value.sourceObservationId, 'sourceObservationId') }),
    ...(order ? { order } : {})
  }
}

function recipeRule(value: EvaluationRecipeRule): EvaluationRecipeRule {
  if (!isRecord(value) || !isRecord(value.scope) || !Array.isArray(value.clauses)) throw new Error('규칙이 올바르지 않습니다.')
  if (!RECIPE_LABELS.has(value.label)) throw new Error('규칙 결과가 올바르지 않습니다.')
  if (value.status !== 'candidate' && value.status !== 'verified') throw new Error('규칙 상태가 올바르지 않습니다.')
  if (!['analysis', 'project', 'customer', 'global'].includes(String(value.scope.kind))) throw new Error('규칙 범위가 올바르지 않습니다.')
  if (!value.clauses.length || value.clauses.length > MAX_CLAUSES_PER_RULE) throw new Error('규칙 절 개수가 올바르지 않습니다.')
  if (!Array.isArray(value.createdFromSourceIds) || value.createdFromSourceIds.length > 10_000) {
    throw new Error('규칙 원본 참조가 올바르지 않습니다.')
  }
  return {
    id: safeIdentifier(value.id, 'ruleId'),
    label: value.label,
    status: value.status,
    scope: {
      kind: value.scope.kind,
      ...(value.scope.id === undefined ? {} : { id: safeIdentifier(value.scope.id, 'scopeId') })
    },
    clauses: value.clauses.map(recipeClause),
    priority: safeInteger(value.priority, 'priority', -10_000, 10_000),
    confidence: safeNumber(value.confidence, 'confidence', 0, 1),
    repetition: safeInteger(value.repetition, 'repetition', 1),
    createdFromSourceIds: [...new Set(value.createdFromSourceIds.map((item) => safeIdentifier(item, 'createdFromSourceId')))]
  }
}

function emptyProject(): StoredEvaluationProject {
  return { revision: 0, decisions: [], recipes: [], batches: [], metadataApprovals: [] }
}

function isStoredProject(value: unknown): value is StoredEvaluationProject {
  return isRecord(value) && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 &&
    Array.isArray(value.decisions) && Array.isArray(value.recipes) && Array.isArray(value.batches) &&
    Array.isArray(value.metadataApprovals)
}

function isEvaluationDatabase(value: unknown): value is EvaluationDatabase {
  return isRecord(value) && value.schemaVersion === 1 && isRecord(value.projects) &&
    Object.entries(value.projects).every(([key, project]) => /^[a-f0-9]{64}$/.test(key) && isStoredProject(project))
}

function safeStartedAt(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('startedAt이 올바르지 않습니다.')
  return new Date(value).toISOString()
}

export class EvaluationRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`EVALUATION_REVISION_CONFLICT: expected ${expected}, actual ${actual}`)
    this.name = 'EvaluationRevisionConflictError'
  }
}

/** Durable semantic state. Raw logs remain exclusively in ArtifactService. */
export class EvaluationStore {
  private readonly filePath: string
  private readonly store: AtomicJsonStore<EvaluationDatabase>
  private readonly now: () => Date
  private readonly makeId: () => string
  private initialization?: Promise<void>
  private storageNotice?: EvaluationStorageNotice

  constructor(dataRoot: string, options: EvaluationStoreOptions = {}) {
    this.filePath = join(dataRoot, 'metadata', 'evaluations.json')
    this.store = new AtomicJsonStore(this.filePath, { schemaVersion: 1, projects: {} })
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? randomUUID
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce()
    return this.initialization
  }

  private async initializeOnce(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        await this.recoverInvalidStore('recovered-corrupt')
        await this.store.initialize()
        return
      }
      let valid = isEvaluationDatabase(parsed)
      if (valid) {
        try {
          rejectSensitivePayload(parsed)
        } catch {
          valid = false
        }
      }
      if (!valid) {
        await this.recoverInvalidStore(isRecord(parsed) && parsed.schemaVersion !== 1
          ? 'recovered-unsupported-version'
          : 'recovered-corrupt')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.store.initialize()
  }

  private async recoverInvalidStore(kind: EvaluationStorageNotice['kind']): Promise<void> {
    const recoveredAt = this.now().toISOString()
    const suffix = kind === 'recovered-corrupt' ? 'corrupt' : 'unsupported'
    const backupPath = `${this.filePath}.${suffix}-${this.now().getTime()}`
    await rename(this.filePath, backupPath)
    this.storageNotice = { kind, recoveredAt, backupFileName: basename(backupPath) }
  }

  async snapshot(projectId: string): Promise<EvaluationProjectSnapshot> {
    await this.initialize()
    const key = projectKey(projectId)
    const database = await this.store.read()
    return this.toSnapshot(key, database.projects[key] ?? emptyProject())
  }

  async saveDecision(input: EvaluationSaveDecisionInput): Promise<EvaluationDecisionSaveResult> {
    rejectSensitivePayload(input)
    if (!RESULT_LABELS.has(input.result)) throw new Error('판정 결과가 올바르지 않습니다.')
    const source = sourceRef(input.source)
    const refs = evidenceRefs(input.evidenceRefs)
    let saved!: EvaluationDecisionRevision
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const previous = [...project.decisions].reverse().find((item) =>
        item.source.sourceId === source.sourceId && item.source.artifactId === source.artifactId)
      saved = {
        id: this.makeId(),
        revision: (previous?.revision ?? 0) + 1,
        source,
        result: input.result,
        decidedBy: 'engineer',
        evidenceRefs: refs,
        createdAt: this.now().toISOString(),
        ...(previous ? { supersedesId: previous.id } : {})
      }
      project.decisions.push(saved)
    })
    return { snapshot, decision: saved }
  }

  async saveRecipe(input: EvaluationSaveRecipeInput): Promise<EvaluationRecipeSaveResult> {
    rejectSensitivePayload(input)
    if (!Array.isArray(input.rules) || !input.rules.length || input.rules.length > MAX_RULES_PER_RECIPE) {
      throw new Error('저장할 규칙 개수가 올바르지 않습니다.')
    }
    const name = safeText(input.name, 'recipe name', 160)
    const rules = input.rules.map(recipeRule)
    const recipeId = input.recipeId === undefined ? this.makeId() : safeIdentifier(input.recipeId, 'recipeId')
    let saved!: EvaluationRecipeRevision
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const previous = [...project.recipes].reverse().find((item) => item.recipeId === recipeId)
      saved = {
        id: this.makeId(),
        recipeId,
        revision: (previous?.revision ?? 0) + 1,
        name,
        rules,
        createdAt: this.now().toISOString(),
        ...(previous ? { supersedesId: previous.id } : {})
      }
      project.recipes.push(saved)
    })
    return { snapshot, recipe: saved }
  }

  async archiveRecipe(input: EvaluationArchiveRecipeInput): Promise<EvaluationRecipeSaveResult> {
    rejectSensitivePayload(input)
    const recipeId = safeIdentifier(input.recipeId, 'recipeId')
    let saved!: EvaluationRecipeRevision
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const previous = [...project.recipes].reverse().find((item) => item.recipeId === recipeId)
      if (!previous) throw new Error('존재하지 않는 recipeId입니다.')
      saved = {
        id: this.makeId(),
        recipeId: previous.recipeId,
        revision: previous.revision + 1,
        name: previous.name,
        rules: [],
        createdAt: this.now().toISOString(),
        supersedesId: previous.id,
        archived: true
      }
      project.recipes.push(saved)
    })
    return { snapshot, recipe: saved }
  }

  async saveBatch(input: EvaluationSaveBatchInput): Promise<EvaluationBatchSaveResult> {
    rejectSensitivePayload(input)
    if (!['completed', 'failed', 'cancelled'].includes(String(input.status))) throw new Error('batch status가 올바르지 않습니다.')
    if (!Array.isArray(input.recipeRevisionIds) || !input.recipeRevisionIds.length) throw new Error('recipe revision이 필요합니다.')
    if (!Array.isArray(input.outcomes) || input.outcomes.length > MAX_BATCH_OUTCOMES) throw new Error('batch outcome 개수가 올바르지 않습니다.')
    const recipeRevisionIds = [...new Set(input.recipeRevisionIds.map((item) => safeIdentifier(item, 'recipeRevisionId')))]
    const outcomes = input.outcomes.map((item) => this.batchOutcome(item))
    const duplicateSources = new Set<string>()
    outcomes.forEach((outcome) => {
      const key = `${outcome.source.sourceId}\0${outcome.source.artifactId}`
      if (duplicateSources.has(key)) throw new Error('batch에 같은 source revision이 중복되었습니다.')
      duplicateSources.add(key)
    })
    let saved!: EvaluationBatchRun
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const referencedRecipes = project.recipes.filter((item) => recipeRevisionIds.includes(item.id))
      if (referencedRecipes.length !== recipeRevisionIds.length) throw new Error('존재하지 않는 recipe revision입니다.')
      const referencedRules = new Map(referencedRecipes.flatMap((recipe) => recipe.rules.map((rule) => [rule.id, rule] as const)))
      const latestDecisions = new Map<string, EvaluationDecisionRevision>()
      project.decisions.forEach((decision) => {
        latestDecisions.set(`${decision.source.sourceId}\0${decision.source.artifactId}`, decision)
      })
      for (const outcome of outcomes) {
        if (outcome.outcomeSource === 'rule' && !outcome.matchedRuleId) {
          throw new Error('rule 결과에는 matchedRuleId가 필요합니다.')
        }
        const matchedRule = outcome.matchedRuleId ? referencedRules.get(outcome.matchedRuleId) : undefined
        if (outcome.matchedRuleId && !matchedRule) {
          throw new Error('matchedRuleId가 참조한 recipe revision에 포함되어 있지 않습니다.')
        }
        if (outcome.outcomeSource === 'rule' && matchedRule?.label !== outcome.result) {
          throw new Error('rule 결과가 matched rule label과 일치하지 않습니다.')
        }
        const exactDecision = latestDecisions.get(`${outcome.source.sourceId}\0${outcome.source.artifactId}`)
        if (exactDecision && (outcome.outcomeSource !== 'engineer-preserved' || outcome.result !== exactDecision.result)) {
          throw new Error('batch 결과가 exact engineer decision을 보존하지 않았습니다.')
        }
        if (!exactDecision && outcome.outcomeSource === 'engineer-preserved') {
          throw new Error('보존할 exact engineer decision이 존재하지 않습니다.')
        }
        if (outcome.conflictingDecisionId && outcome.conflictingDecisionId !== exactDecision?.id) {
          throw new Error('conflictingDecisionId가 exact engineer decision과 일치하지 않습니다.')
        }
      }
      const completedAt = this.now().toISOString()
      saved = {
        id: this.makeId(),
        status: input.status,
        recipeRevisionIds,
        outcomes,
        matchedCount: outcomes.filter((item) => !item.exceptionCode && item.result !== 'UNKNOWN').length,
        exceptionCount: outcomes.filter((item) => Boolean(item.exceptionCode) || item.result === 'UNKNOWN').length,
        startedAt: safeStartedAt(input.startedAt, completedAt),
        completedAt
      }
      project.batches.push(saved)
    })
    return { snapshot, batch: saved }
  }

  async saveRecipeAndBatch(input: EvaluationSaveRecipeAndBatchInput): Promise<EvaluationRecipeAndBatchSaveResult> {
    rejectSensitivePayload(input)
    if (!Array.isArray(input.recipe.rules) || !input.recipe.rules.length || input.recipe.rules.length > MAX_RULES_PER_RECIPE) {
      throw new Error('저장할 규칙 개수가 올바르지 않습니다.')
    }
    const name = safeText(input.recipe.name, 'recipe name', 160)
    const rules = input.recipe.rules.map(recipeRule)
    const recipeId = input.recipe.recipeId === undefined ? this.makeId() : safeIdentifier(input.recipe.recipeId, 'recipeId')
    if (!['completed', 'failed', 'cancelled'].includes(String(input.batch.status))) throw new Error('batch status가 올바르지 않습니다.')
    if (!Array.isArray(input.batch.outcomes) || input.batch.outcomes.length > MAX_BATCH_OUTCOMES) throw new Error('batch outcome 개수가 올바르지 않습니다.')
    const outcomes = this.normalizeBatchOutcomes(input.batch.outcomes)
    let savedRecipe!: EvaluationRecipeRevision
    let savedBatch!: EvaluationBatchRun
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const previous = [...project.recipes].reverse().find((item) => item.recipeId === recipeId)
      const reusable = previous && previous.name === name && JSON.stringify(previous.rules) === JSON.stringify(rules)
      savedRecipe = reusable ? previous : {
        id: this.makeId(),
        recipeId,
        revision: (previous?.revision ?? 0) + 1,
        name,
        rules,
        createdAt: this.now().toISOString(),
        ...(previous ? { supersedesId: previous.id } : {})
      }
      if (!reusable) project.recipes.push(savedRecipe)
      this.validateBatch(project, [savedRecipe.id], outcomes)
      const completedAt = this.now().toISOString()
      savedBatch = {
        id: this.makeId(),
        status: input.batch.status,
        recipeRevisionIds: [savedRecipe.id],
        outcomes,
        matchedCount: outcomes.filter((item) => !item.exceptionCode && item.result !== 'UNKNOWN').length,
        exceptionCount: outcomes.filter((item) => Boolean(item.exceptionCode) || item.result === 'UNKNOWN').length,
        startedAt: safeStartedAt(input.batch.startedAt, completedAt),
        completedAt
      }
      project.batches.push(savedBatch)
    })
    return { snapshot, recipe: savedRecipe, batch: savedBatch }
  }

  async approveMetadata(input: EvaluationApproveMetadataInput): Promise<EvaluationMetadataSaveResult> {
    rejectSensitivePayload(input)
    if (input.approval !== 'approved' && input.approval !== 'rejected' && input.approval !== 'reset') throw new Error('metadata approval이 올바르지 않습니다.')
    const source = sourceRef(input.source)
    const fieldKey = safeIdentifier(input.fieldKey, 'fieldKey', 100)
    const candidateValue = safeOptionalText(input.candidateValue, 'candidateValue')
    const approvedValue = safeOptionalText(input.approvedValue, 'approvedValue')
    const extractorId = safeOptionalText(input.extractorId, 'extractorId', 160)
    if (approvedValue === '미확인') throw new Error('미확인은 approvedValue로 저장할 수 없습니다.')
    if (input.approval === 'approved' && approvedValue === undefined && candidateValue === undefined) {
      throw new Error('승인할 metadata 값이 필요합니다.')
    }
    let saved!: EvaluationMetadataApprovalRevision
    const snapshot = await this.mutate(input.projectId, input.expectedRevision, (project) => {
      const previous = [...project.metadataApprovals].reverse().find((item) =>
        item.source.sourceId === source.sourceId && item.source.artifactId === source.artifactId && item.fieldKey === fieldKey)
      saved = {
        id: this.makeId(),
        revision: (previous?.revision ?? 0) + 1,
        source,
        fieldKey,
        ...(candidateValue === undefined ? {} : { candidateValue }),
        ...(approvedValue === undefined ? {} : { approvedValue }),
        ...(extractorId === undefined ? {} : { extractorId }),
        approval: input.approval,
        approvedBy: 'engineer',
        createdAt: this.now().toISOString(),
        ...(previous ? { supersedesId: previous.id } : {})
      }
      project.metadataApprovals.push(saved)
    })
    return { snapshot, metadataApproval: saved }
  }

  private batchOutcome(value: EvaluationBatchOutcomeInput): EvaluationBatchOutcome {
    if (!isRecord(value) || !RESULT_LABELS.has(value.result)) throw new Error('batch outcome이 올바르지 않습니다.')
    if (!['rule', 'engineer-preserved', 'unknown'].includes(String(value.outcomeSource))) {
      throw new Error('batch outcome source가 올바르지 않습니다.')
    }
    if (value.exceptionCode !== undefined && !BATCH_EXCEPTION_CODES.has(value.exceptionCode)) {
      throw new Error('batch exception code가 올바르지 않습니다.')
    }
    return {
      source: sourceRef(value.source),
      result: value.result,
      outcomeSource: value.outcomeSource,
      ...(value.matchedRuleId === undefined ? {} : { matchedRuleId: safeIdentifier(value.matchedRuleId, 'matchedRuleId') }),
      evidenceRefs: evidenceRefs(value.evidenceRefs),
      ...(value.exceptionCode === undefined ? {} : { exceptionCode: value.exceptionCode }),
      ...(value.conflictingDecisionId === undefined
        ? {}
        : { conflictingDecisionId: safeIdentifier(value.conflictingDecisionId, 'conflictingDecisionId') })
    }
  }

  private normalizeBatchOutcomes(outcomes: EvaluationBatchOutcomeInput[]): EvaluationBatchOutcome[] {
    const normalized = outcomes.map((item) => this.batchOutcome(item))
    const sources = new Set<string>()
    normalized.forEach((outcome) => {
      const key = `${outcome.source.sourceId}\0${outcome.source.artifactId}`
      if (sources.has(key)) throw new Error('batch에 같은 source revision이 중복되었습니다.')
      sources.add(key)
    })
    return normalized
  }

  private validateBatch(project: StoredEvaluationProject, recipeRevisionIds: string[], outcomes: EvaluationBatchOutcome[]): void {
    const referencedRecipes = project.recipes.filter((item) => recipeRevisionIds.includes(item.id))
    if (referencedRecipes.length !== recipeRevisionIds.length) throw new Error('존재하지 않는 recipe revision입니다.')
    const referencedRules = new Map(referencedRecipes.flatMap((recipe) => recipe.rules.map((rule) => [rule.id, rule] as const)))
    const latestDecisions = new Map<string, EvaluationDecisionRevision>()
    project.decisions.forEach((decision) => latestDecisions.set(`${decision.source.sourceId}\0${decision.source.artifactId}`, decision))
    for (const outcome of outcomes) {
      if (outcome.outcomeSource === 'rule' && !outcome.matchedRuleId) throw new Error('rule 결과에는 matchedRuleId가 필요합니다.')
      const matchedRule = outcome.matchedRuleId ? referencedRules.get(outcome.matchedRuleId) : undefined
      if (outcome.matchedRuleId && !matchedRule) throw new Error('matchedRuleId가 참조한 recipe revision에 포함되어 있지 않습니다.')
      if (outcome.outcomeSource === 'rule' && matchedRule?.label !== outcome.result) throw new Error('rule 결과가 matched rule label과 일치하지 않습니다.')
      const exactDecision = latestDecisions.get(`${outcome.source.sourceId}\0${outcome.source.artifactId}`)
      if (exactDecision && (outcome.outcomeSource !== 'engineer-preserved' || outcome.result !== exactDecision.result)) throw new Error('batch 결과가 exact engineer decision을 보존하지 않았습니다.')
      if (!exactDecision && outcome.outcomeSource === 'engineer-preserved') throw new Error('보존할 exact engineer decision이 존재하지 않습니다.')
      if (outcome.conflictingDecisionId && outcome.conflictingDecisionId !== exactDecision?.id) throw new Error('conflictingDecisionId가 exact engineer decision과 일치하지 않습니다.')
    }
  }

  private async mutate(
    projectId: string,
    expectedRevisionValue: number,
    change: (project: StoredEvaluationProject) => void
  ): Promise<EvaluationProjectSnapshot> {
    await this.initialize()
    const key = projectKey(projectId)
    const expectedRevision = safeInteger(expectedRevisionValue, 'expectedRevision')
    const database = await this.store.update((draft) => {
      const project = draft.projects[key] ?? emptyProject()
      if (project.revision !== expectedRevision) throw new EvaluationRevisionConflictError(expectedRevision, project.revision)
      change(project)
      project.revision += 1
      draft.projects[key] = project
    })
    return this.toSnapshot(key, database.projects[key])
  }

  private toSnapshot(key: string, project: StoredEvaluationProject): EvaluationProjectSnapshot {
    return {
      schemaVersion: 1,
      projectIdHash: key,
      revision: project.revision,
      decisions: structuredClone(project.decisions),
      recipes: structuredClone(project.recipes),
      batches: structuredClone(project.batches),
      metadataApprovals: structuredClone(project.metadataApprovals),
      ...(this.storageNotice ? { storageNotice: structuredClone(this.storageNotice) } : {})
    }
  }
}
