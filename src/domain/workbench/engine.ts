import type {
  CandidateRuleOptions,
  ClauseEvaluation,
  DocumentEvaluation,
  EngineerDecision,
  EvidenceOccurrence,
  EvaluationException,
  LogDocument,
  MatchedRuleEvaluation,
  PrecomputedDocumentEvidence,
  RecipeRule,
  ResultLabel,
  RuleClause,
  SearchObservation,
  SearchTarget,
} from "./types";

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function defaultConfidence(evidenceCount: number, repetition: number): number {
  // This reports support strength only; it never decides between conflicting semantics.
  return clamp(0.45 + Math.min(evidenceCount, 5) * 0.06 + Math.min(repetition - 1, 5) * 0.04, 0, 0.91);
}

function buildClause(observation: SearchObservation, index: number): RuleClause {
  return {
    id: `clause-${index + 1}-${stableHash(observation.id)}`,
    presence: observation.matched ? "present" : "absent",
    matcher: {
      kind: observation.matcherKind,
      pattern: observation.query,
      caseSensitive: observation.caseSensitive,
      target: observation.target,
    },
    sourceObservationId: observation.id,
  };
}

/**
 * Compiles only an explicit engineer decision and its explicitly selected
 * evidence. UNKNOWN cannot become a semantic rule.
 */
export function buildCandidateRule(
  decision: EngineerDecision | null | undefined,
  observations: readonly SearchObservation[],
  options: CandidateRuleOptions = {},
): RecipeRule | null {
  if (!decision || decision.decidedBy !== "engineer" || decision.result === "UNKNOWN") {
    return null;
  }

  const selectedIds = new Set(decision.evidenceObservationIds);
  const evidence = observations.filter(
    (observation) =>
      observation.sourceId === decision.sourceId &&
      observation.role === "decision_evidence" &&
      selectedIds.has(observation.id),
  );

  if (evidence.length === 0) {
    return null;
  }

  const repetition = Math.max(1, Math.floor(options.repetition ?? 1));
  const clauses = evidence.map(buildClause);
  const identity = JSON.stringify({ result: decision.result, clauses, scope: options.scope });

  return {
    id: `rule-${stableHash(identity)}`,
    label: decision.result,
    status: "candidate",
    scope: options.scope ?? { kind: "analysis" },
    clauses,
    priority: Math.floor(options.priority ?? 0),
    confidence: clamp(options.confidence ?? defaultConfidence(evidence.length, repetition), 0, 1),
    repetition,
    createdFromSourceIds: [decision.sourceId],
  };
}

function targetText(document: LogDocument, target: SearchTarget): string {
  if (target === "file_name") return document.fileName ?? "";
  if (target === "path") return document.path ?? "";
  return document.text;
}

function matchLiteral(haystack: string, needle: string, caseSensitive: boolean): {
  count: number;
  firstIndex?: number;
  lastIndex?: number;
} {
  const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const query = caseSensitive ? needle : needle.toLocaleLowerCase();
  if (!query) return { count: 0 };

  let count = 0;
  let offset = 0;
  let firstIndex: number | undefined;
  let lastIndex: number | undefined;
  while (offset <= source.length - query.length) {
    const foundAt = source.indexOf(query, offset);
    if (foundAt < 0) break;
    count += 1;
    firstIndex ??= foundAt;
    lastIndex = foundAt;
    offset = foundAt + Math.max(query.length, 1);
  }
  return { count, firstIndex, lastIndex };
}

