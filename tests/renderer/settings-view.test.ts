import { describe, expect, it } from 'vitest'
import {
  apiKeyAction,
  apiKeyActionLabel,
  buildApiKeyClearRequest,
  llmRateLimitHelpText,
  MIN_LLM_TOKENS_PER_MINUTE,
  isVertexBaseUrl,
  saveConfirmationMessage
} from '../../src/views/SettingsView'
import type { LlmConfigSummary } from '../../electron/shared/contracts'

function summary(
  apiKeyPersisted: boolean,
  apiKeyFromEnvironment: boolean,
  apiKeyConfigured = apiKeyPersisted || apiKeyFromEnvironment,
): Pick<LlmConfigSummary, 'apiKeyPersisted' | 'apiKeyConfigured' | 'managedByEnvironment'> {
  return {
    apiKeyPersisted,
    managedByEnvironment: {
      baseUrl: false,
      model: false,
      apiKey: apiKeyFromEnvironment
    },
    apiKeyConfigured
  }
}

describe('SettingsView save confirmation', () => {
  it('reports an environment-provided API key instead of claiming encrypted storage', () => {
    const message = saveConfirmationMessage(summary(true, true), false, false)

    expect(message).toBe('설정을 저장했습니다. API key는 환경변수로 공급되므로 이 앱에 암호화 저장되지 않습니다.')
    expect(message).not.toContain('암호화된 API key를 저장했습니다')
  })

  it('reports an API key as encrypted only when it is persisted without environment management', () => {
    expect(saveConfirmationMessage(summary(true, false), false, true)).toBe('설정과 암호화된 API key를 저장했습니다.')
  })

  it('keeps the host-cleared and session-only messages for their respective save responses', () => {
    expect(saveConfirmationMessage(summary(false, false), true, false)).toBe('Gateway 주소가 바뀌어 이전 host의 API key를 안전하게 해제했습니다.')
    expect(saveConfirmationMessage(summary(false, false), false, true)).toBe('설정을 저장했습니다. API key는 OS 암호화 가능 여부에 따라 세션에만 유지될 수 있습니다.')
  })
})

describe('SettingsView API key action', () => {
  it('clears typed input without treating it as a stored-key deletion', () => {
    expect(apiKeyAction('draft-secret', summary(true, false))).toBe('clear-input')
    expect(apiKeyActionLabel(apiKeyAction('draft-secret', summary(true, false)))).toBe('입력 지우기')
  })

  it('offers stored-key deletion only when the input is empty', () => {
    expect(apiKeyAction('', summary(true, false))).toBe('clear-stored')
    expect(apiKeyActionLabel(apiKeyAction('', summary(true, false)))).toBe('저장 키 삭제')
  })

  it('shows environment management instead of offering a clear request', () => {
    const environmentSummary = summary(false, true, false)

    expect(apiKeyAction('', environmentSummary)).toBe('environment-managed')
    expect(apiKeyActionLabel(apiKeyAction('', environmentSummary))).toBe('환경변수로 관리됨')
  })

  it('builds a clear request that preserves every current setting and contains no secret', () => {
    const request = buildApiKeyClearRequest({
      baseUrl: 'https://gateway.example/v1',
      model: 'qwen3-32b',
      requestsPerMinute: 12,
      tokensPerMinute: 120_000,
      timeoutSeconds: 90,
      maxRetries: 3
    })

    expect(request).toEqual({
      baseUrl: 'https://gateway.example/v1',
      model: 'qwen3-32b',
      requestsPerMinute: 12,
      tokensPerMinute: 120_000,
      timeoutSeconds: 90,
      maxRetries: 3,
      clearApiKey: true
    })
    expect(request).not.toHaveProperty('apiKey')
  })
})

describe('SettingsView LLM rate limits', () => {
  it('uses a TPM minimum that can reserve completion tokens and a non-empty prompt', () => {
    expect(MIN_LLM_TOKENS_PER_MINUTE).toBe(1_201)
    expect(llmRateLimitHelpText()).toContain('최소 1,201')
    expect(llmRateLimitHelpText()).toContain('응답 예약 1,200 토큰')
    expect(llmRateLimitHelpText()).toContain('최소 프롬프트 1토큰')
  })
})

describe('SettingsView Vertex recognition', () => {
  it('shows automatic gcloud auth only for the official OpenAI-compatible endpoint', () => {
    expect(isVertexBaseUrl('https://asia-northeast3-aiplatform.googleapis.com/v1beta1/projects/demo/locations/asia-northeast3/endpoints/openapi')).toBe(true)
    expect(isVertexBaseUrl('https://llm.internal.example/v1')).toBe(false)
  })
})
