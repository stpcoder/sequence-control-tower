import { describe, expect, it } from 'vitest'
import { addEvaluationWithEvidence, addFailureHypothesis, buildEvaluationContextMarkdown, evaluationAnalysisRequest, evaluationBranchSummary, evaluationFolderBranches, evaluationFolderFlow, evaluationLogResultLabel, evaluationMemoryCsv, groupEvaluationFolders, linkedEvidenceLogIds, openIdForEvidenceLog, shouldProactivelyAnalyzeFolder, trendInterpretation, withProjectConditions } from '../../src/views/EvaluationMemoryView'
import type { DominanceFinding, EvaluationMemory } from '../../src/domain/evaluation-memory'

const memory: EvaluationMemory = { project: { id: 'p', name: 'LPDDR6', customer: 'Customer A', targetDevice: 'SoC-X', densityGb: 16, nominalVoltage: 1.1 }, hypotheses: [], nodes: [], evidence: [] }
describe('evaluation memory workflow helpers', () => {
  it('shows unresolved logs in product language instead of the internal UNKNOWN token', () => {
    expect(evaluationLogResultLabel('UNKNOWN')).toBe('미정')
    expect(evaluationLogResultLabel(undefined)).toBe('미정')
    expect(evaluationLogResultLabel('SYSTEM_HALT')).toBe('SYSTEM_HALT')
  })
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
        { id: 'n-b', projectId: 'p', evaluationScopeId: 'root-b', parentId: 'n-a2', name: 'VDD improvement', dimensions: {}, status: 'pass' },
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
    expect(evaluationFolderFlow(scoped, groups).map((item) => ({ id: item.group.id, parent: item.parentGroupId }))).toEqual([
      { id: 'root-a', parent: undefined }, { id: 'root-b', parent: 'root-a' },
    ])
  })
  it('keeps purpose changes in one failure issue lane and groups uncertain folders in one queue', () => {
    const scoped: EvaluationMemory = {
      ...memory,
      hypotheses: [
        { id: 'h-vperi', projectId: 'p', title: 'VPERI DQ9 반복 불량', origin: 'engineer-confirmed', evaluationNodeIds: ['n-fail', 'n-pass', 'n-side'] },
        { id: 'h-retention', projectId: 'p', title: 'Retention DQ4 불량', origin: 'ai-proposed', evaluationNodeIds: ['n-unknown'] },
      ],
      nodes: [
        { id: 'n-fail', projectId: 'p', hypothesisId: 'h-vperi', evaluationScopeId: 'root-fail', branchId: 'screen', relation: 'baseline', name: 'screen', purpose: 'screening', dimensions: {}, status: 'fail' },
        { id: 'n-pass', projectId: 'p', hypothesisId: 'h-vperi', evaluationScopeId: 'root-pass', parentId: 'n-fail', branchId: 'improve', relation: 'improvement', name: 'improve', purpose: 'improvement', dimensions: {}, status: 'pass' },
        { id: 'n-side', projectId: 'p', hypothesisId: 'h-vperi', evaluationScopeId: 'root-side', parentId: 'n-fail', branchId: 'side-dq5', relation: 'side-effect', name: 'side effect', purpose: 'characterization', dimensions: {}, status: 'fail' },
        { id: 'n-unknown', projectId: 'p', hypothesisId: 'h-retention', evaluationScopeId: 'root-unknown', parentId: 'n-fail', branchId: 'pending', relation: 'baseline', name: 'retention', purpose: 'characterization', dimensions: {}, status: 'inconclusive' },
      ], evidence: [],
    }
    const groups = groupEvaluationFolders(scoped, [
      { id: 'f', rootId: 'root-fail', folderName: 'FAIL 평가', name: 'fail.log' },
      { id: 'p', rootId: 'root-pass', folderName: 'PASS 평가', name: 'pass.log' },
      { id: 's', rootId: 'root-side', folderName: 'Side effect 평가', name: 'side.log' },
      { id: 'u', rootId: 'root-unknown', folderName: '미정 평가', name: 'unknown.log' },
      { id: 'n', rootId: 'root-new', folderName: '분석 전 평가', name: 'new.log' },
      { id: 'n2', rootId: 'root-new-2', folderName: '추가 분석 평가', name: 'new-2.log' },
    ])
    const branches = evaluationFolderBranches(scoped, evaluationFolderFlow(scoped, groups))
    expect(branches.map((branch) => ({ id: branch.id, label: branch.label, kind: branch.kind, parent: branch.parentGroupId, groups: branch.items.map((item) => item.group.id) }))).toEqual([
      { id: 'h-vperi:main', label: 'VPERI DQ9 반복 불량', kind: 'issue', parent: undefined, groups: ['root-fail', 'root-pass'] },
      { id: 'h-vperi:side-effect:side-dq5', label: 'VPERI DQ9 반복 불량 · Side effect', kind: 'issue', parent: 'root-fail', groups: ['root-side'] },
      { id: 'h-retention:main', label: 'Retention DQ4 불량', kind: 'issue', parent: undefined, groups: ['root-unknown'] },
      { id: 'classification-queue:root-new', label: '분류 대기', kind: 'queue', parent: undefined, groups: ['root-new'] },
      { id: 'classification-queue:root-new-2', label: '분류 대기', kind: 'queue', parent: undefined, groups: ['root-new-2'] },
    ])
    expect(evaluationBranchSummary(branches[0])).toBe('2개 평가 · FAIL → PASS')
    expect(evaluationBranchSummary(branches[3])).toBe('1개 평가 · 확인 필요')
  })
  it('opens a bounded purpose question only for an unreviewed folder and preserves confirmed intent', () => {
    const unreviewed = { id: 'root-new', label: '05-boot-training', logs: [{ id: 's-new', openId: 'open-new', name: 'run.log' }], nodes: [], evidence: [] }
    expect(shouldProactivelyAnalyzeFolder(unreviewed)).toBe(true)
    expect(evaluationAnalysisRequest(unreviewed)).toEqual({ evaluationScopeId: 'root-new', title: '05-boot-training', sourceIds: ['s-new'], openId: 'open-new' })
    const confirmed = { ...unreviewed, nodes: [{ id: 'n', projectId: 'p', name: '부팅 후 메모리 테스트', evaluationScopeId: 'root-new', purpose: 'verification' as const, status: 'pass' as const, dimensions: {}, interpretation: 'VDD 변경 후 개선 효과 검증', reviewState: 'confirmed' as const }] }
    expect(shouldProactivelyAnalyzeFolder(confirmed)).toBe(false)
    expect(evaluationAnalysisRequest(confirmed, confirmed.nodes[0])).toMatchObject({ intent: 'VDD 변경 후 개선 효과 검증' })
  })
  it('exports concise client context and complete CSV', () => { const next = addEvaluationWithEvidence(memory, { name: 'fail run', status: 'fail', dimensions: { dq: 7 }, logIds: ['log-1'], origin: 'ai-proposed' }); const context = buildEvaluationContextMarkdown(next); expect(context).toContain('fail run'); expect(context).toContain('Customer: Customer A'); expect(context).toContain('Target device: SoC-X'); expect(context).toContain('Density: 16Gb'); expect(context).toContain('Nominal voltage: 1.1V'); expect(context).toContain('log-1'); const csv = evaluationMemoryCsv(next); expect(csv).toContain('customer,targetDevice,densityGb,nominalVoltage,program,phase'); expect(csv).toContain('sourceIds'); expect(csv).toContain('"log-1"') })
})
