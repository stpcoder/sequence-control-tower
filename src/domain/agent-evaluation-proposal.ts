import type {
  NativeAgentEvaluationProposal,
  ProjectEvaluationDimensions,
  ProjectEvaluationReportOutcome,
} from '../../electron/shared/contracts'

const OUTCOMES = new Set<ProjectEvaluationReportOutcome>([
  'PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT',
  'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED',
])
const PURPOSES = new Set(['screening', 'improvement', 'reproduction', 'characterization', 'verification', 'stage-verification'])
const DIMENSIONS = new Set<keyof ProjectEvaluationDimensions>([
  'skew', 'lot', 'material', 'die', 'sample', 'socVendor', 'socModel', 'bootProfileId', 'bl', 'dq', 'equipmentChannel',
  'eccMode', 'customCondition', 'evaluationStep', 'channel', 'subChannel', 'chipSelect', 'rank', 'bank', 'bankGroup', 'row',
  'column', 'pattern', 'writeData', 'readData', 'gridId', 'frequencyMHz', 'temperatureC', 'temperatureCorner', 'vdd',
  'vddCorner', 'conditionCorner', 'timingSkewPs', 'testMode',
])

const clean = (value: unknown, maximum = 4_000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum)
  : ''
const list = (value: unknown, maximum = 20, textMaximum = 500): string[] => Array.isArray(value)
  ? [...new Set(value.map((item) => clean(item, textMaximum)).filter(Boolean))].slice(0, maximum)
  : []

export function normalizeNativeEvaluationProposal(value: unknown): Omit<NativeAgentEvaluationProposal, 'id'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const outcome = typeof source.outcome === 'string' && OUTCOMES.has(source.outcome as ProjectEvaluationReportOutcome)
    ? source.outcome as ProjectEvaluationReportOutcome
    : 'UNKNOWN'
  const purpose = typeof source.purpose === 'string' && PURPOSES.has(source.purpose) ? source.purpose as NonNullable<NativeAgentEvaluationProposal['purpose']> : undefined
  const rawDimensions = source.dimensions && typeof source.dimensions === 'object' && !Array.isArray(source.dimensions)
    ? source.dimensions as Record<string, unknown>
    : {}
  const dimensions: Partial<ProjectEvaluationDimensions> = {}
  for (const [key, raw] of Object.entries(rawDimensions)) {
    if (!DIMENSIONS.has(key as keyof ProjectEvaluationDimensions)) continue
    if (typeof raw === 'number' && Number.isFinite(raw)) (dimensions as Record<string, unknown>)[key] = raw
    else {
      const text = clean(raw, 160)
      if (text) (dimensions as Record<string, unknown>)[key] = text
    }
  }
  const rawDraft = source.draft && typeof source.draft === 'object' && !Array.isArray(source.draft)
    ? source.draft as Record<string, unknown>
    : {}
  const draft = {
    purpose: clean(rawDraft.purpose, 1_500),
    changedConditions: list(rawDraft.changedConditions),
    fixedConditions: list(rawDraft.fixedConditions),
    interpretation: clean(rawDraft.interpretation, 3_000),
    findings: list(rawDraft.findings),
    counterEvidence: list(rawDraft.counterEvidence),
    caveats: list(rawDraft.caveats),
    trends: clean(rawDraft.trends, 3_000),
    nextPlan: clean(rawDraft.nextPlan, 3_000),
    ...(clean(rawDraft.nextObjective, 800) ? { nextObjective: clean(rawDraft.nextObjective, 800) } : {}),
    ...(clean(rawDraft.changedVariable, 160) ? { changedVariable: clean(rawDraft.changedVariable, 160) } : {}),
    levels: list(rawDraft.levels),
    heldConditions: list(rawDraft.heldConditions),
    samples: list(rawDraft.samples),
    ...(Number.isSafeInteger(rawDraft.repeats) && Number(rawDraft.repeats) > 0 && Number(rawDraft.repeats) <= 1_000 ? { repeats: Number(rawDraft.repeats) } : {}),
    successCriteria: list(rawDraft.successCriteria),
  }
  if (![draft.purpose, draft.interpretation, draft.trends, draft.nextPlan].some(Boolean)) return null
  return {
    outcome,
    ...(purpose ? { purpose } : {}),
    dimensions,
    rationale: clean(source.rationale, 1_500) || draft.interpretation,
    draft,
    evidenceSourceIds: list(source.evidenceSourceIds, 200, 160),
  }
}

const PROPOSAL_PATTERN = /<sct-evaluation-proposal>([\s\S]*?)<\/sct-evaluation-proposal>/i

export function extractNativeEvaluationProposal(content: string): {
  content: string
  proposal: Omit<NativeAgentEvaluationProposal, 'id'> | null
} {
  const match = PROPOSAL_PATTERN.exec(content)
  if (!match) return { content: content.trim(), proposal: null }
  let parsed: unknown
  try { parsed = JSON.parse(match[1].trim()) } catch { parsed = null }
  return {
    content: content.replace(PROPOSAL_PATTERN, '').trim(),
    proposal: normalizeNativeEvaluationProposal(parsed),
  }
}
