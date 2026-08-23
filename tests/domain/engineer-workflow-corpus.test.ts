import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { extractLpddrFilenameDimensions, extractLpddrFilenameOutcome, parsePositionalLabFilename } from "../../src/domain/lpddr-filename-dimensions";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(".");
const corpusRoot = resolve("tests/fixtures/engineer-workflow");
const generator = resolve("tests/fixtures/generators/generate-engineer-workflow-corpus.mjs");
const temporaryRoots: string[] = [];

const expectedAxes = {
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
] as const;

type ResultLabel = (typeof resultLabels)[number];
type PairTransition = "RECOVERY" | "REGRESSION" | "STABLE_PASS" | "STABLE_FAILURE";

type Fixture = {
  relativePath: string;
  sample: string;
  temperature: string;
  mode: string;
  run: number;
  outcome: ResultLabel;
  expectedResult: ResultLabel;
  pairTransition: PairTransition;
  comparisonKey: string;
};

type Manifest = {
  generatorId: string;
  schemaVersion: number;
  title: string;
  privacy: string;
  axes: {
    samples: string[];
    temperatures: string[];
    modes: string[];
    runs: number[];
  };
  fixtureCount: number;
  outcomeCounts: Record<string, number>;
  pairTransitionCounts: Record<string, number>;
  fixtures: Fixture[];
};

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(path));
    else files.push(path);
  }
  return files;
}

async function readManifest(root = corpusRoot): Promise<Manifest> {
  return JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
}

async function corpusSnapshot(root: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  for (const file of await allFiles(root)) {
    snapshot.set(relative(root, file).replaceAll("\\", "/"), await readFile(file));
  }
  return snapshot;
}

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function expectedComparisonKey(sample: string, temperature: string, mode: string): string {
  return `${sample}|${temperature}|${mode}`;
}

function expectedTransition(run1: ResultLabel, run2: ResultLabel): PairTransition {
  if (run1 === "PASS" && run2 === "PASS") return "STABLE_PASS";
  if (run1 !== "PASS" && run2 === "PASS") return "RECOVERY";
  if (run1 === "PASS" && run2 !== "PASS") return "REGRESSION";
  return "STABLE_FAILURE";
}

function parseFilename(filename: string): Pick<Fixture, "sample" | "temperature" | "mode" | "run"> {
  const match = /^26-08-\d{2}-\d{2}-\d{2}-\d{2}_UTF02A-2_Ch\d+_SM8975_\d+_(-?\d+)_\d+(?:\.\d+)?_EVA_EN_SKEW-(?:SS|SF|FS|FF)_TM-(DIAG|STRESS)_RUN(1|2)_9600MHZ_COM\d+_(DHCST-(?:89|90|91|92))_C_[A-Za-z]+\.log$/.exec(filename);
  if (!match) throw new Error(`Unexpected engineer-workflow filename: ${filename}`);
  return {
    sample: match[4],
    temperature: `${match[1]}C`,
    mode: match[2],
    run: Number(match[3]),
  };
}

function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

function linePosition(lines: string[], marker: string): number {
  return lines.indexOf(marker);
}

function expectOrderedLines(lines: string[], markers: string[], label: string): void {
  let cursor = -1;
  for (const marker of markers) {
    const position = linePosition(lines, marker);
    expect(position, `${label}: ${marker}`).toBeGreaterThan(cursor);
    cursor = position;
  }
}

