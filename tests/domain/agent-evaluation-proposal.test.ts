import { describe, expect, it } from 'vitest'
import { extractNativeEvaluationProposal, normalizeNativeEvaluationProposal } from '../../src/domain/agent-evaluation-proposal'

describe('native evaluation proposal', () => {
  it('extracts a reviewable OpenCode proposal without exposing its envelope', () => {
    const result = extractNativeEvaluationProposal(`확인한 결과입니다.\n<sct-evaluation-proposal>{
      "outcome":"DIAG_FAIL",
      "purpose":"characterization",
      "dimensions":{"skew":"SS","dq":9,"unknown":"drop"},
      "rationale":"고온 2/2, 상온 0/1로 고온에서 더 잘 재현될 가능성이 높습니다.",
      "draft":{"purpose":"VPERI 불량 경향 확인","changedConditions":["온도"],"fixedConditions":["VDD"],"interpretation":"고온에서 재현 증가","findings":["DQ9 반복"],"counterEvidence":[],"caveats":["Sample도 다름"],"trends":"DQ9 집중","nextPlan":"같은 Sample로 온도만 비교","levels":["Hot","Room"],"heldConditions":["VDD"],"samples":["DHCST-89"],"repeats":3,"successCriteria":["동일 signature 재현"]},
      "evidenceSourceIds":["s1","s2"]
    }</sct-evaluation-proposal>`)
    expect(result.content).toBe('확인한 결과입니다.')
    expect(result.proposal).toMatchObject({
      outcome: 'DIAG_FAIL', purpose: 'characterization', dimensions: { skew: 'SS', dq: 9 },
      draft: { purpose: 'VPERI 불량 경향 확인', repeats: 3 }, evidenceSourceIds: ['s1', 's2'],
    })
  })

  it('rejects an empty or malformed report instead of partially applying it', () => {
    expect(normalizeNativeEvaluationProposal({ outcome: 'PASS', draft: {} })).toBeNull()
    expect(extractNativeEvaluationProposal('<sct-evaluation-proposal>{bad}</sct-evaluation-proposal>').proposal).toBeNull()
  })
})
