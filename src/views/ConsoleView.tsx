import { useState } from 'react'
import { Activity, AlertTriangle, ChevronRight, CircleCheck, Clock3, HardDrive, Pause, Play, Radio, RotateCcw, Server, ShieldAlert, Thermometer, Unplug, Zap } from 'lucide-react'
import { slots } from '../data/demo'
import { StatusDot } from '../components/StatusDot'

export function ConsoleView() {
  const [selected, setSelected] = useState(slots[0].id)
  const current = slots.find((slot) => slot.id === selected) ?? slots[0]

  return (
    <div className="view console-view">
      <div className="console-banner">
        <div><Radio size={17} /><span><strong>EQUIPMENT-PC-03</strong> · Windows Agent connected · 14ms</span></div>
        <div><Server size={15} /> 4 slots <HardDrive size={15} /> 284 GB free <Clock3 size={15} /> synced 8 sec ago</div>
      </div>

      <section className="slot-grid guide-equipment-slots">
        {slots.map((slot) => (
          <button key={slot.id} className={`slot-card ${selected === slot.id ? 'active' : ''} ${slot.status}`} onClick={() => setSelected(slot.id)}>
            <div className="slot-top"><span>{slot.id}</span><StatusDot status={slot.status} /></div>
            <strong>{slot.sample}</strong>
            <p>{slot.detail}</p>
            <div className="slot-phase"><span>{slot.phase}</span><small>{slot.progress}%</small></div>
            <div className="slot-progress"><i style={{ width: `${slot.progress}%` }} /></div>
            <div className="slot-foot"><span>{slot.eta}</span><span>{slot.signal}</span></div>
          </button>
        ))}
      </section>

      <div className="console-layout">
        <section className="panel run-timeline guide-run-timeline">
          <div className="panel-heading">
            <div><span className="section-kicker">{current.id} · RUN-624</span><h3>{current.sample} 실행 타임라인</h3></div>
            <div className="run-actions"><button><Pause size={15} /> 일시정지</button><button className="danger"><Unplug size={15} /> 안전 중단</button></div>
          </div>
          <div className="timeline-steps">
            <TimelineStep icon={<CircleCheck size={15} />} title="Identity & preflight" meta="COM14 · ADB R58M…871 · 12/12 verified" time="13:21" state="done" />
            <TimelineStep icon={<Thermometer size={15} />} title="Environment stabilization" meta="105.1℃ · 0.910V · dwell 15m" time="13:39" state="done" />
            <TimelineStep icon={<Zap size={15} />} title="Sequence blocks 01—17" meta="17 passed · 0 warning · baseline range" time="14:01" state="done" />
            <TimelineStep icon={<Activity size={15} />} title="Block 18 · Pattern 6060" meta="Diagnostic running · 응답 정상" time="NOW" state="active" />
            <TimelineStep icon={<HardDrive size={15} />} title="Artifact collection" meta="raw log · logcat · manifest" time="—" state="pending" />
          </div>
        </section>

        <aside className="panel preflight-panel guide-preflight">
          <div className="panel-heading compact"><div><span className="section-kicker">LIVE SAFETY</span><h3>실행 근거</h3></div><span className="safety-score">12 / 12</span></div>
          <div className="preflight-list">
            <p><CircleCheck size={15} /><span>Board identity<strong>SM8750-A03 일치</strong></span></p>
            <p><CircleCheck size={15} /><span>Sequence artifact<strong>SHA-256 verified</strong></span></p>
            <p><CircleCheck size={15} /><span>Temperature<strong>105.1℃ · ±0.2</strong></span></p>
            <p><CircleCheck size={15} /><span>VDD readback<strong>0.910V</strong></span></p>
            <p><CircleCheck size={15} /><span>Resource lock<strong>COM14 · TC1 · VDD2</strong></span></p>
          </div>
          <div className="safety-note"><ShieldAlert size={16} /><p>LLM 응답이 없어도 실행 정책과 안전 차단은 로컬에서 계속 동작합니다.</p></div>
        </aside>
      </div>

      <section className="live-event-strip">
        <div className="event-main"><Activity size={16} /><span><small>14:08:45</small><strong>hdiag 응답을 관찰 중입니다.</strong><p>정상 범위 10—40초 · 현재 22초 · 자동 재전송 금지</p></span></div>
        <div className="event-actions"><button><Play size={14} /> Raw tail</button><button><RotateCcw size={14} /> 기준 Run 비교</button><button><ChevronRight size={15} /> 상세</button></div>
      </section>

      <div className="simulation-note"><AlertTriangle size={14} /> PoC에서는 장비 상태가 시뮬레이션됩니다. 실제 Serial/ADB 연결은 Agent adapter 연동 단계에서 활성화됩니다.</div>
    </div>
  )
}

function TimelineStep({ icon, title, meta, time, state }: { icon: React.ReactNode; title: string; meta: string; time: string; state: string }) {
  return <div className={`timeline-step ${state}`}><div className="step-track"><i>{icon}</i></div><div><strong>{title}</strong><p>{meta}</p></div><span>{time}</span></div>
}
