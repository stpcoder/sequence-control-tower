import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "../../electron/main/artifact-service";
import {
  buildRecipeEvidencePlan,
  buildResultTableRow,
  evaluatePrecomputedEvidence,
  evaluateText,
  precomputedEvidenceFromInspection,
  serializeResultTableCsv,
  type MetadataFieldDefinition,
  type RecipeRule,
  type ResultLabel,
  type RuleClause,
} from "../../src/domain/workbench";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function clause(
  ruleId: string,
  name: string,
  pattern: string,
  presence: RuleClause["presence"] = "present",
  after?: string,
): RuleClause {
  return {
    id: `${ruleId}-${name}`,
    presence,
    matcher: { kind: "literal", pattern, caseSensitive: false, target: "content" },
    sourceObservationId: `${ruleId}-${name}-engineer-evidence`,
    ...(after ? { order: { afterClauseId: `${ruleId}-${after}` } } : {}),
  };
}

function rule(
  id: string,
  label: Exclude<ResultLabel, "UNKNOWN">,
  clauses: RuleClause[],
  priority = 0,
): RecipeRule {
  return {
    id,
    label,
    status: "verified",
    scope: { kind: "project", id: "qualcomm" },
    clauses,
    priority,
    confidence: 1,
    repetition: 5,
    createdFromSourceIds: ["engineer-confirmed-example"],
  };
}

const rules: RecipeRule[] = [
  rule("pass", "PASS", [
    clause("pass", "stress", "stressapp"),
    clause("pass", "hidag", "hidag", "present", "stress"),
    clause("pass", "pass", "@PASS", "present", "hidag"),
    clause("pass", "fail", "@FAIL", "absent"),
    clause("pass", "training", "TRAINING_FAIL", "absent"),
    clause("pass", "reboot", "SYSTEM REBOOT", "absent"),
  ]),
  rule("diag", "DIAG_FAIL", [
    clause("diag", "stress", "stressapp"),
    clause("diag", "hidag", "hidag", "present", "stress"),
    clause("diag", "fail", "@FAIL", "present", "hidag"),
    clause("diag", "pass", "@PASS", "absent"),
    clause("diag", "training", "TRAINING_FAIL", "absent"),
    clause("diag", "reboot", "SYSTEM REBOOT", "absent"),
  ]),
  rule("training", "TRAINING_FAIL", [
    clause("training", "stress", "stressapp"),
    clause("training", "hidag", "hidag", "present", "stress"),
    clause("training", "training", "TRAINING_FAIL", "present", "hidag"),
    clause("training", "fail", "@FAIL", "present", "training"),
    clause("training", "pass", "@PASS", "absent"),
  ], 10),
  rule("reboot", "SYSTEM_REBOOT", [
    clause("reboot", "stress", "stressapp"),
    clause("reboot", "reboot", "SYSTEM REBOOT", "present", "stress"),
    clause("reboot", "pass", "@PASS", "absent"),
  ], 10),
  rule("halt", "SYSTEM_HALT", [
    clause("halt", "stress", "stressapp"),
    clause("halt", "hidag", "hidag", "present", "stress"),
    clause("halt", "pass", "@PASS", "absent"),
    clause("halt", "fail", "@FAIL", "absent"),
    clause("halt", "training", "TRAINING_FAIL", "absent"),
    clause("halt", "reboot", "SYSTEM REBOOT", "absent"),
  ]),
];

const metadataFields: MetadataFieldDefinition[] = [
  { key: "sample", label: "Sample", target: "file_name", pattern: "^(SMP[A-Z0-9=+@-]+)_", captureGroup: 1, required: true },
  { key: "temperature_c", label: "Temperature (C)", target: "file_name", pattern: "_(-?\\d+)C_", captureGroup: 1, required: true },
  { key: "mode", label: "Mode", target: "file_name", pattern: "C_(DIAG|NORMAL)_", captureGroup: 1, required: true },
];

