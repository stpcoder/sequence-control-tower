import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "../../electron/main/artifact-service";
import { EvaluationStore } from "../../electron/main/evaluation-store";
import {
  buildCandidateRule,
  buildRecipeEvidencePlan,
  evaluatePrecomputedEvidence,
  precomputedEvidenceFromInspection,
  recordObservation,
  selectDecisionEvidence,
  type RecipeRule,
  type ResultLabel,
} from "../../src/domain/workbench";
import type {
  ArtifactEvidenceSource,
  ArtifactEvidenceSourceResult,
  ArtifactEvidenceSpec,
} from "../../electron/shared/contracts";
import type { WorkbenchFile } from "../../src/views/WorkbenchView";
import {
  DEFAULT_EXPORT_COLUMNS,
  EVIDENCE_EXPORT_COLUMNS,
  projectLogRecords,
  serializeLogRecordsCsv,
  serializeLogRecordsTsv,
  type LogResultRecord,
} from "../../src/state/logRecords";

const corpusRoot = resolve("tests/fixtures/engineer-workflow");
const temporaryRoots: string[] = [];

const axes = {
  samples: ["DHCST-89", "DHCST-90", "DHCST-91", "DHCST-92"],
  temperatures: ["-40C", "25C", "85C"],
  modes: ["DIAG", "STRESS"],
  runs: [1, 2],
} as const;

const resultLabels = [
  "PASS",
  "DIAG_FAIL",
  "TEST_FAIL",
  "TRAINING_FAIL",
  "SYSTEM_HALT",
  "SYSTEM_REBOOT",
  "INCOMPLETE",
  "UNKNOWN",
] as const satisfies readonly ResultLabel[];

type ExpectedLabel = (typeof resultLabels)[number];
type PairTransition = "RECOVERY" | "REGRESSION" | "STABLE_PASS" | "STABLE_FAILURE";

interface FixtureRow {
  relativePath: string;
  sample: string;
  temperature: string;
  mode: string;
  run: number;
  expectedResult: ExpectedLabel;
}

interface CorpusManifest {
  fixtureCount: number;
  axes: typeof axes;
  fixtures: FixtureRow[];
}

type DecisiveLabel = Exclude<ExpectedLabel, "UNKNOWN">;

interface RuleTemplateClause {
  key: string;
  query: string;
  presence: "present" | "absent";
  afterKey?: string;
}

interface RuleTemplate {
  label: DecisiveLabel;
  priority: number;
  clauses: readonly RuleTemplateClause[];
}

function line(pattern: string): string {
  return `^${pattern}$`;
}

const actualLogMarkers = {
  uefiEntry: line("UEFI entry firmware=.*;"),
  exitBootServices: line("ExitBootServices status=success;"),
  osBootStart: line("OS boot start loader=.*;"),
  stressappStart: line("stressapp start profile=.*;"),
  stressappPass: line("stressapp completed result=PASS;"),
  hidagStart: line("HIDAG START mode=(?:DIAG|STRESS);"),
  hidagEndPass: line("HIDAG END result=PASS;"),
  atPass: line("@PASS;"),
  diagOrAtFail: line("(?:DIAG_FAIL|@FAIL)\\b.*"),
  testFail: line("TEST_FAIL\\b.*"),
  trainingFail: line("TRAINING_FAIL\\b.*"),
  watchdogReset: line("WATCHDOG_RESET\\b.*"),
  systemReboot: line("SYSTEM_REBOOT;"),
  consoleHalted: line("INFO console_state=halted;"),
  captureStopped: line("INFO capture_state=stopped-before-terminal;"),
  captureAmbiguous: line("INFO capture_state=ambiguous;"),
} as const;

/**
 * These are the engineer's marker searches. They intentionally describe only
 * observed log symptoms; manifest labels are never used to create this list.
 */
