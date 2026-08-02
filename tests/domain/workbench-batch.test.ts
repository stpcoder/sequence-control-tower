import { describe, expect, it } from "vitest";
import {
  aggregateBatchResults,
  limitQuestionsByImpact,
  type DocumentEvaluation,
  type QuestionCandidate,
} from "../../src/domain/workbench";

describe("workbench batch triage", () => {
  it("aggregates outcomes and preserves file-level exceptions", () => {
    const evaluations: DocumentEvaluation[] = [
      { sourceId: "a", result: "PASS", selectedRuleId: "pass", matchedRules: [], exceptions: [] },
      {
        sourceId: "b",
        result: "UNKNOWN",
        matchedRules: [],
        exceptions: [{ code: "NO_MATCH", message: "No match", ruleIds: [] }],
      },
      {
        sourceId: "c",
        result: "SYSTEM_HALT",
        selectedRuleId: "halt",
        matchedRules: [],
        exceptions: [],
      },
    ];

    const summary = aggregateBatchResults(evaluations);
    expect(summary).toMatchObject({ total: 3, decisiveCount: 2 });
    expect(summary.counts.PASS).toBe(1);
    expect(summary.counts.SYSTEM_HALT).toBe(1);
    expect(summary.counts.UNKNOWN).toBe(1);
    expect(summary.exceptions).toEqual([
      expect.objectContaining({ sourceId: "b", exception: expect.objectContaining({ code: "NO_MATCH" }) }),
    ]);
  });

  it("asks at most three cluster-level questions ordered by impact", () => {
    const question = (
      id: string,
      files: number,
      severity: number,
      conflict: number,
    ): QuestionCandidate => ({
      id,
      prompt: `Resolve ${id}`,
      affectedSourceIds: Array.from({ length: files }, (_, index) => `${id}-${index}`),
      severity,
      conflict,
      options: ["SYSTEM_HALT", "INCOMPLETE", "UNKNOWN"],
    });
    const candidates = [
      question("small", 1, 1, 0.2),
      question("high", 20, 5, 1),
      question("medium", 10, 3, 0.8),
      question("low", 2, 2, 0.5),
      question("second", 15, 4, 0.9),
    ];

    const selected = limitQuestionsByImpact(candidates, 99);
    expect(selected).toHaveLength(3);
    expect(selected.map((item) => item.id)).toEqual(["high", "second", "medium"]);
    expect(selected[0].impact).toBe(100);
  });
});
