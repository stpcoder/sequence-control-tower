/**
 * Local, serialisable memory for an LPDDR6 evaluation.  This module is
 * intentionally independent of parsers, storage, and UI code.
 */
export type EvaluationStatus = "pass" | "fail" | "inconclusive" | "running";
export type AssessmentOrigin = "engineer-confirmed" | "ai-proposed";
export type EvaluationPurpose = "screening" | "improvement" | "reproduction" | "characterization" | "verification" | "stage-verification";
export type EvaluationAuthorship = "automatic" | "agent" | "engineer";
export type EvaluationReviewState = "proposed" | "confirmed";
/** Why an evaluation follows another evaluation in the same failure issue. */
export type EvaluationRelationKind = "baseline" | "retest" | "condition-comparison" | "improvement" | "verification" | "side-effect";

export interface EvaluationDimensions {
  skew?: string;
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
  subChannel?: string | number;
  chipSelect?: string | number;
  rank?: string | number;
  bank?: string | number;
  bankGroup?: string | number;
  row?: string | number;
  column?: string | number;
  pattern?: string | number;
  writeData?: string | number;
  readData?: string | number;
  gridId?: string;
  frequencyMHz?: number;
  temperatureC?: number;
  temperatureCorner?: string;
  vdd?: number;
  vddCorner?: string;
  conditionCorner?: string;
  timingSkewPs?: number;
  testMode?: string;
}

export interface ProductProject {
  id: string;
  name: string;
  product?: string;
  skew?: string;
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
  /** Connected project root. One root normally represents one evaluation folder. */
  evaluationScopeId?: string;
  name: string;
  /** Why the evaluation was run, kept separate from its PASS/FAIL outcome. */
  purpose?: EvaluationPurpose;
  dimensions: EvaluationDimensions;
  status?: EvaluationStatus;
  /** Qualitative engineering description authored by Agent or an engineer. */
  interpretation?: string;
  /** Creation source and review state are kept separately for clear provenance. */
  authorship?: EvaluationAuthorship;
  reviewState?: EvaluationReviewState;
  sequenceSignature?: string;
  attemptNo?: number;
  /** The previous failed evaluation node repeated with the same sample and sequence. */
  retestOf?: string;
  /** Decision relationship to parentId. This is not plain chronological order. */
  relation?: EvaluationRelationKind;
  /** Local/Agent confidence for the proposed relationship, from 0 to 1. */
  relationConfidence?: number;
  /** Short evidence-based explanation for the relationship. */
  relationReason?: string;
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
  "skew", "lot", "material", "die", "sample", "socModel", "dq", "bl", "pattern", "channel", "subChannel", "chipSelect", "rank", "bank", "bankGroup", "row", "column", "writeData", "readData", "gridId", "frequencyMHz", "temperatureC", "temperatureCorner", "vdd", "vddCorner", "conditionCorner", "timingSkewPs", "testMode",
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
  const observationKeys = (record: EvidenceRecord, nodeId: string): string[] => {
    const sources = record.sourceIds?.length ? record.sourceIds : record.logRef ? [record.logRef] : [record.id];
    return [...new Set(sources)].map((source) => `${nodeId}\u0000${source}`);
  };
  const failedObservations = new Set<string>();
  memory.evidence.forEach((record) => {
    const node = nodeById.get(record.evaluationNodeId);
    if (!node || node.projectId !== memory.project.id || record.status !== "fail") return;
    observationKeys(record, node.id).forEach((key) => failedObservations.add(key));
  });
  const findings: DominanceFinding[] = [];

  for (const dimension of DOMINANCE_DIMENSIONS) {
    const buckets = new Map<string, Map<string, { status: EvaluationStatus; confirmed: boolean }>>();
    for (const record of memory.evidence) {
      const node = nodeById.get(record.evaluationNodeId);
      if (!node || node.projectId !== memory.project.id) continue;
      const value = displayValue(effectiveDimensions(node, record, nodeById, memory.project.id)[dimension]);
      if (!value) continue;
      const bucket = buckets.get(value) ?? new Map<string, { status: EvaluationStatus; confirmed: boolean }>();
      const hypothesis = node.hypothesisId ? hypothesisById.get(node.hypothesisId) : undefined;
      const confirmed = record.origin === "engineer-confirmed" || hypothesis?.origin === "engineer-confirmed";
      for (const key of observationKeys(record, node.id)) {
        const previous = bucket.get(key);
        const status = previous?.status === "fail" || record.status === "fail"
          ? "fail"
          : previous?.status === "pass" || record.status === "pass" ? "pass" : record.status;
        bucket.set(key, { status, confirmed: Boolean(previous?.confirmed || (record.status === "fail" && confirmed)) });
      }
      buckets.set(value, bucket);
    }
    for (const [value, bucket] of buckets) {
      const observations = [...bucket.values()].filter((item) => item.status === "fail" || item.status === "pass");
      const failures = observations.filter((item) => item.status === "fail").length;
      const passes = observations.filter((item) => item.status === "pass").length;
      if (!failures) continue;
      const evidenceCount = observations.length;
      const failureRate = failures / evidenceCount;
      const dominance = failedObservations.size ? failures / failedObservations.size : 0;
      findings.push({
        dimension,
        value,
        evidenceCount,
        failureCount: failures,
        passCount: passes,
        failureRate,
        dominance,
        confidence: Number((dominance * failureRate * (evidenceCount / (evidenceCount + 2))).toFixed(4)),
        origin: observations.some((item) => item.status === "fail" && item.confirmed) ? "engineer-confirmed" : "ai-proposed",
      });
    }
  }
  return findings.sort((a, b) => b.confidence - a.confidence || b.failureCount - a.failureCount || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value));
}

