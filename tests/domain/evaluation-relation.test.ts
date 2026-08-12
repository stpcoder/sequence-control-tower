import { describe, expect, it } from 'vitest'
import type { EvaluationMemory, EvaluationNode } from '../../src/domain/evaluation-memory'
import { evaluationEntryLabel, evaluationRelationLabel, suggestEvaluationRelation } from '../../src/domain/evaluation-relation'

const baseNode: EvaluationNode = {
  id: 'n-screen', projectId: 'p', hypothesisId: 'h-vperi', evaluationScopeId: 'folder-screen',
  name: 'VPERI DQ9 screening', purpose: 'screening', status: 'fail', sequenceSignature: 'seq-vperi',
  dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16, channel: 0, temperatureC: 85, vdd: 1.295 },
}
const memory = (nodes: EvaluationNode[] = [baseNode]): EvaluationMemory => ({
  project: { id: 'p', name: 'LPDDR6' },
  hypotheses: nodes.some((node) => node.hypothesisId === 'h-vperi')
    ? [{ id: 'h-vperi', projectId: 'p', title: 'VPERI DQ9 반복 불량', origin: 'engineer-confirmed', evaluationNodeIds: nodes.map((node) => node.id) }]
    : [],
  nodes,
  evidence: [],
})

describe('evaluation issue relation suggestion', () => {
  it('does not present the first stored reproduction as the original failure', () => {
    expect(evaluationRelationLabel('baseline')).toBe('기준 평가')
    expect(evaluationEntryLabel({ purpose: 'reproduction', relation: 'baseline' })).toBe('재현 평가')
    expect(evaluationEntryLabel({ purpose: 'improvement', relation: 'baseline' })).toBe('개선 평가')
    expect(evaluationEntryLabel({ purpose: 'screening', relation: 'baseline' })).toBe('검출 평가')
    expect(evaluationEntryLabel({ purpose: 'reproduction', relation: 'retest', parentId: 'n-old' })).toBe('동일 조건 RT')
  })

  it('keeps reproduction and improvement folders in the same failure issue', () => {
    const rt = suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-rt', name: 'same sample RT2', purpose: 'reproduction', status: 'fail', sequenceSignature: 'seq-vperi',
      dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16, channel: 0, sample: 'S01' },
    })
    expect(rt).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', parentNodeId: 'n-screen', relation: 'retest' })

    const improve = suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-vdd', name: 'VDD improvement', purpose: 'improvement', status: 'pass',
      dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16, channel: 0, temperatureC: 85, vdd: 1.315 },
    })
    expect(improve).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', parentNodeId: 'n-screen', relation: 'improvement' })
  })

  it('updates the existing folder record instead of making a duplicate node', () => {
    expect(suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-screen', name: 'reanalyze', purpose: 'screening', dimensions: { testMode: 'VPERI', dq: 9 },
    })).toMatchObject({ classification: 'update-existing', existingNodeId: 'n-screen', hypothesisId: 'h-vperi', confidence: 1 })
  })

  it('separates a boot or training failure from a memory-test issue', () => {
    expect(suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-boot', name: 'MTK 24D Training fail', purpose: 'stage-verification', status: 'fail',
      dimensions: { socModel: 'MTK-24D', bootProfileId: 'mediatek-default' },
    })).toMatchObject({ classification: 'new-issue', relation: 'baseline' })
  })

  it('flags a shifted fail location after an improvement as a side-effect check', () => {
    expect(suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-tm2', name: 'TM2 improvement', purpose: 'improvement', status: 'fail',
      dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 6, bl: 12, channel: 0 },
    })).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', relation: 'side-effect' })
  })

  it('sends weak ambiguous evidence to the classification queue', () => {
    expect(suggestEvaluationRelation(memory(), {
      evaluationScopeId: 'folder-unknown', name: 'additional run', purpose: 'characterization', dimensions: { temperatureC: 25 },
    })).toMatchObject({ classification: 'pending', candidateHypothesisId: 'h-vperi' })
  })

  it('keeps RT, frequency comparison, improvement, side effect, and verification in one grounded issue', () => {
    const nodes: EvaluationNode[] = [
      baseNode,
      { ...baseNode, id: 'n-rt', parentId: 'n-screen', evaluationScopeId: 'folder-rt', purpose: 'reproduction', relation: 'retest', attemptNo: 2 },
      { ...baseNode, id: 'n-freq', parentId: 'n-rt', evaluationScopeId: 'folder-freq', purpose: 'characterization', relation: 'condition-comparison', dimensions: { ...baseNode.dimensions, frequencyMHz: 8533 } },
      { ...baseNode, id: 'n-improve', parentId: 'n-freq', evaluationScopeId: 'folder-improve', purpose: 'improvement', relation: 'improvement', status: 'pass', dimensions: { ...baseNode.dimensions, vdd: 1.315 } },
    ]
    const projectMemory = memory(nodes)
    const sideEffect = suggestEvaluationRelation(projectMemory, {
      evaluationScopeId: 'folder-side', name: 'TM2 DQ6 side effect', purpose: 'improvement', status: 'fail',
      sequenceSignature: 'seq-vperi', dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 6, bl: 12, channel: 0 },
    })
    expect(sideEffect).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', relation: 'side-effect' })

    const verification = suggestEvaluationRelation(projectMemory, {
      evaluationScopeId: 'folder-stability', name: 'all skew stability', purpose: 'verification', status: 'pass',
      sequenceSignature: 'seq-vperi', dimensions: { socModel: 'SM-8975', testMode: 'VPERI', pattern: 'WR', dq: 9, bl: 16, channel: 0 },
    })
    expect(verification).toMatchObject({ classification: 'existing-issue', hypothesisId: 'h-vperi', relation: 'verification' })
  })
})
