import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, EvaluationProjectSnapshot, ProjectSnapshot } from '../electron/shared/contracts'
import {
  appliedBatchRulesByFolder,
  availableEvaluationLogs,
  createLatestProjectSaveQueue,
  projectArtifactFiles,
  projectLoadFileState,
  reconcileProjectListedFiles,
  reconcileProjectUpdateFileState,
} from './App'
import type { WorkbenchFile } from './views/WorkbenchView'
import type { LogResultRecord } from './state/logRecords'
import type { RecipeRule } from './domain/workbench'

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
  it('restores the cumulative rule set most recently applied to an evaluation folder', () => {
    const savedRule: RecipeRule = {
      id: 'rule-pass',
      label: 'PASS',
      status: 'candidate',
      scope: { kind: 'analysis' },
      clauses: [{
        id: 'clause-pass',
        presence: 'present',
        occurrence: { kind: 'atLeast', count: 1 },
        matcher: { kind: 'literal', pattern: '@PASS', caseSensitive: false, target: 'content' },
        sourceObservationId: 'observation-pass',
      }],
      priority: 0,
      confidence: 0.9,
      repetition: 1,
      createdFromSourceIds: ['file-a'],
    }
    const snapshot: EvaluationProjectSnapshot = {
      schemaVersion: 1,
      projectIdHash: 'project',
      revision: 1,
      decisions: [],
      recipes: [
        { id: 'saved-revision', recipeId: 'saved-pass', revision: 1, name: 'PASS', rules: [savedRule], createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'batch-revision', recipeId: 'active-batch-ruleset', revision: 1, name: 'Applied rules', rules: [savedRule], createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      batches: [{
        id: 'batch-a',
        status: 'completed',
        recipeRevisionIds: ['batch-revision'],
        outcomes: [{
          source: { sourceId: 'file-a', artifactId: 'artifact-a', sourceKeyHash: 'source-a' },
          result: 'PASS',
          outcomeSource: 'rule',
          matchedRuleId: 'rule-pass',
          evidenceRefs: [],
        }],
        matchedCount: 1,
        exceptionCount: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
      }],
      metadataApprovals: [],
    }

    expect(appliedBatchRulesByFolder([
      { id: 'file-a', name: 'file-a.log', artifactId: 'artifact-a', rootId: 'root-a' },
    ], snapshot)).toEqual({ 'root:root-a': [savedRule] })
  })

  it('serializes immediate memory saves against the latest saved revision', async () => {
    let current = { revision: 1, value: '' }
    const seen: Array<{ revision: number; value: string }> = []
    const queue = createLatestProjectSaveQueue(
      () => current,
      async (project, value: string) => {
        seen.push({ revision: project.revision, value })
        return { revision: project.revision + 1, value }
      },
      (saved) => { current = saved },
    )
    await Promise.all([queue('first'), queue('second')])
    expect(seen).toEqual([{ revision: 1, value: 'first' }, { revision: 2, value: 'second' }])
    expect(current).toEqual({ revision: 3, value: 'second' })
  })

  it('propagates a rejected save without blocking the subsequent queued save', async () => {
    let current = { revision: 1, value: '' }
    const queue = createLatestProjectSaveQueue(
      () => current,
      async (project, value: string) => {
        if (value === 'reject') throw new Error('disk unavailable')
        return { revision: project.revision + 1, value }
      },
      (saved) => { current = saved },
    )
    const rejected = queue('reject')
    const saved = queue('persisted')
    await expect(rejected).rejects.toThrow('disk unavailable')
    await expect(saved).resolves.toEqual({ revision: 2, value: 'persisted' })
    expect(current).toEqual({ revision: 2, value: 'persisted' })
  })

  it('maps result rows to evaluation-memory log references without losing source identity', () => {
    const row: LogResultRecord = {
      id: 'source-a', fileName: 'VPERI_DQ9.log', folder: 'logs', relativePath: 'VPERI_DQ9.log',
      sample: { value: 'S01', state: 'approved' }, temperature: { value: '85', state: 'approved' },
      mode: { value: 'VPERI', state: 'approved' }, grid: { value: 'DQ9', state: 'candidate' },
      result: 'TEST_FAIL', resultSource: 'engineer', stageResults: [], review: 'confirmed', evidenceCount: 1, selectedEvidenceCount: 1,
    }
    const projectWithSource = { ...project('p1', ['root-a']), artifacts: [{ sourceId: 'durable-source-a', rootId: 'root-a', artifactId: 'artifact-a', relativePath: 'VPERI_DQ9.log' }] }
    const rendererFile: WorkbenchFile = { id: 'renderer-row-a', name: row.fileName, artifactId: 'artifact-a', rootId: 'root-a', relativePath: 'VPERI_DQ9.log' }
    const mappedRow = { ...row, id: rendererFile.id }
    expect(availableEvaluationLogs([mappedRow], [rendererFile], projectWithSource)).toEqual([{
      id: 'durable-source-a', openId: 'renderer-row-a', rootId: 'root-a', folderName: 'root-a', name: 'VPERI_DQ9.log', result: 'TEST_FAIL', sample: 'S01', temperatureC: 85, mode: 'VPERI', grid: 'DQ9',
    }])
    expect(availableEvaluationLogs([mappedRow], [rendererFile], { ...projectWithSource, artifacts: [] })).toEqual([])
  })

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

  it('keeps the active project isolated when the artifact store contains other project sources', () => {
    const shared = artifact('shared-artifact', 'root-project')
    shared.sources = [
      { rootId: 'root-project', folderLabel: 'project logs', relativePath: 'same.log' },
      { rootId: 'root-other', folderLabel: 'other logs', relativePath: 'same.log' },
    ]
    const unrelated = artifact('other-artifact', 'root-other')
    const sources = [{ sourceId: 'source-project', rootId: 'root-project', artifactId: shared.id, relativePath: 'same.log' }]

    const scoped = projectArtifactFiles([shared, unrelated], sources)
    const reconciled = reconcileProjectListedFiles([
      file('stale-global', 'root-other'),
      ...scoped,
    ], [shared, unrelated], sources)

    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ artifactId: shared.id, rootId: 'root-project', relativePath: 'same.log' })
    expect(reconciled).toEqual(scoped)
  })
})
