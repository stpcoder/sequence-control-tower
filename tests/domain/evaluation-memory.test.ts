import { describe, expect, it } from "vitest";
import { flattenEvaluationMemory, inferEvaluationTrends, type EvaluationMemory } from "../../src/domain/evaluation-memory";

const memory: EvaluationMemory = {
  project: { id: "lp6-a", name: "LPDDR6 VPERI", product: "LPDDR6", skew: "SS", customer: "Customer A", targetDevice: "SoC-X", densityGb: 16, nominalVoltage: 1.1, program: "P1", phase: "ES" },
  hypotheses: [{ id: "h-vperi", projectId: "lp6-a", title: "VPERI DQ9 marginality", origin: "engineer-confirmed" }],
  nodes: [
    { id: "base", projectId: "lp6-a", name: "baseline", branchId: "main", dimensions: { skew: "SS", lot: "L24", sample: "S01", bl: 16, dq: 9, channel: 0, subChannel: 1, rank: 0, bank: 2, bankGroup: 1, row: "0x2A", column: "0x14", pattern: "PRBS31", frequencyMHz: 8533, temperatureC: 85, vdd: 1.1, timingSkewPs: 18, testMode: "VPERI" } },
    { id: "dq9", projectId: "lp6-a", hypothesisId: "h-vperi", parentId: "base", branchId: "dq9-vperi", name: "DQ9 retry", dimensions: { dq: 9, pattern: "PRBS31", frequencyMHz: 8533, testMode: "VPERI" } },
    { id: "dq20", projectId: "lp6-a", parentId: "base", branchId: "control", name: "DQ20 control", dimensions: { dq: 20, pattern: "PRBS7", frequencyMHz: 6400, testMode: "VPERI" } },
  ],
  evidence: [
    { id: "e1", projectId: "lp6-a", evaluationNodeId: "dq9", status: "fail", result: "CA fail", origin: "engineer-confirmed" },
    { id: "e2", projectId: "lp6-a", evaluationNodeId: "dq9", status: "fail", result: "CA fail" },
    { id: "e3", projectId: "lp6-a", evaluationNodeId: "dq9", status: "pass", result: "recovered", dimensions: { timingSkewPs: 5 } },
    { id: "e4", projectId: "lp6-a", evaluationNodeId: "dq20", status: "pass", result: "clean" },
  ],
};

describe("evaluation memory", () => {
  it("keeps a parent/branch lineage and makes DQ9 the deterministic failure signal", () => {
    const trends = inferEvaluationTrends(memory);
    const dq9 = trends.find((trend) => trend.dimension === "dq" && trend.value === "9");
    expect(dq9).toMatchObject({ evidenceCount: 3, failureCount: 2, passCount: 1, dominance: 1, origin: "engineer-confirmed" });
    expect(dq9!.confidence).toBeGreaterThan(0.3);
    expect(trends.some((trend) => trend.dimension === "dq" && trend.value === "20")).toBe(false);
  });

  it("flattens node defaults and evidence overrides for CSV/XLSX export", () => {
    const row = flattenEvaluationMemory(memory).find((item) => item.evidenceId === "e3")!;
    expect(row).toMatchObject({ projectName: "LPDDR6 VPERI", customer: "Customer A", targetDevice: "SoC-X", densityGb: "16", nominalVoltage: "1.1", program: "P1", phase: "ES", parentNodeId: "base", branchId: "dq9-vperi", dq: "9", bl: "16", subChannel: "1", rank: "0", row: "0x2A", column: "0x14", timingSkewPs: "5", status: "pass", hypothesisOrigin: "engineer-confirmed" });
    expect(Object.values(row).every((value) => typeof value === "string")).toBe(true);
  });

  it("joins source IDs in the flat export without replacing the legacy log reference", () => {
    const withSources: EvaluationMemory = { ...memory, evidence: [{ ...memory.evidence[0], sourceIds: ["log-a", "log-b"], logRef: "legacy-ref" }] };
    expect(flattenEvaluationMemory(withSources)[0]).toMatchObject({ sourceIds: "log-a,log-b", logRef: "legacy-ref" });
  });

  it("stops safely at unknown, foreign, and cyclic parents while retaining valid lineage dimensions", () => {
    const malformed: EvaluationMemory = {
      ...memory,
      nodes: [
        { id: "unknown-parent", projectId: "lp6-a", name: "unknown", parentId: "missing", dimensions: { dq: 1 } },
        { id: "foreign-parent", projectId: "other-project", name: "foreign", dimensions: { bl: 99 } },
        { id: "foreign-child", projectId: "lp6-a", name: "foreign child", parentId: "foreign-parent", dimensions: { dq: 2 } },
        { id: "cycle-a", projectId: "lp6-a", name: "cycle a", parentId: "cycle-b", dimensions: { bl: 16 } },
        { id: "cycle-b", projectId: "lp6-a", name: "cycle b", parentId: "cycle-a", dimensions: { dq: 9 } },
      ],
      evidence: [
        { id: "unknown", projectId: "lp6-a", evaluationNodeId: "unknown-parent", status: "pass" },
        { id: "foreign", projectId: "lp6-a", evaluationNodeId: "foreign-child", status: "pass" },
        { id: "cycle", projectId: "lp6-a", evaluationNodeId: "cycle-b", status: "pass" },
      ],
    };
    const rows = flattenEvaluationMemory(malformed);
    expect(rows.find((row) => row.evidenceId === "unknown")).toMatchObject({ dq: "1", bl: "" });
    expect(rows.find((row) => row.evidenceId === "foreign")).toMatchObject({ dq: "2", bl: "" });
    expect(rows.find((row) => row.evidenceId === "cycle")).toMatchObject({ dq: "9", bl: "16" });
  });
});
