import type {
  ProjectEvidenceRecord, ProjectEvaluationNode, ProjectFailureHypothesis, ProjectSaveInput, ProjectSnapshot,
} from "../../electron/shared/contracts";
import type { EvaluationMemory, EvidenceRecord, EvaluationNode, FailureHypothesis } from "../domain/evaluation-memory";

export type EvaluationMemorySave = Pick<ProjectSaveInput,
  "lpddrDevelopmentContext" | "failureHypotheses" | "evaluationNodes" | "evidenceRecords"
>;

function sourceIds(record: { sourceIds?: string[]; logRef?: string }): string[] {
  const values = record.sourceIds?.length ? record.sourceIds : record.logRef ? [record.logRef] : [];
  return [...new Set(values)];
}

/** Converts persisted project memory into the domain shape, injecting its owner ID. */
export function projectSnapshotToEvaluationMemory(project: ProjectSnapshot): EvaluationMemory {
  const context = project.lpddrDevelopmentContext ?? {};
  return {
    project: { id: project.id, name: project.name, product: context.product, skew: context.skew, program: context.program, phase: context.phase, customer: context.customer, targetDevice: context.targetDevice, densityGb: context.densityGb, nominalVoltage: context.nominalVoltage },
    hypotheses: (project.failureHypotheses ?? []).map((hypothesis): FailureHypothesis => ({ ...hypothesis, evaluationNodeIds: hypothesis.evaluationNodeIds && [...hypothesis.evaluationNodeIds], projectId: project.id })),
    nodes: (project.evaluationNodes ?? []).map((node): EvaluationNode => ({ ...node, dimensions: { ...node.dimensions }, projectId: project.id })),
    evidence: (project.evidenceRecords ?? []).map((record): EvidenceRecord => ({ ...record, dimensions: record.dimensions && { ...record.dimensions }, sourceIds: sourceIds(record), projectId: project.id })),
  };
}

/** Produces only the memory fields for an existing projects.save request. */
export function evaluationMemoryToProjectSave(memory: EvaluationMemory): EvaluationMemorySave {
  return {
    lpddrDevelopmentContext: { product: memory.project.product, skew: memory.project.skew, program: memory.project.program, phase: memory.project.phase, customer: memory.project.customer, targetDevice: memory.project.targetDevice, densityGb: memory.project.densityGb, nominalVoltage: memory.project.nominalVoltage },
    failureHypotheses: memory.hypotheses.map(({ projectId: _projectId, ...hypothesis }): ProjectFailureHypothesis => ({ ...hypothesis, evaluationNodeIds: hypothesis.evaluationNodeIds && [...hypothesis.evaluationNodeIds] })),
    evaluationNodes: memory.nodes.map(({ projectId: _projectId, ...node }): ProjectEvaluationNode => ({ ...node, dimensions: { ...node.dimensions } })),
    evidenceRecords: memory.evidence.map(({ projectId: _projectId, logRef, ...record }): ProjectEvidenceRecord => ({ ...record, dimensions: record.dimensions && { ...record.dimensions }, sourceIds: sourceIds({ sourceIds: record.sourceIds, logRef }) })),
  };
}
