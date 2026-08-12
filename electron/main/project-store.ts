import { access, chmod, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename, resolve } from 'node:path'
import type {
  ProjectArchiveExportPresetInput, ProjectArchiveInput, ProjectArtifactSourceRef, ProjectConnectArtifactsInput,
  ProjectCreateInput, ProjectEquipmentProfile, ProjectExportPreset, ProjectFolderRef, ProjectFolderStatus,
  ProjectSaveExportPresetInput, ProjectSaveInput, ProjectSnapshot, ProjectTemplatePin, ProjectLpddrDevelopmentContext,
  ProjectFailureHypothesis, ProjectEvaluationNode, ProjectEvidenceRecord, ProjectEvaluationDimensions
} from '../shared/contracts'
import type { JsonValue } from '../shared/contracts'
import { AtomicJsonStore } from './json-store'

interface StoredRoot { rootId: string; canonicalPath: string; displayLabel: string }
interface StoredProject extends Omit<ProjectSnapshot, 'schemaVersion'> {}
interface ProjectDatabase { schemaVersion: 2; projects: Record<string, StoredProject> }
interface RootDatabase { schemaVersion: 2; roots: Record<string, StoredRoot> }

export class ProjectRevisionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`프로젝트가 변경되었습니다. 최신 revision은 ${actual}입니다.`)
    this.name = 'ProjectRevisionConflictError'
  }
}

const text = (value: unknown, name: string, max = 240): string => {
  if (typeof value !== 'string') throw new Error(`${name}이(가) 올바르지 않습니다.`)
  const result = value.trim()
  if (!result || result.length > max || /[\u0000-\u001f\u007f\r\n]/.test(result)) throw new Error(`${name}이(가) 올바르지 않습니다.`)
  return result
}
const id = (value: unknown, name: string): string => text(value, name, 160)
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('expectedRevision이(가) 올바르지 않습니다.')
  return value as number
}
const now = (): string => new Date().toISOString()
const rootIdFor = (path: string): string => createHash('sha256').update('sequence-control-tower-project-root\0').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 24)
const jsonValue = (value: unknown, name = 'options'): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Array.from(value, (item) => jsonValue(item, name))
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, name)]))
  }
  throw new Error(`${name}이(가) JSON 형식이 아닙니다.`)
}
const presetOptions = (value: unknown): Record<string, JsonValue> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('export preset options가 올바르지 않습니다.')
  return jsonValue(value) as Record<string, JsonValue>
}
const optionalText = (value: unknown, name: string, max = 240): string | undefined => value === undefined ? undefined : text(value, name, max)
const optionalNumber = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name}이(가) 올바르지 않습니다.`)
  return value
}
const optionalPositiveNumber = (value: unknown, name: string): number | undefined => {
  const result = optionalNumber(value, name)
  if (result !== undefined && result <= 0) throw new Error(`${name}이(가) 올바르지 않습니다.`)
  return result
}
const optionalPositiveInteger = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name}이(가) 올바르지 않습니다.`)
  return value as number
}
const optionalVendor = (value: unknown, name: string): 'qualcomm' | 'mediatek' | 'unknown' | undefined => {
  if (value === undefined) return undefined
  if (value === 'qualcomm' || value === 'mediatek' || value === 'unknown') return value
  throw new Error(`${name}이(가) 올바르지 않습니다.`)
}
const optionalDimension = (value: unknown, name: string): string | number | undefined => typeof value === 'number' ? optionalNumber(value, name) : optionalText(value, name)
const status = (value: unknown, name: string): 'pass' | 'fail' | 'inconclusive' | 'running' => {
  if (value === 'pass' || value === 'fail' || value === 'inconclusive' || value === 'running') return value
  throw new Error(`${name}이(가) 올바르지 않습니다.`)
}
const origin = (value: unknown, name: string): 'engineer-confirmed' | 'ai-proposed' => {
  if (value === 'engineer-confirmed' || value === 'ai-proposed') return value
  throw new Error(`${name}이(가) 올바르지 않습니다.`)
}
const authorship = (value: unknown): ProjectEvaluationNode['authorship'] => {
  if (value === 'automatic' || value === 'agent' || value === 'engineer') return value
  throw new Error('evaluation authorship가 올바르지 않습니다.')
}
const reviewState = (value: unknown): ProjectEvaluationNode['reviewState'] => {
  if (value === 'proposed' || value === 'confirmed') return value
  throw new Error('evaluation review state가 올바르지 않습니다.')
}