function occurrenceAt(
  target: SearchTarget,
  text: string,
  start: number,
  end: number,
): EvidenceOccurrence {
  const lineStart = target === "content" ? text.lastIndexOf("\n", Math.max(0, start - 1)) + 1 : 0;
  const lineEndCandidate = target === "content" ? text.indexOf("\n", end) : -1;
  const lineEnd = lineEndCandidate < 0 ? text.length : lineEndCandidate;
  const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
  const maximum = 320;
  const localAnchor = Math.max(0, start - lineStart);
  const excerptStart = Math.max(0, Math.min(localAnchor - Math.floor(maximum / 2), line.length - maximum));
  const excerptEnd = Math.min(line.length, excerptStart + maximum);
  const lineNumber = target === "content"
    ? text.slice(0, lineStart).split("\n").length
    : undefined;
  return {
    target,
    ...(lineNumber === undefined ? {} : { lineNumber }),
    columnStart: start - lineStart + 1,
    columnEnd: end - lineStart + 1,
    excerpt: `${excerptStart > 0 ? "…" : ""}${line.slice(excerptStart, excerptEnd)}${excerptEnd < line.length ? "…" : ""}`,
    excerptTruncated: excerptStart > 0 || excerptEnd < line.length,
  };
}

function evaluateClause(document: LogDocument, clause: RuleClause): ClauseEvaluation {
  const value = targetText(document, clause.matcher.target);
  let occurrenceCount = 0;
  let firstIndex: number | undefined;
  let lastIndex: number | undefined;
  let firstMatchedLength = 0;
  let lastMatchedLength = 0;

  try {
    if (clause.matcher.kind === "literal") {
      const matches = matchLiteral(value, clause.matcher.pattern, clause.matcher.caseSensitive);
      occurrenceCount = matches.count;
      firstIndex = matches.firstIndex;
      lastIndex = matches.lastIndex;
      firstMatchedLength = clause.matcher.pattern.length;
      lastMatchedLength = clause.matcher.pattern.length;
    } else {
      const flags = clause.matcher.caseSensitive ? "g" : "gi";
      const matches = [...value.matchAll(new RegExp(clause.matcher.pattern, flags))];
      occurrenceCount = matches.length;
      firstIndex = matches[0]?.index;
      lastIndex = matches.at(-1)?.index;
      firstMatchedLength = matches[0]?.[0].length ?? 0;
      lastMatchedLength = matches.at(-1)?.[0].length ?? 0;
    }
  } catch (error) {
    return {
      clauseId: clause.id,
      satisfied: false,
      occurrenceCount: 0,
      error: error instanceof Error ? error.message : "Invalid matcher",
    };
  }

  const isPresent = occurrenceCount > 0;
  return {
    clauseId: clause.id,
    satisfied: clause.presence === "present" ? isPresent : !isPresent,
    occurrenceCount,
    ...(firstIndex === undefined ? {} : {
      firstOccurrence: occurrenceAt(
        clause.matcher.target,
        value,
        firstIndex,
        firstIndex + firstMatchedLength,
      ),
    }),
    ...(lastIndex === undefined ? {} : {
      lastOccurrence: occurrenceAt(clause.matcher.target, value, lastIndex, lastIndex + lastMatchedLength),
    }),
  };
}

/**
 * Produces the same bounded clause evidence shape as the main-process stream
 * inspector for in-memory/demo logs. Keeping this separate from evaluation
 * lets the fail-closed precomputed path handle both sources identically.
 */
export function precomputeDocumentEvidence(
  document: LogDocument,
  rules: readonly RecipeRule[],
): PrecomputedDocumentEvidence {
  return {
    sourceId: document.id,
    rules: rules.map((rule) => ({
      ruleId: rule.id,
      clauses: rule.clauses.map((clause) => {
        const evaluated = evaluateClause(document, clause);
        return {
          clauseId: clause.id,
          occurrenceCount: evaluated.occurrenceCount,
          ...(evaluated.firstOccurrence ? { firstOccurrence: evaluated.firstOccurrence } : {}),
          ...(evaluated.lastOccurrence ? { lastOccurrence: evaluated.lastOccurrence } : {}),
          ...(evaluated.error ? { error: evaluated.error } : {}),
        };
      }),
    })),
  };
}

