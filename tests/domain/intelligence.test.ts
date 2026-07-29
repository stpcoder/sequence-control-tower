import { describe, expect, it } from "vitest";
import {
  analyzeSequence,
  buildDemoSequenceProject,
  recommendParentCandidates,
  semanticDiff,
  sequenceSimilarity,
} from "../../src/domain";

describe("sequence intelligence", () => {
  it("recognizes close revisions and explains semantic changes", () => {
    const demo = buildDemoSequenceProject();
    const similarity = sequenceSimilarity(demo.previous, demo.current);
    expect(similarity.overall).toBeGreaterThan(0.45);

    const diff = semanticDiff(demo.previous, demo.current);
    const temperature = diff.dnaChanges.find((change) => change.field === "temperaturesC");
    const voltage = diff.dnaChanges.find((change) => change.field === "voltages");
    expect(temperature?.kind).toBe("unchanged");
    expect(voltage?.kind).toBe("changed");
    expect(diff.summary).toContain("전압");
    expect(diff.statistics.blocksAdded + diff.statistics.blocksChanged).toBeGreaterThan(0);
  });

  it("ranks parent candidates without silently verifying them", () => {
    const demo = buildDemoSequenceProject();
    expect(demo.parentCandidates[0].sourceId).toBe("seq-high-temp-v2");
    expect(demo.parentCandidates[0].requiresConfirmation).toBe(true);
    expect(demo.parentCandidates[0].provenance[0].kind).toBe("heuristic");
  });

  it("does not consider exact duplicates to be parents", () => {
    const source = {
      id: "same-a",
      filename: "same-a.seq",
      content: "# Baseline\nrun test;",
    };
    const target = analyzeSequence({ ...source, id: "same-b", filename: "same-b.seq" });
    const candidate = analyzeSequence(source);
    expect(recommendParentCandidates(target, [candidate])).toEqual([]);
  });
});
