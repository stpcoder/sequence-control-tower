import type {
  Candidate,
  Trend
} from '../shared/contracts'
import { parseFilenameMetadata, type FilenameMetadata } from '../../src/domain/workbench/filenameMetadata'
import { AGENT_LIMITS, authorizeToolAction, boundLine, boundedAgentText, protectFilenameCandidate, redactAgentText, validateCandidateShape } from './agent-policy'

export interface BoundedObservationReference {
  id: string
  sourceId: string
  lineNumber?: number
  excerpt?: string
}

export interface BoundedObservation {
  id: string
  sourceId: string
  kind: 'search' | 'lineWindow' | 'inspect'
  matched?: boolean
  lineNumber?: number
  lines?: string[]
  excerpt?: string
}

export interface AgentEvidence {
  observations: BoundedObservation[]
  aggregateExcerpt: string
  filenameMetadata: FilenameMetadata
  candidates: Candidate[]
}

function boundedExcerpt(value: string): string {
  const safe = redactAgentText(value)
  return safe.length <= AGENT_LIMITS.maxAggregateExcerptChars
    ? safe
    : `${safe.slice(0, AGENT_LIMITS.maxAggregateExcerptChars - 1)}…`
}

export function boundObservation(observation: BoundedObservation): BoundedObservation {
  const lines = (observation.lines ?? []).slice(0, AGENT_LIMITS.maxLinesPerWindow).map((line) => boundLine(redactAgentText(line)))
  return {
    id: boundedAgentText(observation.id) ?? 'observation',
    sourceId: boundedAgentText(observation.sourceId) ?? 'source',
    kind: observation.kind,
    ...(observation.matched === undefined ? {} : { matched: Boolean(observation.matched) }),
    ...(observation.lineNumber === undefined ? {} : { lineNumber: Math.max(1, Math.floor(observation.lineNumber)) }),
    ...(lines.length ? { lines } : {}),
    ...(observation.excerpt ? { excerpt: boundedExcerpt(observation.excerpt) } : {})
  }
}

export function buildAgentEvidence(input: {
  fileName: string
  observations: readonly BoundedObservation[]
  candidates?: readonly Candidate[]
}): AgentEvidence {
  const usedIds = new Set<string>()
  const observations = input.observations.slice(0, AGENT_LIMITS.maxTools).map(boundObservation).map((observation) => {
    let id = observation.id
    let suffix = 1
    while (usedIds.has(id)) { id = `${observation.id.slice(0, AGENT_LIMITS.maxIdentifierChars - 12)}-${suffix++}` }
    usedIds.add(id)
    return { ...observation, id }
  })
  const fragments = observations.flatMap((observation) => [
    observation.excerpt ?? '',
    ...(observation.lines ?? [])
  ]).filter(Boolean)
  const aggregateExcerpt = boundedExcerpt(fragments.join('\n'))
  const filenameMetadata = parseFilenameMetadata(input.fileName)
  const references = observations.map((observation) => ({ id: observation.id, sourceId: observation.sourceId }))
  const candidates = (input.candidates ?? []).filter(validateCandidateShape).map((candidate) => {
    let boundedCandidate: Candidate = {
      ...candidate,
      ...(candidate.value === undefined ? {} : { value: boundedAgentText(candidate.value) ?? '' }),
      observationIds: candidate.observationIds.map((id) => boundedAgentText(id) ?? '').filter(Boolean)
    }
    if (boundedCandidate.kind === 'action') {
      const action = authorizeToolAction(boundedCandidate.action, 0)
      if (action.ok) boundedCandidate = { ...boundedCandidate, action: action.value }
    } else if (boundedCandidate.kind === 'question' && boundedCandidate.question) {
      boundedCandidate = { ...boundedCandidate, question: { ...boundedCandidate.question, id: boundedAgentText(boundedCandidate.question.id) ?? '', prompt: boundedAgentText(boundedCandidate.question.prompt) ?? '', ...(boundedCandidate.question.choices ? { choices: boundedCandidate.question.choices.map((choice) => boundedAgentText(choice) ?? '') } : {}) } }
    }
    return boundedCandidate.kind === 'metadata' ? protectFilenameCandidate(boundedCandidate, filenameMetadata) : boundedCandidate
  }).map((candidate) => gateResultCandidate(candidate, references))
  return { observations, aggregateExcerpt, filenameMetadata, candidates }
}

export function hasBoundedObservationReference(candidate: Candidate, references: readonly BoundedObservationReference[]): boolean {
  if (!candidate.observationIds.length) return false
  const allowed = new Set(references.map((reference) => reference.id))
  return candidate.observationIds.every((id) => allowed.has(id))
}

export function gateResultCandidate(
  candidate: Candidate,
  references: readonly BoundedObservationReference[]
): Candidate {
  const resultCandidate = candidate.result === 'PASS' || candidate.result === 'DIAG_FAIL' || candidate.result === 'TEST_FAIL'
    || candidate.result === 'TRAINING_FAIL' || candidate.result === 'SYSTEM_HALT' || candidate.result === 'SYSTEM_REBOOT'
  if (!resultCandidate) return candidate
  return hasBoundedObservationReference(candidate, references) ? candidate : { ...candidate, status: 'unknown' }
}

export interface TrendSample {
  sample?: string
  temperature?: string
  mode?: string
  grid?: string
  result?: string
  stage?: string
  channel?: string
}

function counts(values: readonly (string | undefined)[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const value of values) {
    const key = value?.trim() || 'unknown'
    result[key] = (result[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

/** Computes all trend numbers locally; no model-provided counts are accepted. */
export function aggregateTrend(samples: readonly TrendSample[]): Trend {
  const dimensions = {
    sample: counts(samples.map((item) => item.sample)),
    temperature: counts(samples.map((item) => item.temperature)),
    mode: counts(samples.map((item) => item.mode)),
    grid: counts(samples.map((item) => item.grid)),
    result: counts(samples.map((item) => item.result)),
    stage: counts(samples.map((item) => item.stage)),
    channel: counts(samples.map((item) => item.channel))
  }
  const candidates = (Object.keys(dimensions) as Array<keyof Trend['dimensions']>).flatMap((dimension) =>
    Object.entries(dimensions[dimension]).map(([value, count]) => ({ dimension, value, count }))
  ).sort((left, right) => right.count - left.count || left.dimension.localeCompare(right.dimension) || left.value.localeCompare(right.value))
  const major = candidates[0]
  return {
    dimensions,
    majorConcentration: major ? { ...major, share: Number((major.count / Math.max(samples.length, 1)).toFixed(6)) } : null
  }
}