function expectSnapshotEqual(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [path, expectedBytes] of expected) {
    const actualBytes = actual.get(path);
    expect(actualBytes, path).toBeDefined();
    expect(Buffer.compare(actualBytes!, expectedBytes), path).toBe(0);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic Luna engineer workflow corpus", () => {
  it("contains exactly 48 logs across the declared 4 x 3 x 2 x 2 Cartesian axes", async () => {
    const manifest = await readManifest();
    const entries = await readdir(corpusRoot, { withFileTypes: true });
    const logEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log"));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatorId).toBe("engineer-workflow-corpus-v2");
    expect(manifest.axes).toEqual(expectedAxes);
    expect(manifest.fixtureCount).toBe(48);
    expect(manifest.fixtures).toHaveLength(48);
    expect(logEntries).toHaveLength(48);
    expect(entries).toHaveLength(49);
    expect(entries.filter((entry) => entry.name === "manifest.json")).toHaveLength(1);
    expect(logEntries.some((entry) => entry.name === "manifest.json")).toBe(false);

    const expectedPaths = manifest.fixtures.map((fixture) => fixture.relativePath);
    expect(logEntries.map((entry) => entry.name).sort()).toEqual(expectedPaths.sort());
    expect(new Set(manifest.fixtures.map((fixture) => fixture.relativePath)).size).toBe(48);
  });

  it("keeps filenames, manifest rows, and content metadata in agreement", async () => {
    const manifest = await readManifest();
    const fixturePaths = new Set(manifest.fixtures.map((fixture) => fixture.relativePath));
    const diskPaths = new Set((await allFiles(corpusRoot))
      .filter((file) => file.endsWith(".log"))
      .map((file) => relative(corpusRoot, file).replaceAll("\\", "/")));

    expect(diskPaths).toEqual(fixturePaths);
    for (const fixture of manifest.fixtures) {
      const filenameMetadata = parseFilename(fixture.relativePath);
      expect({
        sample: fixture.sample,
        temperature: fixture.temperature,
        mode: fixture.mode,
        run: fixture.run,
      }, fixture.relativePath).toEqual(filenameMetadata);
      expect(fixture.comparisonKey).toBe(expectedComparisonKey(fixture.sample, fixture.temperature, fixture.mode));
      expect(parsePositionalLabFilename(fixture.relativePath), fixture.relativePath).toMatchObject({
        material: fixture.sample,
        temperatureC: Number(fixture.temperature.replace(/C$/, "")),
        outcome: fixture.expectedResult,
      });
      expect(extractLpddrFilenameOutcome(fixture.relativePath), fixture.relativePath).toBe(fixture.expectedResult);
      expect(extractLpddrFilenameDimensions(fixture.relativePath), fixture.relativePath).toMatchObject({
        sample: fixture.sample,
        material: fixture.sample,
        testMode: fixture.mode,
      });

      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      const lines = linesOf(content);
      expect(lines).toContain(`SAMPLE=${fixture.sample};`);
      expect(lines).toContain(`TEMP=${fixture.temperature};`);
      expect(lines).toContain(`MODE=${fixture.mode};`);
      expect(lines).toContain(`RUN=${fixture.run};`);
      expect(lines).toContain(`COMPARISON_KEY=${fixture.comparisonKey};`);
      expect(lines).toContain(`EXPECTED_RESULT=${fixture.expectedResult};`);
      expect(lines).toContain(`PAIR_TRANSITION=${fixture.pairTransition};`);
    }
  });

  it("covers every required result label with the manifest oracle and exact content counts", async () => {
    const manifest = await readManifest();
    const contents = await Promise.all(manifest.fixtures.map((fixture) => readFile(join(corpusRoot, fixture.relativePath), "utf8")));
    const expectedResults = manifest.fixtures.map((fixture) => fixture.expectedResult);

    expect(new Set(expectedResults)).toEqual(new Set(resultLabels));
    expect(counts(expectedResults)).toEqual({
      PASS: 23,
      DIAG_FAIL: 3,
      TEST_FAIL: 3,
      TRAINING_FAIL: 3,
      SYSTEM_HALT: 5,
      SYSTEM_REBOOT: 4,
      INCOMPLETE: 4,
      UNKNOWN: 3,
    });
    expect(manifest.outcomeCounts).toEqual(counts(expectedResults));
    expect(contents.map((content) => content.match(/^EXPECTED_RESULT=(.+);$/m)![1])).toEqual(expectedResults);
    expect(contents.join("\n")).toContain("@PASS;");
    expect(contents.join("\n")).toContain("DIAG_FAIL code=SYN-DIAG-07;");
    expect(contents.join("\n")).toContain("TEST_FAIL bank=SYN-BANK-01;");
    expect(contents.join("\n")).toContain("TRAINING_FAIL lane=SYN-LANE-01;");
    expect(contents.join("\n")).toContain("SYSTEM_REBOOT;");
  });

  it("preserves reachable POWER_ON, UEFI, ExitBootServices, and OS stage order", async () => {
    const manifest = await readManifest();
    for (const fixture of manifest.fixtures) {
      const lines = linesOf(await readFile(join(corpusRoot, fixture.relativePath), "utf8"));
      const powerOn = "POWER_ON state=asserted;";
      const uefi = "UEFI entry firmware=SYN-UEFI-01;";
      const exitBootServices = "ExitBootServices status=success;";
      const osBoot = "OS boot start loader=SYN-OS-01;";

      expectOrderedLines(lines, [powerOn, uefi], fixture.relativePath);
      if (lines.includes(exitBootServices)) {
        expectOrderedLines(lines, [powerOn, uefi, exitBootServices, osBoot], fixture.relativePath);
      } else if (fixture.expectedResult === "UNKNOWN") {
        expect(lines).toContain("FAILURE_POINT=UNCLASSIFIED_CAPTURE_END;");
        expect(lines).not.toContain(osBoot);
        expect(lines).not.toContain("stressapp start profile=synthetic-memory;");
        expect(lines).not.toContain("HIDAG START mode=DIAG;");
        expect(lines).not.toContain("HIDAG START mode=STRESS;");
      } else {
        expect(fixture.expectedResult).toBe("SYSTEM_HALT");
        expect(lines).toContain("FAILURE_POINT=UEFI_HANDOFF;");
        expect(lines).not.toContain(osBoot);
        expect(lines).not.toContain("stressapp start profile=synthetic-memory;");
        expect(lines).not.toContain("HIDAG START mode=DIAG;");
        expect(lines).not.toContain("HIDAG START mode=STRESS;");
      }

      if (fixture.expectedResult === "UNKNOWN") {
        expect(lines).not.toContain(exitBootServices);
        expect(lines).not.toContain(osBoot);
      }
    }
  });

  it("records requested and observed mode, target and measured temperature, VDD, stressapp, and HIDAG evidence", async () => {
    const manifest = await readManifest();
    const vddByTemperature: Record<string, string> = { "-40C": "0.75V", "25C": "0.80V", "85C": "0.90V" };
    let stressappEvidence = 0;
    let hidagEvidence = 0;

    for (const fixture of manifest.fixtures) {
      const lines = linesOf(await readFile(join(corpusRoot, fixture.relativePath), "utf8"));
      expect(lines).toContain(`TARGET_TEMPERATURE=${fixture.temperature};`);
      expect(lines).toContain(`VDD=${vddByTemperature[fixture.temperature]};`);
      expect(lines).toContain(`REQUESTED_TEST_MODE=${fixture.mode};`);
      expect(lines).toContain(`OBSERVED_TEST_MODE=${fixture.mode};`);
      expect(lines.some((line) => /^MEASURED_TEMPERATURE=-?\d+\.\dC;$/.test(line))).toBe(true);

      if (lines.includes("stressapp start profile=synthetic-memory;")) {
        stressappEvidence += 1;
        expect(lines).toContain("stressapp heartbeat=stable;");
        expect(lines.indexOf("stressapp start profile=synthetic-memory;")).toBeLessThan(lines.indexOf("stressapp heartbeat=stable;"));
        if (fixture.expectedResult === "TEST_FAIL") {
          expect(lines).toContain("TEST_FAIL bank=SYN-BANK-01;");
          expect(lines).not.toContain("stressapp completed result=PASS;");
          expect(lines).not.toContain(`HIDAG START mode=${fixture.mode};`);
        } else {
          expect(lines).toContain("stressapp completed result=PASS;");
          expect(lines.indexOf("stressapp heartbeat=stable;")).toBeLessThan(lines.indexOf("stressapp completed result=PASS;"));
        }
      }
      if (lines.some((line) => line.startsWith("HIDAG START mode="))) {
        hidagEvidence += 1;
        const hidagStart = lines.findIndex((line) => line.startsWith("HIDAG START mode="));
        expect(hidagStart).toBeGreaterThan(lines.indexOf("stressapp heartbeat=stable;"));
        expect(lines[hidagStart]).toBe(`HIDAG START mode=${fixture.mode};`);
      }
    }

    expect(stressappEvidence).toBeGreaterThan(0);
    expect(hidagEvidence).toBeGreaterThan(0);
    expect(hidagEvidence).toBeGreaterThan(20);
    const allText = (await Promise.all(manifest.fixtures.map((fixture) => readFile(join(corpusRoot, fixture.relativePath), "utf8")))).join("\n");
    expect(allText).toContain("HIDAG END result=PASS;");
    expect(allText).toContain("stressapp completed result=PASS;");
  });

  it("keeps Run1/Run2 comparison keys and recovery, regression, and stable transitions coherent", async () => {
    const manifest = await readManifest();
    const byComparisonKey = new Map<string, Fixture[]>();
    for (const fixture of manifest.fixtures) {
      const pair = byComparisonKey.get(fixture.comparisonKey) ?? [];
      pair.push(fixture);
      byComparisonKey.set(fixture.comparisonKey, pair);
    }

    expect(byComparisonKey).toHaveLength(24);
    expect(manifest.pairTransitionCounts).toEqual({ RECOVERY: 16, STABLE_PASS: 12, REGRESSION: 6, STABLE_FAILURE: 14 });
    for (const [comparisonKey, pair] of byComparisonKey) {
      expect(pair.map((fixture) => fixture.run).sort()).toEqual([1, 2]);
      expect(new Set(pair.map((fixture) => fixture.pairTransition))).toHaveLength(1);
      const [run1, run2] = pair.sort((a, b) => a.run - b.run);
      expect(run1.comparisonKey).toBe(comparisonKey);
      expect(run2.comparisonKey).toBe(comparisonKey);
      expect(run1.pairTransition).toBe(expectedTransition(run1.expectedResult, run2.expectedResult));
    }
    expect(new Set(manifest.fixtures.map((fixture) => fixture.pairTransition))).toEqual(
      new Set(["RECOVERY", "REGRESSION", "STABLE_PASS", "STABLE_FAILURE"]),
    );
  });

  it("contains only privacy-safe synthetic identifiers and regenerates byte-identically", async () => {
    const manifest = await readManifest();
    expect(manifest.privacy).toBe("All identifiers, addresses, temperatures, voltages, and records are synthetic and deterministic.");
    const original = await corpusSnapshot(corpusRoot);
    const corpusText = [...original.values()].map((bytes) => bytes.toString("utf8")).join("\n");

    expect(corpusText).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(corpusText).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(corpusText).not.toMatch(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/i);
    expect(corpusText).not.toMatch(/(?:https?|ssh|file):\/\//i);
    expect(corpusText).not.toMatch(/(?:\/Users\/|[A-Z]:\\)/);
    expect(corpusText).not.toMatch(/\b(?:api[_-]?key|bearer|password|secret|customer|employee|proprietary)\b/i);
    expect(corpusText).toContain("# SYNTHETIC_METADATA");
    expect(corpusText).toContain("SYN-UEFI-01");
    expect(corpusText).toContain("SYN-OS-01");

    const temporaryRoot = await mkdtemp(join(tmpdir(), "luna-engineer-workflow-"));
    temporaryRoots.push(temporaryRoot);
    await execFileAsync(process.execPath, [generator, "--output", temporaryRoot], { cwd: repositoryRoot });
    const regenerated = await corpusSnapshot(temporaryRoot);
    expectSnapshotEqual(regenerated, original);
    expect((await readdir(temporaryRoot)).filter((name) => name.endsWith(".log"))).toHaveLength(48);
    expect((await readdir(temporaryRoot)).filter((name) => name === "manifest.json")).toHaveLength(1);
  });
});
