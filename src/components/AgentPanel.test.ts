import { describe, expect, it } from 'vitest'
import { evaluationProposalTitle, mergeEvaluationAgentMemory, shouldRetainAgentSession } from './AgentPanel'
import type { EvaluationAgentMemoryPayloadView, ProjectSnapshot } from '../../electron/shared/contracts'

const project: ProjectSnapshot = { schemaVersion: 2, id: 'p1', name: 'P', revision: 4, archived: false, createdAt: '', updatedAt: '', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [] }

describe('mergeEvaluationAgentMemory', () => {
  it('adds confirmed hypothesis, node, and source-linked evidence without replacing existing memory', () => {
    const payload: EvaluationAgentMemoryPayloadView = {
      hypothesis: { id: 'h2', projectId: 'p1', title: 'FAIL', origin: 'ai-proposed', evaluationNodeIds: ['n2'] },
      node: { id: 'n2', projectId: 'p1', hypothesisId: 'h2', name: 'Agent proposal', dimensions: { dq: 8 }, status: 'fail' },
      evidence: [{ id: 'e2', projectId: 'p1', evaluationNodeId: 'n2', status: 'fail', result: 'FAIL', sourceIds: ['s1'], summary: 'bounded summary', origin: 'ai-proposed' }]
    }
    const next = mergeEvaluationAgentMemory({ ...project, failureHypotheses: [{ id: 'h1', title: 'old', origin: 'engineer-confirmed' }] }, payload)
    expect(next.failureHypotheses).toHaveLength(2)
    const retried = mergeEvaluationAgentMemory(next, payload)
    expect(retried.failureHypotheses).toHaveLength(2)
    expect(retried.evidenceRecords).toEqual([expect.objectContaining({ id: 'e2', sourceIds: ['s1'], note: 'bounded summary', origin: 'engineer-confirmed' })])
  })

  it('uses a useful Korean-style trend title from confirmed dimensions', () => {
    expect(evaluationProposalTitle({ outcome: 'FAIL', dimensions: { testMode: 'VPERI', dq: 9 }, rationale: '', evidenceIds: [], sourceIds: [] })).toBe('VPERI · DQ9 경향')
  })

  it('keeps a live agent session for revision updates but clears it on project switch', () => {
    expect(shouldRetainAgentSession({ ...project, revision: 1 }, { ...project, revision: 2 })).toBe(true)
    expect(shouldRetainAgentSession(project, { ...project, id: 'other' })).toBe(false)
  })
})
