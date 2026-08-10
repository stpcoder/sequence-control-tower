import { describe, expect, it } from 'vitest'
import { addEvaluationWithEvidence, addFailureHypothesis, buildEvaluationContextMarkdown, evaluationMemoryCsv, groupEvaluationFolders, linkedEvidenceLogIds, openIdForEvidenceLog, trendInterpretation, withProjectConditions } from '../../src/views/EvaluationMemoryView'
import type { DominanceFinding, EvaluationMemory } from '../../src/domain/evaluation-memory'

const memory: EvaluationMemory = { project: { id: 'p', name: 'LPDDR6', customer: 'Customer A', targetDevice: 'SoC-X', densityGb: 16, nominalVoltage: 1.1 }, hypotheses: [], nodes: [], evidence: [] }
describe('evaluation memory workflow helpers', () => {
  it('adds a hypothesis', () => { const next = addFailureHypothesis(memory, { title: 'DQ issue', origin: 'ai-proposed' }); expect(next.hypotheses[0]).toMatchObject({ projectId: 'p', title: 'DQ issue' }) })
  it('adds and reopens linked durable log evidence through its renderer open ID', () => { const withHypothesis = addFailureHypothesis(memory, { title: 'DQ issue', origin: 'engineer-confirmed' }); const next = addEvaluationWithEvidence(withHypothesis, { name: '105C sweep', purpose: 'screening', hypothesisId: withHypothesis.hypotheses[0].id, status: 'fail', dimensions: { dq: 7, pattern: 6060 }, logIds: ['source-1'], origin: 'engineer-confirmed' }); expect(next.nodes[0]).toMatchObject({ hypothesisId: withHypothesis.hypotheses[0].id, purpose: 'screening' }); expect(next.evidence[0]).toMatchObject({ evaluationNodeId: next.nodes[0].id, logRef: 'source-1', sourceIds: ['source-1'] }); expect(linkedEvidenceLogIds(next, next.nodes[0].id)).toEqual(['source-1']); expect(openIdForEvidenceLog('source-1', [{ id: 'source-1', openId: 'renderer-file-1', name: 'run.log' }])).toBe('renderer-file-1') })
  it('batches edited project conditions into one memory payload', () => { const next = withProjectConditions(memory, { ...memory.project, customer: 'Customer B', nominalVoltage: 1.05 }); expect(next.project).toMatchObject({ id: 'p', name: 'LPDDR6', customer: 'Customer B', nominalVoltage: 1.05 }); expect(memory.project.customer).toBe('Customer A') })
  it('labels calculated trends with their failure numerator and denominator', () => { const trend: DominanceFinding = { dimension: 'frequencyMHz', value: '9600', evidenceCount: 11, failureCount: 6, passCount: 5, failureRate: 6 / 11, dominance: .6, confidence: .4, origin: 'engineer-confirmed' }; expect(trendInterpretation(trend)).toBe('주파수 9600 · 6/11 실패') })
  it('uses one attached folder as one evaluation while retaining its internal analysis records', () => {
    const scoped: EvaluationMemory = {
      ...memory,
      nodes: [
        { id: 'n-a1', projectId: 'p', evaluationScopeId: 'root-a', name: 'baseline', dimensions: {}, status: 'fail' },
        { id: 'n-a2', projectId: 'p', evaluationScopeId: 'root-a', name: 'RT2', dimensions: {}, status: 'fail' },
        { id: 'n-b', projectId: 'p', evaluationScopeId: 'root-b', name: 'VDD improvement', dimensions: {}, status: 'pass' },
      ],
      evidence: [
        { id: 'e-a1', projectId: 'p', evaluationNodeId: 'n-a1', status: 'fail', sourceIds: ['a-1'] },
        { id: 'e-a2', projectId: 'p', evaluationNodeId: 'n-a2', status: 'fail', sourceIds: ['a-2'] },
        { id: 'e-b', projectId: 'p', evaluationNodeId: 'n-b', status: 'pass', sourceIds: ['b-1'] },
      ],
    }
    const groups = groupEvaluationFolders(scoped, [
      { id: 'a-1', rootId: 'root-a', folderName: 'DQ9 재현', name: 'a1.log' },
      { id: 'a-2', rootId: 'root-a', folderName: 'DQ9 재현', name: 'a2.log' },
      { id: 'b-1', rootId: 'root-b', folderName: 'VDD 개선', name: 'b.log' },
    ])
    expect(groups.map((group) => ({ id: group.id, logs: group.logs.length, nodes: group.nodes.length }))).toEqual([
      { id: 'root-a', logs: 2, nodes: 2 }, { id: 'root-b', logs: 1, nodes: 1 },
    ])
  })
  it('exports concise client context and complete CSV', () => { const next = addEvaluationWithEvidence(memory, { name: 'fail run', status: 'fail', dimensions: { dq: 7 }, logIds: ['log-1'], origin: 'ai-proposed' }); const context = buildEvaluationContextMarkdown(next); expect(context).toContain('fail run'); expect(context).toContain('Customer: Customer A'); expect(context).toContain('Target device: SoC-X'); expect(context).toContain('Density: 16Gb'); expect(context).toContain('Nominal voltage: 1.1V'); expect(context).toContain('log-1'); const csv = evaluationMemoryCsv(next); expect(csv).toContain('customer,targetDevice,densityGb,nominalVoltage,program,phase'); expect(csv).toContain('sourceIds'); expect(csv).toContain('"log-1"') })
})