const evaluationRelation = (value: unknown): ProjectEvaluationNode['relation'] => {
  if (!['baseline', 'retest', 'condition-comparison', 'improvement', 'verification', 'side-effect'].includes(String(value))) throw new Error('evaluation relation이 올바르지 않습니다.')
  return value as ProjectEvaluationNode['relation']
}

const relationConfidence = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error('relationConfidence가 올바르지 않습니다.')
  return parsed
}

export class ProjectStore {
  private readonly projects: AtomicJsonStore<ProjectDatabase>
  private readonly roots: AtomicJsonStore<RootDatabase>
  private initialized = false
  constructor(private readonly dataRoot: string) {
    this.projects = new AtomicJsonStore(join(dataRoot, 'metadata', 'projects.json'), { schemaVersion: 2, projects: {} })
    this.roots = new AtomicJsonStore(join(dataRoot, 'config', 'canonical-roots.json'), { schemaVersion: 2, roots: {} })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await Promise.all([this.projects.initialize(), this.roots.initialize()])
    const database = await this.projects.read()
    if (database.schemaVersion !== 2 || !database.projects) await this.projects.update(() => ({ schemaVersion: 2, projects: {} }))
    else await this.projects.update((db) => { for (const project of Object.values(db.projects)) this.defaults(project) })
    const rootDatabase = await this.roots.read()
    if (rootDatabase.schemaVersion !== 2 || !rootDatabase.roots) await this.roots.update(() => ({ schemaVersion: 2, roots: {} }))
    await chmod(join(this.dataRoot, 'config', 'canonical-roots.json'), 0o600).catch(() => undefined)
    this.initialized = true
  }

  async create(input: ProjectCreateInput): Promise<ProjectSnapshot> {
    await this.initialize(); const name = text(input?.name, '프로젝트 이름'); const description = input?.description === undefined ? undefined : text(input.description, '설명', 2_000)
    const project: StoredProject = { id: randomUUID(), name, ...(description ? { description } : {}), ...(input.onboardingAnswers ? { onboardingAnswers: input.onboardingAnswers } : {}), revision: 0, archived: false, createdAt: now(), updatedAt: now(), folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [], lpddrDevelopmentContext: {}, failureHypotheses: [], evaluationNodes: [], evidenceRecords: [] }
    await this.projects.update((db) => { db.projects[project.id] = project })
    return this.public(project)
  }

  async list(includeArchived = false): Promise<ProjectSnapshot[]> { await this.initialize(); const db = await this.projects.read(); return Object.values(db.projects).filter((p) => includeArchived || !p.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => this.public(p)) }
  async get(projectId: string): Promise<ProjectSnapshot | null> { await this.initialize(); const p = (await this.projects.read()).projects[id(projectId, 'projectId')]; return p ? this.public(p) : null }
  async load(projectId: string): Promise<ProjectSnapshot | null> { return this.get(projectId) }

  async save(input: ProjectSaveInput): Promise<ProjectSnapshot> {
    return this.mutate(input.projectId, input.expectedRevision, (p) => {
      if (input.name !== undefined) p.name = text(input.name, '프로젝트 이름')
      if (input.description !== undefined) p.description = text(input.description, '설명', 2_000)
      if (input.onboardingAnswers !== undefined) p.onboardingAnswers = input.onboardingAnswers
      if (input.equipmentProfiles !== undefined) p.equipmentProfiles = this.profiles(input.equipmentProfiles)
      if (input.templatePins !== undefined) p.templatePins = this.pins(input.templatePins)
      if (input.exportPresets !== undefined) p.exportPresets = this.presets(input.exportPresets)
      if (input.lpddrDevelopmentContext !== undefined) p.lpddrDevelopmentContext = this.context(input.lpddrDevelopmentContext)
      if (input.failureHypotheses !== undefined || input.evaluationNodes !== undefined || input.evidenceRecords !== undefined) {
        const memory = this.memory(input.failureHypotheses ?? p.failureHypotheses, input.evaluationNodes ?? p.evaluationNodes, input.evidenceRecords ?? p.evidenceRecords, p.artifacts)
        p.failureHypotheses = memory.hypotheses; p.evaluationNodes = memory.nodes; p.evidenceRecords = memory.evidence
      }
    })
  }

