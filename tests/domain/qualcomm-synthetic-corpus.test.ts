import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(".");
const corpusRoot = resolve("tests/fixtures/qualcomm-bringup");
const generator = resolve("tests/fixtures/soc-logs/generators/generate-qualcomm-bringup-corpus.mjs");
const referenceParserRoot = "/Users/taehoje/study_lp/lpddr6-packet-mapper";
const temporaryRoots: string[] = [];
const expectedFlow = [
  "SYN_POWER_ON",
  "SYN_UEFI_ENTER",
  "SYN_UEFI_EXIT",
  "SYN_OS_BOOT_START",
  "SYN_OS_READY",
];

type Fixture = {
  relativePath: string;
  variant: number;
  scenarioFamily: string;
  scenarioVariant: string;
  expectedTerminalResult: string;
  needsReview: boolean;
  metadata: {
    sample: string;
    material: string;
    tempC: string;
    mode: string;
    vdd: string;
    run: string;
  };
  orderedStageMarkers: string[];
  features: string[];
  parserOracle: ParserOracle | null;
  metadataMismatchOracle: MetadataMismatchOracle | null;
};

type MetadataMismatchOracle =
  | { kind: "expected-vs-observed"; field: "temperature" | "vdd" | "mode"; expected: string; observed: string }
  | { kind: "filename-vs-content"; field: "mode"; filename: string; content: string };

type ParserOracle = {
  expectedStressappRows: number;
  expectedTskhynixRows: number;
  expectedStressappRecords: number;
  expectedTskhynixRecords: number;
  expectedParserError: string | null;
};

