import { describe, expect, it } from 'vitest'
import { hasMeaningfulAgentMessage } from '../../src/domain/agent-message'

describe('Agent message validation', () => {
  it('rejects empty, punctuation-only, and focus debris', () => {
    expect(hasMeaningfulAgentMessage('')).toBe(false)
    expect(hasMeaningfulAgentMessage(' ,         . ')).toBe(false)
    expect(hasMeaningfulAgentMessage('---')).toBe(false)
    expect(hasMeaningfulAgentMessage('🙂')).toBe(false)
  })

  it('accepts Korean questions and engineering tokens', () => {
    expect(hasMeaningfulAgentMessage('이 평가는 RT인가요?')).toBe(true)
    expect(hasMeaningfulAgentMessage('@FAIL')).toBe(true)
    expect(hasMeaningfulAgentMessage('DQ=9')).toBe(true)
    expect(hasMeaningfulAgentMessage('SM-8975')).toBe(true)
    expect(hasMeaningfulAgentMessage('^TRAINING\\s+FAIL$')).toBe(true)
  })
})
