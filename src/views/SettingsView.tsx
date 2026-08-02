import { useEffect, useState } from 'react'
import { Check, CloudCog, Database, Gauge, KeyRound, PlugZap, Save, ServerCog, ShieldCheck, SlidersHorizontal, WifiOff } from 'lucide-react'
import type { LlmConfigSummary } from '../../electron/shared/contracts'

function urlOrigin(value: string): string {
  try {
    return value.trim() ? new URL(value).origin : ''
  } catch {
    return ''
  }
}

export function SettingsView() {
  const [saved, setSaved] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [loadedBaseUrl, setLoadedBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [summary, setSummary] = useState<LlmConfigSummary | null>(null)
  const [message, setMessage] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [discovering, setDiscovering] = useState(false)

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
    const api = window.sequenceIntelligence
    if (!api) {
      setSaved(true)
      setMessage('웹 미리보기 설정입니다. Windows 앱에서는 이 PC에 안전하게 저장됩니다.')
      return
    }
    try {
      const hostChanged = Boolean(
        summary?.apiKeyConfigured &&
        urlOrigin(loadedBaseUrl) &&
        urlOrigin(baseUrl) !== urlOrigin(loadedBaseUrl),
      )
      const updated = await api.settings.saveLlm({ baseUrl, model, apiKey: apiKey || undefined })
      setSummary(updated)
      setLoadedBaseUrl(updated.baseUrl)
      setApiKey('')
      setSaved(true)
      setMessage(hostChanged && !apiKey
        ? 'Gateway 주소가 바뀌어 이전 host의 API key를 안전하게 해제했습니다.'
        : updated.apiKeyPersisted
          ? '설정과 암호화된 API key를 저장했습니다.'
          : '설정을 저장했습니다. API key는 OS 암호화 가능 여부에 따라 세션에만 유지될 수 있습니다.')
    } catch (error) {
      setSaved(false)
      setMessage(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.')
    }
  }

  const discoverModels = async () => {
    const api = window.sequenceIntelligence
    if (!api) {
      const demoModels = ['qwen3-32b', 'glm-4.5-air', 'lab-reasoning-32b']
      setModels(demoModels)
      if (!model) setModel(demoModels[0])
      setMessage('웹 미리보기 모델입니다. Windows 앱에서는 사내 Gateway의 /models를 한 번만 조회합니다.')
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
        <aside className="settings-index">
          <span>환경 설정</span>
          <button className="active"><CloudCog size={16} /> AI Gateway</button>
          <button disabled title="PoC에서는 자동 관리됩니다"><Database size={16} /> Local Storage <small>자동</small></button>
          <button disabled title="고객사별 adapter 확장 지점입니다"><SlidersHorizontal size={16} /> Parser Profiles <small>확장</small></button>
          <button disabled title="실장기 제어는 시뮬레이션 범위입니다"><ServerCog size={16} /> Equipment Agents <small>다음 단계</small></button>
        </aside>

        <section className="settings-content guide-llm-settings">
          <div className="settings-title"><span className="section-kicker">OPENAI-COMPATIBLE API</span><h2>사내 AI Gateway</h2><p>비밀키는 로컬 main process에만 저장되며 Renderer와 Wiki에 노출되지 않습니다.</p></div>

          <div className="settings-card">
            <div className="setting-row"><label htmlFor="base-url"><strong>Base URL</strong><span>사내 OpenAI-compatible endpoint</span></label><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://internal-vllm.company.local/v1" /></div>
            <div className="setting-row"><label htmlFor="model"><strong>Model</strong><span>{models.length ? `Gateway에서 확인된 ${models.length}개 모델` : '연결 확인 후 자동 선택하거나 직접 입력'}</span></label><input id="model" list="available-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="연결 확인 시 자동 선택" /><datalist id="available-models">{models.map((item) => <option value={item} key={item} />)}</datalist></div>
            <div className="setting-row"><label htmlFor="key"><strong>API key</strong><span>{summary?.apiKeyConfigured && urlOrigin(loadedBaseUrl) !== urlOrigin(baseUrl) ? '주소 변경 시 이전 host의 key는 해제됩니다' : summary?.apiKeyConfigured ? '현재 key가 설정되어 있습니다' : '입력하지 않으면 기존 key 유지'}</span></label><div className="secret-input"><KeyRound size={15} /><input id="key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={summary?.apiKeyConfigured ? '••••••••••••••••' : '선택 사항'} /><button type="button" onClick={() => setApiKey('')}>입력 지우기</button></div></div>
            <div className="connection-test"><span><i className={summary?.configured || models.length ? '' : 'idle'} /> {summary?.configured ? `Gateway configured · ${summary.source}` : '미연결 시 로컬 엔진 사용'}</span><button type="button" disabled={discovering || refreshing || !baseUrl.trim()} onClick={() => void discoverModels()}><PlugZap size={14} /> {discovering ? '연결 중' : '연결 확인 · 모델 찾기'}</button></div>
          </div>

          <div className="settings-two-column">
            <div className="settings-card compact-card guide-rate-limits">
              <div className="card-icon-heading"><Gauge size={18} /><div><strong>Rate & latency 보호</strong><span>느린 시간대에도 UX를 멈추지 않습니다.</span></div></div>
              <label className="inline-field"><span>RPM limit <small>환경 변수</small></span><input type="number" value={summary?.limits.requestsPerMinute ?? 8} readOnly /></label>
              <label className="inline-field"><span>TPM limit <small>환경 변수</small></span><input type="number" value={summary?.limits.tokensPerMinute ?? 80000} readOnly /></label>
              <label className="inline-field"><span>Timeout <small>환경 변수</small></span><div><input type="number" value={Math.round((summary?.limits.timeoutMs ?? 60000) / 1000)} readOnly /><small>sec</small></div></label>
              <label className="toggle-row"><span><strong>같은 분석 결과 캐시</strong><small>Sequence hash + prompt version 기준</small></span><input type="checkbox" defaultChecked /></label>
              <label className="toggle-row"><span><strong>대기열 백그라운드 처리</strong><small>화면 이동 후에도 안전하게 재시도</small></span><input type="checkbox" defaultChecked /></label>
            </div>

            <div className="settings-card compact-card">
              <div className="card-icon-heading"><WifiOff size={18} /><div><strong>LLM 없이도 계속 동작</strong><span>로컬 엔진이 담당하는 영역입니다.</span></div></div>
              <ul className="offline-list">
                <li><Check size={14} /> Sequence 문법 파싱</li>
                <li><Check size={14} /> DNA·fingerprint 추출</li>
                <li><Check size={14} /> 유사도 및 부모 후보</li>
                <li><Check size={14} /> 원본 SHA-256 보존</li>
                <li><Check size={14} /> Semantic diff 후보 추출</li>
              </ul>
              <div className="security-callout"><ShieldCheck size={16} /><p>LLM은 설명과 불확실성 질문에만 사용하며, 원본 보존과 안전 정책에는 관여하지 않습니다.</p></div>
            </div>
          </div>

          <div className="settings-actions"><span>{message || (saved ? '설정이 로컬에 저장되었습니다.' : '변경 사항은 이 PC에만 적용됩니다.')}</span><button className="primary-button" onClick={() => void save()}>{saved ? <Check size={16} /> : <Save size={16} />}{saved ? '저장됨' : '설정 저장'}</button></div>
        </section>
      </div>
    </div>
  )
}
