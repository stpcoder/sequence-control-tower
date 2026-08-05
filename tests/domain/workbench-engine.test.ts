import { describe, expect, it } from "vitest";
import {
  buildCandidateRule,
  createObservation,
  evaluateDocument,
  evaluateText,
  clauseOrderingError,
  recalculateClauseOrder,
  reorderClauses,
  recordObservation,
  selectDecisionEvidence,
  type RecipeRule,
  type RuleClause,
} from "../../src/domain/workbench";

function verified(rule: RecipeRule, id = rule.id): RecipeRule {
  return { ...rule, id, status: "verified" };
}

describe("teach-by-search recipe engine", () => {
  it("reorders clauses purely and rebuilds predecessor references", () => {
    const clauses: RuleClause[] = ["a", "b", "c"].map((id) => ({
      id, presence: "present" as const,
      matcher: { kind: "literal" as const, pattern: id, caseSensitive: true, target: "content" as const },
      sourceObservationId: `${id}-obs`,
    }));
    const reordered = reorderClauses(clauses, 2, 0);
    expect(reordered.map((clause) => clause.id)).toEqual(["c", "a", "b"]);
    expect(reordered.map((clause) => clause.order?.afterClauseId)).toEqual([undefined, "c", "a"]);
    expect(clauses.every((clause) => clause.order === undefined)).toBe(true);
    expect(recalculateClauseOrder(reordered)).toEqual(reordered);
  });

  it.each([
    ["cycle", (clauses: RecipeRule["clauses"]) => clauses.map((clause, index) => ({ ...clause, order: { afterClauseId: clauses[(index + 1) % clauses.length].id } })), "cyclic"],
    ["absence", (clauses: RecipeRule["clauses"]) => clauses.map((clause, index) => index === 1 ? { ...clause, presence: "absent" as const, order: { afterClauseId: clauses[0].id } } : clause), "absence"],
    ["non-content", (clauses: RecipeRule["clauses"]) => clauses.map((clause, index) => index === 1 ? { ...clause, matcher: { ...clause.matcher, target: "path" as const }, order: { afterClauseId: clauses[0].id } } : clause), "outside log content"],
  ])("reports %s ordering errors consistently", (_name, mutate, fragment) => {
    const base: RuleClause[] = ["a", "b"].map((id) => ({
      id, presence: "present" as const,
      matcher: { kind: "literal" as const, pattern: id, caseSensitive: true, target: "content" as const },
      sourceObservationId: `${id}-obs`,
    }));
    expect(clauseOrderingError(mutate(base), "rule-x")).toContain(fragment);
  });

  it("deduplicates searches without silently promoting search history", () => {
    let observations = recordObservation([], {
      sourceId: "sample-1",
      query: "stressapp",
      matched: true,
      matchCount: 1,
      excerpts: ["stressapp start"],
    });
    observations = recordObservation(observations, {
      sourceId: "sample-1",
      query: "stressapp",
      matched: true,
      matchCount: 2,
      excerpts: ["stressapp completed"],
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ role: "search_history", matchCount: 2 });
    expect(observations[0].excerpts).toEqual(["stressapp start", "stressapp completed"]);

    const selected = selectDecisionEvidence(observations, [observations[0].id]);
    expect(selected[0].role).toBe("decision_evidence");
    expect(selectDecisionEvidence(selected, [])[0].role).toBe("search_history");
  });

  it("requires an engineer decision and compiles only selected decision evidence", () => {
    const stressapp = createObservation({
      sourceId: "sample-1",
      query: "stressapp",
      matched: true,
      role: "decision_evidence",
    });
    const exploratoryTemperature = createObservation({
      sourceId: "sample-1",
      query: "temperature",
      matched: true,
      role: "search_history",
    });

    expect(buildCandidateRule(undefined, [stressapp])).toBeNull();
    expect(
      buildCandidateRule(
        {
          sourceId: "sample-1",
          result: "SYSTEM_HALT",
          decidedBy: "engineer",
          evidenceObservationIds: [exploratoryTemperature.id],
        },
        [stressapp, exploratoryTemperature],
      ),
    ).toBeNull();

    const candidate = buildCandidateRule(
      {
        sourceId: "sample-1",
        result: "SYSTEM_HALT",
        decidedBy: "engineer",
        evidenceObservationIds: [stressapp.id, exploratoryTemperature.id],
      },
      [stressapp, exploratoryTemperature],
    );

    expect(candidate?.clauses).toHaveLength(1);
    expect(candidate?.clauses[0].matcher.pattern).toBe("stressapp");
    expect(candidate?.status).toBe("candidate");
  });

  it("detects system halt using present and absent evidence", () => {
    const evidence = [
      createObservation({ sourceId: "halt-1", query: "stressapp", matched: true, role: "decision_evidence" }),
      createObservation({ sourceId: "halt-1", query: "hidag", matched: true, role: "decision_evidence" }),
      createObservation({ sourceId: "halt-1", query: "@PASS", matched: false, role: "decision_evidence" }),
      createObservation({ sourceId: "halt-1", query: "@FAIL", matched: false, role: "decision_evidence" }),
      createObservation({ sourceId: "halt-1", query: "normal end", matched: false, role: "decision_evidence" }),
    ];
    const candidate = buildCandidateRule(
      {
        sourceId: "halt-1",
        result: "SYSTEM_HALT",
        decidedBy: "engineer",
        evidenceObservationIds: evidence.map((item) => item.id),
      },
      evidence,
      { repetition: 4 },
    );

    expect(candidate).not.toBeNull();
    expect(candidate?.clauses.map((clause) => clause.presence)).toEqual([
      "present",
      "present",
      "absent",
      "absent",
      "absent",
    ]);

    const result = evaluateText("boot\nstressapp start\nhidag start\nsystem stopped", [candidate!]);
    expect(result.result).toBe("SYSTEM_HALT");
    expect(result.selectedRuleId).toBe(candidate?.id);

    const completed = evaluateText("stressapp start\nhidag start\n@PASS\nnormal end", [candidate!]);
    expect(completed.result).toBe("UNKNOWN");
    expect(completed.exceptions[0].code).toBe("NO_MATCH");
  });

  it("keeps equal-precedence semantic conflicts unknown", () => {
    const passRule: RecipeRule = {
      id: "pass-rule",
      label: "PASS",
      status: "verified",
      scope: { kind: "project", id: "p1" },
      clauses: [
        {
          id: "pass-clause",
          presence: "present",
          matcher: { kind: "literal", pattern: "DONE", caseSensitive: true, target: "content" },
          sourceObservationId: "obs-pass",
        },
      ],
      priority: 0,
      confidence: 0.99,
      repetition: 100,
      createdFromSourceIds: ["a"],
    };
    const failRule: RecipeRule = {
      ...passRule,
      id: "fail-rule",
      label: "TEST_FAIL",
      confidence: 0.51,
      repetition: 1,
    };

    const conflict = evaluateDocument({ id: "log-1", text: "DONE" }, [passRule, failRule]);
    expect(conflict.result).toBe("UNKNOWN");
    expect(conflict.exceptions).toContainEqual(
      expect.objectContaining({ code: "RULE_CONFLICT", ruleIds: ["fail-rule", "pass-rule"] }),
    );

    const explicitPrecedence = evaluateDocument(
      { id: "log-1", text: "DONE" },
      [passRule, { ...failRule, priority: 10 }],
    );
    expect(explicitPrecedence.result).toBe("TEST_FAIL");
    expect(explicitPrecedence.selectedRuleId).toBe("fail-rule");
  });

  it("lets a verified rule outrank a matching candidate", () => {
    const observation = createObservation({
      sourceId: "a",
      query: "@PASS",
      matched: true,
      role: "decision_evidence",
    });
    const candidate = buildCandidateRule(
      {
        sourceId: "a",
        result: "PASS",
        decidedBy: "engineer",
        evidenceObservationIds: [observation.id],
      },
      [observation],
    )!;
    const contradictoryCandidate: RecipeRule = { ...candidate, id: "candidate-fail", label: "TEST_FAIL" };

    expect(evaluateText("@PASS", [verified(candidate, "verified-pass"), contradictoryCandidate]).result).toBe(
      "PASS",
    );
  });
});