describe("adversarial local log pipeline", () => {
  it("keeps physical source rows, ordered provenance, explicit metadata, and ambiguous failures without LLM calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "adversarial-log-pipeline-"));
    temporaryRoots.push(root);
    const first = join(root, "customer-a", "lot-01");
    const second = join(root, "customer-b", "lot-02");
    const dataRoot = join(root, "private-data");
    await Promise.all([mkdir(first, { recursive: true }), mkdir(second, { recursive: true })]);

    const duplicatePass = "boot\nstressapp start\nhidag start\n@PASS checkpoint\n@PASS final\nnormal end\n";
    await Promise.all([
      writeFile(join(first, "SMPA_-40C_DIAG_run01.log"), duplicatePass, "utf8"),
      writeFile(join(second, "SMPZ_105C_NORMAL_run77.log"), duplicatePass, "utf8"),
      writeFile(join(first, "SMPB_105C_DIAG_run02.log"), "boot\nstressapp start\nhidag start\n@FAIL code=DG_07\n", "utf8"),
      writeFile(join(first, "SMPC_25C_DIAG_run03.log"), "boot\nstressapp start\nhidag start\nclock stopped\n", "utf8"),
      writeFile(join(second, "SMPD_85C_NORMAL_run04.log"), "boot\nstressapp start\nwatchdog\nSYSTEM REBOOT reason=wdt\n", "utf8"),
      writeFile(join(second, "SMPE_95C_DIAG_run05.log"), "boot\nstressapp start\nhidag start\nTRAINING_FAIL lane=1\n@FAIL code=TR_14\n", "utf8"),
      writeFile(join(second, "SMPF_25C_DIAG_bad-order.log"), "@PASS stale\nstressapp start\nhidag start\n", "utf8"),
      writeFile(join(second, "SMPG_25C_DIAG_binary.log"), Buffer.from([0x62, 0x6f, 0x6f, 0x74, 0x00, 0x40, 0x50, 0x41, 0x53, 0x53])),
      writeFile(join(second, "SMPH_25C_DIAG_long-line.log"), `stressapp ${"x".repeat(4 * 1024 * 1024)} hidag`, "utf8"),
      writeFile(join(second, "SMPI_25C_DIAG_missing.log"), "unique missing object\nstressapp\nhidag\n@PASS\n", "utf8"),
    ]);

    const service = new ArtifactService(dataRoot);
    await service.initialize();
    const imported = await service.importFolders([join(root, "customer-a"), join(root, "customer-b")], {
      extensions: ["log"],
      maxFiles: 100,
    });
    expect(imported.failures).toEqual([]);
    expect(imported.artifacts).toHaveLength(9);

    const records = await service.list();
    const missing = records.find((record) => record.sources?.some((source) => source.relativePath.endsWith("missing.log")));
    expect(missing).toBeDefined();
    await unlink(service.objectPath(missing!.id));

    const sources = records.flatMap((record) => (record.sources ?? []).map((source) => ({
      sourceId: `${source.rootId}:${source.relativePath}`,
      artifactId: record.id,
      rootId: source.rootId,
      relativePath: source.relativePath,
    })));
    expect(sources).toHaveLength(10);

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network must not be called");
    }) as typeof fetch;
    let inspected;
    const evidencePlan = buildRecipeEvidencePlan(rules);
    expect(evidencePlan.specs.length).toBeLessThan(rules.flatMap((item) => item.clauses).length);
    try {
      inspected = await service.inspectEvidence({ sources, specs: evidencePlan.specs });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(networkCalls).toBe(0);
    expect(JSON.stringify(inspected)).not.toContain(root);
    expect(JSON.stringify(inspected)).not.toContain(duplicatePass);

    const rows = inspected.sources.map((source) => {
      const evidence = precomputedEvidenceFromInspection(source, rules, evidencePlan);
      const evaluation = evaluatePrecomputedEvidence(evidence, rules);
      return buildResultTableRow({ source, evaluation, metadataFields });
    });
    const byName = new Map(rows.map((row) => [row.fileName, row]));

    expect(byName.get("SMPA_-40C_DIAG_run01.log")).toMatchObject({
      result: "PASS",
      needsReview: false,
      metadata: {
        sample: { value: "SMPA", state: "extracted" },
        temperature_c: { value: "-40", state: "extracted" },
        mode: { value: "DIAG", state: "extracted" },
      },
    });
    expect(byName.get("SMPZ_105C_NORMAL_run77.log")).toMatchObject({
      result: "PASS",
      metadata: { sample: { value: "SMPZ" }, temperature_c: { value: "105" }, mode: { value: "NORMAL" } },
    });
    expect(byName.get("SMPB_105C_DIAG_run02.log")?.result).toBe("DIAG_FAIL");
    expect(byName.get("SMPC_25C_DIAG_run03.log")?.result).toBe("SYSTEM_HALT");
    expect(byName.get("SMPD_85C_NORMAL_run04.log")?.result).toBe("SYSTEM_REBOOT");
    expect(byName.get("SMPE_95C_DIAG_run05.log")?.result).toBe("TRAINING_FAIL");

    for (const name of [
      "SMPF_25C_DIAG_bad-order.log",
      "SMPG_25C_DIAG_binary.log",
      "SMPH_25C_DIAG_long-line.log",
      "SMPI_25C_DIAG_missing.log",
    ]) {
      expect(byName.get(name)).toMatchObject({ result: "UNKNOWN", needsReview: true });
    }

    const passEvidence = byName.get("SMPA_-40C_DIAG_run01.log")!.evidence;
    expect(passEvidence.find((item) => item.clauseId === "pass-stress")?.firstOccurrence?.lineNumber).toBe(2);
    expect(passEvidence.find((item) => item.clauseId === "pass-hidag")?.firstOccurrence?.lineNumber).toBe(3);
    expect(passEvidence.find((item) => item.clauseId === "pass-pass")?.firstOccurrence?.lineNumber).toBe(4);
    expect(passEvidence.find((item) => item.clauseId === "pass-pass")?.lastOccurrence?.lineNumber).toBe(5);
    expect(passEvidence.every((item) => (item.firstOccurrence?.excerpt?.length ?? 0) <= 322)).toBe(true);
  }, 30_000);

  it("fails ordered rules closed when provenance is missing or marker order is reversed", () => {
    const ordered = rule("ordered", "PASS", [
      clause("ordered", "stress", "stressapp"),
      clause("ordered", "hidag", "hidag", "present", "stress"),
      clause("ordered", "pass", "@PASS", "present", "hidag"),
    ]);
    expect(evaluateText("@PASS\nstressapp\nhidag", [ordered]).result).toBe("UNKNOWN");
    expect(evaluateText("stressapp\nhidag\n@PASS", [ordered]).result).toBe("PASS");

    const missingProvenance = evaluatePrecomputedEvidence({
      sourceId: "counts-only",
      rules: [{
        ruleId: ordered.id,
        clauses: ordered.clauses.map((item) => ({ clauseId: item.id, occurrenceCount: 1 })),
      }],
    }, [ordered]);
    expect(missingProvenance.result).toBe("UNKNOWN");
    expect(missingProvenance.exceptions).toContainEqual(expect.objectContaining({ code: "MISSING_EVIDENCE" }));
  });

  it("serializes stable Excel-shaped rows while neutralizing formula injection and excluding absolute paths", () => {
    const source = {
      sourceId: "=WEBSERVICE(\"https://example.invalid\")",
      artifactId: "a".repeat(64),
      fileName: "+malicious.log",
      relativePath: "/Users/secret/customer/+malicious.log",
      evidence: [],
    };
    const row = buildResultTableRow({
      source,
      evaluation: { sourceId: source.sourceId, result: "UNKNOWN", matchedRules: [], exceptions: [] },
      metadataFields: [],
    });
    const csv = serializeResultTableCsv([row], []);
    expect(csv).toContain("\"'=WEBSERVICE(\"\"https://example.invalid\"\")\"");
    expect(csv).toContain("\"'+malicious.log\"");
    expect(csv).not.toContain("/Users/");
    expect(row).toMatchObject({ needsReview: true, exceptionCodes: ["UNSAFE_SOURCE_PATH"] });
    expect(row.relativePath).toBeUndefined();
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