  async archive(input: ProjectArchiveInput): Promise<ProjectSnapshot> { return this.mutate(input.projectId, input.expectedRevision, (p) => { p.archived = true }) }

  async attachFolder(projectId: string, expectedRevision: number, selectedPath: string): Promise<ProjectSnapshot> {
    const canonicalPath = await realpath(resolve(selectedPath)); const info = await stat(canonicalPath)
    if (!info.isDirectory()) throw new Error('폴더만 연결할 수 있습니다.')
    await access(canonicalPath).catch((error) => { throw this.pathError(error) })
    const rootId = rootIdFor(canonicalPath); const displayLabel = basename(canonicalPath) || canonicalPath
    await this.roots.update((db) => { db.roots[rootId] = { rootId, canonicalPath, displayLabel } })
    return this.mutate(projectId, expectedRevision, (p) => {
      if (!p.folders.some((folder) => folder.rootId === rootId)) p.folders.push({ rootId, displayLabel, status: 'available', connectedAt: now() })
    })
  }

  async availableFolderPaths(projectId: string): Promise<Array<{ rootId: string; path: string }>> {
    await this.initialize()
    const project = (await this.projects.read()).projects[id(projectId, 'projectId')]
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    const roots = await this.roots.read()
    return project.folders.flatMap((folder) => {
      const path = roots.roots[folder.rootId]?.canonicalPath
      return path && folder.status === 'available' ? [{ rootId: folder.rootId, path }] : []
    })
  }

  async detachFolder(projectId: string, expectedRevision: number, rootId: string): Promise<ProjectSnapshot> {
    return this.mutate(projectId, expectedRevision, (p) => {
      const target = id(rootId, 'rootId'); p.folders = p.folders.filter((folder) => folder.rootId !== target); p.artifacts = p.artifacts.filter((artifact) => artifact.rootId !== target)
    })
  }

  async validateFolders(projectId: string, rootIds?: string[]): Promise<ProjectFolderRef[]> {
    await this.initialize(); const db = await this.projects.read(); const p = db.projects[id(projectId, 'projectId')]; if (!p) throw new Error('프로젝트를 찾을 수 없습니다.')
    const roots = await this.roots.read(); const selected = new Set(rootIds?.map((root) => id(root, 'rootId')))
    const updated = await Promise.all(p.folders.map(async (folder) => ({ ...folder, status: await this.status(roots.roots[folder.rootId]?.canonicalPath) })))
    if (updated.some((folder, i) => folder.status !== p.folders[i].status)) await this.projects.update((draft) => { const current = draft.projects[p.id]; if (current) current.folders = updated })
    return updated.filter((folder) => !rootIds || selected.has(folder.rootId))
  }

  async connectArtifacts(input: ProjectConnectArtifactsInput): Promise<ProjectSnapshot> {
    return this.mutate(input.projectId, input.expectedRevision, (p) => {
      const next = this.artifactSources(p, input.artifacts)
      const merged = [...p.artifacts.filter((a) => !next.some((n) => n.sourceId === a.sourceId)), ...next]
      if (this.sameArtifactSources(p.artifacts, merged)) return false
      p.artifacts = merged
    })
  }