type Manifest = {
  generatorId: string;
  schemaVersion: number;
  title: string;
  privacy: string;
  flowConvention: string[];
  flowConventionNotice: string;
  fixtureCount: number;
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
  const files = await allFiles(root);
  const snapshot = new Map<string, Buffer>();
  for (const file of files) {
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

function assertOrderedMarkers(content: string, markers: string[], label: string): void {
  const eventText = content
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("FLOW_CONVENTION="))
    .join("\n");
  let cursor = -1;
  for (const marker of markers) {
    const position = eventText.indexOf(marker, cursor + 1);
    expect(position, `${label}: ${marker}`).toBeGreaterThan(cursor);
    cursor = position;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic Qualcomm-style synthetic corpus", () => {
  it("contains exactly 160 privacy-safe fixtures with deliberate oracle distribution", async () => {
    const manifest = await readManifest();
    const files = (await allFiles(corpusRoot)).filter((file) => file.endsWith(".log"));
    const relativePaths = files.map((file) => relative(corpusRoot, file).replaceAll("\\", "/"));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generatorId).toBe("qualcomm-bringup-corpus-v1");
    expect(manifest.fixtureCount).toBe(160);
    expect(manifest.fixtures).toHaveLength(160);
    expect(manifest.flowConvention).toEqual(expectedFlow);
    expect(manifest.flowConventionNotice).toContain("NOT official Qualcomm strings");
    expect(new Set(relativePaths).size).toBe(160);
    expect(new Set(manifest.fixtures.map((fixture) => fixture.relativePath)).size).toBe(160);
    expect(relativePaths.sort()).toEqual(manifest.fixtures.map((fixture) => fixture.relativePath).sort());

    expect(counts(manifest.fixtures.map((fixture) => fixture.scenarioFamily))).toEqual({
      pass: 16,
      "uefi-failure": 16,
      "uefi-exit": 16,
      "os-failure": 16,
      "reboot-recovered": 16,
      "stale-conflict": 16,
      "multiple-runs": 16,
      "metadata-mismatch": 16,
      "filename-variants": 16,
      "memory-records": 16,
    });
    expect(counts(manifest.fixtures.map((fixture) => fixture.expectedTerminalResult))).toEqual({
      PASS: 58,
      TEST_FAIL: 9,
      UEFI_FAIL: 11,
      SYSTEM_HALT: 10,
      UEFI_EXIT_FAIL: 16,
      OS_PANIC: 6,
      INCOMPLETE: 5,
      SYSTEM_REBOOT: 8,
      UNKNOWN: 37,
    });
    expect(manifest.fixtures.filter((fixture) => fixture.needsReview)).toHaveLength(61);
    expect(manifest.fixtures.filter((fixture) => fixture.expectedTerminalResult === "UNKNOWN").every((fixture) => fixture.needsReview)).toBe(true);
    const corpusLabels = new Set(["PASS", "TEST_FAIL", "UEFI_FAIL", "SYSTEM_HALT", "UEFI_EXIT_FAIL", "OS_PANIC", "INCOMPLETE", "SYSTEM_REBOOT", "UNKNOWN"]);
    expect(manifest.fixtures.every((fixture) => corpusLabels.has(fixture.expectedTerminalResult))).toBe(true);
    expect(new Set(manifest.fixtures.map((fixture) => fixture.expectedTerminalResult))).toContain("UEFI_FAIL");
    expect(new Set(manifest.fixtures.map((fixture) => fixture.expectedTerminalResult))).toContain("UEFI_EXIT_FAIL");
    expect(new Set(manifest.fixtures.map((fixture) => fixture.expectedTerminalResult))).toContain("OS_PANIC");

    for (const fixture of manifest.fixtures) {
      expect(Object.keys(fixture.metadata).sort()).toEqual(["material", "mode", "run", "sample", "tempC", "vdd"]);
      expect(Object.values(fixture.metadata).every((value) => typeof value === "string")).toBe(true);
      expect(fixture.orderedStageMarkers.length).toBeGreaterThan(0);
      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      assertOrderedMarkers(content, fixture.orderedStageMarkers, fixture.relativePath);
      if (fixture.scenarioFamily !== "metadata-mismatch") expect(fixture.metadataMismatchOracle).toBeNull();
    }

    const totalBytes = (await Promise.all(files.map(async (file) => (await stat(file)).size)))
      .reduce((sum, size) => sum + size, 0);
    expect(totalBytes).toBeLessThan(3 * 1024 * 1024);
  });

  it("uses explicit run boundaries and exact two-run recovery flows", async () => {
    const manifest = await readManifest();
    for (const fixture of manifest.fixtures.filter((entry) => entry.scenarioFamily === "reboot-recovered" && entry.scenarioVariant === "recovered")) {
      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      expect(content.match(/^RUN_ID=001;$/gm)).toHaveLength(1);
      expect(content.match(/^RUN_ID=002;$/gm)).toHaveLength(1);
      expect(content.match(/^SYN_POWER_ON;$/gm)).toHaveLength(2);
      expect(content.match(/^SYN_WATCHDOG_RESET;$/gm)).toHaveLength(1);
      expect(content.indexOf("RUN_ID=001;")).toBeLessThan(content.indexOf("SYN_WATCHDOG_RESET;"));
      expect(content.indexOf("SYN_WATCHDOG_RESET;")).toBeLessThan(content.indexOf("RUN_ID=002;"));
    }
    for (const fixture of manifest.fixtures.filter((entry) => entry.scenarioFamily === "stale-conflict" && ["stale-terminal", "stale-uefi"].includes(entry.scenarioVariant))) {
      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      expect(content.indexOf("RUN_ID=PREVIOUS;")).toBeLessThan(content.indexOf("RUN_BOUNDARY=CURRENT;"));
      expect(content.indexOf("RUN_BOUNDARY=CURRENT;")).toBeLessThan(content.indexOf("SYN_POWER_ON;"));
    }
  });

  it("stores genuine metadata mismatches and their oracle values", async () => {
    const fixtures = (await readManifest()).fixtures.filter((entry) => entry.scenarioFamily === "metadata-mismatch");
    expect(counts(fixtures.map((fixture) => fixture.scenarioVariant))).toEqual({ temperature: 4, vdd: 4, mode: 4, "filename-content": 4 });
    for (const fixture of fixtures) {
      const oracle = fixture.metadataMismatchOracle!;
      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      expect(oracle).not.toBeNull();
      if (oracle.kind === "expected-vs-observed") {
        expect(oracle.expected).not.toBe(oracle.observed);
        if (oracle.field === "temperature") expect(content).toContain(`TEMP_TARGET=${oracle.expected}C; TEMP_READBACK=${oracle.observed}C;`);
        if (oracle.field === "vdd") expect(content).toContain(`VDD_TARGET=${oracle.expected}V; VDD_READBACK=${oracle.observed}V;`);
        if (oracle.field === "mode") expect(content).toContain(`MODE_FILE=${oracle.expected}; MODE_INSERTED=${oracle.observed};`);
      } else {
        expect(oracle.filename).not.toBe(oracle.content);
        expect(fixture.relativePath.split("/").at(-1)?.toUpperCase()).toContain(oracle.filename.toUpperCase());
        expect(content).toContain(`MODE=${oracle.content};`);
        expect(content).toContain(`FILENAME_MODE=${oracle.filename}; CONTENT_MODE=${oracle.content};`);
      }
    }
  });

  it("covers stressapptest and tSKHYNIX edge records without proprietary data", async () => {
    const memoryFixtures = (await readManifest()).fixtures.filter((fixture) => fixture.scenarioFamily === "memory-records");
    const text = (await Promise.all(memoryFixtures.map((fixture) => readFile(join(corpusRoot, fixture.relativePath), "utf8")))).join("\n");

    expect(text).toMatch(/Hardware Error: miscompare on CPU \d+\(<-\d+\) at 0x[0-9a-f]+\(0x[0-9a-f]+:DIMM [^)]+\): read:0x[0-9a-f]+, reread:0x[0-9a-f]+ expected:0x[0-9a-f]+/i);
    expect(text).toMatch(/Hardware Error: CRC check at 0x[0-9a-f]+\(0x[0-9a-f]+:DIMM [^)]+\): miscompare on CPU \d+\(<-\d+\): read:0x[0-9a-f]+, reread:0x[0-9a-f]+ expected:0x[0-9a-f]+/i);
    expect(text).toMatch(/STRESSAPP EXCLUDED/);
    expect(text).toMatch(/STRESSAPP MALFORMED/);
    const repeatedPhysical = text.match(/at 0x[0-9a-f]+\((0x[0-9a-f]+):DIMM[^\n]+\nHardware Error: miscompare[^\n]+at 0x[0-9a-f]+\(\1:DIMM/i);
    expect(repeatedPhysical).not.toBeNull();

    expect(text).toMatch(/^tSKHYNIX_[A-Za-z0-9_]+(?:,|\s)/m);
    expect(text).toMatch(/tSKHYNIX_MARCH_32, ADDR=.*WR=0x[0-9a-f]{8}, RD=0x[0-9a-f]{8}/i);
    expect(text).toMatch(/tSKHYNIX_RANDOM_64 ADDR=.*WR=0x[0-9a-f]{16} RD=0x[0-9a-f]{16}/i);
    expect(text).toMatch(/tSKHYNIX_ALIAS_CONTEXT, ADDRESS=.*INDEX=.*BANK=.*COLUMN=.*EXPECTED=.*ACTUAL=/i);
    expect(text).toMatch(/tSKHYNIX_EQUAL_BASELINE, ADDR=.*WR=0xdeadbeef, RD=0xdeadbeef/i);
    expect(text).toMatch(/tSKHYNIX_MISSING_WRITE, ADDR=.*RD=/i);
    expect(text).toMatch(/tSKHYNIX_MISSING_READ, ADDR=.*WR=/i);
    expect(text).toMatch(/tSKHYNIX_MISALIGNED ADDR=0x[0-9a-f]*303 WR=/i);
    expect(text).toMatch(/tSKHYNIX_OVERLONG ADDR=.*WR=0x[0-9a-f]{48} RD=0x[0-9a-f]{48}/i);

    const hashes = new Set<string>();
    for (const fixture of memoryFixtures) {
      const content = await readFile(join(corpusRoot, fixture.relativePath));
      hashes.add(createHash("sha256").update(content).digest("hex"));
      expect(fixture.features).toContain("stressapptest");
      expect(fixture.features).toContain("tSKHYNIX");
      expect(fixture.parserOracle).not.toBeNull();
    }
    expect(hashes).toHaveLength(16);
  });

  it("enforces the local memory grammar and manifest oracle", async () => {
    const manifest = await readManifest();
    const stressGrammar = /^Hardware Error: miscompare on CPU \d+\(<-\d+\) at 0x[0-9a-f]+\(0x[0-9a-f]+:DIMM [^)]+\): read:0x[0-9a-f]{1,16}, reread:0x[0-9a-f]{1,16} expected:0x[0-9a-f]{1,16}/i;
    const crcGrammar = /^Hardware Error: CRC check at 0x[0-9a-f]+\(0x[0-9a-f]+:DIMM [^)]+\): miscompare on CPU \d+\(<-\d+\): read:0x[0-9a-f]{1,16}, reread:0x[0-9a-f]{1,16} expected:0x[0-9a-f]{1,16}/i;
    const tskGrammar = /^tSKHYNIX_[A-Za-z0-9_]+(?:,|\s)/;
    for (const fixture of manifest.fixtures) {
      if (fixture.scenarioFamily !== "memory-records") {
        expect(fixture.parserOracle).toBeNull();
        continue;
      }
      const oracle = fixture.parserOracle;
      expect(oracle).not.toBeNull();
      const content = await readFile(join(corpusRoot, fixture.relativePath), "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      const stressLines = lines.filter((line) => line.startsWith("Hardware Error:"));
      const acceptedStressLines = stressLines.filter((line) => stressGrammar.test(line) || crcGrammar.test(line));
      const tskLines = lines.filter((line) => line.startsWith("tSKHYNIX_"));
      expect(tskLines.every((line) => tskGrammar.test(line)), fixture.relativePath).toBe(true);
      expect(acceptedStressLines.length, fixture.relativePath).toBe(oracle!.expectedStressappRecords);
      expect(oracle!.expectedStressappRows).toBeGreaterThanOrEqual(oracle!.expectedStressappRecords);
      if (fixture.scenarioVariant === "both-half-mismatch") expect(oracle!.expectedStressappRows).toBe(2);
      if (fixture.scenarioVariant === "repeated-address") expect(oracle!.expectedStressappRows).toBe(3);
      if (fixture.scenarioVariant === "32-bit") expect(tskLines.some((line) => /WR=0x[0-9a-f]{8}, RD=0x[0-9a-f]{8}/i.test(line))).toBe(true);
      if (fixture.scenarioVariant === "64-bit") expect(tskLines.some((line) => /WR=0x[0-9a-f]{16} RD=0x[0-9a-f]{16}/i.test(line))).toBe(true);
      if (fixture.scenarioVariant === "alias") expect(tskLines.some((line) => /ADDRESS=.*INDEX=.*BANK=.*COLUMN=.*EXPECTED=.*ACTUAL=/i.test(line))).toBe(true);
      if (["misaligned", "overlong"].includes(fixture.scenarioVariant)) expect(oracle!.expectedParserError).not.toBeNull();
      if (["excluded", "malformed", "equal-values", "missing-fields", "baseline"].includes(fixture.scenarioVariant)) {
        expect(oracle!.expectedStressappRows + oracle!.expectedTskhynixRows).toBe(0);
      }
    }
  });

  it("matches the read-only Python reference parser when available", async () => {
    if (!existsSync(join(referenceParserRoot, "lpddr6_packet_mapper", "stressapp_parser.py"))) return;
    const pythonReady = await execFileAsync("python3", ["-c", "import sys"]).then(() => true).catch(() => false);
    if (!pythonReady) return;
    const parserScript = `
import json
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from lpddr6_packet_mapper.stressapp_parser import _parse_line

rows = {"stressapptest": 0, "tskhynix": 0}
records = {"stressapptest": 0, "tskhynix": 0}
parser_error = None
for source_line, line in enumerate(Path(sys.argv[2]).read_text(encoding="utf-8", errors="replace").splitlines(keepends=True), start=1):
    try:
        parsed = _parse_line(line, source_file=Path(sys.argv[2]).name, source_line=source_line)
    except Exception as error:
        parser_error = type(error).__name__
        break
    if parsed:
        record_format = parsed[0]["record_format"]
        records[record_format] += 1
        rows[record_format] += len(parsed)
print(json.dumps({"rows": rows, "records": records, "parserError": parser_error}))
`;
    const manifest = await readManifest();
    for (const fixture of manifest.fixtures.filter((entry) => entry.scenarioFamily === "memory-records")) {
      const oracle = fixture.parserOracle!;
      const result = await execFileAsync(
        "python3",
        ["-c", parserScript, referenceParserRoot, join(corpusRoot, fixture.relativePath)],
        { cwd: repositoryRoot },
      );
      const parsed = JSON.parse(result.stdout) as {
        rows: { stressapptest: number; tskhynix: number };
        records: { stressapptest: number; tskhynix: number };
        parserError: string | null;
      };
      expect(parsed.rows.stressapptest, fixture.relativePath).toBe(oracle.expectedStressappRows);
      expect(parsed.rows.tskhynix, fixture.relativePath).toBe(oracle.expectedTskhynixRows);
      expect(parsed.records.stressapptest, fixture.relativePath).toBe(oracle.expectedStressappRecords);
      expect(parsed.records.tskhynix, fixture.relativePath).toBe(oracle.expectedTskhynixRecords);
      expect(parsed.parserError === null, fixture.relativePath).toBe(oracle.expectedParserError === null);
    }
  });

  it("preserves CRLF and truncated-final-line cases", async () => {
    const manifest = await readManifest();
    const crlfFixtures = manifest.fixtures.filter((fixture) => fixture.features.includes("crlf"));
    const truncatedFixtures = manifest.fixtures.filter((fixture) => fixture.features.includes("truncated-final-line"));
    expect(crlfFixtures).toHaveLength(4);
    expect(truncatedFixtures).toHaveLength(4);
    for (const fixture of crlfFixtures) {
      expect((await readFile(join(corpusRoot, fixture.relativePath))).includes(Buffer.from("\r\n"))).toBe(true);
    }
    for (const fixture of truncatedFixtures) {
      const content = await readFile(join(corpusRoot, fixture.relativePath));
      expect(content.toString("utf8")).not.toContain("END_SYNTHETIC_RECORD=true;");
      expect(content.toString("utf8").endsWith("tSKHYNIX_ADDR=0x1000 WR=0x")).toBe(true);
      expect(content.at(-1)).not.toBe(0x0a);
    }
  });

  it("regenerates byte-for-byte into --output directories", async () => {
    const firstOutput = await mkdtemp(join(tmpdir(), "qualcomm-corpus-a-"));
    const secondOutput = await mkdtemp(join(tmpdir(), "qualcomm-corpus-b-"));
    temporaryRoots.push(firstOutput, secondOutput);
    await execFileAsync(process.execPath, [generator, "--output", firstOutput], { cwd: repositoryRoot });
    await execFileAsync(process.execPath, [generator, "--output", secondOutput], { cwd: repositoryRoot });

    const trackedSnapshot = await corpusSnapshot(corpusRoot);
    const firstSnapshot = await corpusSnapshot(firstOutput);
    const secondSnapshot = await corpusSnapshot(secondOutput);
    expect([...firstSnapshot.keys()].sort()).toEqual([...trackedSnapshot.keys()].sort());
    expect([...secondSnapshot.keys()].sort()).toEqual([...trackedSnapshot.keys()].sort());
    for (const [path, content] of trackedSnapshot) {
      expect(firstSnapshot.get(path), path).toEqual(content);
      expect(secondSnapshot.get(path), path).toEqual(content);
    }
  }, 30_000);

  it("fails closed instead of overwriting an unowned output directory", async () => {
    const output = await mkdtemp(join(tmpdir(), "qualcomm-corpus-unowned-"));
    temporaryRoots.push(output);
    await writeFile(join(output, "rogue.log"), "unowned\n", "utf8");
    await expect(execFileAsync(process.execPath, [generator, "--output", output], { cwd: repositoryRoot })).rejects.toThrow(/non-empty output|valid corpus manifest/i);
    expect(await readFile(join(output, "rogue.log"), "utf8")).toBe("unowned\n");
  });
});
