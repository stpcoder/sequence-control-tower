import { useEffect, useState } from 'react'
import type { DemoPage } from '../data/demo'

const labels: Record<DemoPage, { selector: string; number: number; label: string }[]> = {
  workbench: [
    { selector: '.workbench-sidebar', number: 1, label: '여러 폴더의 로그 탐색' },
    { selector: '.workbench-editor-shell', number: 2, label: '검색 중심 읽기 전용 로그 뷰어' },
    { selector: '.decision-panel', number: 3, label: '근거·판정·Recipe 저장' },
  ],
  tower: [
    { selector: '.guide-project-overview', number: 1, label: '프로젝트 목적과 현재 핵심 판단' },
    { selector: '.guide-project-lineage', number: 2, label: '평가 Revision 계보' },
    { selector: '.guide-knowledge-gaps', number: 3, label: '가장 가치가 큰 확인 작업' },
  ],
  inbox: [
    { selector: '.guide-import-sequence', number: 1, label: 'Sequence·폴더 가져오기' },
    { selector: '.guide-inbox-list', number: 2, label: '분류 대기함' },
    { selector: '.guide-agent-question', number: 3, label: 'Agent의 최소 확인 질문' },
  ],
  review: [
    { selector: '.guide-semantic-story', number: 1, label: '변경의 목적과 의미' },
    { selector: '.guide-semantic-diff', number: 2, label: '명령과 의미를 함께 비교' },
    { selector: '.guide-ai-finding', number: 3, label: '근거 기반 Finding' },
  ],
  console: [
    { selector: '.guide-equipment-slots', number: 1, label: '4대 실장기 상태' },
    { selector: '.guide-run-timeline', number: 2, label: '평가 진행 타임라인' },
    { selector: '.guide-preflight', number: 3, label: '로컬 안전 근거' },
  ],
  knowledge: [
    { selector: '.guide-knowledge-library', number: 1, label: '승인된 회사 평가 지식' },
    { selector: '.guide-knowledge-case', number: 2, label: '근거가 연결된 사례' },
  ],
  settings: [
    { selector: '.guide-llm-settings', number: 1, label: '사내 LLM 연결 설정' },
    { selector: '.guide-rate-limits', number: 2, label: 'TPM·RPM·지연 보호' },
  ],
}

const agentLabels = [
  { selector: '.agent-context', number: 1, label: '현재 검토 중인 평가 컨텍스트' },
  { selector: '.quick-answers', number: 2, label: '부담이 적은 선택형 확인' },
  { selector: '.agent-sources', number: 3, label: '근거와 캐시 상태' },
  { selector: '.agent-composer', number: 4, label: '필요할 때만 자유 대화' },
]

export function GuideOverlay({ page }: { page: DemoPage }) {
  const [boxes, setBoxes] = useState<{ top: number; left: number; width: number; height: number; number: number; label: string }[]>([])

  useEffect(() => {
    const measure = () => {
      const agentOnly = new URLSearchParams(window.location.search).get('agentguide') === '1'
      const requested = agentOnly ? agentLabels : labels[page]
      setBoxes(requested.flatMap((item) => {
        const element = document.querySelector<HTMLElement>(item.selector)
        if (!element) return []
        const rect = element.getBoundingClientRect()
        return [{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, number: item.number, label: item.label }]
      }))
    }
    const timer = window.setTimeout(measure, 350)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [page])

  return (
    <div className="guide-overlay" aria-hidden="true">
      {boxes.map((box) => <GuideBox key={`${page}-${box.number}`} {...box} />)}
    </div>
  )
}

function GuideBox({ top, left, width, height, number, label }: { top: number; left: number; width: number; height: number; number: number; label: string }) {
  return (
    <div className="guide-box" style={{ top: top - 4, left: left - 4, width: width + 8, height: height + 8 }}>
      <span>{number}</span><strong>{label}</strong>
    </div>
  )
}
