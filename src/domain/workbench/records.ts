import type {
  ArtifactEvidenceSpec,
  ArtifactEvidenceSourceResult,
  ArtifactEvidenceTarget,
} from "../../../electron/shared/contracts";
import type {
  DocumentEvaluation,
  EvidenceOccurrence,
  PrecomputedDocumentEvidence,
  RecipeRule,
  ResultLabel,
} from "./types";

export interface MetadataFieldDefinition {
  key: string;
  label: string;
  target: Extract<ArtifactEvidenceTarget, "file_name" | "path">;
  /** Explicit engineer-authored regex. No metadata is guessed without it. */
  pattern: string;
  captureGroup: number | string;
  caseSensitive?: boolean;
  required?: boolean;
}

export interface MetadataFieldValue {
  key: string;
  label: string;
  value: string | null;
  state: "extracted" | "missing" | "ambiguous" | "invalid-rule";
  required: boolean;
  provenance?: {
    target: Extract<ArtifactEvidenceTarget, "file_name" | "path">;
    columnStart: number;
    columnEnd: number;
    excerpt: string;
  };
}

export interface ResultEvidenceCell {
  ruleId: string;
  clauseId: string;
  satisfied: boolean;
  occurrenceCount: number;
  firstOccurrence?: EvidenceOccurrence;
  lastOccurrence?: EvidenceOccurrence;
  orderSatisfied?: boolean;
}

/** Stable, JSON-serializable row suitable for an Excel/CSV export adapter. */
export interface ResultTableRow {
  sourceId: string;
  artifactId: string;
  fileName: string;
  /** Safe relative path only. Absolute paths are deliberately not accepted. */
  relativePath?: string;
  metadata: Record<string, MetadataFieldValue>;
  result: ResultLabel;
  needsReview: boolean;
  selectedRuleId?: string;
  exceptionCodes: string[];
  evidence: ResultEvidenceCell[];
}

export interface RecipeEvidencePlan {
  specs: ArtifactEvidenceSpec[];
  /** Keyed internally by rule id + clause id; values point to deduplicated specs. */
  specIdByClause: Record<string, string>;
}

const MAX_METADATA_PATTERN_CHARS = 500;
const MAX_METADATA_VALUE_CHARS = 500;

function validFieldKey(key: string): boolean {
  return /^[a-z][a-z0-9_.-]{0,63}$/i.test(key);
}

function clausePlanKey(ruleId: string, clauseId: string): string {
  return `${ruleId}\u0000${clauseId}`;
}

/** Deduplicates identical matchers before the backend scans the corpus once. */
export function buildRecipeEvidencePlan(rules: readonly RecipeRule[]): RecipeEvidencePlan {
  const specs: ArtifactEvidenceSpec[] = [];
  const specIdByMatcher = new Map<string, string>();
  const specIdByClause: Record<string, string> = {};
  for (const rule of rules) {
    for (const clause of rule.clauses) {
      const matcherKey = JSON.stringify(clause.matcher);
      let specId = specIdByMatcher.get(matcherKey);
      if (!specId) {
        specId = `recipe-spec-${specs.length + 1}`;
        specIdByMatcher.set(matcherKey, specId);
        specs.push({
          id: specId,
          query: clause.matcher.pattern,
          mode: clause.matcher.kind,
          caseSensitive: clause.matcher.caseSensitive,
          target: clause.matcher.target,
        });
      }
      specIdByClause[clausePlanKey(rule.id, clause.id)] = specId;
    }
  }
  return { specs, specIdByClause };
}

function safeRelativePath(value: string | undefined): string | undefined {
  if (!value || value.length > 4_000 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)) return undefined;
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) return undefined;
  return parts.filter((part) => part && part !== ".").join("/") || undefined;
}

function extractMetadataValue(
  definition: MetadataFieldDefinition,
  fileName: string,
  relativePath?: string,
): MetadataFieldValue {
  const required = definition.required === true;
  const base = { key: definition.key, label: definition.label, required };
  if (!validFieldKey(definition.key) || !definition.pattern || definition.pattern.length > MAX_METADATA_PATTERN_CHARS) {
    return { ...base, value: null, state: "invalid-rule" };
  }
  const targetText = definition.target === "file_name" ? fileName : relativePath ?? fileName;
  let expression: RegExp;
  try {
    expression = new RegExp(definition.pattern, definition.caseSensitive === true ? "gu" : "giu");
  } catch {
    return { ...base, value: null, state: "invalid-rule" };
  }

  const values: Array<{ value: string; start: number; end: number; excerpt: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(targetText)) !== null) {
    if (!match[0].length) return { ...base, value: null, state: "invalid-rule" };
    const captured = typeof definition.captureGroup === "number"
      ? match[definition.captureGroup]
      : match.groups?.[definition.captureGroup];
    if (captured === undefined) return { ...base, value: null, state: "invalid-rule" };
    const captureOffset = match[0].indexOf(captured);
    const start = match.index + Math.max(0, captureOffset);
    values.push({
      value: captured.slice(0, MAX_METADATA_VALUE_CHARS),
      start,
      end: start + captured.length,
      excerpt: targetText.slice(0, MAX_METADATA_VALUE_CHARS),
    });
    if (values.length > 20) break;
  }
  if (!values.length) return { ...base, value: null, state: "missing" };
  const unique = [...new Set(values.map((item) => item.value))];
  if (unique.length !== 1) return { ...base, value: null, state: "ambiguous" };
  const chosen = values[0];
  return {
    ...base,
    value: chosen.value,
    state: "extracted",
    provenance: {
      target: definition.target,
      columnStart: chosen.start + 1,
      columnEnd: chosen.end + 1,
      excerpt: chosen.excerpt,
    },
  };
}

