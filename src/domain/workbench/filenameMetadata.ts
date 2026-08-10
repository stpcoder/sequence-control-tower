export type FilenameMetadataKey = "sample" | "temperature" | "mode" | "grid";
export type FilenameMetadataState = "extracted" | "unknown" | "conflict";

export interface FilenameMetadataProvenance {
  source: "basename";
  token: string;
  start: number;
  end: number;
  rule: string;
}

export interface FilenameMetadataField {
  value: string | null;
  state: FilenameMetadataState;
  confidence: number;
  candidates: string[];
  provenance: FilenameMetadataProvenance[];
}

export interface FilenameMetadata {
  source: "basename";
  basename: string;
  sample: FilenameMetadataField;
  temperature: FilenameMetadataField;
  mode: FilenameMetadataField;
  grid: FilenameMetadataField;
}

const EMPTY_FIELD: Omit<FilenameMetadataField, "provenance"> = {
  value: null,
  state: "unknown",
  confidence: 0,
  candidates: [],
};

function emptyField(): FilenameMetadataField {
  return { ...EMPTY_FIELD, provenance: [] };
}

function sourceBasename(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.replace(/\.[^.\/]+$/, "");
}

function fieldFromMatches(
  matches: Array<{ value: string; token: string; start: number; end: number; rule: string }>,
  confidence: number,
): FilenameMetadataField {
  const boundedMatches = matches.slice(0, 8);
  const unique = [...new Set(boundedMatches.map((match) => match.value))];
  if (!unique.length) return emptyField();
  if (unique.length > 1) {
    return {
      value: null,
      state: "conflict",
      confidence: 0,
      candidates: unique,
      provenance: boundedMatches.map(({ value: _value, ...provenance }) => ({ source: "basename", ...provenance })),
    };
  }
  return {
    value: unique[0],
    state: "extracted",
    confidence,
    candidates: unique,
    provenance: boundedMatches.map(({ value: _value, ...provenance }) => ({ source: "basename", ...provenance })),
  };
}

function matchesFor(
  stem: string,
  expression: RegExp,
  normalize: (value: string, match: RegExpMatchArray) => string,
  rule: string,
): Array<{ value: string; token: string; start: number; end: number; rule: string }> {
  return [...stem.matchAll(expression)].flatMap((match) => {
    const raw = match.groups?.value ?? match[1];
    if (!raw) return [];
    const value = normalize(raw, match);
    const offset = match[0].indexOf(raw);
    return [{ value, token: match[0], start: match.index + Math.max(offset, 0), end: match.index + Math.max(offset, 0) + raw.length, rule }];
  });
}

function normalizeSample(value: string): string {
  return value.toUpperCase().replace(/^(?:SAMPLE|SMP)[=_-]/i, "");
}

function normalizeMode(value: string): string {
  return value.toUpperCase();
}

function normalizeGrid(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

/**
 * Reads only the basename. It deliberately does not inspect file contents or
 * infer a value from an unrelated numeric token in the name.
 */
export function parseFilenameMetadata(fileName: string): FilenameMetadata {
  const basename = sourceBasename(typeof fileName === "string" ? fileName : "");
  const stem = basename.trim();
  const sample = matchesFor(
    stem,
    /(?:^|[_.+@-])(?:(?:SAMPLE|SMP)(?:[=_:-]?)|S[=_:-])(?<value>[A-Z0-9][A-Z0-9-]*?)(?=$|[_.+@]|-(?:SAMPLE|SMP|S)(?:[=_:-]?))/giu,
    normalizeSample,
    "sample-label",
  );
  // Repository fixtures also use an unlabeled leading sample, e.g.
  // `SAMP-A__TEMP=25C__MODE=DIAG__RUN=1`. Keep this anchored to the basename
  // prefix so an unrelated `SAMP-*` token later in a name is not inferred.
  if (!sample.length) {
    sample.push(...matchesFor(
      stem,
      /^(?<value>SAMP-[A-Z0-9]+)(?=$|[_.+@-])/giu,
      (value) => value.toUpperCase(),
      "sample-leading-unlabeled",
    ));
  }
  const temperature = matchesFor(
    stem,
    /(?:^|[_.+@-])(?:TEMPERATURE|TEMP|T)(?:[=_:]?)(?<value>-?\d+(?:[p.]\d+)?)(?:\s*C)?(?=$|[_.+@-])/giu,
    (value, match) => {
      // In `+TEMP-125C+MODE-*`, plus-delimited corpus names use the hyphen as
      // the label separator. Explicit negative values remain `TEMP=-40C` or
      // the established compact `T-40C` form.
      const token = match[0].toUpperCase();
      const normalized = token.startsWith("+TEMP-") || token.startsWith("+TEMPERATURE-")
        ? value.replace(/^-/, "")
        : value;
      return normalized.replace("p", ".");
    },
    "temperature-label",
  );
  const mode = matchesFor(
    stem,
    /(?:^|[_.+@-])(?:MODE(?:[=_:-]?)|M[=_:-])(?<value>[A-Z][A-Z0-9-]*?)(?=$|[_.+@-])/giu,
    normalizeMode,
    "mode-label",
  );
  const grid = matchesFor(
    stem,
    /(?:^|[_.+@-])(?:(?:GRID|MATRIX)(?:[=_:-]?)|G[=_:-])(?<value>[A-Z0-9][A-Z0-9xX*-]*?)(?=$|[_.+@-])/giu,
    normalizeGrid,
    "grid-label",
  );

  // A bare negative/positive temperature is common in lab filenames. It is
  // accepted only when followed by C, avoiding run IDs and other numbers.
  if (!temperature.length) {
    temperature.push(...matchesFor(
      stem,
      /(?:^|[_.+@])(?<value>-?\d+(?:[p.]\d+)?)C(?=$|[_.+@-])/giu,
      (value) => value.replace("p", "."),
      "temperature-bare",
    ));
  }

  return {
    source: "basename",
    basename,
    sample: fieldFromMatches(sample, 0.97),
    temperature: fieldFromMatches(temperature, 0.97),
    mode: fieldFromMatches(mode, 0.95),
    grid: fieldFromMatches(grid, 0.95),
  };
}

export const parseFilename = parseFilenameMetadata;
