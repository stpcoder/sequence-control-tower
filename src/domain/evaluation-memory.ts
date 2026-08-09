/**
 * Local, serialisable memory for an LPDDR6 evaluation.  This module is
 * intentionally independent of parsers, storage, and UI code.
 */
export type EvaluationStatus = "pass" | "fail" | "inconclusive" | "running";
export type AssessmentOrigin = "engineer-confirmed" | "ai-proposed";

export interface EvaluationDimensions {
  sku?: string;
  lot?: string;
  material?: string;
  die?: string;
  sample?: string;
  socVendor?: "qualcomm" | "mediatek" | "unknown";
  socModel?: string;
  bootProfileId?: string;
  bl?: string | number;
  dq?: string | number;
  channel?: string | number;
  bank?: string | number;
  bankGroup?: string | number;
  pattern?: string | number;
  frequencyMHz?: number;
  temperatureC?: number;
  vdd?: number;
  skewPs?: number;
  testMode?: string;
}

export interface ProductProject {
  id: string;
  name: string;
  product?: string;
  sku?: string;
  customer?: string;
  targetDevice?: string;
  densityGb?: number;
  nominalVoltage?: number;
  program?: string;
  phase?: string;
}

export interface FailureHypothesis {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  origin: AssessmentOrigin;
  /** A hypothesis may be linked to one or more branches of an experiment. */
  evaluationNodeIds?: string[];
}

export interface EvaluationNode {
  id: string;
  projectId: string;
  hypothesisId?: string;
  parentId?: string;
  branchId?: string;
  name: string;
  dimensions: EvaluationDimensions;
  status?: EvaluationStatus;
  sequenceSignature?: string;
  attemptNo?: number;
  /** The previous failed evaluation node repeated with the same sample and sequence. */
  retestOf?: string;
}

export interface EvidenceRecord {
  id: string;
  projectId: string;
  evaluationNodeId: string;
  occurredAt?: string;
  status: EvaluationStatus;
  result?: string;
  dimensions?: Partial<EvaluationDimensions>;
  /** Connected artifact source IDs; logRef remains available for legacy records. */
  sourceIds?: string[];
  logRef?: string;
  note?: string;
  origin?: AssessmentOrigin;
}

export interface EvaluationMemory {
  project: ProductProject;
  hypotheses: FailureHypothesis[];
  nodes: EvaluationNode[];
  evidence: EvidenceRecord[];
}

export const DOMINANCE_DIMENSIONS = [
  "sku", "lot", "material", "die", "sample", "socModel", "dq", "bl", "pattern", "channel", "bank", "bankGroup", "frequencyMHz", "temperatureC", "vdd", "skewPs", "testMode",
] as const;
export type DominanceDimension = (typeof DOMINANCE_DIMENSIONS)[number];