function ruleOrderingError(rule: RecipeRule): string | null {
  const clauses = new Map<string, RuleClause>();
  for (const clause of rule.clauses) {
    if (clauses.has(clause.id)) return `Rule ${rule.id} has duplicate clause ids.`;
    clauses.set(clause.id, clause);
  }
  for (const clause of rule.clauses) {
    const afterId = clause.order?.afterClauseId;
    if (!afterId) continue;
    const reference = clauses.get(afterId);
    if (!reference || reference.id === clause.id) return `Rule ${rule.id} has an invalid order reference.`;
    if (clause.presence !== "present" || reference.presence !== "present") {
      return `Rule ${rule.id} applies ordering to an absence clause.`;
    }
    if (clause.matcher.target !== "content" || reference.matcher.target !== "content") {
      return `Rule ${rule.id} applies ordering outside log content.`;
    }
    const seen = new Set([clause.id]);
    let cursor: RuleClause | undefined = reference;
    while (cursor?.order?.afterClauseId) {
      if (seen.has(cursor.id)) return `Rule ${rule.id} contains a cyclic order.`;
      seen.add(cursor.id);
      cursor = clauses.get(cursor.order.afterClauseId);
    }
  }
  return null;
}

function occurrencePosition(occurrence: EvidenceOccurrence): readonly [number, number] | null {
  if (!Number.isSafeInteger(occurrence.lineNumber) || (occurrence.lineNumber ?? 0) < 1) return null;
  if (!Number.isSafeInteger(occurrence.columnStart) || occurrence.columnStart < 1) return null;
  return [occurrence.lineNumber!, occurrence.columnStart];
}

function applyClauseOrdering(rule: RecipeRule, evaluations: ClauseEvaluation[]): boolean {
  const byId = new Map(evaluations.map((item) => [item.clauseId, item]));
  let complete = true;
  for (const clause of rule.clauses) {
    const afterId = clause.order?.afterClauseId;
    if (!afterId) continue;
    const evaluation = byId.get(clause.id)!;
    const reference = byId.get(afterId)!;
    const currentPosition = evaluation.lastOccurrence && occurrencePosition(evaluation.lastOccurrence);
    const referencePosition = reference.firstOccurrence && occurrencePosition(reference.firstOccurrence);
    if (!currentPosition || !referencePosition) {
      evaluation.satisfied = false;
      evaluation.orderSatisfied = false;
      if (evaluation.occurrenceCount > 0 && !currentPosition) complete = false;
      if (reference.occurrenceCount > 0 && !referencePosition) complete = false;
      continue;
    }
    const after = currentPosition[0] > referencePosition[0]
      || (currentPosition[0] === referencePosition[0] && currentPosition[1] > referencePosition[1]);
    evaluation.orderSatisfied = after;
    evaluation.satisfied = evaluation.satisfied && reference.satisfied && after;
  }
  return complete;
}

const scopePrecedence = {
  global: 0,
  customer: 1,
  project: 2,
  analysis: 3,
} as const;

function precedence(rule: RecipeRule): readonly [number, number, number] {
  return [rule.status === "verified" ? 1 : 0, rule.priority, scopePrecedence[rule.scope.kind]];
}

function comparePrecedence(left: RecipeRule, right: RecipeRule): number {
  const leftValue = precedence(left);
  const rightValue = precedence(right);
  for (let index = 0; index < leftValue.length; index += 1) {
    if (leftValue[index] !== rightValue[index]) return rightValue[index] - leftValue[index];
  }
  return left.id.localeCompare(right.id);
}

function samePrecedence(left: RecipeRule, right: RecipeRule): boolean {
  return precedence(left).every((value, index) => value === precedence(right)[index]);
}

export interface EvaluateOptions {
  minimumConfidence?: number;
}

