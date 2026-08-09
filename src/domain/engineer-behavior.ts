import type {
  EngineerEvaluationStage,
  EngineerWorkflowCheckView,
  EngineerWorkflowResult,
  ProjectEvaluationDimensions,
} from '../../electron/shared/contracts'

export interface EngineerSearchEvent {
  query: string
  mode: 'literal' | 'regex'
  caseSensitive: boolean
  matchCount: number
  activeMatchCount?: number
  occurredAt: string
}

export interface EngineerWorkflowCandidate {
  stages: EngineerEvaluationStage[]
  checks: EngineerWorkflowCheckView[]
  suggestions: string[]
  signature: string
}

const STAGES: Array<{ stage: EngineerEvaluationStage; pattern: RegExp }> = [
  { stage: 'retest', pattern: /(?:^|[^a-z0-9])(?:rt|retest|re-test)(?:[^a-z0-9]|$)/i },
  { stage: 'power-on', pattern: /power[ _-]*on|platform[ _-]*init|\b(?:pbl|xbl|abl)\b|\bboot\b/i },
  { stage: 'uefi', pattern: /uefi|edk2|exit[ _-]*boot[ _-]*services|\b(?:dxe|bds)\b/i },
  { stage: 'training', pattern: /train(?:ing)?|write[ _-]*level|read[ _-]*gate|wck[ _-]*sync|dqs[ _-]*osc/i },
  { stage: 'reboot', pattern: /reboot|watchdog|warm[ _-]*reset|reset[ _-]*reason/i },
  { stage: 'halt', pattern: /system[ _-]*halt|cpu[ _-]*halt|kernel[ _-]*panic|fatal[ _-]*exception|hang|freeze/i },
  { stage: 'os', pattern: /\b(?:android|linux|kernel|adb|init\.rc|systemd|os)\b/i },
  { stage: 'memory-test', pattern: /stressapp|stressapptest|hidag|hi_diag|memtester|memory[ _-]*test|@pass|@fail|test[ _-]*pattern|diag/i },
]

const normalized = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 500)

export function classifyEngineerSearchStage(query: string): EngineerEvaluationStage {
  return STAGES.find((item) => item.pattern.test(query))?.stage ?? 'unknown'
}

export function engineerStageLabel(stage: EngineerEvaluationStage): string {
  const labels: Record<EngineerEvaluationStage, string> = {
    'power-on': 'Power on', uefi: 'UEFI', training: 'Training', os: 'OS',
    'memory-test': 'Memory test', halt: 'Halt', reboot: 'Reboot', retest: 'RT', unknown: '기타',
  }
  return labels[stage]
}

function purposeSuggestions(
  stages: EngineerEvaluationStage[],
  result: EngineerWorkflowResult,
  dimensions: Partial<ProjectEvaluationDimensions> = {},
): string[] {
  const values: string[] = []
  if (result === 'TRAINING_FAIL' || stages.includes('training')) values.push('Training 안정성 확인')
  if (result === 'SYSTEM_REBOOT' || result === 'SYSTEM_HALT' || stages.some((stage) => stage === 'reboot' || stage === 'halt')) values.push('부팅 중단 원인 확인')
  if (stages.includes('memory-test')) values.push('OS Memory Test 판정')
  else if (stages.some((stage) => stage === 'power-on' || stage === 'uefi' || stage === 'os')) values.push('부팅 경로 확인')
  if (stages.includes('retest')) values.push('RT 재현성 확인')
  if ((dimensions.temperatureC !== undefined || dimensions.vdd !== undefined || dimensions.frequencyMHz !== undefined)
    && result !== 'PASS' && result !== 'EXCLUDED') values.push('불량 가속 조건 확인')
  if (result === 'PASS') values.push('개선 조건 유효성 확인')
  return [...new Set(values)].slice(0, 3)
}

/**
 * Converts a bounded, chronological Ctrl-F trace into a review candidate.
 * It deliberately does not create a rule: only an engineer confirmation can
 * promote the candidate to durable workflow memory.
 */
export function buildEngineerWorkflowCandidate(
  events: readonly EngineerSearchEvent[],
  result: EngineerWorkflowResult,
  dimensions?: Partial<ProjectEvaluationDimensions>,
): EngineerWorkflowCandidate | null {
  const seen = new Set<string>()
  const checks = events
    .slice(-20)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .flatMap((event) => {
      const query = event.query.trim().slice(0, 500)
      const key = `${event.mode}:${event.caseSensitive ? '1' : '0'}:${normalized(query)}`
      if (query.length < 2 || seen.has(key)) return []
      seen.add(key)
      const matchCount = Number.isSafeInteger(event.activeMatchCount) && event.activeMatchCount! >= 0
        ? event.activeMatchCount!
        : Math.max(0, Math.trunc(event.matchCount || 0))
      return [{
        query,
        mode: event.mode,
        caseSensitive: event.caseSensitive,
        expected: matchCount > 0 ? 'present' as const : 'absent' as const,
        matchCount,
        stage: classifyEngineerSearchStage(query),
        order: seen.size,
      }]
    })
  // One search is ordinary navigation, not enough evidence of a workflow.
  if (checks.length < 2) return null
  const stages = [...new Set(checks.map((check) => check.stage))]
  const signature = checks.map((check) => [
    check.order, check.mode, check.caseSensitive ? 1 : 0, normalized(check.query), check.expected, check.stage,
  ].join(':')).join('|') + `|result:${result}`
  return { checks, stages, suggestions: purposeSuggestions(stages, result, dimensions), signature }
}

export function engineerWorkflowSimilarity(
  left: Pick<EngineerWorkflowCandidate, 'checks' | 'stages'>,
  right: Pick<EngineerWorkflowCandidate, 'checks' | 'stages'>,
): number {
  const values = (workflow: Pick<EngineerWorkflowCandidate, 'checks' | 'stages'>): Set<string> => new Set([
    ...workflow.checks.map((check) => `${normalized(check.query)}:${check.expected}`),
    ...workflow.stages.map((stage) => `stage:${stage}`),
  ])
  const a = values(left); const b = values(right)
  const union = new Set([...a, ...b])
  if (!union.size) return 0
  return [...a].filter((item) => b.has(item)).length / union.size
}
