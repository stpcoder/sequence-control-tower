import { useEffect, useRef, useState } from 'react'
import { Check, KeyRound, PlugZap, Save } from 'lucide-react'
import type { LlmConfigInput, LlmConfigSummary } from '../../electron/shared/contracts'

const DEFAULT_LIMITS = {
  requestsPerMinute: 8,
  tokensPerMinute: 80_000,
  timeoutSeconds: 60,
  maxRetries: 2
} as const

export const MIN_LLM_TOKENS_PER_MINUTE = 1_201

export function llmRateLimitHelpText(): string {
  return `TPM 최소 ${MIN_LLM_TOKENS_PER_MINUTE.toLocaleString('ko-KR')} · 응답 예약 1,200 토큰과 최소 프롬프트 1토큰을 포함한 요청 기준`
}

function urlOrigin(value: string): string {
  try {
    return value.trim() ? new URL(value).origin : ''
  } catch {
    return ''
  }
}

export function isVertexBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' &&
      url.hostname.endsWith('-aiplatform.googleapis.com') &&
      /\/locations\/[^/]+\/endpoints\/openapi(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

type SaveConfirmationSummary = Pick<LlmConfigSummary, 'apiKeyPersisted' | 'managedByEnvironment'>

type ApiKeyActionSummary = Pick<LlmConfigSummary, 'apiKeyConfigured' | 'managedByEnvironment'>

export type ApiKeyAction = 'clear-input' | 'clear-stored' | 'environment-managed' | 'noop'

export function apiKeyAction(inputValue: string, summary: ApiKeyActionSummary | null): ApiKeyAction {
  if (summary?.managedByEnvironment.apiKey) return 'environment-managed'
  if (inputValue.length > 0) return 'clear-input'
  if (summary?.apiKeyConfigured) return 'clear-stored'
  return 'noop'
}

export function apiKeyActionLabel(action: ApiKeyAction): string {
  if (action === 'clear-input') return '입력 지우기'
  if (action === 'clear-stored') return '저장 키 삭제'
  if (action === 'environment-managed') return '환경변수로 관리됨'
  return '지우기'
}

type LlmSettingsValues = Pick<LlmConfigInput, 'baseUrl' | 'model' | 'requestsPerMinute' | 'tokensPerMinute' | 'timeoutSeconds' | 'maxRetries'>

export function buildApiKeyClearRequest(values: LlmSettingsValues): LlmConfigInput {
  return {
    ...values,
    clearApiKey: true
  }
}

export function saveConfirmationMessage(
  summary: SaveConfirmationSummary,
  hostChanged: boolean,
  apiKeyProvided: boolean,
): string {
  if (summary.managedByEnvironment.apiKey) {
    return '설정을 저장했습니다. API key는 환경변수로 공급되므로 이 앱에 암호화 저장되지 않습니다.'
  }
  if (hostChanged && !apiKeyProvided) {
    return 'Gateway 주소가 바뀌어 이전 host의 API key를 안전하게 해제했습니다.'
  }
  if (summary.apiKeyPersisted) {
    return '설정과 암호화된 API key를 저장했습니다.'
  }
  return '설정을 저장했습니다. API key는 OS 암호화 가능 여부에 따라 세션에만 유지될 수 있습니다.'
}

export function SettingsView() {
  const [saved, setSaved] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [loadedBaseUrl, setLoadedBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [requestsPerMinute, setRequestsPerMinute] = useState(String(DEFAULT_LIMITS.requestsPerMinute))
  const [tokensPerMinute, setTokensPerMinute] = useState(String(DEFAULT_LIMITS.tokensPerMinute))
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_LIMITS.timeoutSeconds))
  const [maxRetries, setMaxRetries] = useState(String(DEFAULT_LIMITS.maxRetries))
  const [summary, setSummary] = useState<LlmConfigSummary | null>(null)
  const [message, setMessage] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  const setSavingState = (value: boolean) => {
    savingRef.current = value
    setSaving(value)
  }

  const refreshSummary = async (announce = true) => {
    const api = window.sequenceIntelligence
    if (!api) {
      if (announce) setMessage('웹 미리보기에서는 Gateway 설정 상태를 조회하지 않습니다.')
      return
    }
    setRefreshing(true)
    try {
      const current = await api.settings.getLlm()
      setSummary(current)
      if (current.baseUrl) {
        setBaseUrl(current.baseUrl)
        setLoadedBaseUrl(current.baseUrl)
      }
      if (current.model) setModel(current.model)
      setRequestsPerMinute(String(current.limits.requestsPerMinute))
      setTokensPerMinute(String(current.limits.tokensPerMinute))
      setTimeoutSeconds(String(current.limits.timeoutSeconds ?? Math.round(current.limits.timeoutMs / 1_000)))
      setMaxRetries(String(current.limits.maxRetries ?? DEFAULT_LIMITS.maxRetries))
      if (announce) {
        setMessage(current.configured ? '이 PC에 적용된 Gateway 설정을 다시 읽었습니다.' : 'Gateway가 설정되지 않아 로컬 fallback을 사용합니다.')
      }
    } catch {
      setMessage('저장된 LLM 설정을 읽지 못했습니다.')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void refreshSummary(false)
  }, [])

  const save = async () => {
    if (saving || savingRef.current) return
    const api = window.sequenceIntelligence
    if (!api) {
      setSaved(true)
      setMessage('웹 미리보기 설정입니다. 데스크톱 앱에서는 이 PC에 안전하게 저장됩니다.')
      return
    }
    setSavingState(true)
    try {
      const hostChanged = Boolean(
        summary?.apiKeyConfigured &&
        urlOrigin(loadedBaseUrl) &&
        urlOrigin(baseUrl) !== urlOrigin(loadedBaseUrl),
      )
      const updated = await api.settings.saveLlm({
        baseUrl,
        model,
        apiKey: summary?.managedByEnvironment.apiKey ? undefined : apiKey || undefined,
        requestsPerMinute: Number(requestsPerMinute),
        tokensPerMinute: Number(tokensPerMinute),
        timeoutSeconds: Number(timeoutSeconds),
        maxRetries: Number(maxRetries)
      })
      setSummary(updated)
      setLoadedBaseUrl(updated.baseUrl)
      setApiKey('')
      setSaved(true)
      setMessage(saveConfirmationMessage(updated, hostChanged, Boolean(apiKey)))
    } catch (error) {
      setSaved(false)
      setMessage(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.')
    } finally {
      setSavingState(false)
    }
  }

  const handleApiKeyAction = async () => {
    if (saving || savingRef.current) return

    const action = apiKeyAction(apiKey, summary)
    if (action === 'clear-input') {
      setApiKey('')
      setSaved(false)
      setMessage('입력 중인 API key를 지웠습니다.')
      return
    }
    if (action === 'environment-managed') {
      setMessage('API key는 환경변수로 관리되어 앱에서 삭제할 수 없습니다.')
      return
    }
    if (action !== 'clear-stored') return

    const api = window.sequenceIntelligence
    if (!api) {
      setMessage('웹 미리보기에서는 저장된 API key를 삭제하지 않습니다.')
      return
    }

    setSavingState(true)
    setSaved(false)
    setMessage('저장된 API key를 삭제하고 있습니다…')
    try {
      const updated = await api.settings.saveLlm(buildApiKeyClearRequest({
        baseUrl,
        model,
        requestsPerMinute: Number(requestsPerMinute),
        tokensPerMinute: Number(tokensPerMinute),
        timeoutSeconds: Number(timeoutSeconds),
        maxRetries: Number(maxRetries)
      }))
      setSummary(updated)
      setLoadedBaseUrl(updated.baseUrl)
      setApiKey('')
      setSaved(true)
      setMessage('저장된 API key를 삭제했습니다.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '저장된 API key를 삭제하지 못했습니다.')
    } finally {
      setSavingState(false)
    }
  }

  const discoverModels = async () => {
    const api = window.sequenceIntelligence
    if (!api) {
      const demoModels = ['qwen3-32b', 'glm-4.5-air', 'lab-reasoning-32b']
      setModels(demoModels)
      if (!model) setModel(demoModels[0])
      setMessage('웹 미리보기 모델입니다. 데스크톱 앱에서는 사내 Gateway의 /models를 한 번만 조회합니다.')
      return
    }
    setDiscovering(true)
    setMessage('Gateway에 한 번 연결해 사용 가능한 모델을 확인하고 있습니다…')
    try {
      const result = await api.settings.discoverModels({ baseUrl, apiKey: apiKey || undefined })
      setModels(result.models)
      if (result.models.length && !model.trim()) setModel(result.models[0])
      setMessage(result.models.length
        ? `${result.models.length}개 모델 확인 · ${result.latencyMs}ms${result.truncated ? ' · 일부만 표시' : ''}`
        : `연결됨 · ${result.latencyMs}ms · 모델은 직접 입력해 주세요.`)
    } catch (error) {
      setMessage(error instanceof Error ? `연결 확인 실패: ${error.message}` : 'Gateway 연결을 확인하지 못했습니다.')
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <div className="view settings-view">
      <div className="settings-layout">
        <section className="settings-content guide-llm-settings">
          <div className="settings-title"><h2>LLM 연결</h2><p>OpenAI-compatible 사내 API를 연결합니다. API key는 환경변수 또는 이 PC의 안전한 저장소를 사용합니다.</p></div>

          <div className="settings-card">
            <div className="setting-row"><label htmlFor="base-url"><strong>Base URL</strong><span>/v1 endpoint</span></label><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://llm-gateway.example/v1" /></div>
            <div className="setting-row"><label htmlFor="model"><strong>Model</strong><span>{models.length ? `${models.length}개 확인됨` : '모델 ID'}</span></label><input id="model" list="available-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="예: qwen3-32b" /><datalist id="available-models">{models.map((item) => <option value={item} key={item} />)}</datalist></div>
            <div className="setting-row"><label htmlFor="key"><strong>API key</strong><span>{summary?.managedByEnvironment.apiKey ? '환경변수 관리 중' : summary?.apiKeyConfigured && urlOrigin(loadedBaseUrl) !== urlOrigin(baseUrl) ? '주소 변경 · key 재입력 필요' : summary?.apiKeyConfigured ? '설정됨' : isVertexBaseUrl(baseUrl) ? 'gcloud 자동 인증' : '선택 사항'}</span></label><div className="secret-input"><KeyRound size={16} /><input id="key" type="password" value={apiKey} disabled={saving || summary?.managedByEnvironment.apiKey === true} onChange={(event) => setApiKey(event.target.value)} placeholder={summary?.managedByEnvironment.apiKey ? '환경변수로 관리됨' : summary?.apiKeyConfigured ? '••••••••••••••••' : isVertexBaseUrl(baseUrl) ? '입력하지 않음' : '선택 사항'} /><button type="button" disabled={saving || apiKeyAction(apiKey, summary) === 'environment-managed'} onClick={() => void handleApiKeyAction()}>{saving ? '처리 중…' : apiKeyActionLabel(apiKeyAction(apiKey, summary))}</button></div>{summary?.managedByEnvironment.apiKey && <p className="settings-note">환경변수로 관리 중인 API key는 앱에서 입력하거나 저장할 수 없습니다.</p>}</div>
            <div className="connection-test"><span><i className={summary?.configured || models.length ? '' : 'idle'} /> {summary?.configured ? `연결됨 · ${summary.source}` : '로컬 규칙 엔진 사용 중'}</span><button type="button" disabled={discovering || refreshing || !baseUrl.trim()} onClick={() => void discoverModels()}><PlugZap size={15} /> {discovering ? '연결 중' : '모델 목록 확인'}</button></div>
          </div>

          <div className="settings-two-column">
            <div className="settings-card compact-card guide-rate-limits">
              <div className="settings-section-title"><strong>호출 제한</strong></div>
              <label className="inline-field"><span>RPM</span><input type="number" min={1} max={10_000} step={1} value={requestsPerMinute} onChange={(event) => setRequestsPerMinute(event.target.value)} /></label>
              <label className="inline-field"><span>TPM</span><input type="number" min={MIN_LLM_TOKENS_PER_MINUTE} max={10_000_000} step={1} value={tokensPerMinute} onChange={(event) => setTokensPerMinute(event.target.value)} /></label>
              <label className="inline-field"><span>Timeout</span><div><input type="number" min={5} max={300} step={1} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} /><small>sec</small></div></label>
              <label className="inline-field"><span>Retries</span><input type="number" min={0} max={5} step={1} value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} /></label>
              <p className="settings-note">{llmRateLimitHelpText()}</p>
            </div>

            <div className="settings-card compact-card">
              <div className="settings-section-title"><strong>로컬 분석</strong></div>
              <ul className="offline-list">
                <li><Check size={15} /> 로그 검색 · 정규식</li>
                <li><Check size={15} /> 판정 규칙 · 근거 줄</li>
                <li><Check size={15} /> 결과표 · 패턴 집계</li>
              </ul>
              <p className="settings-note">LLM이 느리거나 제한되어도 로그 분석은 계속됩니다.</p>
            </div>
          </div>

          <div className="settings-actions"><span>{message || (saved ? '이 PC에 저장됨' : '이 PC에만 적용')}</span><button className="primary-button" disabled={saving} onClick={() => void save()}>{saved ? <Check size={16} /> : <Save size={16} />}{saved ? '저장됨' : '저장'}</button></div>
        </section>
      </div>
    </div>
  )
}
