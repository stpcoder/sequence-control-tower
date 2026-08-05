import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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
    expect(await readFile(rootsFile, 'utf8')).toContain(folder)
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
})