export interface EvaluationExportRow {
  projectId: string; projectName: string; product: string; projectSkew: string; customer: string; targetDevice: string; densityGb: string; nominalVoltage: string; program: string; phase: string;
  hypothesisId: string; hypothesisTitle: string; hypothesisOrigin: string;
  nodeId: string; parentNodeId: string; branchId: string; evaluationScopeId: string; nodeName: string; nodePurpose: string; nodeStatus: string; interpretation: string; authorship: string; reviewState: string; sequenceSignature: string; attemptNo: string; retestOf: string; relation: string; relationConfidence: string; relationReason: string;
  evidenceId: string; occurredAt: string; status: string; result: string; sourceIds: string; logRef: string; note: string; evidenceOrigin: string;
  skew: string; lot: string; material: string; die: string; sample: string; socVendor: string; socModel: string; bootProfileId: string; bl: string; dq: string; channel: string; subChannel: string; chipSelect: string; rank: string; bank: string; bankGroup: string; row: string; column: string;
  pattern: string; writeData: string; readData: string; gridId: string; frequencyMHz: string; temperatureC: string; temperatureCorner: string; vdd: string; vddCorner: string; conditionCorner: string; timingSkewPs: string; testMode: string;
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
      projectId: memory.project.id, projectName: memory.project.name, product: text(memory.project.product), projectSkew: text(memory.project.skew), customer: text(memory.project.customer), targetDevice: text(memory.project.targetDevice), densityGb: text(memory.project.densityGb), nominalVoltage: text(memory.project.nominalVoltage), program: text(memory.project.program), phase: text(memory.project.phase),
      hypothesisId: text(hypothesis?.id), hypothesisTitle: text(hypothesis?.title), hypothesisOrigin: text(hypothesis?.origin),
      nodeId: node.id, parentNodeId: text(node.parentId), branchId: text(node.branchId), evaluationScopeId: text(node.evaluationScopeId), nodeName: node.name, nodePurpose: text(node.purpose), nodeStatus: text(node.status), interpretation: text(node.interpretation), authorship: text(node.authorship), reviewState: text(node.reviewState), sequenceSignature: text(node.sequenceSignature), attemptNo: text(node.attemptNo), retestOf: text(node.retestOf), relation: text(node.relation), relationConfidence: text(node.relationConfidence), relationReason: text(node.relationReason),
      evidenceId: record.id, occurredAt: text(record.occurredAt), status: record.status, result: text(record.result), sourceIds: (record.sourceIds ?? []).join(","), logRef: text(record.logRef), note: text(record.note), evidenceOrigin: text(record.origin),
      skew: text(d.skew), lot: text(d.lot), material: text(d.material), die: text(d.die), sample: text(d.sample), socVendor: text(d.socVendor), socModel: text(d.socModel), bootProfileId: text(d.bootProfileId), bl: text(d.bl), dq: text(d.dq), channel: text(d.channel), subChannel: text(d.subChannel), chipSelect: text(d.chipSelect), rank: text(d.rank), bank: text(d.bank), bankGroup: text(d.bankGroup), row: text(d.row), column: text(d.column), pattern: text(d.pattern), writeData: text(d.writeData), readData: text(d.readData), gridId: text(d.gridId), frequencyMHz: text(d.frequencyMHz), temperatureC: text(d.temperatureC), temperatureCorner: text(d.temperatureCorner), vdd: text(d.vdd), vddCorner: text(d.vddCorner), conditionCorner: text(d.conditionCorner), timingSkewPs: text(d.timingSkewPs), testMode: text(d.testMode),
    };
  });
}