export interface DominanceFinding {
  dimension: DominanceDimension;
  value: string;
  evidenceCount: number;
  failureCount: number;
  passCount: number;
  failureRate: number;
  dominance: number;
  confidence: number;
  origin: AssessmentOrigin;
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function effectiveDimensions(
  node: EvaluationNode,
  record: EvidenceRecord,
  nodeById: ReadonlyMap<string, EvaluationNode>,
  projectId: string,
): EvaluationDimensions {
  // Walk upward iteratively: malformed imported data must not recurse forever.
  // A missing or foreign-project parent is not part of this project's lineage.
  const lineage: EvaluationNode[] = [];
  const seen = new Set<string>();
  let current: EvaluationNode | undefined = node;
  while (current && current.projectId === projectId && !seen.has(current.id)) {
    lineage.push(current);
    seen.add(current.id);
    current = current.parentId ? nodeById.get(current.parentId) : undefined;
  }
  return Object.assign({}, ...lineage.reverse().map((item) => item.dimensions), record.dimensions);
}

/**
 * Infers repeatable failure concentrations.  Dominance is the fraction of all
 * failed records represented by a value; confidence combines that concentration
 * with its observed failure rate, so a single failure is never overconfident.
 */
export function inferEvaluationTrends(memory: EvaluationMemory): DominanceFinding[] {
  const nodeById = new Map(memory.nodes.map((node) => [node.id, node]));
  const hypothesisById = new Map(memory.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const failures = memory.evidence.filter((record) => record.status === "fail");
  const findings: DominanceFinding[] = [];

  for (const dimension of DOMINANCE_DIMENSIONS) {
    const buckets = new Map<string, { evidence: EvidenceRecord[]; failures: number; passes: number; confirmed: boolean }>();
    for (const record of memory.evidence) {
      const node = nodeById.get(record.evaluationNodeId);
      if (!node || node.projectId !== memory.project.id) continue;
      const value = displayValue(effectiveDimensions(node, record, nodeById, memory.project.id)[dimension]);
      if (!value) continue;
      const bucket = buckets.get(value) ?? { evidence: [], failures: 0, passes: 0, confirmed: false };
      bucket.evidence.push(record);
      if (record.status === "fail") {
        bucket.failures += 1;
        const hypothesis = node.hypothesisId ? hypothesisById.get(node.hypothesisId) : undefined;
        bucket.confirmed ||= record.origin === "engineer-confirmed" || hypothesis?.origin === "engineer-confirmed";
      }
      if (record.status === "pass") bucket.passes += 1;
      buckets.set(value, bucket);
    }
    for (const [value, bucket] of buckets) {
      if (!bucket.failures) continue;
      const evidenceCount = bucket.evidence.length;
      const failureRate = bucket.failures / evidenceCount;
      const dominance = failures.length ? bucket.failures / failures.length : 0;
      findings.push({
        dimension,
        value,
        evidenceCount,
        failureCount: bucket.failures,
        passCount: bucket.passes,
        failureRate,
        dominance,
        confidence: Number((dominance * failureRate * (evidenceCount / (evidenceCount + 2))).toFixed(4)),
        origin: bucket.confirmed ? "engineer-confirmed" : "ai-proposed",
      });
    }
  }
  return findings.sort((a, b) => b.confidence - a.confidence || b.failureCount - a.failureCount || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value));
}

export interface EvaluationExportRow {
  projectId: string; projectName: string; product: string; projectSku: string; customer: string; targetDevice: string; densityGb: string; nominalVoltage: string; program: string; phase: string;
  hypothesisId: string; hypothesisTitle: string; hypothesisOrigin: string;
  nodeId: string; parentNodeId: string; branchId: string; nodeName: string; nodeStatus: string; sequenceSignature: string; attemptNo: string; retestOf: string;
  evidenceId: string; occurredAt: string; status: string; result: string; sourceIds: string; logRef: string; note: string; evidenceOrigin: string;
  sku: string; lot: string; material: string; die: string; sample: string; socVendor: string; socModel: string; bootProfileId: string; bl: string; dq: string; channel: string; bank: string; bankGroup: string;
  pattern: string; frequencyMHz: string; temperatureC: string; vdd: string; skewPs: string; testMode: string;
}

/** One row per evidence record, ready for CSV/XLSX writers without nested values. */
export function flattenEvaluationMemory(memory: EvaluationMemory): EvaluationExportRow[] {
  const nodes = new Map(memory.nodes.map((node) => [node.id, node]));
  const hypotheses = new Map(memory.hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const text = (value: unknown) => displayValue(value) ?? "";
  return memory.evidence.map((record) => {
    const node = nodes.get(record.evaluationNodeId);
    if (!node) throw new Error(`Evidence ${record.id} references unknown evaluation node ${record.evaluationNodeId}`);
    const hypothesis = node.hypothesisId ? hypotheses.get(node.hypothesisId) : undefined;
    const d = effectiveDimensions(node, record, nodes, memory.project.id);
    return {
      projectId: memory.project.id, projectName: memory.project.name, product: text(memory.project.product), projectSku: text(memory.project.sku), customer: text(memory.project.customer), targetDevice: text(memory.project.targetDevice), densityGb: text(memory.project.densityGb), nominalVoltage: text(memory.project.nominalVoltage), program: text(memory.project.program), phase: text(memory.project.phase),
      hypothesisId: text(hypothesis?.id), hypothesisTitle: text(hypothesis?.title), hypothesisOrigin: text(hypothesis?.origin),
      nodeId: node.id, parentNodeId: text(node.parentId), branchId: text(node.branchId), nodeName: node.name, nodeStatus: text(node.status), sequenceSignature: text(node.sequenceSignature), attemptNo: text(node.attemptNo), retestOf: text(node.retestOf),
      evidenceId: record.id, occurredAt: text(record.occurredAt), status: record.status, result: text(record.result), sourceIds: (record.sourceIds ?? []).join(","), logRef: text(record.logRef), note: text(record.note), evidenceOrigin: text(record.origin),
      sku: text(d.sku), lot: text(d.lot), material: text(d.material), die: text(d.die), sample: text(d.sample), socVendor: text(d.socVendor), socModel: text(d.socModel), bootProfileId: text(d.bootProfileId), bl: text(d.bl), dq: text(d.dq), channel: text(d.channel), bank: text(d.bank), bankGroup: text(d.bankGroup), pattern: text(d.pattern), frequencyMHz: text(d.frequencyMHz), temperatureC: text(d.temperatureC), vdd: text(d.vdd), skewPs: text(d.skewPs), testMode: text(d.testMode),
    };
  });
}
