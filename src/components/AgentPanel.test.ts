import { describe, expect, it } from 'vitest'
import { evaluationDimensionSummary, evaluationProposalTitle, mergeEvaluationAgentMemory, proposalDecisionResult, shouldRetainAgentSession, toolsForAssistantMessage } from './AgentPanel'
import type { EvaluationAgentMemoryPayloadView, NativeAgentMessageView, NativeAgentToolTraceView, ProjectSnapshot } from '../../electron/shared/contracts'

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
    expect(evaluationProposalTitle({ outcome: 'TEST_FAIL', dimensions: { testMode: 'VPERI', dq: 9 }, rationale: '', evidenceIds: [], sourceIds: [] })).toBe('VPERI · DQ9 경향')
    expect(proposalDecisionResult('TEST_FAIL')).toBe('TEST_FAIL')
    expect(proposalDecisionResult('UNKNOWN')).toBeNull()
    expect(evaluationDimensionSummary({ skew: 'SS', channel: 0, subChannel: 1, bank: 5 })).toEqual(['SKEW SS', 'CH 0', 'Sub CH 1', 'Bank 5'])
  })

  it('keeps a live agent session for revision updates but clears it on project switch', () => {
    expect(shouldRetainAgentSession({ ...project, revision: 1 }, { ...project, revision: 2 })).toBe(true)
    expect(shouldRetainAgentSession(project, { ...project, id: 'other' })).toBe(false)
  })

  it('places only the tools used for an answer directly before that answer', () => {
    const messages: NativeAgentMessageView[] = [
      { id: 'u1', role: 'user', content: 'DQ 경향?', createdAt: '2026-08-10T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: '**DQ9** 집중', createdAt: '2026-08-10T00:00:03.000Z', evidenceSourceIds: ['s1'] },
    ]
    const tools: NativeAgentToolTraceView[] = [
      { id: 't1', name: 'failure_trends_get', label: '불량 경향', state: 'completed', startedAt: '2026-08-10T00:00:01.000Z', completedAt: '2026-08-10T00:00:02.000Z', evidenceSourceIds: ['s1'] },
      { id: 't2', name: 'project_history_get', label: '과거 평가', state: 'completed', startedAt: '2026-08-09T23:59:00.000Z', completedAt: '2026-08-09T23:59:01.000Z' },
    ]
    expect(toolsForAssistantMessage(messages[1], messages, tools).map((tool) => tool.id)).toEqual(['t1'])
  })
})
