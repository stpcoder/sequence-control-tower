import type {
  EvaluationDimensions,
  EvaluationMemory,
  EvaluationNode,
  EvaluationPurpose,
  EvaluationRelationKind,
  EvaluationStatus,
} from './evaluation-memory'

export type EvaluationIssueClassification = 'update-existing' | 'existing-issue' | 'new-issue' | 'pending'

export interface EvaluationRelationCandidate {
  evaluationScopeId?: string
  name?: string
  purpose?: EvaluationPurpose
  status?: EvaluationStatus
  dimensions: Partial<EvaluationDimensions>
  interpretation?: string
  sequenceSignature?: string
}

export interface EvaluationRelationSuggestion {
  classification: EvaluationIssueClassification
  relation?: EvaluationRelationKind
  hypothesisId?: string
  parentNodeId?: string
  existingNodeId?: string
  candidateHypothesisId?: string
  candidateNodeId?: string
  candidateTitle?: string
  suggestedIssueTitle: string
  confidence: number
  reason: string
}

const SIGNATURE_FIELDS: ReadonlyArray<[keyof EvaluationDimensions, number, 'core' | 'location']> = [
  ['testMode', 3, 'core'], ['pattern', 2, 'core'], ['socModel', 2, 'core'], ['bootProfileId', 1, 'core'],
  ['dq', 4, 'location'], ['bl', 2, 'location'], ['channel', 2, 'location'], ['subChannel', 2, 'location'],
  ['chipSelect', 1, 'location'], ['rank', 1, 'location'], ['bankGroup', 1.5, 'location'], ['bank', 1.5, 'location'],
  ['row', 1, 'location'], ['column', 1, 'location'],
]

function value(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value).trim().toLocaleLowerCase().replace(/\s+/g, '')
}

function stageFamily(candidate: Pick<EvaluationRelationCandidate, 'name' | 'purpose' | 'interpretation' | 'dimensions'>): 'boot' | 'memory' | 'unknown' {
  if (candidate.purpose === 'stage-verification') return 'boot'
  const text = [candidate.name, candidate.interpretation, candidate.dimensions.testMode, candidate.dimensions.bootProfileId].filter(Boolean).join(' ').toLocaleLowerCase()
  if (/training|boot|uefi|post[-_ ]?pbl|\blk2?\b|firmware|부팅/.test(text)) return 'boot'
  if (/hdiag|diag|memory|memtest|stress|vperi|retention|pattern|\bdq\b|\bbl\b/.test(text)) return 'memory'
  if (candidate.dimensions.dq !== undefined || candidate.dimensions.bl !== undefined || candidate.dimensions.pattern !== undefined) return 'memory'
  return 'unknown'
}

function inheritedDimensions(nodes: readonly EvaluationNode[], node: EvaluationNode): EvaluationDimensions {
  const byId = new Map(nodes.map((item) => [item.id, item]))
  const lineage: EvaluationNode[] = []
  const seen = new Set<string>()
  let current: EvaluationNode | undefined = node
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    lineage.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return Object.assign({}, ...lineage.reverse().map((item) => item.dimensions))
}

export function relationForEvaluationPurpose(purpose?: EvaluationPurpose): EvaluationRelationKind {
  if (purpose === 'reproduction') return 'retest'
  if (purpose === 'improvement') return 'improvement'
  if (purpose === 'verification' || purpose === 'stage-verification') return 'verification'
  if (purpose === 'screening' || purpose === 'characterization') return 'condition-comparison'
  return 'baseline'
}

export function evaluationRelationLabel(relation?: EvaluationRelationKind): string {
  return ({
    baseline: '기준 평가', retest: '동일 조건 RT', 'condition-comparison': '가속·조건 비교',
    improvement: '개선 조건', verification: '안정성 검증', 'side-effect': 'Side effect 확인',
  } as const)[relation ?? 'baseline']
}

/** The first persisted node is only the beginning of the recorded issue. It may
 * itself be an RT or an improvement imported without its predecessor, so never
 * present a baseline relation as proof that this was the original failure. */
