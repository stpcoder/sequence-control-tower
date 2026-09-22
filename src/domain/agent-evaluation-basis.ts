import type { EvaluationProjectSnapshot, NativeAgentEvaluationBasis, NativeAgentEvaluationProposal, ProjectSnapshot } from '../../electron/shared/contracts'
import type { LogResultRecord } from '../state/logRecords'

export function normalizeNativeEvaluationBasis(value: unknown): NativeAgentEvaluationBasis | undefined {
  if (!value || typeof value !== 'object') return undefined
  const basis = value as NativeAgentEvaluationBasis
  if (!Number.isSafeInteger(basis.projectRevision) || basis.projectRevision < 0
    || !Number.isSafeInteger(basis.evaluationRevision) || basis.evaluationRevision < 0
    || typeof basis.recordsFingerprint !== 'string' || !/^v1:[a-f0-9]{16}$/.test(basis.recordsFingerprint)) return undefined
  return { projectRevision: basis.projectRevision, evaluationRevision: basis.evaluationRevision, recordsFingerprint: basis.recordsFingerprint }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** A change detector for local report inputs, not a security/authentication hash. */
export function evaluationRecordsFingerprint(project: ProjectSnapshot, scopeId: string, records: readonly LogResultRecord[]): string {
  const text = canonical({
    sources: project.artifacts.filter((source) => source.rootId === scopeId).sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    rows: records.filter((row) => row.evaluationScopeId === scopeId).map((row) => ({
      id: row.id, fileName: row.fileName, result: row.result, dimensions: row.dimensions,
      review: row.review, stageResults: row.stageResults, resultSource: row.resultSource,
      sample: row.sample, temperature: row.temperature, vdd: row.vdd, grid: row.grid,
      failureAddressEvents: row.failureAddressEvents, failureAddressTruncated: row.failureAddressTruncated,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  })
  let left = 2166136261, right = 3339675911
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    left = Math.imul(left ^ code, 16777619)
    right = Math.imul(right ^ code, 2246822519)
  }
  return `v1:${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

export function captureNativeEvaluationBasis(project: ProjectSnapshot, snapshot: EvaluationProjectSnapshot | null, scopeId: string | undefined, records: readonly LogResultRecord[]): NativeAgentEvaluationBasis | undefined {
  if (!snapshot || !scopeId || !records.some((row) => row.evaluationScopeId === scopeId)) return undefined
  return normalizeNativeEvaluationBasis({ projectRevision: project.revision, evaluationRevision: snapshot.revision, recordsFingerprint: evaluationRecordsFingerprint(project, scopeId, records) })
}

export function nativeEvaluationProposalState(project: ProjectSnapshot, sessionId: string, proposal: NativeAgentEvaluationProposal, current: NativeAgentEvaluationBasis | undefined): 'saved' | 'stale' | 'ready' {
  if (project.evaluationNodes?.some((node) => node.agentProposal?.sessionId === sessionId && node.agentProposal.proposalId === proposal.id)) return 'saved'
  const basis = normalizeNativeEvaluationBasis(proposal.basis)
  if (!basis || !current || basis.projectRevision !== current.projectRevision || basis.evaluationRevision !== current.evaluationRevision || basis.recordsFingerprint !== current.recordsFingerprint) return 'stale'
  return 'ready'
}
