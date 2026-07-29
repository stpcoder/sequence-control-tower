import type {
  ClockMode,
  ClockSetting,
  CommandFamily,
  EccMode,
  EvidenceValue,
  ExtractedCondition,
  ParsedSequence,
  PatternSetting,
  Provenance,
  SequenceDNA,
  VoltageSetting,
} from "./types";

interface EvidenceText {
  text: string;
  confidence: number;
  provenance: Provenance;
}

const uniqueNumbers = (values: number[]): number[] =>
  [...new Set(values.filter(Number.isFinite).map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b);

const uniqueStrings = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function evidence<T>(
  value: T | null,
  confidence: number,
  provenance: Provenance[],
  status: EvidenceValue<T>["status"] = value === null ? "unknown" : "extracted",
): EvidenceValue<T> {
  return {
    value,
    confidence: Math.max(0, Math.min(1, confidence)),
    provenance,
    status,
  };
}

function corpus(parsed: ParsedSequence): EvidenceText[] {
  const sourceId = parsed.source.id;
  const items: EvidenceText[] = [
    {
      text: parsed.source.filename,
      confidence: 0.64,
      provenance: { kind: "filename", sourceId, excerpt: parsed.source.filename },
    },
  ];
  if (parsed.source.userComment) {
    items.push({
      text: parsed.source.userComment,
      confidence: 0.7,
      provenance: { kind: "user-comment", sourceId, excerpt: parsed.source.userComment },
    });
  }
  for (const block of parsed.blocks) {
    if (!block.synthetic) {
      items.push({
        text: block.header,
        confidence: 0.83,
        provenance: { kind: "source", sourceId, range: block.range, excerpt: block.rawHeader, rule: "block-header" },
      });
    }
    for (const command of block.commands) {
      items.push({
        text: command.text,
        confidence: command.terminated ? 0.98 : 0.82,
        provenance: { kind: "source", sourceId, range: command.range, excerpt: command.raw, rule: "command" },
      });
    }
    for (const note of block.notes) {
      items.push({
        text: note.text,
        confidence: note.reason === "comment" ? 0.7 : 0.5,
        provenance: { kind: "source", sourceId, range: note.range, excerpt: note.text, rule: note.reason },
      });
    }
  }
  return items;
}

function collectMatches(
  items: EvidenceText[],
  patterns: RegExp[],
): Array<{ match: RegExpExecArray; item: EvidenceText; rule: string }> {
  const results: Array<{ match: RegExpExecArray; item: EvidenceText; rule: string }> = [];
  for (const item of items) {
    for (const original of patterns) {
      const flags = original.flags.includes("g") ? original.flags : `${original.flags}g`;
      const pattern = new RegExp(original.source, flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(item.text)) !== null) {
        results.push({ match, item, rule: original.source });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  return results;
}

function provenanceOf(matches: Array<{ item: EvidenceText; rule: string }>): Provenance[] {
  const seen = new Set<string>();
  return matches
    .map(({ item, rule }) => ({ ...item.provenance, rule }))
    .filter((item) => {
      const key = `${item.kind}:${item.range?.startLine ?? ""}:${item.excerpt ?? ""}:${item.rule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function confidenceOf(matches: Array<{ item: EvidenceText }>, ambiguityPenalty = 0): number {
  if (!matches.length) return 0;
  const strongest = Math.max(...matches.map(({ item }) => item.confidence));
  const corroboration = Math.min(0.06, Math.max(0, matches.length - 1) * 0.015);
  return Math.max(0, Math.min(1, strongest + corroboration - ambiguityPenalty));
}

function extractTemperatures(items: EvidenceText[]): EvidenceValue<number[]> {
  const explicit = collectMatches(items, [
    /(?:temp(?:erature)?|tcase|chamber|@?tf(?:\s+set)?)\s*[:=_-]?\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?c?\b/gi,
    /(?:^|[_\s-])(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?[cC](?=$|[_\s-])/g,
  ]);
  const values = uniqueNumbers(explicit.map(({ match }) => Number(match[1])).filter((value) => value >= -100 && value <= 250));
  return values.length
    ? evidence(values, confidenceOf(explicit), provenanceOf(explicit))
    : evidence<number[]>(null, 0, []);
}

function normalizeVoltage(raw: string): number | null {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric > 100) return numeric / 1000;
  if (numeric > 5) return numeric / 100;
  return numeric;
}

function extractVoltages(items: EvidenceText[]): EvidenceValue<VoltageSetting[]> {
  const matches = collectMatches(items, [
    /\b(vdd(?:2h|2l|q|h|l)?|vcc[a-z0-9_]*|vpp)\s*(?:=|:|set\s+)?\s*(\d+(?:\.\d+)?)\s*(mv|v)?\b/gi,
    /\bset_rail\s+([a-z][\w-]*)\s+(\d+(?:\.\d+)?)\s*(mv|v)?\b/gi,
  ]);
  const settings: VoltageSetting[] = [];
  for (const { match } of matches) {
    let volts = normalizeVoltage(match[2]);
    if (volts === null) continue;
    if (match[3]?.toLowerCase() === "mv" && Number(match[2]) <= 100) volts = Number(match[2]) / 1000;
    if (volts < 0.1 || volts > 10) continue;
    settings.push({ rail: match[1].toUpperCase(), volts: Number(volts.toFixed(4)), original: match[0] });
  }
  const deduped = settings.filter(
    (setting, index) =>
      settings.findIndex((candidate) => candidate.rail === setting.rail && candidate.volts === setting.volts) === index,
  );
  return deduped.length
    ? evidence(deduped, confidenceOf(matches), provenanceOf(matches))
    : evidence<VoltageSetting[]>(null, 0, []);
}

function extractEcc(items: EvidenceText[]): EvidenceValue<EccMode> {
  const enabled = collectMatches(items, [
    /\becc\s*(?:=|:|_|-)?\s*(?:enable(?:d)?|on|en|1)\b/gi,
    /\b(?:enable|set)\s+ecc\b/gi,
  ]);
  const disabled = collectMatches(items, [
    /\becc\s*(?:=|:|_|-)?\s*(?:disable(?:d)?|off|dis|ef|0)\b/gi,
    /\b(?:disable|clear)\s+ecc\b/gi,
  ]);
  if (!enabled.length && !disabled.length) return evidence<EccMode>("unknown", 0, [], "unknown");
  const mode: EccMode = enabled.length && disabled.length ? "mixed" : enabled.length ? "enabled" : "disabled";
  const matches = [...enabled, ...disabled];
  return evidence(mode, confidenceOf(matches, mode === "mixed" ? 0.08 : 0), provenanceOf(matches));
}

function extractClocks(items: EvidenceText[]): EvidenceValue<ClockSetting> {
  const fixed = collectMatches(items, [
    /\b(?:clk|clock|frequency|freq)\s*(?:=|:|_|-)?\s*(\d{2,6}(?:\.\d+)?(?:\s*[,/]\s*\d{2,6}(?:\.\d+)?)*)\s*(?:mhz)?\b/gi,
    /\bclk(?:\.sh)?\b[^;\n]*?\s-f\s+((?:\d{2,6}(?:\.\d+)?(?:\s*[,/]\s*|\s+))*\d{2,6}(?:\.\d+)?)(?=\s+-|\s*[;\n]|$)/gi,
  ]);
  const sweep = collectMatches(items, [
    /\b(?:clk|clock|frequency|freq)[\w./-]*\s*(?:=|:|_|-)?\s*(?:full[_ -]?)?sweep\b/gi,
    /\bclk(?:\.sh)?\b[^;\n]*?\s-lf\b/gi,
  ]);
  const rawValues = fixed.flatMap(({ match }) => match[1].trim().split(/(?:\s*[,/]\s*|\s+)/));
  const valuesMHz = uniqueNumbers(rawValues.map(Number).filter((value) => value >= 10 && value <= 1_000_000));
  if (!fixed.length && !sweep.length) return evidence<ClockSetting>(null, 0, []);
  const mode: ClockMode = fixed.length && sweep.length ? "mixed" : fixed.length ? "fixed" : "sweep";
  const matches = [...fixed, ...sweep];
  return evidence({ mode, valuesMHz, rawValues: uniqueStrings(rawValues) }, confidenceOf(matches), provenanceOf(matches));
}

function extractPatterns(items: EvidenceText[]): EvidenceValue<PatternSetting> {
  const selected = collectMatches(items, [
    /\bpatterns?\s*(?:=|:|_|-)?\s*([a-z0-9]+(?:\s*[,/]\s*[a-z0-9]+)*)\b/gi,
    /\b(?:hdiag\w*|diag\w*)\b[^;\n]*?\s-(?:p|pattern)\s+((?:[a-z0-9]+(?:\s*[,/]\s*|\s+))*[a-z0-9]+)(?=\s+-|\s*[;\n]|$)/gi,
  ]);
  const full = collectMatches(items, [/\bpatterns?\s*(?:=|:|_|-)?\s*(?:all|full)\b/gi]);
  const values = uniqueStrings(
    selected
      .flatMap(({ match }) => match[1].trim().split(/(?:\s*[,/]\s*|\s+)/))
      .filter((value) => !/^(?:full|all)$/i.test(value)),
  );
  if (!values.length && !full.length) return evidence<PatternSetting>(null, 0, []);
  const mode: PatternSetting["mode"] = values.length && full.length ? "mixed" : values.length ? "selected" : "full";
  const matches = [...selected, ...full];
  return evidence({ mode, values }, confidenceOf(matches), provenanceOf(matches));
}

function extractConditions(items: EvidenceText[]): EvidenceValue<ExtractedCondition[]> {
  const matches = collectMatches(items, [/\b([A-Za-z][A-Za-z0-9_-]{1,30})\s*[:=]\s*([^\s;,]+)/g]);
  const ignored = new Set(["pid", "tid", "address", "duration", "timestamp", "time"]);
  const conditions: ExtractedCondition[] = [];
  for (const { match } of matches) {
    const normalizedKey = match[1].replace(/[-_]/g, "").toLocaleLowerCase("en-US");
    if (ignored.has(normalizedKey)) continue;
    const condition = { key: match[1], value: match[2], normalizedKey };
    if (!conditions.some((item) => item.normalizedKey === condition.normalizedKey && item.value === condition.value)) {
      conditions.push(condition);
    }
  }
  return conditions.length
    ? evidence(conditions, confidenceOf(matches, 0.03), provenanceOf(matches))
    : evidence<ExtractedCondition[]>([], 1, [], "extracted");
}

function executableOf(command: string): string {
  const trimmed = command.trim().replace(/^(?:cmd\s*\/c|powershell(?:\.exe)?\s+-command)\s+/i, "");
  return trimmed.match(/^(@?[A-Za-z_./\\][\w./\\@-]*)/)?.[1]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? "unknown";
}

export function inferCommandFamily(command: string): { family: string; executable: string } {
  const lower = command.toLocaleLowerCase("en-US");
  const executable = executableOf(command);
  if (/\b(?:@?tf|temp(?:erature)?|chamber)\b/.test(lower)) return { family: "temperature-control", executable };
  if (/\b(?:vdd\w*|vcc\w*|vpp|set_rail)\b/.test(lower)) return { family: "voltage-control", executable };
  if (/\b(?:clk(?:\.sh)?|clock|frequency|freq)\b/.test(lower)) return { family: "clock-control", executable };
  if (/\b(?:hdiag\w*|diag\w*|memtest\w*)\b/.test(lower)) return { family: "diagnostic", executable };
  if (/\badb(?:\.exe)?\b/.test(lower)) return { family: "device-bridge", executable };
  if (/^(?:sleep|wait|timeout)\b/.test(lower)) return { family: "timing", executable };
  if (/^(?:copy|cp|push|pull|download|flash)\b/.test(lower)) return { family: "artifact-transfer", executable };
  return { family: executable === "unknown" ? "unclassified" : "shell", executable };
}

function extractFamilies(parsed: ParsedSequence): EvidenceValue<CommandFamily[]> {
  const histogram = new Map<string, CommandFamily>();
  const provenance: Provenance[] = [];
  for (const command of parsed.blocks.flatMap((block) => block.commands)) {
    const result = inferCommandFamily(command.text);
    const key = `${result.family}:${result.executable}`;
    const current = histogram.get(key) ?? { ...result, count: 0 };
    current.count += 1;
    histogram.set(key, current);
    provenance.push({
      kind: "derived",
      sourceId: parsed.source.id,
      range: command.range,
      excerpt: command.raw,
      rule: `command-family:${result.family}`,
    });
  }
  const families = [...histogram.values()].sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));
  return evidence(families, families.length ? 0.96 : 0, provenance, families.length ? "extracted" : "unknown");
}

export function extractSequenceDNA(parsed: ParsedSequence): SequenceDNA {
  const items = corpus(parsed);
  const direct: Provenance = { kind: "derived", sourceId: parsed.source.id, rule: "parser-count" };
  return {
    conditions: extractConditions(items),
    temperaturesC: extractTemperatures(items),
    voltages: extractVoltages(items),
    ecc: extractEcc(items),
    clocks: extractClocks(items),
    patterns: extractPatterns(items),
    blockCount: evidence(parsed.stats.blockCount, 1, [direct]),
    commandCount: evidence(parsed.stats.commandCount, 1, [direct]),
    commandFamilies: extractFamilies(parsed),
  };
}
