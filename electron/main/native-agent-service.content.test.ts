import { describe, expect, it } from 'vitest'
import { userFacingAgentContent } from './native-agent-service'

describe('userFacingAgentContent', () => {
  it('removes internal step-limit narration while retaining the engineering answer', () => {
    expect(userFacingAgentContent('Maximum Steps reached.\n\n확인된 사실\n- VDD 1.295V에서 2/3 FAIL')).toBe('확인된 사실\n- VDD 1.295V에서 2/3 FAIL')
    expect(userFacingAgentContent('최대 분석 단계에 도달했습니다.')).toContain('미확인 항목은 확정하지 않았습니다')
  })
})