export function evaluationEntryLabel(
  node: Pick<EvaluationNode, 'purpose' | 'relation' | 'parentId'> | undefined,
): string {
  if (!node) return '분류 전 평가'
  if (node.relation && node.relation !== 'baseline') return evaluationRelationLabel(node.relation)
  if (node.parentId) return evaluationRelationLabel(node.relation ?? relationForEvaluationPurpose(node.purpose))
  if (!node.purpose) return '기준 평가'
  return ({
    reproduction: '재현 평가',
    improvement: '개선 평가',
    verification: '검증 평가',
    screening: '검출 평가',
    characterization: '경향 평가',
    'stage-verification': '부팅·Training 평가',
  } as const)[node.purpose]
}

export function suggestedFailureIssueTitle(candidate: EvaluationRelationCandidate): string {
  const d = candidate.dimensions
  const stage = stageFamily(candidate)
  const parts = [d.testMode, d.pattern, d.dq !== undefined ? `DQ${d.dq}` : undefined, d.bl !== undefined ? `BL${d.bl}` : undefined].filter(Boolean).slice(0, 3)
  if (parts.length) return `${parts.join(' · ')} 불량`
  if (stage === 'boot') return '부팅·Training 불량'
  const name = candidate.name?.replace(/\s+/g, ' ').trim()
  return name ? `${name.slice(0, 60)} 불량` : '분류 대기 불량'
}

interface ScoredNode {
  node: EvaluationNode
  score: number
  knownWeight: number
  coreMatchWeight: number
  locationConflicts: string[]
  matches: string[]
  conflicts: string[]
  stageMismatch: boolean
}

function scoreNode(nodes: readonly EvaluationNode[], node: EvaluationNode, candidate: EvaluationRelationCandidate): ScoredNode {
  const dimensions = inheritedDimensions(nodes, node)
  const candidateStage = stageFamily(candidate)
  const nodeStage = stageFamily({ name: node.name, purpose: node.purpose, interpretation: node.interpretation, dimensions })
  const stageMismatch = candidateStage !== 'unknown' && nodeStage !== 'unknown' && candidateStage !== nodeStage
  let score = stageMismatch ? -20 : 0
  let knownWeight = 0
  let coreMatchWeight = 0
  const matches: string[] = []
  const conflicts: string[] = []
  const locationConflicts: string[] = []
  SIGNATURE_FIELDS.forEach(([field, weight, kind]) => {
    const left = value(candidate.dimensions[field])
    const right = value(dimensions[field])
    if (!left || !right) return
    knownWeight += weight
    if (left === right) {
      score += weight
      if (kind === 'core') coreMatchWeight += weight
      matches.push(String(field))
    } else {
      score -= weight * .8
      conflicts.push(String(field))
      if (kind === 'location') locationConflicts.push(String(field))
    }
  })
  if (candidate.sequenceSignature && node.sequenceSignature) {
    knownWeight += 4
    if (value(candidate.sequenceSignature) === value(node.sequenceSignature)) {
      score += 4; coreMatchWeight += 4; matches.push('sequence')
    } else {
      score -= 2; conflicts.push('sequence')
    }
  }
  ;(['sample', 'die'] as const).forEach((field) => {
    const left = value(candidate.dimensions[field]); const right = value(dimensions[field])
    if (left && right && left === right) { score += .75; matches.push(String(field)) }
  })
  return { node, score, knownWeight, coreMatchWeight, locationConflicts, matches, conflicts, stageMismatch }
}

/**
 * Suggests how one folder-level evaluation belongs in the project history.
 * It is deliberately deterministic and fail-closed: weak evidence goes to the
 * classification queue instead of creating a branch or copying an old rule.
 */
