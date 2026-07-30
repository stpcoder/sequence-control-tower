import type {
  AnalysisJobSnapshot,
  AnalysisResult,
  ArtifactRecord,
  WikiEntryInput,
  WikiEntryRecord,
} from '../../electron/shared/contracts'

export interface WorkspaceArtifact {
  artifact: ArtifactRecord
  job?: AnalysisJobSnapshot
  analysis?: AnalysisResult
  userComment?: string
}

export interface SavedKnowledgeDetail {
  record: WikiEntryRecord
  input: WikiEntryInput
}

export function mergeArtifacts(current: ArtifactRecord[], incoming: ArtifactRecord[]): ArtifactRecord[] {
  const merged = new Map(current.map((artifact) => [artifact.id, artifact]))
  incoming.forEach((artifact) => merged.set(artifact.id, artifact))
  return [...merged.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
}

export function artifactDisplayName(artifact: ArtifactRecord): string {
  return artifact.originalNames[0] ?? `artifact-${artifact.id.slice(0, 8)}`
}

export function artifactShortId(artifact: ArtifactRecord): string {
  return `SEQ-${artifact.id.slice(0, 6).toUpperCase()}`
}

export function analysisConfidence(analysis?: AnalysisResult, artifact?: ArtifactRecord): number {
  let score: number
  if (analysis?.inferences.length) {
    score = Math.round(
      analysis.inferences.reduce((sum, inference) => sum + inference.confidence, 0) /
        analysis.inferences.length * 100,
    )
  } else if (analysis?.facts.length) {
    score = Math.round(
      analysis.facts.reduce((sum, fact) => sum + fact.confidence, 0) / analysis.facts.length * 100,
    )
  } else {
    score = artifact?.fingerprint?.facts.length ? 76 : 38
  }
  // Perfect extraction confidence must not be confused with confidence in the
  // evaluation intent. Unanswered questions deliberately cap the UI score.
  if (analysis?.questions.length) score = Math.min(score, 78)
  if (analysis?.source === 'deterministic-fallback') score = Math.min(score, 88)
  return score
}

export function upsertWikiEntries(current: WikiEntryRecord[], record: WikiEntryRecord): WikiEntryRecord[] {
  return [record, ...current.filter((entry) => entry.id !== record.id)].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )
}
