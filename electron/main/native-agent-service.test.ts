import { describe, expect, it } from 'vitest'
import { planLpddrTools } from './native-agent-service'

describe('planLpddrTools', () => {
  it('routes an evaluation-context question to bounded evidence tools', () => {
    const names = planLpddrTools('새 로그의 온도와 VDD, DQ별 불량률을 보고 과거 LPDDR5 유사 사례와 다음 평가를 추천해줘').map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['project_context_get', 'project_history_get', 'filename_dimensions_scan', 'pass_fail_scan', 'failure_trends_get', 'similar_case_search']))
    expect(names.length).toBeLessThanOrEqual(6)
  })
})
