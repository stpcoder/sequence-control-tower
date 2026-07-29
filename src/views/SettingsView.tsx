import { useEffect, useState } from 'react'
import { Check, CloudCog, Database, Gauge, KeyRound, RotateCw, Save, ServerCog, ShieldCheck, SlidersHorizontal, WifiOff } from 'lucide-react'
import type { LlmConfigSummary } from '../../electron/shared/contracts'

export function SettingsView() {
  const [saved, setSaved] = useState(false)
  const [baseUrl, setBaseUrl] = useState('http://internal-llm.company.local/v1')
  const [model, setModel] = useState('lab-reasoning-32b')
  const [apiKey, setApiKey] = useState('')
  const [summary, setSummary] = useState<LlmConfigSummary | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const api = window.sequenceIntelligence
    if (!api) return
    void api.settings.getLlm().then((current) => {
      setSummary(current)
      if (current.baseUrl) setBaseUrl(current.baseUrl)
      if (current.model) setModel(current.model)
    }).catch(() => setMessage('저장된 LLM 설정을 읽지 못했습니다.'))
  }, [])

  const save = async () => {
    const api = window.sequenceIntelligence
    if (!api) {
      setSaved(true)
      setMessage('웹 미리보기 설정입니다. Windows 앱에서는 이 PC에 안전하게 저장됩니다.')
      return
    }
    try {
      const updated = await api.settings.saveLlm({ baseUrl, model, apiKey: apiKey || undefined })
      setSummary(updated)
      setApiKey('')
      setSaved(true)
      setMessage(updated.apiKeyPersisted ? '설정과 암호화된 API key를 저장했습니다.' : '설정을 저장했습니다. API key는 OS 암호화 가능 여부에 따라 세션에만 유지될 수 있습니다.')
    } catch (error) {
      setSaved(false)
      setMessage(error instanceof Error ? error.message : '설정을 저장하지 못했습니다.')
    }
  }

  return (
    <div className="view settings-view">
      <div className="settings-layout">
        <aside className="settings-index">
          <span>환경 설정</span>
          <button className="active"><CloudCog size={16} /> AI Gateway</button>
          <button><Database size={16} /> Local Storage</button>
          <button><SlidersHorizontal size={16} /> Parser Profiles</button>
          <button><ServerCog size={16} /> Equipment Agents</button>
        </aside>

        <section className="settings-content guide-llm-settings">
          <div className="settings-title"><span className="section-kicker">OPENAI-COMPATIBLE API</span><h2>사내 AI Gateway</h2><p>비밀키는 로컬 main process에만 저장되며 Renderer와 Wiki에 노출되지 않습니다.</p></div>

          <div className="settings-card">
            <div className="setting-row"><label htmlFor="base-url"><strong>Base URL</strong><span>사내 OpenAI-compatible endpoint</span></label><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div>
            <div className="setting-row"><label htmlFor="model"><strong>Model</strong><span>Sequence 설명 및 질의에 사용할 모델</span></label><input id="model" value={model} onChange={(event) => setModel(event.target.value)} /></div>
            <div className="setting-row"><label htmlFor="key"><strong>API key</strong><span>{summary?.apiKeyConfigured ? '현재 key가 설정되어 있습니다' : '입력하지 않으면 기존 key 유지'}</span></label><div className="secret-input"><KeyRound size={15} /><input id="key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={summary?.apiKeyConfigured ? '••••••••••••••••' : '선택 사항'} /><button type="button" onClick={() => setApiKey('')}>지우기</button></div></div>
            <div className="connection-test"><span><i className={summary?.configured ? '' : 'idle'} /> {summary?.configured ? `Gateway configured · ${summary.source}` : '로컬 fallback 활성화'}</span><button><RotateCw size={14} /> 연결 상태 새로고침</button></div>
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
