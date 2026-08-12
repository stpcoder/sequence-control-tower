import { describe, expect, it } from 'vitest'
import { userFacingAgentContent } from './native-agent-service'

describe('userFacingAgentContent', () => {
  it('removes internal step-limit narration while retaining the engineering answer', () => {
    expect(userFacingAgentContent('Maximum Steps reached.\n\n확인된 사실\n- VDD 1.295V에서 2/3 FAIL')).toBe('확인된 사실\n- VDD 1.295V에서 2/3 FAIL')
    expect(userFacingAgentContent('최대 분석 단계에 도달했습니다.')).toContain('미확인 항목은 확정하지 않았습니다')
  })

  it('hides internal project and source identifiers from the user-facing answer', () => {
    expect(userFacingAgentContent('folder 0e618917c5fc560b63851c07 (sample-n-screen) source 4cf9b9603c7b0625fef48afb2280752e58e8ee71 session 37e41de6-3d3d-42e5-8084-33a722e800a0'))
      .toBe('folder 연결된 항목 source 연결된 항목 session 연결된 항목')
  })
})
