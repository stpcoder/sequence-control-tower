import type { NativeAgentContextKind, NativeAgentEvaluationStage } from '../../electron/shared/contracts'
import type { AppPage } from '../state/appNavigation'

export const AGENT_EVALUATION_STAGES: readonly NativeAgentEvaluationStage[] = [
  'purpose', 'results', 'interpretation', 'trends', 'next_plan',
]

export const AGENT_EVALUATION_STAGE_LABELS: Record<NativeAgentEvaluationStage, string> = {
  purpose: '평가 목적',
  results: '평가 결과',
  interpretation: '결과 해석',
  trends: '불량 경향',
  next_plan: '다음 평가',
}

export function isAgentEvaluationStage(value: unknown): value is NativeAgentEvaluationStage {
  return typeof value === 'string' && AGENT_EVALUATION_STAGES.includes(value as NativeAgentEvaluationStage)
}

export function defaultAgentStageForContext(contextKind: NativeAgentContextKind): NativeAgentEvaluationStage {
  if (contextKind === 'analysis_view') return 'trends'
  if (contextKind === 'evaluation_history') return 'next_plan'
  if (contextKind === 'project_compare') return 'interpretation'
  if (contextKind === 'log_search' || contextKind === 'results') return 'results'
  return 'purpose'
}

export function defaultAgentStageForPage(page: AppPage): NativeAgentEvaluationStage {
  if (page === 'workbench' || page === 'results') return 'results'
  if (page === 'patterns') return 'trends'
  if (page === 'history') return 'next_plan'
  return 'purpose'
}

const STAGE_FOCUS: Record<NativeAgentEvaluationStage, string> = {
  purpose: '파일명 조건, 입력 명령, 저장된 검색 행동으로 이번 평가가 확인하려는 대상을 정리합니다. 목적이 불확실하면 후보를 짧게 제시하고 엔지니어에게 확인합니다.',
  results: '현재 폴더 전체의 판정과 조건을 로컬 근거로 정확히 집계합니다. LLM 추론보다 확정 규칙과 Pass/Fail 근거를 우선합니다.',
  interpretation: '확정 결과와 대조 조건을 바탕으로 개선, 악화, side effect를 구분합니다. 근거가 부족한 인과관계는 가설로 표시합니다.',
  trends: '온도, VDD, 주파수, Skew, Sample과 Fail 주소 차원의 집중 경향을 분모와 함께 비교합니다. 근거가 있는 차원만 남깁니다.',
  next_plan: '현재 폴더와 프로젝트 이력을 연결해 다음 검증 조건을 제안합니다. 과거 근거가 없으면 현재 결과에서 바로 검증 가능한 계획만 제시합니다.',
}

/** Thin execution context. LPDDR criteria stay in the installed failure-analysis Skill. */
export function agentEvaluationStageInstruction(stage: NativeAgentEvaluationStage | undefined): string {
  const current = stage ?? 'purpose'
  return `현재 작업 단계: ${AGENT_EVALUATION_STAGE_LABELS[current]}\n${STAGE_FOCUS[current]}\n평가 목적, 평가 결과, 결과 해석, 불량 경향, 다음 평가의 다섯 단계는 하나의 프로젝트 기억으로 계속 유지하십시오. 현재 단계에 우선 답하되 다른 단계의 확정 정보를 버리거나 임의로 다시 정의하지 마십시오.`
}
