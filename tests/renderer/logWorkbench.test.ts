import { describe, expect, it } from "vitest";
import { createObservation, type RecipeRule } from "../../src/domain/workbench";
import {
  LOG_WORKBENCH_SCHEMA_VERSION,
  MAX_PERSISTED_DECISIONS,
  MAX_PERSISTED_OBSERVATIONS,
  MAX_PERSISTED_RULES,
  loadLogWorkbenchState,
  logWorkbenchStorageKey,
  saveLogWorkbenchState,
  type StorageLike,
} from "../../src/state/logWorkbench";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function rule(index: number): RecipeRule {
  return {
    id: `rule-${index}`,
    label: "SYSTEM_HALT",
    status: "verified",
    scope: { kind: "project", id: "qcom" },
    clauses: [
      {
        id: `clause-${index}`,
        presence: "absent",
        matcher: { kind: "literal", pattern: "@PASS", caseSensitive: true, target: "content" },
        sourceObservationId: `obs-${index}`,
      },
    ],
    priority: 0,
    confidence: 0.9,
    repetition: 3,
    createdFromSourceIds: [`source-${index}`],
  };
}

describe("log workbench renderer persistence", () => {
  it("round-trips DIAG_FAIL decisions and explicit marker ordering", () => {
    const storage = new MemoryStorage();
    const diagRule = rule(90);
    diagRule.label = "DIAG_FAIL";
    diagRule.clauses = [
      { ...diagRule.clauses[0], id: "hidag", presence: "present", matcher: { ...diagRule.clauses[0].matcher, pattern: "hidag" } },
      {
        ...diagRule.clauses[0],
        id: "diag-fail",
        presence: "present",
        matcher: { ...diagRule.clauses[0].matcher, pattern: "@FAIL" },
        order: { afterClauseId: "hidag" },
      },
    ];

    const saved = saveLogWorkbenchState(storage, "diag", {
      schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
      observations: [],
      decisions: [{
        sourceId: "sample-diag",
        result: "DIAG_FAIL",
        decidedBy: "engineer",
        evidenceObservationIds: [],
      }],
      recipes: [{ metadata: { id: "diag", name: "Diag fail", revision: 1 }, rules: [diagRule] }],
    });

    expect(saved.ok).toBe(true);
    expect(saved.state.decisions[0].result).toBe("DIAG_FAIL");
    expect(saved.state.recipes[0].rules[0].label).toBe("DIAG_FAIL");
    expect(saved.state.recipes[0].rules[0].clauses[1].order).toEqual({ afterClauseId: "hidag" });
  });

  it("round-trips only allowlisted, non-sensitive state per project", () => {
    const storage = new MemoryStorage();
    const observation = {
      ...createObservation({
        sourceId: "sample-1",
        query: "@PASS",
        matched: false,
        role: "decision_evidence",
        excerpts: ["customer secret around @PASS"],
      }),
      rawLogText: "RAW-LOG-MUST-NOT-PERSIST",
      apiKey: "sk-super-secret-api-key-value",
      absolutePath: "C:\\Customer\\Secret\\sample.log",
    };
    const state = {
      schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
      observations: [observation],
      decisions: [
        {
          sourceId: "sample-1",
          result: "SYSTEM_HALT",
          decidedBy: "engineer",
          evidenceObservationIds: [observation.id],
          snippet: "decision secret",
        },
      ],
      recipes: [{ metadata: { id: "halt", name: "Halt detection", revision: 2 }, rules: [rule(1)] }],
      rawLogText: "RAW ROOT LOG",
      apiKey: "token-should-not-exist-anywhere",
    };

    expect(saveLogWorkbenchState(storage, "project-A", state).ok).toBe(true);
    const serialized = storage.getItem(logWorkbenchStorageKey("project-A"))!;
    expect(serialized).not.toContain("customer secret");
    expect(serialized).not.toContain("RAW-LOG-MUST-NOT-PERSIST");
    expect(serialized).not.toContain("C:\\\\Customer");
    expect(serialized).not.toContain("super-secret-api-key");

    const loaded = loadLogWorkbenchState(storage, "project-A");
    expect(loaded.status).toBe("loaded");
    expect(loaded.state.observations).toEqual([{ ...createObservation({
      sourceId: "sample-1",
      query: "@PASS",
      matched: false,
      role: "decision_evidence",
    }), excerpts: [] }]);
    expect(loaded.state.decisions[0]).toEqual({
      sourceId: "sample-1",
      result: "SYSTEM_HALT",
      decidedBy: "engineer",
      evidenceObservationIds: [observation.id],
    });
    expect(loaded.state.recipes[0].rules).toEqual([rule(1)]);
    expect(loadLogWorkbenchState(storage, "project-B").status).toBe("empty");
    expect(logWorkbenchStorageKey("C:\\Secret\\project")).not.toContain("Secret");
  });

  it("fails closed for corrupt and unsupported JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem(logWorkbenchStorageKey("corrupt"), "{bad json");
    expect(loadLogWorkbenchState(storage, "corrupt")).toMatchObject({
      status: "corrupt",
      state: { observations: [], decisions: [], recipes: [] },
    });

    storage.setItem(logWorkbenchStorageKey("future"), JSON.stringify({ schemaVersion: 99 }));
    expect(loadLogWorkbenchState(storage, "future")).toMatchObject({
      status: "unsupported-version",
      state: { schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION },
    });
  });

  it("retains the 10k import ceiling while capping observations and rules", () => {
    const storage = new MemoryStorage();
    const observations = Array.from({ length: MAX_PERSISTED_OBSERVATIONS + 3 }, (_, index) =>
      createObservation({ sourceId: `source-${index}`, query: `query-${index}`, matched: true }),
    );
    const rules = Array.from({ length: MAX_PERSISTED_RULES + 4 }, (_, index) => rule(index));
    const decisions = Array.from({ length: MAX_PERSISTED_DECISIONS }, (_, index) => ({
      sourceId: `source-${index}`,
      result: "PASS" as const,
      decidedBy: "engineer" as const,
      evidenceObservationIds: [],
    }));

    const saved = saveLogWorkbenchState(storage, "large", {
      schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
      observations,
      decisions,
      recipes: [{ metadata: { id: "large", name: "Large", revision: 1 }, rules }],
    });

    expect(saved.state.observations).toHaveLength(MAX_PERSISTED_OBSERVATIONS);
    expect(saved.state.observations[0].sourceId).toBe("source-3");
    expect(saved.state.decisions).toHaveLength(MAX_PERSISTED_DECISIONS);
    expect(saved.state.recipes[0].rules).toHaveLength(MAX_PERSISTED_RULES);
    expect(saved.state.recipes[0].rules[0].id).toBe("rule-4");
  });

  it("drops absolute-path and secret-bearing matchers instead of persisting them", () => {
    const storage = new MemoryStorage();
    const unsafePathRule = rule(1);
    unsafePathRule.clauses[0].matcher.pattern = "C:\\Customer\\Secret\\sample.log";
    const unsafeTokenRule = rule(2);
    unsafeTokenRule.clauses[0].matcher.pattern = "Bearer abcdefghijklmnopqrstuvwxyz";

    const saved = saveLogWorkbenchState(storage, "safe", {
      schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
      observations: [],
      decisions: [],
      recipes: [{ metadata: { id: "safe", name: "Safe", revision: 1 }, rules: [unsafePathRule, unsafeTokenRule, rule(3)] }],
    });

    expect(saved.state.recipes[0].rules.map((item) => item.id)).toEqual(["rule-3"]);
    const serialized = storage.getItem(logWorkbenchStorageKey("safe"))!;
    expect(serialized).not.toContain("Customer");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it.each([
    ["anchored Windows", "^C:\\\\Customer\\\\Secret\\\\sample\\.log$"],
    ["whole-word Windows", "\\b(?:C:\\\\Customer\\\\Secret\\\\sample\\.log)\\b"],
    ["noncapturing UNC", "^(?:\\\\\\\\server\\\\share\\\\sample\\.log)$"],
    ["anchored POSIX", "^(?:/home/customer/secret/sample\\.log)$"],
  ])("drops %s paths embedded in regex wrappers", (_name, pattern) => {
    const storage = new MemoryStorage();
    const unsafeRule = rule(1);
    unsafeRule.clauses[0].matcher.kind = "regex";
    unsafeRule.clauses[0].matcher.pattern = pattern;

    const saved = saveLogWorkbenchState(storage, "wrapped-path", {
      schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
      observations: [{
        ...createObservation({ sourceId: "source", query: pattern, matcherKind: "regex", matched: true }),
      }],
      decisions: [],
      recipes: [{ metadata: { id: "unsafe", name: "Unsafe", revision: 1 }, rules: [unsafeRule] }],
    });

    expect(saved.state.observations).toEqual([]);
    expect(saved.state.recipes[0].rules).toEqual([]);
    const serialized = storage.getItem(logWorkbenchStorageKey("wrapped-path"))!;
    expect(serialized).not.toContain("Customer");
    expect(serialized).not.toContain("server");
    expect(serialized).not.toContain("customer/secret");
  });
});
