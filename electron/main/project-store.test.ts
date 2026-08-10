import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRevisionConflictError, ProjectStore } from './project-store'

const roots: string[] = []
async function tempRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'project-store-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('ProjectStore', () => {
  it('persists project metadata, canonical roots separately, and never returns a path', async () => {
    const dataRoot = await tempRoot(); const folder = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(folder)
    const store = new ProjectStore(dataRoot); const project = await store.create({ name: 'Bring-up' })
    const attached = await store.attachFolder(project.id, 0, folder)
    expect(attached.folders[0]).toMatchObject({ displayLabel: basename(folder), status: 'available' })
    expect(JSON.stringify(attached)).not.toContain(folder)
    const stored = await readFile(join(dataRoot, 'metadata', 'projects.json'), 'utf8')
    expect(stored).not.toContain(folder)
    const rootsFile = join(dataRoot, 'config', 'canonical-roots.json')
    const rootsDatabase = JSON.parse(await readFile(rootsFile, 'utf8')) as { roots: Record<string, { canonicalPath: string }> }
    expect(Object.values(rootsDatabase.roots).map((root) => root.canonicalPath)).toContain(await realpath(folder))
    if (process.platform !== 'win32') expect((await stat(rootsFile)).mode & 0o777).toBe(0o600)
  })

  it('uses optimistic revisions and archives without deleting physical folders', async () => {
    const dataRoot = await tempRoot(); const folder = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(folder)
    const store = new ProjectStore(dataRoot); const project = await store.create({ name: 'Archive me' })
    const attached = await store.attachFolder(project.id, 0, folder)
    await expect(store.archive({ projectId: project.id, expectedRevision: 0 })).rejects.toBeInstanceOf(ProjectRevisionConflictError)
    const archived = await store.archive({ projectId: project.id, expectedRevision: attached.revision })
    expect(archived.archived).toBe(true); expect(await stat(folder)).toBeDefined()
    expect((await store.list()).find((item) => item.id === project.id)).toBeUndefined()
    expect((await store.list(true)).find((item) => item.id === project.id)?.archived).toBe(true)
  })

  it('reports missing folders and migrates an empty v1 database', async () => {
    const dataRoot = await tempRoot(); const store = new ProjectStore(dataRoot); const created = await store.create({ name: 'Status' })
    const folder = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(folder)
    const attached = await store.attachFolder(created.id, 0, folder); await rm(folder, { recursive: true, force: true })
    expect(await store.validateFolders(created.id)).toMatchObject([{ rootId: attached.folders[0].rootId, status: 'missing' }])
  })

  it('persists recursive JSON-safe export preset options and rejects non-JSON values', async () => {
    const dataRoot = await tempRoot(); const store = new ProjectStore(dataRoot); const project = await store.create({ name: 'Layouts' })
    const saved = await store.saveExportPreset({
      projectId: project.id, expectedRevision: project.revision,
      preset: { id: 'layout', name: 'Layout', format: 'json', options: { axes: ['sample', null], filters: { failOnly: true } } },
    })
    expect(saved.exportPresets[0].options).toEqual({ axes: ['sample', null], filters: { failOnly: true } })
    await expect(store.saveExportPreset({
      projectId: saved.id, expectedRevision: saved.revision,
      preset: { id: 'layout', name: 'Layout', format: 'json', options: { invalid: new Date() } as unknown as Record<string, never> },
    })).rejects.toThrow('JSON')
  })

  it('creates, saves, and reloads bounded LPDDR evaluation memory through projects.save', async () => {
    const dataRoot = await tempRoot(); const folder = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(folder)
    const store = new ProjectStore(dataRoot); const project = await store.create({ name: 'LPDDR6' })
    const attached = await store.attachFolder(project.id, project.revision, folder)
    const connected = await store.connectArtifacts({ projectId: project.id, expectedRevision: attached.revision, artifacts: [{ sourceId: 'log-vperi', rootId: attached.folders[0].rootId, artifactId: 'artifact-vperi', relativePath: 'vperi.log' }] })
    const reconnected = await store.connectArtifacts({ projectId: project.id, expectedRevision: connected.revision, artifacts: [{ sourceId: 'log-vperi', rootId: attached.folders[0].rootId, artifactId: 'artifact-vperi', relativePath: 'vperi.log' }] })
    expect(reconnected.revision).toBe(connected.revision)
    const payload = {
      projectId: project.id, expectedRevision: reconnected.revision,
      lpddrDevelopmentContext: { product: 'LPDDR6', skew: 'SS', phase: 'bring-up', customer: 'Acme', targetDevice: 'Orion', densityGb: 16, nominalVoltage: 1.1 },
      equipmentProfiles: [{ alias: 'SM-8975 실장기', profileId: 'qualcomm-default', vendor: 'qualcomm' as const, socModels: ['SM-8975'], filenameAliases: ['SM8975'], updatedAt: '2026-08-10T00:00:00.000Z' }],
      failureHypotheses: [{ id: 'h-dq9', title: 'VPERI DQ9', origin: 'engineer-confirmed' as const, evaluationNodeIds: ['dq9'] }],
      evaluationNodes: [
        { id: 'base', name: 'baseline', purpose: 'screening' as const, dimensions: { bl: 16, temperatureC: 85, die: '03', socVendor: 'qualcomm' as const, socModel: 'SM-8975', bootProfileId: 'qualcomm-default' }, sequenceSignature: 'seq:vperi', attemptNo: 1, status: 'fail' as const },
        { id: 'dq9', parentId: 'base', retestOf: 'base', hypothesisId: 'h-dq9', branchId: 'vperi', evaluationScopeId: attached.folders[0].rootId, name: 'DQ9 RT', purpose: 'reproduction' as const, dimensions: { dq: 9, testMode: 'VPERI' }, interpretation: 'DQ9에서 동일 조건 재평가도 실패했습니다.', authorship: 'agent' as const, reviewState: 'confirmed' as const, sequenceSignature: 'seq:vperi', attemptNo: 2, status: 'fail' as const },
      ],
      evidenceRecords: [{ id: 'e-dq9', evaluationNodeId: 'dq9', status: 'fail' as const, sourceIds: ['log-vperi'], result: 'repeatable fail' }],
    }
    const saved = await store.save(payload)
    expect(saved.lpddrDevelopmentContext).toEqual(payload.lpddrDevelopmentContext)
    expect(saved.equipmentProfiles).toEqual(payload.equipmentProfiles)
    expect(saved.evidenceRecords).toEqual(payload.evidenceRecords)
    expect((await new ProjectStore(dataRoot).get(project.id))?.evaluationNodes).toEqual(payload.evaluationNodes)
    await expect(store.save({ ...payload, expectedRevision: saved.revision, evidenceRecords: [{ ...payload.evidenceRecords[0], id: 'bad', sourceIds: ['not-connected'] }] })).rejects.toThrow('evidence record')
    await expect(store.save({ ...payload, expectedRevision: saved.revision, lpddrDevelopmentContext: { ...payload.lpddrDevelopmentContext, nominalVoltage: 0 } })).rejects.toThrow('nominalVoltage')
    await expect(store.save({ ...payload, expectedRevision: saved.revision, lpddrDevelopmentContext: { ...payload.lpddrDevelopmentContext, densityGb: -1 } })).rejects.toThrow('densityGb')
  })

  it('synchronizes current log sources while retaining evidence-backed history', async () => {
    const dataRoot = await tempRoot(); const folder = await mkdtemp(join(tmpdir(), 'project-folder-')); roots.push(folder)
    const store = new ProjectStore(dataRoot); const project = await store.create({ name: 'Source sync' })
    const attached = await store.attachFolder(project.id, project.revision, folder)
    const rootId = attached.folders[0].rootId
    const connected = await store.connectArtifacts({ projectId: project.id, expectedRevision: attached.revision, artifacts: [
      { sourceId: 'keep-history', rootId, artifactId: 'old-log', relativePath: 'old.log' },
      { sourceId: 'remove-manifest', rootId, artifactId: 'manifest', relativePath: 'manifest.json' },
      { sourceId: 'replace-log', rootId, artifactId: 'replace-old', relativePath: 'replace.log' },
    ] })
    const withMemory = await store.save({
      projectId: project.id, expectedRevision: connected.revision,
      evaluationNodes: [{ id: 'node', name: 'historical fail', dimensions: {}, status: 'fail' }],
      evidenceRecords: [{ id: 'evidence', evaluationNodeId: 'node', status: 'fail', sourceIds: ['keep-history'] }],
    })
    const synced = await store.syncArtifacts({ projectId: project.id, expectedRevision: withMemory.revision, artifacts: [
      { sourceId: 'replace-log', rootId, artifactId: 'replace-new', relativePath: 'replace.log' },
      { sourceId: 'new-log', rootId, artifactId: 'new-log', relativePath: 'new.log' },
    ] }, [rootId])
    expect(synced.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'keep-history', artifactId: 'old-log' }),
      expect.objectContaining({ sourceId: 'replace-log', artifactId: 'replace-new' }),
      expect.objectContaining({ sourceId: 'new-log' }),
    ]))
    expect(synced.artifacts.some((source) => source.sourceId === 'remove-manifest')).toBe(false)
    expect(synced.evidenceRecords?.[0].sourceIds).toEqual(['keep-history'])
    const unchanged = await store.syncArtifacts({ projectId: project.id, expectedRevision: synced.revision, artifacts: [
      { sourceId: 'replace-log', rootId, artifactId: 'replace-new', relativePath: 'replace.log' },
      { sourceId: 'new-log', rootId, artifactId: 'new-log', relativePath: 'new.log' },
    ] }, [rootId])
    expect(unchanged.revision).toBe(synced.revision)
  })

  it('adds empty LPDDR memory fields when reading a legacy v2 project and rejects broken references', async () => {
    const dataRoot = await tempRoot(); await mkdir(join(dataRoot, 'metadata'), { recursive: true })
    await writeFile(join(dataRoot, 'metadata', 'projects.json'), JSON.stringify({ schemaVersion: 2, projects: {
      legacy: { id: 'legacy', name: 'Legacy', revision: 0, archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [] },
    } }))
    const store = new ProjectStore(dataRoot); const legacy = await store.get('legacy')
    expect(legacy).toMatchObject({ lpddrDevelopmentContext: {}, failureHypotheses: [], evaluationNodes: [], evidenceRecords: [] })
    await expect(store.save({ projectId: 'legacy', expectedRevision: 0, evaluationNodes: [{ id: 'orphan', parentId: 'missing', name: 'orphan', dimensions: {} }] })).rejects.toThrow('evaluation node')
  })

  it('atomically clears malformed present legacy memory before later partial saves', async () => {
    const dataRoot = await tempRoot(); await mkdir(join(dataRoot, 'metadata'), { recursive: true })
    await writeFile(join(dataRoot, 'metadata', 'projects.json'), JSON.stringify({ schemaVersion: 2, projects: {
      broken: {
        id: 'broken', name: 'Broken', revision: 3, archived: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [],
        lpddrDevelopmentContext: ['not-an-object'],
        failureHypotheses: { id: 'not-an-array' },
        evaluationNodes: [{ id: 'n1', hypothesisId: 'missing', name: 'orphan', dimensions: {} }],
        evidenceRecords: [{ id: 'e1', evaluationNodeId: 'n1', status: 'fail', sourceIds: [] }],
      },
    } }))
    const store = new ProjectStore(dataRoot); const normalized = await store.get('broken')
    expect(normalized).toMatchObject({ lpddrDevelopmentContext: {}, failureHypotheses: [], evaluationNodes: [], evidenceRecords: [] })
    const renamed = await store.save({ projectId: 'broken', expectedRevision: 3, name: 'Recovered' })
    expect(renamed.name).toBe('Recovered')
    expect(renamed.evidenceRecords).toEqual([])
    const persisted = JSON.parse(await readFile(join(dataRoot, 'metadata', 'projects.json'), 'utf8'))
    expect(persisted.projects.broken.lpddrDevelopmentContext).toEqual({})
    expect(persisted.projects.broken.failureHypotheses).toEqual([])
  })
})
