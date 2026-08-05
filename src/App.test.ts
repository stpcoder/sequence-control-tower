import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, ProjectSnapshot } from '../electron/shared/contracts'
import {
  projectLoadFileState,
  reconcileProjectUpdateFileState,
} from './App'
import type { WorkbenchFile } from './views/WorkbenchView'

function project(id: string, roots: string[]): ProjectSnapshot {
  return {
    schemaVersion: 2,
    id,
    name: id,
    revision: 1,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    folders: roots.map((rootId) => ({ rootId, displayLabel: rootId, status: 'available', connectedAt: '2026-01-01T00:00:00.000Z' })),
    artifacts: [],
    equipmentProfiles: [],
    templatePins: [],
    exportPresets: [],
  }
}

function file(id: string, rootId?: string): WorkbenchFile {
  return { id, name: `${id}.log`, ...(rootId ? { rootId } : {}) }
}

function artifact(id: string, rootId: string): ArtifactRecord {
  return {
    id,
    sha256: id,
    size: 10,
    extension: '.log',
    originalNames: [`${id}.log`],
    importedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    importCount: 1,
    sources: [{ rootId, folderLabel: rootId, relativePath: `${id}.log` }],
  }
}

describe('project UI state updates', () => {
  it('keeps files and selection when validation changes only folder status', () => {
    const previous = project('p1', ['root-a'])
    const next = { ...previous, folders: [{ ...previous.folders[0], status: 'missing' as const }] }
    const state = reconcileProjectUpdateFileState([file('a', 'root-a')], 'a', previous, next)

    expect(state).toEqual({ files: [file('a', 'root-a')], selectedFileId: 'a' })
  })

  it('removes detached-root rows but keeps unrelated project rows and selection', () => {
    const previous = project('p1', ['root-a', 'root-b'])
    const next = project('p1', ['root-b'])
    const state = reconcileProjectUpdateFileState([file('a', 'root-a'), file('b', 'root-b'), file('legacy')], 'b', previous, next)

    expect(state.files.map((item) => item.id)).toEqual(['b', 'legacy'])
    expect(state.selectedFileId).toBe('b')
  })

  it('falls back to an unrelated row when the detached row was selected', () => {
    const previous = project('p1', ['root-a', 'root-b'])
    const next = project('p1', ['root-b'])
    const state = reconcileProjectUpdateFileState([file('a', 'root-a'), file('b', 'root-b')], 'a', previous, next)

    expect(state.selectedFileId).toBe('b')
  })

  it('replaces files and selection only for a full project switch', () => {
    const state = projectLoadFileState([artifact('new-artifact', 'root-new')])

    expect(state.files).toHaveLength(1)
    expect(state.files[0].artifactId).toBe('new-artifact')
    expect(state.files[0].rootId).toBe('root-new')
    expect(state.selectedFileId).toBe(state.files[0].id)
  })
})
