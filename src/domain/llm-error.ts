const CONTROL = /[\u0000-\u001f\u007f]/g
const SECRET_ASSIGNMENT = /((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|secret)\s*["']?\s*[:=]\s*["']?)([^\s,"';}]+)/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+/gi
const AUTHORIZATION = /(\bauthorization\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"';}]+/gi

export function sanitizeLlmErrorDetail(value: unknown, max = 360): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(CONTROL, ' ')
    .replace(AUTHORIZATION, '$1[REDACTED]')
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Extract only common OpenAI-compatible error fields; never reflect an arbitrary body. */
export function openAiErrorDetail(bodyText: string, statusText = ''): string {
  const values: string[] = []
  try {
    const root = objectValue(JSON.parse(bodyText))
    const error = objectValue(root?.error)
    for (const value of [error?.code, error?.type, error?.message, root?.code, root?.type, root?.message, root?.detail]) {
      const safe = sanitizeLlmErrorDetail(value)
      if (safe && !values.includes(safe)) values.push(safe)
    }
  } catch { /* Non-JSON gateway bodies are deliberately not reflected. */ }
  const fallback = sanitizeLlmErrorDetail(statusText, 80)
  return values.slice(0, 3).join(' · ') || fallback
}

export function llmHttpErrorCode(status: number, bodyText: string, statusText = ''): string {
  const detail = openAiErrorDetail(bodyText, statusText)
  return `LLM_HTTP_${status}${detail ? ` · ${detail}` : ''}`
}

export function llmErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return /LLM_HTTP_\d{3}/.exec(raw)?.[0]
    ?? /LLM_(?:REQUEST_TIMEOUT|REQUEST_FAILED|UNAVAILABLE|TPM_REQUEST_TOO_LARGE|INVALID_JSON_RESPONSE|EMPTY_RESPONSE|REASONING_ONLY_RESPONSE|RESPONSE_TOO_LARGE|VERTEX_AUTH_UNAVAILABLE)/.exec(raw)?.[0]
    ?? ''
}

export function llmFailureDisplay(error: unknown): string | null {
  const raw = sanitizeLlmErrorDetail(error instanceof Error ? error.message : String(error ?? ''), 600)
  const http = /LLM_HTTP_(\d{3})(?:\s*·\s*(.*))?/.exec(raw)
  if (http) return `사내 LLM 요청 실패 · HTTP ${http[1]}${http[2] ? ` · ${http[2]}` : ''}`
  const code = llmErrorCode(raw)
  if (code === 'LLM_REQUEST_TIMEOUT') return '사내 LLM 요청 시간 초과'
  if (code === 'LLM_REQUEST_FAILED') return '사내 LLM 연결 또는 응답 스트림 실패'
  if (code === 'LLM_UNAVAILABLE') return 'LLM 주소 또는 모델이 저장되지 않았습니다.'
  if (code === 'LLM_TPM_REQUEST_TOO_LARGE') return '요청 크기가 설정한 TPM 한도를 초과했습니다.'
  if (code === 'LLM_INVALID_JSON_RESPONSE') return 'LLM 응답이 OpenAI Chat Completions JSON 형식이 아닙니다.'
  if (code === 'LLM_EMPTY_RESPONSE') return 'LLM 응답의 choices[0].message.content가 비어 있습니다.'
  if (code === 'LLM_REASONING_ONLY_RESPONSE') return 'LLM이 최종 답변 없이 추론 내용만 반환했습니다.'
  if (code === 'LLM_RESPONSE_TOO_LARGE') return 'LLM 응답이 앱의 안전 용량 제한을 초과했습니다.'
  if (code === 'LLM_VERTEX_AUTH_UNAVAILABLE') return 'Vertex 인증 토큰을 가져오지 못했습니다.'
  return null
}
