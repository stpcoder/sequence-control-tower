import { describe, expect, it } from "vitest";
import {
  evaluateDocument,
  evaluatePrecomputedEvidence,
  type PrecomputedDocumentEvidence,
  type RecipeRule,
} from "../../src/domain/workbench";

function rule(
  id: string,
  label: RecipeRule["label"],
  status: RecipeRule["status"] = "verified",
  priority = 0,
  confidence = 0.9,
): RecipeRule {
  return {
    id,
    label,
    status,
    priority,
    confidence,
    repetition: 2,
    scope: { kind: "project", id: "qcom" },
    createdFromSourceIds: ["example"],
    clauses: [
      {
        id: `${id}-start`,
        presence: "present",
        matcher: { kind: "literal", pattern: "stressapp", caseSensitive: false, target: "content" },
        sourceObservationId: `${id}-obs-start`,
      },
      {
        id: `${id}-pass`,
        presence: "absent",
        matcher: { kind: "literal", pattern: "@PASS", caseSensitive: true, target: "content" },
        sourceObservationId: `${id}-obs-pass`,
      },
    ],
  };
}

function evidence(sourceId: string, rules: RecipeRule[], present = 1, pass = 0): PrecomputedDocumentEvidence {
  return {
    sourceId,
    rules: rules.map((item) => ({
      ruleId: item.id,
      clauses: [
        { clauseId: `${item.id}-start`, occurrenceCount: present },
        { clauseId: `${item.id}-pass`, occurrenceCount: pass },
      ],
    })),
  };
}

describe("precomputed recipe evaluation", () => {
  it("matches raw-text evaluation for present and absent clauses", () => {
    const halt = rule("halt", "SYSTEM_HALT");
    const fromText = evaluateDocument({ id: "log-1", text: "stressapp started\nsystem stopped" }, [halt]);
    const fromCounts = evaluatePrecomputedEvidence(evidence("log-1", [halt]), [halt]);

    expect(fromCounts).toEqual(fromText);
    expect(fromCounts.result).toBe("SYSTEM_HALT");
  });

  it("uses the same verified/candidate precedence and confidence threshold", () => {
    const candidate = rule("candidate", "TEST_FAIL", "candidate", 100, 0.99);
    const verified = rule("verified", "PASS", "verified", 0, 0.4);
    const result = evaluatePrecomputedEvidence(evidence("log-2", [candidate, verified]), [candidate, verified], {
      minimumConfidence: 0.5,
    });

    expect(result.result).toBe("UNKNOWN");
    expect(result.exceptions).toContainEqual(expect.objectContaining({ code: "LOW_CONFIDENCE", ruleIds: ["verified"] }));
  });

  it("preserves equal-authority conflicts as unknown", () => {
    const pass = rule("pass", "PASS");
    const halt = rule("halt", "SYSTEM_HALT");
    const result = evaluatePrecomputedEvidence(evidence("log-3", [pass, halt]), [pass, halt]);

    expect(result.result).toBe("UNKNOWN");
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({ code: "RULE_CONFLICT", ruleIds: ["halt", "pass"] }),
    );
  });

  it.each([
    ["missing rule", (valid: PrecomputedDocumentEvidence) => ({ ...valid, rules: [] }), "MISSING_EVIDENCE"],
    ["missing clause", (valid: PrecomputedDocumentEvidence) => ({ ...valid, rules: [{ ...valid.rules[0], clauses: valid.rules[0].clauses.slice(0, 1) }] }), "MISSING_EVIDENCE"],
    ["search error", (valid: PrecomputedDocumentEvidence) => ({ ...valid, rules: [{ ...valid.rules[0], error: "read failed" }] }), "EVIDENCE_ERROR"],
    ["invalid count", (valid: PrecomputedDocumentEvidence) => ({ ...valid, rules: [{ ...valid.rules[0], clauses: [{ ...valid.rules[0].clauses[0], occurrenceCount: -1 }, valid.rules[0].clauses[1]] }] }), "MISSING_EVIDENCE"],
  ])("fails closed for %s even when another rule could match", (_name, corrupt, expectedCode) => {
    const primary = rule("primary", "SYSTEM_HALT", "verified", 10);
    const fallback = rule("fallback", "PASS", "candidate", 0);
    const valid = evidence("log-4", [primary, fallback]);
    const result = evaluatePrecomputedEvidence(corrupt(valid), [primary, fallback]);

    expect(result.result).toBe("UNKNOWN");
    expect(result.selectedRuleId).toBeUndefined();
    expect(result.exceptions.map((item) => item.code)).toContain(expectedCode);
  });

  it("fails closed on duplicate evidence instead of accepting the last value", () => {
    const halt = rule("halt", "SYSTEM_HALT");
    const valid = evidence("log-5", [halt]);
    valid.rules.push({ ...valid.rules[0], clauses: valid.rules[0].clauses.map((item) => ({ ...item })) });

    const result = evaluatePrecomputedEvidence(valid, [halt]);
    expect(result.result).toBe("UNKNOWN");
    expect(result.exceptions).toContainEqual(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
  });
});