  /** Reconciles the current files for selected project roots. Evidence-backed
   * sources remain as durable history even if the physical file later moves. */
  async syncArtifacts(input: ProjectConnectArtifactsInput, rootIds: string[]): Promise<ProjectSnapshot> {
    return this.mutate(input.projectId, input.expectedRevision, (p) => {
      const selected = new Set(rootIds.map((rootId) => id(rootId, 'rootId')))
      const validRoots = new Set(p.folders.map((folder) => folder.rootId))
      if ([...selected].some((rootId) => !validRoots.has(rootId))) throw new Error('동기화할 프로젝트 폴더가 올바르지 않습니다.')
      const next = this.artifactSources(p, input.artifacts)
      if (next.some((source) => !selected.has(source.rootId))) throw new Error('동기화할 artifact source 범위가 올바르지 않습니다.')
      const referenced = new Set((p.evidenceRecords ?? []).flatMap((record) => record.sourceIds))
      const retainedHistory = p.artifacts.filter((source) => selected.has(source.rootId)
        && referenced.has(source.sourceId)
        && !next.some((candidate) => candidate.sourceId === source.sourceId))
      const merged = [...p.artifacts.filter((source) => !selected.has(source.rootId)), ...retainedHistory, ...next]
      if (this.sameArtifactSources(p.artifacts, merged)) return false
      p.artifacts = merged
    })
  }

  async saveExportPreset(input: ProjectSaveExportPresetInput): Promise<ProjectSnapshot> { return this.mutate(input.projectId, input.expectedRevision, (p) => { const value = input.preset; const stamp = now(); const existing = value.id ? p.exportPresets.find((preset) => preset.id === value.id) : undefined; const preset: ProjectExportPreset = { id: value.id ? id(value.id, 'presetId') : randomUUID(), name: text(value.name, 'preset 이름'), format: value.format, options: presetOptions(value.options), createdAt: existing?.createdAt ?? stamp, updatedAt: stamp, ...(value.archived ? { archived: true } : {}) }; p.exportPresets = [...p.exportPresets.filter((item) => item.id !== preset.id), preset] }) }
  async archiveExportPreset(input: ProjectArchiveExportPresetInput): Promise<ProjectSnapshot> { return this.mutate(input.projectId, input.expectedRevision, (p) => { const preset = p.exportPresets.find((item) => item.id === id(input.presetId, 'presetId')); if (!preset) throw new Error('export preset을 찾을 수 없습니다.'); preset.archived = true; preset.updatedAt = now() }) }