function resolveMatchedRules(
  sourceId: string,
  rules: readonly RecipeRule[],
  matchedRules: MatchedRuleEvaluation[],
  exceptions: EvaluationException[],
  options: EvaluateOptions,
): DocumentEvaluation {
  const ruleLookup = new Map(rules.map((rule) => [rule.id, rule]));

  if (matchedRules.length === 0) {
    exceptions.push({
      code: "NO_MATCH",
      message: "No deterministic rule matched this log.",
      ruleIds: [],
    });
    return { sourceId, result: "UNKNOWN", matchedRules, exceptions };
  }

  const ordered = [...matchedRules].sort((left, right) =>
    comparePrecedence(ruleLookup.get(left.ruleId)!, ruleLookup.get(right.ruleId)!),
  );
  const winningRule = ruleLookup.get(ordered[0].ruleId)!;
  const topTier = ordered.filter((match) => samePrecedence(winningRule, ruleLookup.get(match.ruleId)!));
  const topLabels = new Set(topTier.map((match) => match.label));

  if (topLabels.size > 1) {
    exceptions.push({
      code: "RULE_CONFLICT",
      message: "Equally authoritative rules produced different results.",
      ruleIds: topTier.map((match) => match.ruleId),
    });
    return { sourceId, result: "UNKNOWN", matchedRules: ordered, exceptions };
  }

  const minimumConfidence = clamp(options.minimumConfidence ?? 0, 0, 1);
  if (winningRule.confidence < minimumConfidence) {
    exceptions.push({
      code: "LOW_CONFIDENCE",
      message: `Winning rule confidence ${winningRule.confidence.toFixed(2)} is below ${minimumConfidence.toFixed(2)}.`,
      ruleIds: [winningRule.id],
    });
    return { sourceId, result: "UNKNOWN", matchedRules: ordered, exceptions };
  }

  return {
    sourceId,
    result: winningRule.label,
    selectedRuleId: winningRule.id,
    matchedRules: ordered,
    exceptions,
  };
}

export function evaluateDocument(
  document: LogDocument,
  rules: readonly RecipeRule[],
  options: EvaluateOptions = {},
): DocumentEvaluation {
  const exceptions: EvaluationException[] = [];
  const matchedRules = rules.flatMap((rule) => {
    const orderError = ruleOrderingError(rule);
    if (orderError) {
      exceptions.push({ code: "INVALID_RULE", message: orderError, ruleIds: [rule.id] });
      return [];
    }
    const clauseEvaluations = rule.clauses.map((clause) => evaluateClause(document, clause));
    const invalid = clauseEvaluations.filter((clause) => clause.error);
    if (invalid.length > 0) {
      exceptions.push({
        code: "INVALID_PATTERN",
        message: `Rule ${rule.id} contains an invalid pattern.`,
        ruleIds: [rule.id],
      });
      return [];
    }
    applyClauseOrdering(rule, clauseEvaluations);
    return clauseEvaluations.every((clause) => clause.satisfied)
      ? [{ ruleId: rule.id, label: rule.label, clauseEvaluations }]
      : [];
  });
  return resolveMatchedRules(document.id, rules, matchedRules, exceptions, options);
}

/**
 * Evaluates occurrence counts produced by local search without receiving raw
 * log text. Missing, duplicate, malformed, or failed evidence fails closed.
 */
