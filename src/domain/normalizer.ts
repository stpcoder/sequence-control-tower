import type {
  NormalizationOptions,
  NormalizationResult,
  NormalizationRule,
  SequenceCommand,
  TokenReplacement,
} from "./types";

const BUILTIN_RULES: NormalizationRule[] = [
  {
    id: "uuid",
    kind: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    replacement: "<UUID>",
  },
  {
    id: "iso-timestamp",
    kind: "timestamp",
    pattern: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: "<TIMESTAMP>",
  },
  {
    id: "bracket-timestamp",
    kind: "timestamp",
    pattern: /\[(?:\d{4}[-/.]\d{2}[-/.]\d{2}\s+)?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]/g,
    replacement: "<TIMESTAMP>",
  },
  {
    id: "clock-timestamp",
    kind: "timestamp",
    pattern: /(?<![\d:])\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\d:])/g,
    replacement: "<TIMESTAMP>",
  },
  {
    id: "date",
    kind: "date",
    pattern: /\b(?:19|20)\d{2}[-/.]\d{2}[-/.]\d{2}\b/g,
    replacement: "<DATE>",
  },
  {
    id: "duration",
    kind: "duration",
    pattern: /\b\d+(?:\.\d+)?\s*(?:milliseconds?|msecs?|ms|seconds?|secs?|minutes?|mins?|µs|us)\b/gi,
    replacement: "<DURATION>",
  },
  {
    id: "process-id",
    kind: "process-id",
    pattern: /\b(pid|process(?:_id)?)\s*[:=]\s*\d+\b/gi,
    replacement: (_match, label) => `${label}=<PID>`,
  },
  {
    id: "thread-id",
    kind: "thread-id",
    pattern: /\b(tid|thread(?:_id)?)\s*[:=]\s*\d+\b/gi,
    replacement: (_match, label) => `${label}=<TID>`,
  },
  {
    id: "hex-address",
    kind: "hex-address",
    pattern: /\b0x[0-9a-f]{5,}\b/gi,
    replacement: "<HEX>",
  },
];

function globalPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

function applyRule(input: string, rule: NormalizationRule, replacements: TokenReplacement[]): string {
  const pattern = globalPattern(rule.pattern);
  return input.replace(pattern, (match: string, ...args: unknown[]) => {
    const offset = args.at(-2) as number;
    const groups = args.slice(0, -2).map(String);
    const replacement =
      typeof rule.replacement === "function" ? rule.replacement(match, ...groups) : rule.replacement;
    replacements.push({
      kind: rule.kind,
      original: match,
      replacement,
      start: offset,
      end: offset + match.length,
      ruleId: rule.id,
    });
    return replacement;
  });
}

/** Normalizes only known run-variant tokens; condition numbers remain intact. */
export function normalizeDynamicTokens(input: string, options: NormalizationOptions = {}): NormalizationResult {
  const replacements: TokenReplacement[] = [];
  let text = input.replace(/\r\n?/g, "\n");
  for (const rule of [...BUILTIN_RULES, ...(options.customRules ?? [])]) {
    text = applyRule(text, rule, replacements);
  }

  if (options.collapseWhitespace !== false) {
    text = options.preserveLineBreaks === false
      ? text.replace(/\s+/g, " ").trim()
      : text
          .split("\n")
          .map((line) => line.replace(/[\t ]+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
  }
  if (options.lowercase) text = text.toLocaleLowerCase("en-US");

  return { text, replacements };
}

export function normalizeCommand(command: SequenceCommand | string): string {
  const text = typeof command === "string" ? command : command.text;
  return normalizeDynamicTokens(text, {
    lowercase: true,
    collapseWhitespace: true,
    preserveLineBreaks: false,
  }).text.replace(/\s*([=,:])\s*/g, "$1");
}

export const defaultNormalizationRules: readonly NormalizationRule[] = BUILTIN_RULES;