export function precomputedEvidenceFromInspection(
  source: ArtifactEvidenceSourceResult,
  rules: readonly RecipeRule[],
  plan?: RecipeEvidencePlan,
): PrecomputedDocumentEvidence {
  const evidenceBySpec = new Map(source.evidence.map((item) => [item.specId, item]));
  return {
    sourceId: source.sourceId,
    rules: rules.map((rule) => ({
      ruleId: rule.id,
      ...(source.error ? { error: source.error } : {}),
      clauses: rule.clauses.map((clause) => {
        const specId = plan?.specIdByClause[clausePlanKey(rule.id, clause.id)] ?? clause.id;
        const evidence = evidenceBySpec.get(specId);
        if (!evidence) return { clauseId: clause.id, error: "근거를 찾을 수 없습니다." };
        return {
          clauseId: clause.id,
          ...(evidence.occurrenceCount === undefined ? {} : { occurrenceCount: evidence.occurrenceCount }),
          ...(evidence.firstOccurrence ? { firstOccurrence: evidence.firstOccurrence } : {}),
          ...(evidence.lastOccurrence ? { lastOccurrence: evidence.lastOccurrence } : {}),
          ...(evidence.error ? { error: evidence.error } : {}),
        };
      }),
    })),
  };
}

export function buildResultTableRow(input: {
  source: ArtifactEvidenceSourceResult;
  evaluation: DocumentEvaluation;
  metadataFields: readonly MetadataFieldDefinition[];
}): ResultTableRow {
  const relativePath = safeRelativePath(input.source.relativePath);
  const unsafeSourcePath = Boolean(input.source.relativePath && !relativePath);
  const metadata = Object.fromEntries(input.metadataFields.map((definition) => [
    definition.key,
    extractMetadataValue(definition, input.source.fileName, relativePath),
  ]));
  const selected = input.evaluation.matchedRules.find((rule) => rule.ruleId === input.evaluation.selectedRuleId);
  const relevantRules = selected ? [selected] : input.evaluation.matchedRules;
  const evidence = relevantRules.flatMap((rule) => rule.clauseEvaluations.map((clause) => ({
    ruleId: rule.ruleId,
    clauseId: clause.clauseId,
    satisfied: clause.satisfied,
    occurrenceCount: clause.occurrenceCount,
    ...(clause.firstOccurrence ? { firstOccurrence: clause.firstOccurrence } : {}),
    ...(clause.lastOccurrence ? { lastOccurrence: clause.lastOccurrence } : {}),
    ...(clause.orderSatisfied === undefined ? {} : { orderSatisfied: clause.orderSatisfied }),
  })));
  const metadataNeedsReview = Object.values(metadata).some((field) =>
    field.state === "ambiguous" || field.state === "invalid-rule" || (field.required && field.state === "missing"));
  return {
    sourceId: input.source.sourceId,
    artifactId: input.source.artifactId,
    fileName: input.source.fileName,
    ...(relativePath ? { relativePath } : {}),
    metadata,
    result: input.evaluation.result,
    needsReview: input.evaluation.result === "UNKNOWN"
      || input.evaluation.exceptions.length > 0
      || metadataNeedsReview
      || unsafeSourcePath,
    ...(input.evaluation.selectedRuleId ? { selectedRuleId: input.evaluation.selectedRuleId } : {}),
    exceptionCodes: [
      ...new Set([
        ...input.evaluation.exceptions.map((item) => item.code),
        ...(unsafeSourcePath ? ["UNSAFE_SOURCE_PATH"] : []),
      ]),
    ],
    evidence,
  };
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  // Excel treats leading =, +, -, and @ as formulas, even after whitespace.
  const protectedValue = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

export function serializeResultTableCsv(
  rows: readonly ResultTableRow[],
  metadataFields: readonly MetadataFieldDefinition[],
): string {
  const header = [
    "source_id",
    "file_name",
    "relative_path",
    ...metadataFields.map((field) => field.key),
    "result",
    "needs_review",
    "selected_rule_id",
    "exception_codes",
    "evidence",
  ];
  const records = rows.map((row) => [
    row.sourceId,
    row.fileName,
    row.relativePath ?? "",
    ...metadataFields.map((field) => row.metadata[field.key]?.value ?? ""),
    row.result,
    row.needsReview,
    row.selectedRuleId ?? "",
    row.exceptionCodes.join("|"),
    JSON.stringify(row.evidence),
  ]);
  return [header, ...records].map((record) => record.map(csvCell).join(",")).join("\r\n");
}
