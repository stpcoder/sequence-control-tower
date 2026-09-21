import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { agentEvaluationContext } from './agent-evaluation-context'
import { LpddrAgentToolService } from './lpddr-agent-tools'
import { sourceKeyFor } from '../../src/state/sourceIdentity'
import type { EvaluationProjectSnapshot, EvaluationRecipeRule, ProjectSnapshot } from '../shared/contracts'

const sources = [{ sourceId: 's1', artifactId: 'a', rootId: 'r', relativePath: 'a.log' }, { sourceId: 's2', artifactId: 'a', rootId: 'r2', relativePath: 'a.log' }]
const ref = { sourceId: 'legacy-renderer-id', artifactId: 'a', sourceKeyHash: createHash('sha256').update('sequence-control-tower-source-v1\0').update(sourceKeyFor('r', 'a.log')).digest('hex') }
const rule: EvaluationRecipeRule = { id: 'rule', label: 'PASS', status: 'verified', scope: { kind: 'project' }, clauses: [{ id: 'c', presence: 'present', occurrence: { kind: 'exact', count: 2 }, matcher: { kind: 'literal', pattern: 'END', target: 'content', caseSensitive: true } }], priority: 1, confidence: 1, repetition: 1, createdFromSourceIds: [] }
function snapshot(): EvaluationProjectSnapshot { return {
  schemaVersion: 1, projectIdHash: 'p', revision: 3, metadataApprovals: [], decisions: [],
  recipes: [{ id: 'rev', recipeId: 'recipe', name: '종료 두 번', revision: 1, rules: [rule], createdAt: '' }],
  batches: [{ id: 'batch', status: 'completed', recipeRevisionIds: ['rev'], outcomes: [{ source: ref, result: 'PASS', matchedRuleId: 'rule', outcomeSource: 'rule', evidenceRefs: [{ artifactId: 'a', lineNumber: 14 }] }], matchedCount: 1, exceptionCount: 0, startedAt: '', completedAt: '' }],
} }
const project: ProjectSnapshot = { schemaVersion: 2, id: 'p', name: 'P', revision: 0, archived: false, createdAt: '', updatedAt: '', artifacts: sources, folders: [{ rootId: 'r', displayLabel: 'A', status: 'available', connectedAt: '' }, { rootId: 'r2', displayLabel: 'B', status: 'available', connectedAt: '' }], equipmentProfiles: [], templatePins: [], exportPresets: [] }
function tools(state: EvaluationProjectSnapshot, customProject = project) {
  return new LpddrAgentToolService({
    evaluations: { snapshot: vi.fn(async () => state) }, projects: { get: vi.fn(async () => customProject), list: vi.fn(async () => [customProject]) },
    artifacts: { inspectEvidence: vi.fn(async () => ({ sources: [{ sourceId: 's1', fileName: 'a.log', evidence: [{ specId: 'at-fail', occurrenceCount: 1 }] }] })), list: vi.fn(async () => []), search: vi.fn(), lineWindow: vi.fn(async () => ({ lines: [{ lineNumber: 14, text: 'END' }], hasMoreBefore: true, hasMoreAfter: false })) } as never,
    agentStore: { profileBindings: vi.fn(async () => []) } as never,
  })
}
describe('Agent evaluation evidence', () => {
  it('resolves renderer aliases and keeps identical content in another folder independent', () => {
    const rows = agentEvaluationContext(snapshot(), sources)
    expect(rows[0]).toMatchObject({ result: 'PASS', resultSource: 'rule', evidence: [{ lineNumber: 14 }], appliedRules: [{ clauses: [{ occurrence: { count: 2 } }] }] })
    expect(rows[1].result).toBeUndefined()
  })
  it('never resurrects an old result after changing or removing the last rule', () => {
    const state = snapshot()
    state.recipes.push({ ...state.recipes[0], id: 'rev2', revision: 2, archived: true })
    expect(agentEvaluationContext(state, sources)[0]).toMatchObject({ result: 'UNKNOWN', needsReevaluation: true, appliedRules: [] })
    state.decisions.push({ id: 'd', revision: 1, source: ref, result: 'EXCLUDED', decidedBy: 'engineer', createdAt: '', evidenceRefs: [] })
    expect(agentEvaluationContext(state, sources)[0]).toMatchObject({ result: 'EXCLUDED', resultSource: 'engineer' })
    state.decisions.push({ ...state.decisions[0], id: 'reset', revision: 2, result: 'UNKNOWN', reset: true })
    expect(agentEvaluationContext(state, sources)[0].result).toBe('UNKNOWN')
  })
  it('explains the stored rule result separately from conflicting generic marker evidence', async () => {
    const api = tools(snapshot())
    const result = await api.execute('p', { name: 'pass_fail_scan' }, ['s1'])
    expect(result.data).toMatchObject({ totals: { PASS: 1 }, rows: [{ status: 'PASS', markerStatus: 'TEST_FAIL', resultSource: 'rule', evidence: [{ lineNumber: 14 }] }] })
    const evidence = await api.execute('p', { name: 'evaluation_state_get' }, ['s1'])
    expect(evidence.data).toMatchObject({ rows: [{ appliedRules: [{ clauses: [{ matcher: { pattern: 'END' } }] }] }], savedRecipes: [{ applied: true }] })
    await expect(api.execute('p', { name: 'log_read_window', args: { sourceId: 's2' } }, ['s1'])).rejects.toThrow('로그를 선택')
    await expect(api.execute('p', { name: 'source_list', args: { sourceIds: ['s2'] } }, ['s1'])).rejects.toThrow('허용된 로그 범위')
  })
  it('reports history/current-result discrepancies for the Agent to ask about', async () => {
    const customProject = { ...project, evaluationNodes: [{ id: 'node', evaluationScopeId: 'r', name: '이전 평가', dimensions: {}, reviewState: 'confirmed', report: { purpose: { text: '' }, results: { total: 1, byOutcome: { TEST_FAIL: 1 } }, interpretation: { text: '' }, trends: { text: '' }, nextPlan: { text: '' } } }] } as ProjectSnapshot
    const result = await tools(snapshot(), customProject).execute('p', { name: 'project_history_get' }, ['s1'])
    expect(result.data).toMatchObject({ discrepancies: [{ evaluationId: 'node', saved: { TEST_FAIL: 1 }, current: { PASS: 1 } }] })
  })
  it('lists a folder larger than 100 files without rejecting it or hiding pagination', async () => {
    const artifacts = Array.from({ length: 140 }, (_, i) => ({ ...sources[0], sourceId: `s-${i}`, relativePath: `${i}.log` }))
    const api = tools(snapshot(), { ...project, artifacts })
    const page = await api.execute('p', { name: 'source_list' }, artifacts.map((item) => item.sourceId))
    expect(page.data).toMatchObject({ total: 140, nextOffset: 100 })
    const next = await api.execute('p', { name: 'source_list', args: { offset: 100 } }, artifacts.map((item) => item.sourceId))
    expect(next.data).toMatchObject({ total: 140, nextOffset: null })
    expect((next.data as { sources: unknown[] }).sources).toHaveLength(40)
  })
})
