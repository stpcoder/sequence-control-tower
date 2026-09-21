import type { EvaluationDimensions, EvaluationPurpose } from './evaluation-memory'

export const EVALUATION_REPORT_OUTCOMES = [
  'PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT',
  'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED',
] as const

export type EvaluationReportOutcome = typeof EVALUATION_REPORT_OUTCOMES[number]
export type EvaluationReportConfidence = 'high' | 'medium' | 'low'
export type EvaluationReportSectionState = 'computed' | 'agent-proposed' | 'engineer-confirmed'

export interface EvaluationReportTextSection {
  text: string
  confidence: EvaluationReportConfidence
  evidenceSourceIds: string[]
  state: EvaluationReportSectionState
}

export interface EvaluationPurposeSection extends EvaluationReportTextSection {
  category?: EvaluationPurpose
  baselineNodeId?: string
  changedConditions: string[]
  fixedConditions: string[]
}

export interface EvaluationResultSection {
  summary: string
  total: number
  definitive: number
  byOutcome: Partial<Record<EvaluationReportOutcome, number>>
  unknown: number
  excluded: number
  coverage: 'complete' | 'partial'
  evidenceSourceIds: string[]
  state: 'computed'
}

export interface EvaluationInterpretationSection extends EvaluationReportTextSection {
  findings: string[]
  counterEvidence: string[]
  caveats: string[]
}

export interface EvaluationTrendFinding {
  dimension: string
  value: string
  statement: string
  failures?: number
  total?: number
  failureRate?: number
  confidence: EvaluationReportConfidence
  evidenceSourceIds: string[]
}

export interface EvaluationTrendSection extends EvaluationReportTextSection {
  findings: EvaluationTrendFinding[]
}

export interface EvaluationNextPlanSection extends EvaluationReportTextSection {
  objective?: string
  changedVariable?: string
  levels: string[]
  heldConditions: string[]
  samples: string[]
  repeats?: number
  successCriteria: string[]
  historyNodeIds: string[]
}

/** One folder produces one report. Results stay deterministic; the Agent may
 * author purpose, interpretation, trends and the next plan, but every section
 * retains its provenance and evidence references. */
export interface EvaluationReport {
  schemaVersion: 1
  revision: number
  createdAt: string
  updatedAt: string
  purpose: EvaluationPurposeSection
  results: EvaluationResultSection
  interpretation: EvaluationInterpretationSection
  trends: EvaluationTrendSection
  nextPlan: EvaluationNextPlanSection
}

export interface EvaluationReportSource {
  id: string
  name?: string
  result?: string
  dimensions?: Partial<EvaluationDimensions>
}

export interface EvaluationReportDraftInput {
  title: string
  purpose?: EvaluationPurpose
  purposeText?: string
  interpretation?: string
  sources: readonly EvaluationReportSource[]
  evidenceSourceIds?: readonly string[]
  changedConditions?: readonly string[]
  fixedConditions?: readonly string[]
  createdAt?: string
}

function clean(value: unknown, maximum = 4_000): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
    : ''
}

export function normalizeEvaluationReportOutcome(value: unknown): EvaluationReportOutcome {
  const normalized = clean(value, 80).toUpperCase().replace(/[ -]+/g, '_')
  if (EVALUATION_REPORT_OUTCOMES.includes(normalized as EvaluationReportOutcome)) return normalized as EvaluationReportOutcome
  if (normalized === 'FAIL' || normalized === 'HIDAG_FAIL' || normalized === 'HDIAG_FAIL') return 'DIAG_FAIL'
  if (/REBOOT/.test(normalized)) return 'SYSTEM_REBOOT'
  if (/HALT/.test(normalized)) return 'SYSTEM_HALT'
  if (/TRAINING.*FAIL|FAIL.*TRAINING/.test(normalized)) return 'TRAINING_FAIL'
  if (/PASS/.test(normalized)) return 'PASS'
  if (/FAIL/.test(normalized)) return 'TEST_FAIL'
  return 'UNKNOWN'
}

export function buildEvaluationResultSection(sources: readonly EvaluationReportSource[]): EvaluationResultSection {
  const byOutcome: Partial<Record<EvaluationReportOutcome, number>> = {}
  const evidenceSourceIds: string[] = []
  for (const source of sources) {
    const outcome = normalizeEvaluationReportOutcome(source.result)
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1
    evidenceSourceIds.push(source.id)
  }
  const unknown = byOutcome.UNKNOWN ?? 0
  const excluded = byOutcome.EXCLUDED ?? 0
  const total = sources.length
  const definitive = Math.max(0, total - unknown - excluded)
  const ordered = EVALUATION_REPORT_OUTCOMES
    .filter((outcome) => (byOutcome[outcome] ?? 0) > 0)
    .map((outcome) => `${outcome} ${byOutcome[outcome]}개`)
  return {
    summary: ordered.length ? ordered.join(' · ') : '판정된 로그가 없습니다.',
    total,
    definitive,
    byOutcome,
    unknown,
    excluded,
    coverage: unknown === 0 ? 'complete' : 'partial',
    evidenceSourceIds: [...new Set(evidenceSourceIds)],
    state: 'computed',
  }
}

export function createEvaluationReportDraft(input: EvaluationReportDraftInput): EvaluationReport {
  const stamp = input.createdAt ?? new Date().toISOString()
  const evidenceSourceIds = [...new Set(input.evidenceSourceIds?.length ? input.evidenceSourceIds : input.sources.map((source) => source.id))]
  const results = buildEvaluationResultSection(input.sources)
  const purposeText = clean(input.purposeText) || `${clean(input.title, 240) || '현재 폴더'} 평가의 목적을 확인해야 합니다.`
  const interpretation = clean(input.interpretation) || (results.definitive
    ? `${results.summary}로 확인되었습니다. 조건별 재현 경향과 반복되는 Fail signature를 이전 평가와 비교해야 합니다.`
    : '확정된 결과가 부족해 재현 경향 해석을 보류합니다.')
  return {
    schemaVersion: 1,
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
    purpose: {
      text: purposeText,
      ...(input.purpose ? { category: input.purpose } : {}),
      changedConditions: [...new Set(input.changedConditions ?? [])].map((item) => clean(item, 160)).filter(Boolean),
      fixedConditions: [...new Set(input.fixedConditions ?? [])].map((item) => clean(item, 160)).filter(Boolean),
      confidence: input.purposeText ? 'medium' : 'low',
      evidenceSourceIds,
      state: 'agent-proposed',
    },
    results,
    interpretation: {
      text: interpretation,
      findings: [], counterEvidence: [], caveats: [],
      confidence: results.coverage === 'complete' && results.definitive ? 'medium' : 'low',
      evidenceSourceIds,
      state: 'agent-proposed',
    },
    trends: {
      text: '조건별 비교 결과가 충분하지 않습니다.', findings: [], confidence: 'low',
      evidenceSourceIds, state: 'computed',
    },
    nextPlan: {
      text: '현재 결과와 과거 평가를 비교한 뒤 다음 평가 조건을 확정합니다.',
      levels: [], heldConditions: [], samples: [], successCriteria: [], historyNodeIds: [],
      confidence: 'low', evidenceSourceIds, state: 'agent-proposed',
    },
  }
}

export function evaluationReportInterpretation(report: EvaluationReport): string {
  return [report.purpose.text, report.results.summary, report.interpretation.text, report.trends.text, report.nextPlan.text]
    .map((item) => clean(item))
    .filter(Boolean)
    .join(' ')
    .slice(0, 4_000)
}