const ruleTemplates: readonly RuleTemplate[] = [
  {
    label: "PASS",
    priority: 10,
    clauses: [
      { key: "stressapp-start", query: actualLogMarkers.stressappStart, presence: "present" },
      { key: "stressapp-pass", query: actualLogMarkers.stressappPass, presence: "present", afterKey: "stressapp-start" },
      { key: "hidag-start", query: actualLogMarkers.hidagStart, presence: "present", afterKey: "stressapp-pass" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "present", afterKey: "hidag-start" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "present", afterKey: "hidag-end" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "DIAG_FAIL",
    priority: 80,
    clauses: [
      { key: "hidag-start", query: actualLogMarkers.hidagStart, presence: "present" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "present", afterKey: "hidag-start" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "TEST_FAIL",
    priority: 80,
    clauses: [
      { key: "stressapp-start", query: actualLogMarkers.stressappStart, presence: "present" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "present", afterKey: "stressapp-start" },
      { key: "stressapp-pass", query: actualLogMarkers.stressappPass, presence: "absent" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "TRAINING_FAIL",
    priority: 80,
    clauses: [
      { key: "hidag-start", query: actualLogMarkers.hidagStart, presence: "present" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "present", afterKey: "hidag-start" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "SYSTEM_HALT",
    priority: 70,
    clauses: [
      { key: "uefi-entry", query: actualLogMarkers.uefiEntry, presence: "present" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "present", afterKey: "uefi-entry" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "SYSTEM_REBOOT",
    priority: 90,
    clauses: [
      { key: "hidag-start", query: actualLogMarkers.hidagStart, presence: "present" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "present", afterKey: "hidag-start" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "present", afterKey: "watchdog-reset" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
  {
    label: "INCOMPLETE",
    priority: 60,
    clauses: [
      { key: "uefi-entry", query: actualLogMarkers.uefiEntry, presence: "present" },
      { key: "exit-boot-services", query: actualLogMarkers.exitBootServices, presence: "present", afterKey: "uefi-entry" },
      { key: "os-boot-start", query: actualLogMarkers.osBootStart, presence: "present", afterKey: "exit-boot-services" },
      { key: "stressapp-start", query: actualLogMarkers.stressappStart, presence: "present", afterKey: "os-boot-start" },
      { key: "stressapp-pass", query: actualLogMarkers.stressappPass, presence: "present", afterKey: "stressapp-start" },
      { key: "hidag-start", query: actualLogMarkers.hidagStart, presence: "present", afterKey: "stressapp-pass" },
      { key: "capture-stopped", query: actualLogMarkers.captureStopped, presence: "present", afterKey: "hidag-start" },
      { key: "hidag-end", query: actualLogMarkers.hidagEndPass, presence: "absent" },
      { key: "at-pass", query: actualLogMarkers.atPass, presence: "absent" },
      { key: "diag-or-at-fail", query: actualLogMarkers.diagOrAtFail, presence: "absent" },
      { key: "test-fail", query: actualLogMarkers.testFail, presence: "absent" },
      { key: "training-fail", query: actualLogMarkers.trainingFail, presence: "absent" },
      { key: "watchdog-reset", query: actualLogMarkers.watchdogReset, presence: "absent" },
      { key: "system-reboot", query: actualLogMarkers.systemReboot, presence: "absent" },
      { key: "console-halted", query: actualLogMarkers.consoleHalted, presence: "absent" },
      { key: "capture-ambiguous", query: actualLogMarkers.captureAmbiguous, presence: "absent" },
    ],
  },
];

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function parseFilename(fileName: string): Pick<FixtureRow, "sample" | "temperature" | "mode" | "run"> {
  const match = /^26-08-\d{2}-\d{2}-\d{2}-\d{2}_UTF02A-2_Ch\d+_SM8975_\d+_(-?\d+)_\d+(?:\.\d+)?_EVA_EN_SKEW-(?:SS|SF|FS|FF)_TM-(DIAG|STRESS)_RUN(1|2)_9600MHZ_COM\d+_(DHCST-(?:89|90|91|92))_C_[A-Za-z]+\.log$/.exec(fileName);
  if (!match) throw new Error(`Unexpected engineer-workflow filename: ${fileName}`);
  return {
    sample: match[4],
    temperature: `${match[1]}C`,
    mode: match[2],
    run: Number(match[3]),
  };
}

function transitionFor(run1: ExpectedLabel, run2: ExpectedLabel): PairTransition {
  if (run1 === "PASS" && run2 === "PASS") return "STABLE_PASS";
  if (run1 !== "PASS" && run2 === "PASS") return "RECOVERY";
  if (run1 === "PASS" && run2 !== "PASS") return "REGRESSION";
  return "STABLE_FAILURE";
}

function sourceId(source: Pick<ArtifactEvidenceSource, "rootId" | "relativePath">): string {
  return `${source.rootId}:${source.relativePath}`;
}

function evidenceRefs(source: ArtifactEvidenceSource, inspected: ArtifactEvidenceSourceResult, evaluation: ReturnType<typeof evaluatePrecomputedEvidence>) {
  const selected = evaluation.matchedRules.find((rule) => rule.ruleId === evaluation.selectedRuleId);
  return selected?.clauseEvaluations.flatMap((clause) => {
    const occurrence = clause.firstOccurrence;
    return occurrence
      ? [{
          artifactId: source.artifactId,
          lineNumber: occurrence.lineNumber,
          columnStart: occurrence.columnStart,
          columnEnd: occurrence.columnEnd,
          matcherId: clause.clauseId,
        }]
      : [];
  }) ?? inspected.evidence.flatMap(() => []);
}

function exportColumnCounts(serialized: string, delimiter: "," | "\t"): number[] {
  return serialized
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .map((line) => line.split(delimiter).length);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Luna engineer workflow pipeline", () => {
  it("imports, inspects, classifies, compares, exports, and reopens the 48-file corpus locally", async () => {
    const root = await mkdtemp(join(tmpdir(), "luna-engineer-workflow-pipeline-"));
    temporaryRoots.push(root);

    const manifest = JSON.parse(await readFile(join(corpusRoot, "manifest.json"), "utf8")) as CorpusManifest;
    expect(manifest.fixtureCount).toBe(48);
    expect(manifest.axes).toEqual(axes);

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not be called by the local workflow");
    }) as typeof fetch;

    try {
      const artifacts = new ArtifactService(join(root, "artifact-data"));
      await artifacts.initialize();
      const imported = await artifacts.importFolder(corpusRoot, { extensions: ["log"], maxFiles: 48 });

      expect(imported.cancelled).toBe(false);
      expect(imported.limitReached).toBe(false);
      expect(imported.failures).toEqual([]);
      expect(imported.artifacts).toHaveLength(48);

      const sources: ArtifactEvidenceSource[] = imported.artifacts.flatMap((artifact) =>
        (artifact.sources ?? []).map((location) => ({
          sourceId: sourceId(location),
          artifactId: artifact.id,
          rootId: location.rootId,
          relativePath: location.relativePath,
        })),
      );
      expect(sources).toHaveLength(48);
      expect(new Set(sources.map((source) => source.sourceId)).size).toBe(48);
      expect(new Set(sources.map((source) => source.relativePath)).size).toBe(48);
      expect(sources.every((source) => source.relativePath === basename(source.relativePath!))).toBe(true);
      expect(JSON.stringify(sources)).not.toContain(root);

      const parsedAxes = sources.map((source) => parseFilename(source.relativePath!));
      expect([...new Set(parsedAxes.map((item) => item.sample))].sort()).toEqual([...axes.samples].sort());
      expect([...new Set(parsedAxes.map((item) => item.temperature))].sort()).toEqual([...axes.temperatures].sort());
      expect([...new Set(parsedAxes.map((item) => item.mode))].sort()).toEqual([...axes.modes].sort());
      expect([...new Set(parsedAxes.map((item) => item.run))].sort()).toEqual([...axes.runs].sort());

      const discoverySpecs: ArtifactEvidenceSpec[] = [...new Map(
        ruleTemplates.flatMap((template) => template.clauses.map((clause) => [
          clause.query,
          {
            id: `discovery-${clause.query}`,
            query: clause.query,
            mode: "regex" as const,
            caseSensitive: true,
            target: "content" as const,
          },
        ] as const)),
      ).values()].map((spec, index) => ({ ...spec, id: `discovery-${index + 1}` }));
      const discovery = await artifacts.inspectEvidence({ sources, specs: discoverySpecs });
      const discoveryBySource = new Map(discovery.sources.map((source) => [source.sourceId, source]));
      const discoverySpecByQuery = new Map(discoverySpecs.map((spec) => [spec.query, spec.id]));

      const findEvidence = (sourceId: string, query: string) => {
        const specId = discoverySpecByQuery.get(query);
        expect(specId).toBeDefined();
        const source = discoveryBySource.get(sourceId);
        expect(source).toBeDefined();
        const item = source!.evidence.find((evidence) => evidence.specId === specId);
        expect(item, `${sourceId}:${query}`).toBeDefined();
        return item!;
      };

      const rules: RecipeRule[] = ruleTemplates.map((template) => {
        const seed = discovery.sources.find((source) => template.clauses.every((clause) => {
          const occurrenceCount = findEvidence(source.sourceId, clause.query).occurrenceCount;
          return clause.presence === "present" ? (occurrenceCount ?? 0) > 0 : occurrenceCount === 0;
        }));
        expect(seed, template.label).toBeDefined();

        let history = [] as ReturnType<typeof recordObservation>;
        for (const clause of template.clauses) {
          const evidence = findEvidence(seed!.sourceId, clause.query);
          const matchCount = evidence.occurrenceCount ?? 0;
          expect(clause.presence === "present" ? matchCount > 0 : matchCount === 0).toBe(true);
          history = recordObservation(history, {
            sourceId: seed!.sourceId,
            query: clause.query,
            matcherKind: "regex",
            caseSensitive: true,
            matched: matchCount > 0,
            matchCount,
            excerpts: evidence.firstOccurrence ? [evidence.firstOccurrence.excerpt] : [],
          });
        }
        const selectedEvidence = selectDecisionEvidence(history, history.map((observation) => observation.id));
        const candidate = buildCandidateRule(
          {
            sourceId: seed!.sourceId,
            result: template.label,
            decidedBy: "engineer",
            evidenceObservationIds: selectedEvidence.map((observation) => observation.id),
          },
          selectedEvidence,
          {
            scope: { kind: "project", id: "engineer-workflow" },
            priority: template.priority,
            confidence: 1,
            repetition: 1,
          },
        );
        expect(candidate, template.label).not.toBeNull();
        const clauseIds = new Map(template.clauses.map((clause, index) => [clause.key, candidate!.clauses[index].id]));
        return {
          ...candidate!,
          status: "verified",
          clauses: candidate!.clauses.map((clause, index) => {
            const afterKey = template.clauses[index].afterKey;
            return afterKey
              ? { ...clause, order: { afterClauseId: clauseIds.get(afterKey)! } }
              : clause;
          }),
        };
      });
      const decisiveLabels = resultLabels.filter((label) => label !== "UNKNOWN");
      expect(rules).toHaveLength(7);
      expect(rules.map((rule) => rule.label).sort()).toEqual([...decisiveLabels].sort());
      expect(JSON.stringify(discoverySpecs)).not.toMatch(/EXPECTED_RESULT|PAIR_TRANSITION|FAILURE_POINT|SYNTHETIC_METADATA/);

      const evidencePlan = buildRecipeEvidencePlan(rules);
      expect(JSON.stringify(evidencePlan)).not.toMatch(/EXPECTED_RESULT|PAIR_TRANSITION|FAILURE_POINT|SYNTHETIC_METADATA/);
      const inspected = await artifacts.inspectEvidence({ sources, specs: evidencePlan.specs });

      expect(inspected.sources).toHaveLength(48);
      expect(JSON.stringify(inspected)).not.toContain(root);
      expect(JSON.stringify(inspected)).not.toMatch(/EXPECTED_RESULT|PAIR_TRANSITION|FAILURE_POINT|SYNTHETIC_METADATA/);
      for (const source of inspected.sources) {
        expect(source.error, source.relativePath).toBeUndefined();
        expect(source.evidence.flatMap((item) => [item.firstOccurrence, item.lastOccurrence])
          .filter((occurrence): occurrence is NonNullable<typeof occurrence> => Boolean(occurrence))
          .every((occurrence) => occurrence.excerpt.length <= 322)).toBe(true);
      }

      const evaluations = inspected.sources.map((source) => ({
        source,
        evaluation: evaluatePrecomputedEvidence(
          precomputedEvidenceFromInspection(source, rules, evidencePlan),
          rules,
        ),
      }));
      expect(evaluations).toHaveLength(48);
      const fixtureByPath = new Map(manifest.fixtures.map((fixture) => [fixture.relativePath, fixture]));
      for (const { source, evaluation } of evaluations) {
        const fixture = fixtureByPath.get(source.relativePath!);
        expect(fixture, source.relativePath).toBeDefined();
        expect(evaluation.result, source.relativePath).toBe(fixture!.expectedResult);
      }
      const evidenceCount = (source: ArtifactEvidenceSourceResult, query: string): number => {
        const specId = evidencePlan.specs.find((spec) => spec.query === query)?.id;
        expect(specId).toBeDefined();
        return source.evidence.find((item) => item.specId === specId)?.occurrenceCount ?? 0;
      };
      for (const { source, evaluation } of evaluations) {
        const ambiguousCapture = evidenceCount(source, actualLogMarkers.captureAmbiguous) > 0;
        const stoppedCapture = evidenceCount(source, actualLogMarkers.captureStopped) > 0;
        expect(ambiguousCapture).toBe(evaluation.result === "UNKNOWN");
        expect(stoppedCapture).toBe(evaluation.result === "INCOMPLETE");
      }
      expect(new Set(evaluations.map(({ evaluation }) => evaluation.result))).toEqual(new Set(resultLabels));
      expect(Object.keys(countBy(evaluations.map(({ evaluation }) => evaluation.result)))).toHaveLength(8);

      const comparisonRows = evaluations.map(({ source, evaluation }) => {
        return { parsed: parseFilename(source.relativePath!), evaluation };
      });
      const comparisonGroups = new Map<string, typeof comparisonRows>();
      for (const row of comparisonRows) {
        const comparisonKey = `${row.parsed.sample}|${row.parsed.temperature}|${row.parsed.mode}`;
        const group = comparisonGroups.get(comparisonKey) ?? [];
        group.push(row);
        comparisonGroups.set(comparisonKey, group);
      }
      const transitions = [...comparisonGroups.values()].map((group) => {
        expect(group).toHaveLength(2);
        const run1 = group.find((row) => row.parsed.run === 1);
        const run2 = group.find((row) => row.parsed.run === 2);
        expect(run1).toBeDefined();
        expect(run2).toBeDefined();
        return transitionFor(run1!.evaluation.result as ExpectedLabel, run2!.evaluation.result as ExpectedLabel);
      });
      expect(comparisonGroups).toHaveLength(24);
      expect(transitions).toHaveLength(24);
      expect(Object.keys(countBy(transitions))).toHaveLength(4);
      expect(new Set(transitions)).toEqual(new Set(["RECOVERY", "REGRESSION", "STABLE_PASS", "STABLE_FAILURE"]));

      const files: WorkbenchFile[] = inspected.sources.map((source) => {
        const result = evaluations.find((item) => item.source.sourceId === source.sourceId)!;
        const sourceRow = sources.find((item) => item.sourceId === source.sourceId)!;
        return {
          id: source.sourceId,
          name: source.fileName,
          origin: "engineer-workflow",
          relativePath: source.relativePath,
          artifactId: source.artifactId,
          sourceKey: `${sourceRow.rootId}/${sourceRow.relativePath}`,
          ruleResult: result.evaluation.result,
          ruleNeedsReview: result.evaluation.result === "UNKNOWN" || result.evaluation.exceptions.length > 0,
        };
      });
      const records = projectLogRecords(files);
      expect(records).toHaveLength(48);
      expect(new Set(records.map((record) => record.id)).size).toBe(48);
      expect(new Set(records.map((record) => record.fileName)).size).toBe(48);
      expect(records.map((record) => record.result).sort()).toEqual(evaluations.map(({ evaluation }) => evaluation.result).sort());
      expect(records.every((record) => record.relativePath === record.fileName)).toBe(true);

      const csv = serializeLogRecordsCsv(records);
      const tsv = serializeLogRecordsTsv(records);
      const evidenceExportColumns = [...DEFAULT_EXPORT_COLUMNS, ...EVIDENCE_EXPORT_COLUMNS];
      const evidenceCsv = serializeLogRecordsCsv(records, evidenceExportColumns);
      const evidenceTsv = serializeLogRecordsTsv(records, evidenceExportColumns);
      expect(exportColumnCounts(csv, ",")).toHaveLength(49);
      expect(exportColumnCounts(tsv, "\t")).toHaveLength(49);
      expect(exportColumnCounts(csv, ",").every((columns) => columns === DEFAULT_EXPORT_COLUMNS.length)).toBe(true);
      expect(exportColumnCounts(tsv, "\t").every((columns) => columns === DEFAULT_EXPORT_COLUMNS.length)).toBe(true);
      expect(exportColumnCounts(evidenceCsv, ",").every((columns) => columns === evidenceExportColumns.length)).toBe(true);
      expect(exportColumnCounts(evidenceTsv, "\t").every((columns) => columns === evidenceExportColumns.length)).toBe(true);
      expect(csv).not.toContain(root);
      expect(tsv).not.toContain(root);
      expect(csv).not.toContain("EXPECTED_RESULT=");
      expect(tsv).not.toContain("EXPECTED_RESULT=");
      expect(csv).not.toContain("# SYNTHETIC_METADATA");
      expect(tsv).not.toContain("# SYNTHETIC_METADATA");

      const projectId = "engineer-workflow-e2e";
      const storeRoot = join(root, "evaluation-data");
      const store = new EvaluationStore(storeRoot);
      const savedRecipe = await store.saveRecipe({
        projectId,
        expectedRevision: 0,
        name: "Engineer marker recipe",
        rules,
      });
      const outcomes = evaluations.map(({ source, evaluation }) => {
        const sourceRow = sources.find((item) => item.sourceId === source.sourceId);
        expect(sourceRow).toBeDefined();
        return {
          source: {
            sourceId: source.sourceId,
            artifactId: source.artifactId,
            sourceKey: `${sourceRow!.rootId}/${sourceRow!.relativePath}`,
          },
          result: evaluation.result,
          outcomeSource: evaluation.result === "UNKNOWN" ? "unknown" as const : "rule" as const,
          ...(evaluation.selectedRuleId ? { matchedRuleId: evaluation.selectedRuleId } : {}),
          evidenceRefs: evidenceRefs(sourceRow!, source, evaluation),
          ...(evaluation.result === "UNKNOWN" ? { exceptionCode: "NO_MATCH" as const } : {}),
        };
      });
      const savedBatch = await store.saveBatch({
        projectId,
        expectedRevision: savedRecipe.snapshot.revision,
        status: "completed",
        recipeRevisionIds: [savedRecipe.recipe.id],
        outcomes,
      });
      expect(savedBatch.batch.outcomes).toHaveLength(48);
      expect(savedBatch.batch.matchedCount).toBe(45);
      expect(savedBatch.batch.exceptionCount).toBe(3);

      const reopened = await new EvaluationStore(storeRoot).snapshot(projectId);
      expect(reopened.revision).toBe(savedBatch.snapshot.revision);
      expect(reopened.recipes).toHaveLength(1);
      expect(reopened.recipes[0].rules.map((rule) => rule.label).sort()).toEqual([...decisiveLabels].sort());
      expect(reopened.batches).toHaveLength(1);
      expect(reopened.batches[0].outcomes).toHaveLength(48);
      expect(reopened.batches[0].outcomes.map((outcome) => outcome.result).sort())
        .toEqual(outcomes.map((outcome) => outcome.result).sort());
      expect(JSON.stringify(reopened)).not.toContain(root);
      expect(JSON.stringify(reopened)).not.toContain("# SYNTHETIC_METADATA");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
  }, 30_000);
});