export function suggestEvaluationRelation(memory: EvaluationMemory, candidate: EvaluationRelationCandidate): EvaluationRelationSuggestion {
  const suggestedIssueTitle = suggestedFailureIssueTitle(candidate)
  const existingInScope = candidate.evaluationScopeId
    ? [...memory.nodes].reverse().find((node) => node.evaluationScopeId === candidate.evaluationScopeId)
    : undefined
  if (existingInScope) {
    return {
      classification: 'update-existing', relation: existingInScope.relation ?? relationForEvaluationPurpose(candidate.purpose),
      hypothesisId: existingInScope.hypothesisId, parentNodeId: existingInScope.parentId, existingNodeId: existingInScope.id,
      candidateHypothesisId: existingInScope.hypothesisId, candidateNodeId: existingInScope.id,
      candidateTitle: memory.hypotheses.find((item) => item.id === existingInScope.hypothesisId)?.title,
      suggestedIssueTitle, confidence: 1, reason: '같은 평가 폴더의 기존 기록을 업데이트합니다.',
    }
  }

  const linkedNodes = memory.nodes.filter((node) => node.hypothesisId)
  if (!linkedNodes.length) {
    const requiresPredecessor = candidate.purpose === 'reproduction' || candidate.purpose === 'improvement' || candidate.purpose === 'verification'
    return requiresPredecessor
      ? { classification: 'pending', suggestedIssueTitle, confidence: .35, reason: '이 평가는 앞선 불량과의 관계가 필요하지만 연결할 기존 평가가 없습니다.' }
      : { classification: 'new-issue', relation: 'baseline', suggestedIssueTitle, confidence: .82, reason: '새 불량 이슈의 기준 평가로 제안합니다.' }
  }

  const scored = linkedNodes.map((node) => scoreNode(memory.nodes, node, candidate)).sort((a, b) => b.score - a.score || memory.nodes.indexOf(b.node) - memory.nodes.indexOf(a.node))
  const best = scored[0]
  const hypothesis = memory.hypotheses.find((item) => item.id === best.node.hypothesisId)
  const candidateBase = {
    candidateHypothesisId: best.node.hypothesisId,
    candidateNodeId: best.node.id,
    candidateTitle: hypothesis?.title ?? best.node.name,
    suggestedIssueTitle,
  }
  const hasComparableSignature = best.knownWeight >= 3 || best.matches.includes('sequence')
  const sideEffect = (candidate.purpose === 'improvement' || candidate.purpose === 'verification')
    && best.coreMatchWeight >= 3 && best.locationConflicts.length > 0
  if (!best.stageMismatch && sideEffect) {
    return {
      ...candidateBase, classification: 'existing-issue', relation: 'side-effect', hypothesisId: best.node.hypothesisId,
      parentNodeId: best.node.id, confidence: .66,
      reason: `같은 테스트 맥락에서 ${best.locationConflicts.slice(0, 2).join('·')} 위치가 달라 Side effect 확인 평가로 연결합니다.`,
    }
  }
  if (!best.stageMismatch && hasComparableSignature && best.score >= 3) {
    const relation = relationForEvaluationPurpose(candidate.purpose)
    const confidence = Math.min(.95, Math.max(.58, best.score / Math.max(6, best.knownWeight)))
    const matched = best.matches.filter((item) => !['sample', 'die'].includes(item)).slice(0, 3)
    return {
      ...candidateBase, classification: 'existing-issue', relation, hypothesisId: best.node.hypothesisId,
      parentNodeId: best.node.id, confidence: Number(confidence.toFixed(2)),
      reason: `${matched.length ? matched.join('·') : 'Sequence'} 조건이 이어져 같은 불량 이슈의 ${evaluationRelationLabel(relation)}로 연결합니다.`,
    }
  }

  const candidateStage = stageFamily(candidate)
  const allKnownStages = linkedNodes.map((node) => stageFamily({ name: node.name, purpose: node.purpose, interpretation: node.interpretation, dimensions: inheritedDimensions(memory.nodes, node) })).filter((stage) => stage !== 'unknown')
  if (candidateStage !== 'unknown' && allKnownStages.length && allKnownStages.every((stage) => stage !== candidateStage)) {
    return { ...candidateBase, classification: 'new-issue', relation: 'baseline', confidence: .88, reason: '기존 이력과 실패 단계가 달라 별도 불량 이슈로 제안합니다.' }
  }
  if (best.conflicts.length >= 2 && best.knownWeight >= 5 && best.score < 0) {
    return { ...candidateBase, classification: 'new-issue', relation: 'baseline', confidence: .72, reason: '기존 이력과 핵심 불량 위치·패턴이 달라 별도 불량 이슈로 제안합니다.' }
  }
  return {
    ...candidateBase, classification: 'pending', confidence: Math.max(.2, Math.min(.55, (best.score + 3) / 10)),
    reason: '같은 불량인지 판단할 근거가 부족합니다. 기존 이슈 연결 또는 새 불량 여부를 확인해 주세요.',
  }
}
