import { describe, expect, it } from 'vitest'
import type { EvaluationProjectSnapshot, NativeAgentEvaluationProposal, ProjectSnapshot } from '../../electron/shared/contracts'
import { captureNativeEvaluationBasis, nativeEvaluationProposalState, normalizeNativeEvaluationBasis } from '../../src/domain/agent-evaluation-basis'
import type { LogResultRecord } from '../../src/state/logRecords'

const project = { id: 'p', revision: 3, artifacts: [{ sourceId: 's', rootId: 'folder', artifactId: 'a', relativePath: 'a.log' }], evaluationNodes: [] } as unknown as ProjectSnapshot
const snapshot = { revision: 8 } as EvaluationProjectSnapshot
const records = [{ id: 's', evaluationScopeId: 'folder', fileName: 'a.log', result: 'PASS', review: 'confirmed', dimensions: { temperatureC: 85 }, stageResults: [] }] as unknown as LogResultRecord[]
const basis = captureNativeEvaluationBasis(project, snapshot, 'folder', records)!
const proposal = { id: 'draft', basis } as NativeAgentEvaluationProposal

describe('Agent evaluation proposal provenance', () => {
  it('only accepts the same evaluation, project and computed result inputs', () => {
    expect(nativeEvaluationProposalState(project, 'session', proposal, basis)).toBe('ready')
    for (const current of [
      captureNativeEvaluationBasis(project, { ...snapshot, revision: 9 }, 'folder', records),
      captureNativeEvaluationBasis({ ...project, revision: 4 }, snapshot, 'folder', records),
      captureNativeEvaluationBasis(project, snapshot, 'folder', [{ ...records[0], result: 'TEST_FAIL' }]),
      captureNativeEvaluationBasis(project, snapshot, 'folder', [{ ...records[0], dimensions: { temperatureC: 25 } }]),
      captureNativeEvaluationBasis({ ...project, artifacts: [{ ...project.artifacts[0], artifactId: 'replaced' }] }, snapshot, 'folder', records),
      undefined,
    ]) expect(nativeEvaluationProposalState(project, 'session', proposal, current)).toBe('stale')
    expect(nativeEvaluationProposalState(project, 'session', { ...proposal, basis: undefined }, basis)).toBe('stale')
  })

  it('keeps a saved proposal saved after navigation, human edits and subsequent revision changes', () => {
    const saved: ProjectSnapshot = { ...project, revision: 7, evaluationNodes: [{ id: 'node', name: 'human title', dimensions: {}, interpretation: 'later human edit', agentProposal: { sessionId: 'session', proposalId: proposal.id, basis } }] }
    const restored = JSON.parse(JSON.stringify(saved)) as ProjectSnapshot
    expect(nativeEvaluationProposalState(restored, 'session', proposal, undefined)).toBe('saved')
    expect(nativeEvaluationProposalState(restored, 'another-session', proposal, undefined)).toBe('stale')
    expect(nativeEvaluationProposalState(restored, 'session', { ...proposal, id: 'new-draft' }, undefined)).toBe('stale')
  })

  it('ignores row order and object key insertion order but detects source removal', () => {
    const other = { ...records[0], id: 's2', dimensions: { temperatureC: 25, dq: 9 } }
    const first = captureNativeEvaluationBasis(project, snapshot, 'folder', [...records, other])
    const reordered = captureNativeEvaluationBasis(project, snapshot, 'folder', [{ ...other, dimensions: { dq: 9, temperatureC: 25 } }, ...records])
    expect(first).toEqual(reordered)
    expect(captureNativeEvaluationBasis({ ...project, artifacts: [] }, snapshot, 'folder', records)).not.toEqual(basis)
  })

  it('fails closed for missing snapshots and malformed persisted versions', () => {
    expect(captureNativeEvaluationBasis(project, null, 'folder', records)).toBeUndefined()
    expect(captureNativeEvaluationBasis(project, snapshot, 'empty', records)).toBeUndefined()
    for (const value of [null, {}, { ...basis, projectRevision: -1 }, { ...basis, evaluationRevision: '8' }, { ...basis, recordsFingerprint: 'untrusted' }]) expect(normalizeNativeEvaluationBasis(value)).toBeUndefined()
  })
})
