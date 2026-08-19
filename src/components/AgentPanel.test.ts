import { describe, expect, it } from 'vitest'
import { agentEvaluationPurposeLabel, agentEvaluationRelationSuggestion, agentEvaluationSources, applyEvaluationAgentRelation, evaluationAgentRecordPrefix, evaluationDimensionSummary, evaluationIntentForAgent, evaluationOutcomeLabel, evaluationProposalTitle, isAgentThreadNearBottom, isEvaluationProposalSaved, mergeEvaluationAgentMemory, proposalDecisionResult, proposalSourceDecisions, resolveEvaluationRelationChoice, reusableNativeLaunchSessionId, shouldRestoreEvaluationReview, shouldRetainAgentSession, shouldShowNativeAgentSuggestions, toolsForAssistantMessage, toolsForCurrentAgentRun } from './AgentPanel'
import type { EvaluationAgentMemoryPayloadView, EvaluationAgentSessionView, NativeAgentMessageView, NativeAgentSessionView, NativeAgentToolTraceView, ProjectSnapshot } from '../../electron/shared/contracts'

const project: ProjectSnapshot = { schemaVersion: 2, id: 'p1', name: 'P', revision: 4, archived: false, createdAt: '', updatedAt: '', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [] }

describe('mergeEvaluationAgentMemory', () => {
  it('adds confirmed hypothesis, node, and source-linked evidence without replacing existing memory', () => {
    const payload: EvaluationAgentMemoryPayloadView = {
      hypothesis: { id: 'h2', projectId: 'p1', title: 'FAIL', origin: 'ai-proposed', evaluationNodeIds: ['n2'] },
      node: { id: 'n2', projectId: 'p1', hypothesisId: 'h2', name: 'Agent proposal', dimensions: { dq: 8 }, status: 'fail', evaluationScopeId: 'folder-a', interpretation: 'DQ8에서 반복 실패했으며 추가 전압 비교가 필요합니다.', authorship: 'agent', reviewState: 'confirmed' },
      evidence: [{ id: 'e2', projectId: 'p1', evaluationNodeId: 'n2', status: 'fail', result: 'FAIL', sourceIds: ['s1'], summary: 'bounded summary', origin: 'ai-proposed' }]
    }
    const next = mergeEvaluationAgentMemory({ ...project, failureHypotheses: [{ id: 'h1', title: 'old', origin: 'engineer-confirmed' }] }, payload)
    expect(next.failureHypotheses).toHaveLength(2)
    const retried = mergeEvaluationAgentMemory(next, payload)
    expect(retried.failureHypotheses).toHaveLength(2)
    expect(retried.evaluationNodes?.[0]).toMatchObject({ evaluationScopeId: 'folder-a', authorship: 'agent', reviewState: 'confirmed', interpretation: expect.stringContaining('추가 전압') })
    expect(retried.evidenceRecords).toEqual([expect.objectContaining({ id: 'e2', sourceIds: ['s1'], note: 'bounded summary', origin: 'engineer-confirmed' })])
  })

  it('links a new evaluation folder to the existing issue and updates repeated folder analysis in place', () => {
    const history: ProjectSnapshot = {
      ...project,
      failureHypotheses: [{ id: 'h-vperi', title: 'VPERI DQ9 반복 불량', origin: 'engineer-confirmed', evaluationNodeIds: ['n-screen'] }],
      evaluationNodes: [{ id: 'n-screen', hypothesisId: 'h-vperi', evaluationScopeId: 'folder-screen', branchId: 'issue:h-vperi:main', name: 'screen', purpose: 'screening', status: 'fail', dimensions: { testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16 } }],
    }
    const run: EvaluationAgentSessionView = {
      schemaVersion: 1, id: 'run-improve', status: 'waiting_confirmation', evaluationIntent: 'VDD 개선 확인',
      calls: 2, searches: 1, depth: 1, files: [], evidence: [], transcript: [], dimensions: {},
      proposal: { outcome: 'PASS', purpose: 'improvement', dimensions: { testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16, vdd: 1.315 }, rationale: 'VDD 상향 후 PASS', evidenceIds: ['agent-e'], sourceIds: ['source-2'] },
    }
    const payload: EvaluationAgentMemoryPayloadView = {
      hypothesis: { id: 'generated-h', projectId: 'p1', title: 'generated', origin: 'ai-proposed', evaluationNodeIds: ['generated-n'] },
      node: { id: 'generated-n', projectId: 'p1', hypothesisId: 'generated-h', evaluationScopeId: 'folder-improve', name: 'VDD 개선', purpose: 'improvement', status: 'pass', dimensions: run.proposal!.dimensions },
      evidence: [{ id: 'generated-e', projectId: 'p1', evaluationNodeId: 'generated-n', status: 'pass', sourceIds: ['source-2'] }],
    }
    const suggested = agentEvaluationRelationSuggestion(history, run, 'folder-improve')!
    expect(suggested).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', parentNodeId: 'n-screen', relation: 'improvement' })
    const linked = applyEvaluationAgentRelation(history, payload, resolveEvaluationRelationChoice(suggested, 'suggested', 'improvement'))
    expect(linked.node).toMatchObject({ hypothesisId: 'h-vperi', parentId: 'n-screen', relation: 'improvement', branchId: 'issue:h-vperi:main' })
    expect(linked.hypothesis.evaluationNodeIds).toEqual(['n-screen', 'generated-n'])

    const rerun = { ...run, id: 'run-screen', evaluationIntent: 'screen 다시 분석', proposal: { ...run.proposal!, outcome: 'TEST_FAIL' as const, purpose: 'screening' as const } }
    const updateSuggestion = agentEvaluationRelationSuggestion(history, rerun, 'folder-screen')!
    const updated = applyEvaluationAgentRelation(history, payload, updateSuggestion)
    expect(updated.node.id).toBe('n-screen')
    expect(updated.evidence[0].evaluationNodeId).toBe('n-screen')
  })

  it('stores an uncertain Agent proposal in the queue without creating an orphan issue', () => {
    const payload: EvaluationAgentMemoryPayloadView = {
      hypothesis: { id: 'h', projectId: 'p1', title: 'unknown', origin: 'ai-proposed', evaluationNodeIds: ['n'] },
      node: { id: 'n', projectId: 'p1', hypothesisId: 'h', name: 'unknown', dimensions: {} },
      evidence: [],
    }
    const pending = applyEvaluationAgentRelation(project, payload, {
      classification: 'pending', suggestedIssueTitle: '분류 대기 불량', confidence: .3, reason: '근거 부족',
    })
    const merged = mergeEvaluationAgentMemory(project, pending)
    expect(merged.failureHypotheses).toEqual([])
    expect(merged.evaluationNodes?.[0]).toMatchObject({ id: 'n', relationReason: '근거 부족' })
    expect(merged.evaluationNodes?.[0].hypothesisId).toBeUndefined()
  })

  it('uses a useful Korean-style trend title from confirmed dimensions', () => {
    expect(evaluationProposalTitle({ outcome: 'TEST_FAIL', dimensions: { testMode: 'VPERI', dq: 9 }, rationale: '', evidenceIds: [], sourceIds: [] })).toBe('VPERI · DQ9 경향')
    expect(evaluationProposalTitle({ outcome: 'UNKNOWN', dimensions: {}, rationale: '', evidenceIds: [], sourceIds: [] })).toBe('미정 경향')
    expect(evaluationOutcomeLabel('UNKNOWN')).toBe('미정')
    expect(proposalDecisionResult('TEST_FAIL')).toBe('TEST_FAIL')
    expect(proposalDecisionResult('UNKNOWN')).toBeNull()
    expect(evaluationDimensionSummary({ skew: 'SS', channel: 0, subChannel: 1, bank: 5 })).toEqual(['SKEW SS', 'CH 0', 'Sub CH 1', 'Bank 5'])
    expect(agentEvaluationPurposeLabel('characterization')).toBe('불량 경향 파악')
    expect(agentEvaluationPurposeLabel('stage-verification')).toBe('부팅·Training 확인')
    expect(evaluationAgentRecordPrefix('project/one', 'session:1')).toBe('ea-projectone-session1')
  })

  it('passes the novice purpose choice into the same-folder result and history Agent', () => {
    const session: NativeAgentSessionView = {
      id: 's', projectId: 'p1', title: 'analysis', backend: 'opencode', status: 'idle',
      evaluationScopeId: 'folder-a', evaluationIntent: '부팅·Training 확인',
      createdAt: '', updatedAt: '', messages: [], tools: [],
    }
    expect(evaluationIntentForAgent(undefined, undefined, session, 'folder-a')).toBe('부팅·Training 확인')
    expect(evaluationIntentForAgent(undefined, undefined, session, 'folder-b')).toBe('')
    expect(evaluationIntentForAgent('직접 지정', undefined, session, 'folder-a')).toBe('직접 지정')
    expect(evaluationIntentForAgent(undefined, {
      id: 'n1', name: 'VPERI 불량 가속 조건 확인', purpose: 'screening',
      dimensions: {}, interpretation: '85°C에서 2/2 FAIL', reviewState: 'confirmed',
    }, session, 'folder-a')).toBe('VPERI 불량 가속 조건 확인')
    expect(evaluationIntentForAgent(undefined, {
      id: 'n2', name: 'Agent proposal', purpose: 'verification',
      dimensions: {}, interpretation: 'VDD 변경 후 PASS', reviewState: 'confirmed',
    }, session, 'folder-a')).toBe('개선 효과 검증')
  })

  it('never applies one project-level outcome to several logs without per-source evidence', () => {
    expect(proposalSourceDecisions({ outcome: 'TEST_FAIL', dimensions: {}, rationale: '', evidenceIds: ['e1', 'e2'], sourceIds: ['s1', 's2'] })).toEqual([])
    expect(proposalSourceDecisions({
      outcome: 'TEST_FAIL', dimensions: {}, rationale: '', evidenceIds: ['e1', 'e2'], sourceIds: ['s1', 's2'],
      sourceAssessments: [{ sourceId: 's1', outcome: 'PASS', evidenceIds: ['e1'] }, { sourceId: 's2', outcome: 'TEST_FAIL', evidenceIds: ['e2'] }],
    })).toEqual([{ sourceId: 's1', outcome: 'PASS', evidenceIds: ['e1'] }, { sourceId: 's2', outcome: 'TEST_FAIL', evidenceIds: ['e2'] }])
  })

  it('keeps a live agent session for revision-only updates and clears it when its log scope changes', () => {
    expect(shouldRetainAgentSession({ ...project, revision: 1 }, { ...project, revision: 2 })).toBe(true)
    expect(shouldRetainAgentSession(project, {
      ...project,
      artifacts: [{ sourceId: 's1', rootId: 'r1', artifactId: 'a1', relativePath: 'one.log' }],
    })).toBe(false)
    expect(shouldRetainAgentSession(project, { ...project, id: 'other' })).toBe(false)
  })

  it('continues one conversation across menus in the same evaluation folder', () => {
    const folderSession: NativeAgentSessionView = {
      id: 'folder-chat', projectId: 'p1', title: 'VPERI 평가', backend: 'opencode', status: 'idle', evaluationScopeId: 'folder-a',
      createdAt: '', updatedAt: '', messages: [], tools: [],
    }
    const summaries = [folderSession, { ...folderSession, id: 'other-folder', evaluationScopeId: 'folder-b' }]
    expect(reusableNativeLaunchSessionId(folderSession, summaries, { evaluationScopeId: 'folder-a' })).toBe('folder-chat')
    expect(reusableNativeLaunchSessionId(folderSession, summaries, { evaluationScopeId: 'folder-b' })).toBe('other-folder')
    expect(reusableNativeLaunchSessionId(folderSession, summaries, {})).toBeNull()
    expect(reusableNativeLaunchSessionId({ ...folderSession, status: 'running' }, [], { evaluationScopeId: 'folder-a' })).toBeNull()
  })

  it('does not restore legacy empty completed reviews or reviews already saved to history', () => {
    const base: EvaluationAgentSessionView = {
      schemaVersion: 1, id: 'session-1', status: 'completed', evaluationIntent: '불량 재현',
      calls: 1, searches: 0, depth: 1, files: [], evidence: [], transcript: [], dimensions: {},
    }
    expect(shouldRestoreEvaluationReview(project, base)).toBe(false)
    expect(shouldRestoreEvaluationReview({ ...project }, { ...base, status: 'failed', failure: 'old provider format' })).toBe(false)
    const reviewable = {
      ...base,
      proposal: { outcome: 'UNKNOWN' as const, dimensions: {}, rationale: '추가 확인이 필요합니다.', evidenceIds: [], sourceIds: [] },
    }
    expect(shouldRestoreEvaluationReview(project, reviewable)).toBe(true)
    const savedNodeId = `${evaluationAgentRecordPrefix(project.id, base.id)}-n`
    expect(shouldRestoreEvaluationReview({ ...project, evaluationNodes: [{ id: savedNodeId, name: 'saved', status: 'inconclusive', dimensions: {} }] }, reviewable)).toBe(false)
  })

  it('marks only the completed proposal saved in the current session', () => {
    const run: EvaluationAgentSessionView = {
      schemaVersion: 1, id: 'session-1', status: 'completed' as const, evaluationIntent: '불량 경향',
      calls: 1, searches: 0, depth: 1, files: [], evidence: [], transcript: [], dimensions: {},
    }
    expect(isEvaluationProposalSaved(run, 'session-1')).toBe(true)
    expect(isEvaluationProposalSaved(run, 'session-2')).toBe(false)
    expect(isEvaluationProposalSaved({ ...run, status: 'waiting_confirmation' }, 'session-1')).toBe(false)
  })

  it('gives the Agent only logs from the selected evaluation folder', () => {
    const scopedProject = {
      ...project,
      artifacts: [
        { sourceId: 'a-1', rootId: 'folder-a', artifactId: 'artifact-a1', relativePath: 'one.log' },
        { sourceId: 'a-2', rootId: 'folder-a', artifactId: 'artifact-a2', relativePath: 'two.log' },
        { sourceId: 'b-1', rootId: 'folder-b', artifactId: 'artifact-b1', relativePath: 'other.log' },
      ],
    }
    const selected = { id: 'row-a', name: 'one.log', artifactId: 'artifact-a1', rootId: 'folder-a', relativePath: 'one.log' }
    expect(agentEvaluationSources(scopedProject, selected).map((item) => item.sourceId)).toEqual(['a-1', 'a-2'])
    expect(agentEvaluationSources(scopedProject, selected, 'folder-b').map((item) => item.sourceId)).toEqual(['b-1'])
    expect(agentEvaluationSources(scopedProject)).toEqual([])
    expect(agentEvaluationSources({ ...scopedProject, artifacts: scopedProject.artifacts.slice(0, 2) }).map((item) => item.sourceId)).toEqual(['a-1', 'a-2'])
  })

  it('keeps primary actions reachable after bounded onboarding answers', () => {
    const session = (userMessages: number, question = false): NativeAgentSessionView => ({
      id: 'session', projectId: 'p1', title: 'analysis', backend: 'internal', status: 'idle',
      createdAt: '', updatedAt: '', tools: [],
      messages: Array.from({ length: userMessages }, (_, index) => ({ id: `m-${index}`, role: 'user' as const, content: `answer ${index}`, createdAt: '' })),
      ...(question ? { question: { id: 'q', kind: 'command-purpose' as const, command: 'memory_training', prompt: 'purpose?', choices: ['Training'] } } : {}),
    })
    expect(shouldShowNativeAgentSuggestions(session(0))).toBe(true)
    expect(shouldShowNativeAgentSuggestions(session(3))).toBe(true)
    expect(shouldShowNativeAgentSuggestions(session(4))).toBe(false)
    expect(shouldShowNativeAgentSuggestions(session(1, true))).toBe(false)
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

  it('follows a new answer only while the engineer remains near the latest message', () => {
    expect(isAgentThreadNearBottom(728, 200, 1000)).toBe(true)
    expect(isAgentThreadNearBottom(500, 200, 1000)).toBe(false)
  })

  it('shows bounded completed OpenCode tools while the current answer is still running', () => {
    const session: NativeAgentSessionView = {
      id: 's', projectId: 'p1', title: 'analysis', backend: 'opencode', status: 'running',
      createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:10.000Z',
      messages: [
        { id: 'u0', role: 'user', content: 'old', createdAt: '2026-08-10T00:00:01.000Z' },
        { id: 'a0', role: 'assistant', content: 'old answer', createdAt: '2026-08-10T00:00:02.000Z' },
        { id: 'u1', role: 'user', content: 'DQ 경향?', createdAt: '2026-08-10T00:00:05.000Z' },
      ],
      tools: [
        { id: 'old', name: 'project_context_get', label: '프로젝트 조건', state: 'completed', startedAt: '2026-08-10T00:00:01.500Z' },
        { id: 'new', name: 'failure_trends_get', label: '조건별 경향', state: 'completed', startedAt: '2026-08-10T00:00:06.000Z', summary: 'DQ9 2/3' },
      ],
    }
    expect(toolsForCurrentAgentRun(session).map((tool) => tool.id)).toEqual(['new'])
    expect(toolsForCurrentAgentRun({ ...session, status: 'idle' })).toEqual([])
  })
})
