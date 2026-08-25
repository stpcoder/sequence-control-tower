import { describe, expect, it } from 'vitest'
import { llmFailureDisplay, llmHttpErrorCode, openAiErrorDetail } from '../../src/domain/llm-error'

describe('LLM error diagnostics', () => {
  it('keeps OpenAI-compatible status, code and message', () => {
    const error = llmHttpErrorCode(503, JSON.stringify({
      error: { code: 'model_not_ready', type: 'upstream_error', message: 'worker is loading' },
    }), 'Service Unavailable')
    expect(error).toBe('LLM_HTTP_503 · model_not_ready · upstream_error · worker is loading')
    expect(llmFailureDisplay(new Error(error))).toBe('사내 LLM 요청 실패 · HTTP 503 · model_not_ready · upstream_error · worker is loading')
  })

  it('redacts credentials and ignores arbitrary non-JSON bodies', () => {
    expect(openAiErrorDetail(JSON.stringify({ error: { message: 'Authorization: Bearer top-secret token=abc123' } })))
      .toBe('Authorization: [REDACTED] token=[REDACTED]')
    expect(openAiErrorDetail('<html>internal gateway dump secret=abc123</html>', 'Bad Gateway')).toBe('Bad Gateway')
  })

  it('explains transport and response-shape failures', () => {
    expect(llmFailureDisplay(new Error('provider failed: LLM_REQUEST_FAILED'))).toBe('사내 LLM 연결 또는 응답 스트림 실패')
    expect(llmFailureDisplay(new Error('LLM_EMPTY_RESPONSE'))).toContain('choices[0].message.content')
    expect(llmFailureDisplay(new Error('LLM_REASONING_ONLY_RESPONSE'))).toContain('추론 내용만 반환')
  })
})