  private async mutate(projectId: string, expected: number, change: (project: StoredProject) => void | false): Promise<ProjectSnapshot> {
    await this.initialize(); const projectKey = id(projectId, 'projectId'); let result: StoredProject | undefined
    await this.projects.update((db) => { const p = db.projects[projectKey]; if (!p) throw new Error('프로젝트를 찾을 수 없습니다.'); const wanted = revision(expected); if (p.revision !== wanted) throw new ProjectRevisionConflictError(wanted, p.revision); if (change(p) === false) { result = p; return }; p.revision += 1; p.updatedAt = now(); result = p })
    return this.public(result!)
  }
  private public(project: StoredProject): ProjectSnapshot { this.defaults(project); return { schemaVersion: 2, ...structuredClone(project) } }
  private artifactSources(project: StoredProject, values: ProjectConnectArtifactsInput['artifacts']): ProjectArtifactSourceRef[] {
    const validRoots = new Set(project.folders.map((folder) => folder.rootId))
    const sources = values.map((a): ProjectArtifactSourceRef => ({ sourceId: id(a.sourceId, 'sourceId'), rootId: id(a.rootId, 'rootId'), ...(a.artifactRootId ? { artifactRootId: id(a.artifactRootId, 'artifactRootId') } : {}), artifactId: id(a.artifactId, 'artifactId'), relativePath: text(a.relativePath, 'relativePath', 2_000) }))
    if (sources.some((a) => !validRoots.has(a.rootId) || a.relativePath.startsWith('/') || a.relativePath.includes('..'))) throw new Error('연결할 artifact source가 프로젝트 폴더에 속하지 않습니다.')
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) throw new Error('sourceId가 중복되었습니다.')
    return sources
  }
  private sameArtifactSources(before: ProjectArtifactSourceRef[], after: ProjectArtifactSourceRef[]): boolean {
    if (before.length !== after.length) return false
    const current = new Map(before.map((source) => [source.sourceId, source]))
    return after.every((source) => {
      const existing = current.get(source.sourceId)
      return existing?.rootId === source.rootId
        && existing.artifactRootId === source.artifactRootId
        && existing.artifactId === source.artifactId
        && existing.relativePath === source.relativePath
    })
  }
  private async status(path: string | undefined): Promise<ProjectFolderStatus> { if (!path) return 'missing'; try { await stat(path); await access(path); return 'available' } catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'missing' } }
  private pathError(error: unknown): Error { const code = (error as NodeJS.ErrnoException).code; return new Error(code === 'EACCES' || code === 'EPERM' ? '선택한 폴더에 접근할 권한이 없습니다.' : '선택한 폴더를 찾을 수 없습니다.') }
  private profiles(value: ProjectEquipmentProfile[]): ProjectEquipmentProfile[] { if (!Array.isArray(value)) throw new Error('장비 profile이 올바르지 않습니다.'); return value.map((p) => ({ alias: text(p.alias, '장비 alias', 120), profileId: id(p.profileId, 'profileId'), updatedAt: text(p.updatedAt, 'updatedAt', 80), ...(p.vendor === undefined ? {} : { vendor: optionalVendor(p.vendor, 'vendor') }), ...(p.socModels === undefined ? {} : { socModels: this.texts(p.socModels, 'socModels', 40) }), ...(p.filenameAliases === undefined ? {} : { filenameAliases: this.texts(p.filenameAliases, 'filenameAliases', 80) }) })) }
  private pins(value: ProjectTemplatePin[]): ProjectTemplatePin[] { if (!Array.isArray(value)) throw new Error('template pin이 올바르지 않습니다.'); return value.map((p) => ({ templateId: id(p.templateId, 'templateId'), revision: revision(p.revision), pinnedAt: text(p.pinnedAt, 'pinnedAt', 80) })) }
  private presets(value: ProjectExportPreset[]): ProjectExportPreset[] { if (!Array.isArray(value)) throw new Error('export preset이 올바르지 않습니다.'); return value.map((p) => ({ ...p, id: id(p.id, 'presetId'), name: text(p.name, 'preset 이름'), format: p.format, options: presetOptions(p.options), createdAt: text(p.createdAt, 'createdAt', 80), updatedAt: text(p.updatedAt, 'updatedAt', 80) })) }
  private defaults(project: StoredProject): void {
    // v2 already permits these optional fields, so a corrupt legacy value can
    // otherwise survive until an unrelated partial save combines it with new
    // input. Normalize all memory fields as one transaction: a broken graph
    // must never leave a partially trusted hypothesis/node/evidence set.
    try { project.equipmentProfiles = this.profiles(project.equipmentProfiles ?? []) } catch { project.equipmentProfiles = [] }
    try {
      project.lpddrDevelopmentContext = project.lpddrDevelopmentContext === undefined
        ? {}
        : this.context(project.lpddrDevelopmentContext)
    } catch {
      project.lpddrDevelopmentContext = {}
    }
    try {
      const memory = this.memory(
        project.failureHypotheses ?? [], project.evaluationNodes ?? [], project.evidenceRecords ?? [], project.artifacts
      )
      project.failureHypotheses = memory.hypotheses
      project.evaluationNodes = memory.nodes
      project.evidenceRecords = memory.evidence
    } catch {
      project.failureHypotheses = []
      project.evaluationNodes = []
      project.evidenceRecords = []
    }
  }
  private context(value: ProjectLpddrDevelopmentContext): ProjectLpddrDevelopmentContext {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LPDDR 개발 context가 올바르지 않습니다.')
    const legacy = value as ProjectLpddrDevelopmentContext & { sku?: unknown }
    return {
      product: optionalText(value.product, 'product', 120), skew: optionalText(value.skew ?? legacy.sku, 'skew', 120),
      program: optionalText(value.program, 'program', 120), phase: optionalText(value.phase, 'phase', 120),
      customer: optionalText(value.customer, 'customer', 160), targetDevice: optionalText(value.targetDevice, 'targetDevice', 160),
      densityGb: optionalPositiveNumber(value.densityGb, 'densityGb'), nominalVoltage: optionalPositiveNumber(value.nominalVoltage, 'nominalVoltage'),
    }
  }
  private dimensions(value: unknown): ProjectEvaluationDimensions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('평가 조건이 올바르지 않습니다.')
    const v = value as Record<string, unknown>
    return { skew: optionalText(v.skew ?? v.sku, 'skew', 120), lot: optionalText(v.lot, 'lot', 120), material: optionalText(v.material, 'material', 120), die: optionalText(v.die, 'die', 120), sample: optionalText(v.sample, 'sample', 120), socVendor: optionalVendor(v.socVendor, 'socVendor'), socModel: optionalText(v.socModel, 'socModel', 120), bootProfileId: optionalText(v.bootProfileId, 'bootProfileId', 120), bl: optionalDimension(v.bl, 'bl'), dq: optionalDimension(v.dq, 'dq'), channel: optionalDimension(v.channel, 'channel'), subChannel: optionalDimension(v.subChannel, 'subChannel'), chipSelect: optionalDimension(v.chipSelect, 'chipSelect'), rank: optionalDimension(v.rank, 'rank'), bank: optionalDimension(v.bank, 'bank'), bankGroup: optionalDimension(v.bankGroup, 'bankGroup'), row: optionalDimension(v.row, 'row'), column: optionalDimension(v.column, 'column'), pattern: optionalDimension(v.pattern, 'pattern'), writeData: optionalDimension(v.writeData, 'writeData'), readData: optionalDimension(v.readData, 'readData'), gridId: optionalText(v.gridId, 'gridId', 120), frequencyMHz: optionalNumber(v.frequencyMHz, 'frequencyMHz'), temperatureC: optionalNumber(v.temperatureC, 'temperatureC'), temperatureCorner: optionalText(v.temperatureCorner, 'temperatureCorner', 40), vdd: optionalNumber(v.vdd, 'vdd'), vddCorner: optionalText(v.vddCorner, 'vddCorner', 40), conditionCorner: optionalText(v.conditionCorner, 'conditionCorner', 40), timingSkewPs: optionalNumber(v.timingSkewPs ?? v.skewPs, 'timingSkewPs'), testMode: optionalText(v.testMode, 'testMode', 120) }
  }
  private memory(hypothesesValue: unknown, nodesValue: unknown, evidenceValue: unknown, artifacts: ProjectArtifactSourceRef[]): { hypotheses: ProjectFailureHypothesis[]; nodes: ProjectEvaluationNode[]; evidence: ProjectEvidenceRecord[] } {
    if (!Array.isArray(hypothesesValue) || !Array.isArray(nodesValue) || !Array.isArray(evidenceValue) || hypothesesValue.length > 200 || nodesValue.length > 1_000 || evidenceValue.length > 5_000) throw new Error('평가 메모리 크기가 올바르지 않습니다.')
    const hypotheses = hypothesesValue.map((value): ProjectFailureHypothesis => { const v = value as Record<string, unknown>; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('failure hypothesis가 올바르지 않습니다.'); return { id: id(v.id, 'hypothesisId'), title: text(v.title, 'hypothesis title', 240), ...(v.description === undefined ? {} : { description: text(v.description, 'hypothesis description', 2_000) }), origin: origin(v.origin, 'hypothesis origin'), ...(v.evaluationNodeIds === undefined ? {} : { evaluationNodeIds: this.ids(v.evaluationNodeIds, 'evaluationNodeIds', 1_000) }) } })
    const nodes = nodesValue.map((value): ProjectEvaluationNode => { const v = value as Record<string, unknown>; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('evaluation node가 올바르지 않습니다.'); const purpose = v.purpose === undefined ? undefined : String(v.purpose); if (purpose !== undefined && !['screening', 'improvement', 'reproduction', 'characterization', 'verification', 'stage-verification'].includes(purpose)) throw new Error('evaluation purpose가 올바르지 않습니다.'); return { id: id(v.id, 'nodeId'), ...(v.hypothesisId === undefined ? {} : { hypothesisId: id(v.hypothesisId, 'hypothesisId') }), ...(v.parentId === undefined ? {} : { parentId: id(v.parentId, 'parentId') }), ...(v.branchId === undefined ? {} : { branchId: id(v.branchId, 'branchId') }), ...(v.evaluationScopeId === undefined ? {} : { evaluationScopeId: id(v.evaluationScopeId, 'evaluationScopeId') }), name: text(v.name, 'node name', 240), ...(purpose === undefined ? {} : { purpose: purpose as ProjectEvaluationNode['purpose'] }), dimensions: this.dimensions(v.dimensions), ...(v.status === undefined ? {} : { status: status(v.status, 'node status') }), ...(v.interpretation === undefined ? {} : { interpretation: text(v.interpretation, 'evaluation interpretation', 4_000) }), ...(v.authorship === undefined ? {} : { authorship: authorship(v.authorship) }), ...(v.reviewState === undefined ? {} : { reviewState: reviewState(v.reviewState) }), ...(v.sequenceSignature === undefined ? {} : { sequenceSignature: text(v.sequenceSignature, 'sequenceSignature', 200) }), ...(v.attemptNo === undefined ? {} : { attemptNo: optionalPositiveInteger(v.attemptNo, 'attemptNo') }), ...(v.retestOf === undefined ? {} : { retestOf: id(v.retestOf, 'retestOf') }), ...(v.relation === undefined ? {} : { relation: evaluationRelation(v.relation) }), ...(v.relationConfidence === undefined ? {} : { relationConfidence: relationConfidence(v.relationConfidence) }), ...(v.relationReason === undefined ? {} : { relationReason: text(v.relationReason, 'relationReason', 800) }) } })
    const nodeIds = new Set(nodes.map((node) => node.id)); const hypothesisIds = new Set(hypotheses.map((hypothesis) => hypothesis.id)); const sourceIds = new Set(artifacts.map((artifact) => artifact.sourceId)); this.unique(hypothesisIds, hypotheses.length, 'hypothesisId'); this.unique(nodeIds, nodes.length, 'nodeId')
    if (nodes.some((node) => (node.parentId && !nodeIds.has(node.parentId)) || (node.retestOf && (node.retestOf === node.id || !nodeIds.has(node.retestOf))) || (node.hypothesisId && !hypothesisIds.has(node.hypothesisId)))) throw new Error('evaluation node 참조가 올바르지 않습니다.')
    if (hypotheses.some((hypothesis) => hypothesis.evaluationNodeIds?.some((nodeId) => !nodeIds.has(nodeId)))) throw new Error('failure hypothesis 참조가 올바르지 않습니다.')
    const evidence = evidenceValue.map((value): ProjectEvidenceRecord => { const v = value as Record<string, unknown>; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('evidence record가 올바르지 않습니다.'); const record = { id: id(v.id, 'evidenceId'), evaluationNodeId: id(v.evaluationNodeId, 'evaluationNodeId'), status: status(v.status, 'evidence status'), sourceIds: this.ids(v.sourceIds, 'sourceIds', 200), ...(v.occurredAt === undefined ? {} : { occurredAt: text(v.occurredAt, 'occurredAt', 80) }), ...(v.result === undefined ? {} : { result: text(v.result, 'result', 2_000) }), ...(v.dimensions === undefined ? {} : { dimensions: this.dimensions(v.dimensions) }), ...(v.note === undefined ? {} : { note: text(v.note, 'note', 4_000) }), ...(v.origin === undefined ? {} : { origin: origin(v.origin, 'evidence origin') }) }; if (!nodeIds.has(record.evaluationNodeId) || record.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) throw new Error('evidence record 참조가 올바르지 않습니다.'); return record })
    this.unique(new Set(evidence.map((record) => record.id)), evidence.length, 'evidenceId')
    return { hypotheses, nodes, evidence }
  }
  private ids(value: unknown, name: string, max: number): string[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${name}이(가) 올바르지 않습니다.`); const values = value.map((item) => id(item, name)); this.unique(new Set(values), values.length, name); return values }
  private texts(value: unknown, name: string, max: number): string[] { if (!Array.isArray(value) || value.length > max) throw new Error(`${name}이(가) 올바르지 않습니다.`); const values = value.map((item) => text(item, name, 160)); this.unique(new Set(values), values.length, name); return values }
  private unique(values: Set<string>, expected: number, name: string): void { if (values.size !== expected) throw new Error(`${name}이(가) 중복되었습니다.`) }
}
