import { createHash } from 'node:crypto'
import type { EvaluationProjectSnapshot, EvaluationSourceRef, ProjectArtifactSourceRef } from '../shared/contracts'
import { evaluationRuleResolver } from '../../src/domain/evaluation-rules'
import { sourceKeyFor } from '../../src/state/sourceIdentity'

/** Resolve the same durable override/rule precedence as the workbench, including legacy source aliases. */
export function agentEvaluationContext(snapshot: EvaluationProjectSnapshot, sources: readonly ProjectArtifactSourceRef[]) {
  const resolver = evaluationRuleResolver(snapshot)
  const index = <T>(items: readonly { source: EvaluationSourceRef; value: T }[]) => {
    const byId = new Map<string, { order: number; value: T }>()
    const byHash = new Map<string, { order: number; value: T }>()
    items.forEach(({ source, value }, order) => {
      byId.set(`${source.artifactId}\0${source.sourceId}`, { order, value })
      byHash.set(`${source.artifactId}\0${source.sourceKeyHash}`, { order, value })
    })
    return (source: ProjectArtifactSourceRef, hash: string) => {
      const exact = byId.get(`${source.artifactId}\0${source.sourceId}`)
      const alias = byHash.get(`${source.artifactId}\0${hash}`)
      return exact && (!alias || exact.order >= alias.order) ? exact.value : alias?.value
    }
  }
  const decisionFor = index(snapshot.decisions.map((decision) => ({ source: decision.source, value: decision })))
  const outcomeFor = index(snapshot.batches.flatMap((batch) => {
    const current = resolver.isCurrent(batch)
    const rules = resolver.currentRules(batch)
    return batch.outcomes.map((outcome) => ({ source: outcome.source, value: { batch, outcome, current, rules } }))
  }))
  return sources.map((source) => {
    const sourceHash = createHash('sha256').update('sequence-control-tower-source-v1').update('\0')
      .update(sourceKeyFor(source.artifactRootId ?? source.rootId, source.relativePath)).digest('hex')
    const decision = decisionFor(source, sourceHash)
    const latest = outcomeFor(source, sourceHash)
    const batch = latest?.batch
    const outcome = latest?.outcome
    const stale = Boolean(batch && (!latest?.current || (outcome?.outcomeSource === 'engineer-preserved' && (!decision || decision.reset))))
    const manual = decision && !decision.reset ? decision : undefined
    return {
      sourceId: source.sourceId, fileName: source.relativePath, folderId: source.rootId,
      result: manual?.result ?? (stale ? 'UNKNOWN' : outcome?.result),
      resultSource: manual ? 'engineer' : stale ? 'stale-rule' : outcome ? outcome.outcomeSource : 'unreviewed',
      needsReevaluation: stale, exception: outcome?.exceptionCode,
      decision: decision ? { id: decision.id, result: decision.result, reset: decision.reset === true, createdAt: decision.createdAt } : undefined,
      batch: batch ? { id: batch.id, status: batch.status, completedAt: batch.completedAt, matchedRuleId: outcome?.matchedRuleId } : undefined,
      evidence: manual?.evidenceRefs ?? outcome?.evidenceRefs ?? [],
      appliedRules: latest?.rules ?? [],
    }
  })
}
