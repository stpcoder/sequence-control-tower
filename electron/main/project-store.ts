import { access, chmod, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, basename, resolve } from 'node:path'
import type {
  ProjectArchiveExportPresetInput, ProjectArchiveInput, ProjectArtifactSourceRef, ProjectConnectArtifactsInput,
  ProjectCreateInput, ProjectEquipmentProfile, ProjectExportPreset, ProjectFolderRef, ProjectFolderStatus,
  ProjectSaveExportPresetInput, ProjectSaveInput, ProjectSnapshot, ProjectTemplatePin
} from '../shared/contracts'
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
    const rootDatabase = await this.roots.read()
    if (rootDatabase.schemaVersion !== 2 || !rootDatabase.roots) await this.roots.update(() => ({ schemaVersion: 2, roots: {} }))
    await chmod(join(this.dataRoot, 'config', 'canonical-roots.json'), 0o600).catch(() => undefined)
    this.initialized = true
  }

  async create(input: ProjectCreateInput): Promise<ProjectSnapshot> {
    await this.initialize(); const name = text(input?.name, '프로젝트 이름'); const description = input?.description === undefined ? undefined : text(input.description, '설명', 2_000)
    const project: StoredProject = { id: randomUUID(), name, ...(description ? { description } : {}), ...(input.onboardingAnswers ? { onboardingAnswers: input.onboardingAnswers } : {}), revision: 0, archived: false, createdAt: now(), updatedAt: now(), folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [] }
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
      const validRoots = new Set(p.folders.map((folder) => folder.rootId)); const next = input.artifacts.map((a): ProjectArtifactSourceRef => ({ sourceId: id(a.sourceId, 'sourceId'), rootId: id(a.rootId, 'rootId'), artifactId: id(a.artifactId, 'artifactId'), relativePath: text(a.relativePath, 'relativePath', 2_000) }))
      if (next.some((a) => !validRoots.has(a.rootId) || a.relativePath.startsWith('/') || a.relativePath.includes('..'))) throw new Error('연결할 artifact source가 프로젝트 폴더에 속하지 않습니다.')
      p.artifacts = [...p.artifacts.filter((a) => !next.some((n) => n.sourceId === a.sourceId)), ...next]
    })
  }

  async saveExportPreset(input: ProjectSaveExportPresetInput): Promise<ProjectSnapshot> { return this.mutate(input.projectId, input.expectedRevision, (p) => { const value = input.preset; const stamp = now(); const existing = value.id ? p.exportPresets.find((preset) => preset.id === value.id) : undefined; const preset: ProjectExportPreset = { id: value.id ? id(value.id, 'presetId') : randomUUID(), name: text(value.name, 'preset 이름'), format: value.format, options: value.options, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp, ...(value.archived ? { archived: true } : {}) }; p.exportPresets = [...p.exportPresets.filter((item) => item.id !== preset.id), preset] }) }
  async archiveExportPreset(input: ProjectArchiveExportPresetInput): Promise<ProjectSnapshot> { return this.mutate(input.projectId, input.expectedRevision, (p) => { const preset = p.exportPresets.find((item) => item.id === id(input.presetId, 'presetId')); if (!preset) throw new Error('export preset을 찾을 수 없습니다.'); preset.archived = true; preset.updatedAt = now() }) }

  private async mutate(projectId: string, expected: number, change: (project: StoredProject) => void): Promise<ProjectSnapshot> {
    await this.initialize(); const projectKey = id(projectId, 'projectId'); let result: StoredProject | undefined
    await this.projects.update((db) => { const p = db.projects[projectKey]; if (!p) throw new Error('프로젝트를 찾을 수 없습니다.'); const wanted = revision(expected); if (p.revision !== wanted) throw new ProjectRevisionConflictError(wanted, p.revision); change(p); p.revision += 1; p.updatedAt = now(); result = p })
    return this.public(result!)
  }
  private public(project: StoredProject): ProjectSnapshot { return { schemaVersion: 2, ...structuredClone(project) } }
  private async status(path: string | undefined): Promise<ProjectFolderStatus> { if (!path) return 'missing'; try { await stat(path); await access(path); return 'available' } catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'missing' } }
  private pathError(error: unknown): Error { const code = (error as NodeJS.ErrnoException).code; return new Error(code === 'EACCES' || code === 'EPERM' ? '선택한 폴더에 접근할 권한이 없습니다.' : '선택한 폴더를 찾을 수 없습니다.') }
  private profiles(value: ProjectEquipmentProfile[]): ProjectEquipmentProfile[] { if (!Array.isArray(value)) throw new Error('장비 profile이 올바르지 않습니다.'); return value.map((p) => ({ alias: text(p.alias, '장비 alias', 120), profileId: id(p.profileId, 'profileId'), updatedAt: text(p.updatedAt, 'updatedAt', 80) })) }
  private pins(value: ProjectTemplatePin[]): ProjectTemplatePin[] { if (!Array.isArray(value)) throw new Error('template pin이 올바르지 않습니다.'); return value.map((p) => ({ templateId: id(p.templateId, 'templateId'), revision: revision(p.revision), pinnedAt: text(p.pinnedAt, 'pinnedAt', 80) })) }
  private presets(value: ProjectExportPreset[]): ProjectExportPreset[] { if (!Array.isArray(value)) throw new Error('export preset이 올바르지 않습니다.'); return value.map((p) => ({ ...p, id: id(p.id, 'presetId'), name: text(p.name, 'preset 이름'), format: p.format, options: p.options, createdAt: text(p.createdAt, 'createdAt', 80), updatedAt: text(p.updatedAt, 'updatedAt', 80) })) }
}
