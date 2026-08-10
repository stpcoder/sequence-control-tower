import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../electron/shared/contracts";
import { evaluationMemoryToProjectSave, projectSnapshotToEvaluationMemory } from "./evaluationMemory";

const snapshot: ProjectSnapshot = {
  schemaVersion: 2, id: "project-a", name: "LPDDR6", revision: 7, archived: false, createdAt: "2026-01-01", updatedAt: "2026-01-02",
  folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [],
  lpddrDevelopmentContext: { product: "LPDDR6", skew: "SS", program: "VPERI", phase: "EVT", customer: "Acme", targetDevice: "Orion", densityGb: 16, nominalVoltage: 1.1 },
  failureHypotheses: [{ id: "h1", title: "DQ9", origin: "ai-proposed", evaluationNodeIds: ["n1"] }],
  evaluationNodes: [{ id: "n1", hypothesisId: "h1", name: "DQ9", dimensions: { dq: 9 } }],
  evidenceRecords: [
    { id: "e1", evaluationNodeId: "n1", status: "fail", sourceIds: ["log-a", "log-a", "log-b"] },
    { id: "e2", evaluationNodeId: "n1", status: "pass", sourceIds: [] } as never,
  ],
};

describe("evaluation memory project adapters", () => {
  it("injects the project ID, preserves each record, and deduplicates stored source IDs", () => {
    const memory = projectSnapshotToEvaluationMemory(snapshot);
    expect(memory.project).toMatchObject({ id: "project-a", name: "LPDDR6", program: "VPERI", customer: "Acme", targetDevice: "Orion", densityGb: 16, nominalVoltage: 1.1 });
    expect(memory.hypotheses[0].projectId).toBe("project-a");
    expect(memory.nodes[0].projectId).toBe("project-a");
    expect(memory.evidence).toHaveLength(2);
    expect(memory.evidence[0]).toMatchObject({ projectId: "project-a", sourceIds: ["log-a", "log-b"] });
  });

  it("removes inner project IDs and uses legacy logRef only when sourceIds are absent", () => {
    const memory = projectSnapshotToEvaluationMemory(snapshot);
    memory.evidence[1] = { ...memory.evidence[1], sourceIds: undefined, logRef: "legacy-log" };
    const save = evaluationMemoryToProjectSave(memory);
    expect(save).toEqual(expect.objectContaining({
      lpddrDevelopmentContext: snapshot.lpddrDevelopmentContext,
      evidenceRecords: [
        expect.objectContaining({ id: "e1", sourceIds: ["log-a", "log-b"] }),
        expect.objectContaining({ id: "e2", sourceIds: ["legacy-log"] }),
      ],
    }));
    expect(JSON.stringify(save)).not.toContain('"projectId"');
    expect(save).not.toHaveProperty("revision");
    expect(snapshot.revision).toBe(7);
  });
});