export function evaluatePrecomputedEvidence(
  evidence: PrecomputedDocumentEvidence,
  rules: readonly RecipeRule[],
  options: EvaluateOptions = {},
): DocumentEvaluation {
  const exceptions: EvaluationException[] = [];
  const matchedRules: MatchedRuleEvaluation[] = [];
  const evidenceByRule = new Map<string, PrecomputedDocumentEvidence["rules"][number]>();
  const duplicateRuleIds = new Set<string>();

  for (const item of evidence.rules) {
    if (evidenceByRule.has(item.ruleId)) duplicateRuleIds.add(item.ruleId);
    else evidenceByRule.set(item.ruleId, item);
  }

  for (const rule of rules) {
    const orderError = ruleOrderingError(rule);
    if (orderError) {
      exceptions.push({ code: "INVALID_RULE", message: orderError, ruleIds: [rule.id] });
      continue;
    }
    const ruleEvidence = evidenceByRule.get(rule.id);
    if (!ruleEvidence || duplicateRuleIds.has(rule.id)) {
      exceptions.push({
        code: "MISSING_EVIDENCE",
        message: duplicateRuleIds.has(rule.id)
          ? `Rule ${rule.id} has duplicate evidence records.`
          : `Rule ${rule.id} has no precomputed evidence.`,
        ruleIds: [rule.id],
      });
      continue;
    }
    if (ruleEvidence.error) {
      exceptions.push({
        code: "EVIDENCE_ERROR",
        message: `Rule ${rule.id} search failed: ${ruleEvidence.error}`,
        ruleIds: [rule.id],
      });
      continue;
    }

    const clausesById = new Map<string, PrecomputedDocumentEvidence["rules"][number]["clauses"][number]>();
    const duplicateClauseIds = new Set<string>();
    for (const item of ruleEvidence.clauses) {
      if (clausesById.has(item.clauseId)) duplicateClauseIds.add(item.clauseId);
      else clausesById.set(item.clauseId, item);
    }

    const clauseEvaluations: ClauseEvaluation[] = [];
    let complete = true;
    for (const clause of rule.clauses) {
      const clauseEvidence = clausesById.get(clause.id);
      if (!clauseEvidence || duplicateClauseIds.has(clause.id)) {
        complete = false;
        exceptions.push({
          code: "MISSING_EVIDENCE",
          message: duplicateClauseIds.has(clause.id)
            ? `Clause ${clause.id} has duplicate evidence records.`
            : `Clause ${clause.id} has no precomputed evidence.`,
          ruleIds: [rule.id],
        });
        continue;
      }
      if (clauseEvidence.error) {
        complete = false;
        exceptions.push({
          code: "EVIDENCE_ERROR",
          message: `Clause ${clause.id} search failed: ${clauseEvidence.error}`,
          ruleIds: [rule.id],
        });
        continue;
      }
      const occurrenceCount = clauseEvidence.occurrenceCount;
      if (typeof occurrenceCount !== "number" || !Number.isSafeInteger(occurrenceCount) || occurrenceCount < 0) {
        complete = false;
        exceptions.push({
          code: "MISSING_EVIDENCE",
          message: `Clause ${clause.id} has no valid occurrence count.`,
          ruleIds: [rule.id],
        });
        continue;
      }
      const present = occurrenceCount > 0;
      clauseEvaluations.push({
        clauseId: clause.id,
        occurrenceCount,
        satisfied: clause.presence === "present" ? present : !present,
        ...(clauseEvidence.firstOccurrence ? { firstOccurrence: clauseEvidence.firstOccurrence } : {}),
        ...(clauseEvidence.lastOccurrence ? { lastOccurrence: clauseEvidence.lastOccurrence } : {}),
      });
    }

    if (complete && !applyClauseOrdering(rule, clauseEvaluations)) {
      exceptions.push({
        code: "MISSING_EVIDENCE",
        message: `Rule ${rule.id} has no valid occurrence provenance for ordered clauses.`,
        ruleIds: [rule.id],
      });
      complete = false;
    }

    if (complete && clauseEvaluations.every((clause) => clause.satisfied)) {
      matchedRules.push({ ruleId: rule.id, label: rule.label, clauseEvaluations });
    }
  }

  if (exceptions.some((exception) => exception.code === "MISSING_EVIDENCE" || exception.code === "EVIDENCE_ERROR")) {
    return { sourceId: evidence.sourceId, result: "UNKNOWN", matchedRules, exceptions };
  }
  return resolveMatchedRules(evidence.sourceId, rules, matchedRules, exceptions, options);
}

export function evaluateText(
  text: string,
  rules: readonly RecipeRule[],
  options: EvaluateOptions = {},
): DocumentEvaluation {
  return evaluateDocument({ id: "text", text }, rules, options);
}

export function isDecisiveResult(result: ResultLabel): boolean {
  return result !== "UNKNOWN";
}
