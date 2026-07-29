import { FormEvent, useState } from 'react'
import { ArrowUp, BookOpen, Clock3, Link2, Sparkles, X } from 'lucide-react'

interface AgentPanelProps {
  open: boolean
  onClose: () => void
  onOpen: () => void
}

const answers = [
  {
    role: 'agent',
    body: 'SEQ-1054는 이전 버전보다 CLK 범위를 좁히고 Pattern 2개를 선택했습니다. 다만 변경 목적은 파일만으로 확정하기 어렵습니다.',
  },
  {
    role: 'question',
    body: '이 변경은 CLK 경계 확인이 주목적인가요?',
  },
]

export function AgentPanel({ open, onClose, onOpen }: AgentPanelProps) {
  const [messages, setMessages] = useState(answers)
  const [input, setInput] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = input.trim()
    if (!value) return
    setMessages((current) => [
      ...current,
      { role: 'user', body: value },
      {
        role: 'agent',
        body: '확인했습니다. 응답을 이 Revision의 승인된 목적에 반영하고, 같은 Family의 추론에도 재사용하겠습니다.',
      },
    ])
    setInput('')
  }

  if (!open) {
    return (
      <button className="agent-fab" onClick={onOpen}>
        <Sparkles size={18} />
        <span>Agent에게 묻기</span>
        <kbd>Ctrl J</kbd>
      </button>
    )
  }

  return (
    <aside className="agent-panel">
      <div className="agent-panel-head">
        <div className="agent-orb">
          <Sparkles size={16} />
        </div>
        <div>
          <strong>Evaluation Agent</strong>
          <span>근거 기반 검토 · 로컬 캐시 사용</span>
        </div>
        <button className="icon-button small" onClick={onClose} aria-label="Agent 패널 닫기">
          <X size={16} />
        </button>
      </div>

      <div className="agent-context">
        <span>현재 컨텍스트</span>
        <strong>SEQ-1054 · CLK boundary</strong>
        <small>4 artifacts · 2 verified cases</small>
      </div>

      <div className="agent-thread">
        <div className="agent-day-divider">오늘 · 14:08</div>
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`agent-message ${message.role}`}>
            {message.role === 'agent' ? <Sparkles size={14} /> : null}
            <p>{message.body}</p>
          </div>
        ))}
        {messages.length === 2 ? (
          <div className="quick-answers">
            <button onClick={() => setMessages((m) => [...m, { role: 'user', body: '네, CLK 경계 확인입니다.' }])}>CLK 경계 확인</button>
            <button onClick={() => setMessages((m) => [...m, { role: 'user', body: 'Pattern 의존성 확인입니다.' }])}>Pattern 의존성</button>
            <button onClick={() => setMessages((m) => [...m, { role: 'user', body: '두 가지 모두입니다.' }])}>두 가지 모두</button>
          </div>
        ) : null}
        <div className="agent-sources">
          <span><Link2 size={12} /> 근거 4개</span>
          <span><BookOpen size={12} /> CASE-042</span>
          <span><Clock3 size={12} /> cache hit</span>
        </div>
      </div>

      <form className="agent-composer" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="변경 이유나 평가 맥락을 알려주세요…"
          rows={2}
        />
        <div>
          <span>LLM 지연 시 대기열에 안전하게 저장됩니다</span>
          <button type="submit" aria-label="메시지 보내기"><ArrowUp size={16} /></button>
        </div>
      </form>
    </aside>
  )
}
