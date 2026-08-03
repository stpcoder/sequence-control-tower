export type ResultLabel =
  | "PASS"
  | "DIAG_FAIL"
  | "TEST_FAIL"
  | "TRAINING_FAIL"
  | "SYSTEM_HALT"
  | "SYSTEM_REBOOT"
  | "INCOMPLETE"
  | "UNKNOWN"
  | "EXCLUDED";

export const RESULT_LABELS: readonly ResultLabel[] = [
  "PASS",
  "DIAG_FAIL",
  "TEST_FAIL",
  "TRAINING_FAIL",
  "SYSTEM_HALT",
  "SYSTEM_REBOOT",
  "INCOMPLETE",
  "UNKNOWN",
  "EXCLUDED",
] as const;

export type ObservationRole = "search_history" | "decision_evidence";
export type SearchTarget = "content" | "file_name" | "path";
export type MatcherKind = "literal" | "regex";

/**
 * A search is history by default. It becomes decision evidence only through an
 * explicit engineer action; merely repeating a search never promotes it.
 */
export interface SearchObservation {
  id: string;
  sourceId: string;
  query: string;
  matcherKind: MatcherKind;
  target: SearchTarget;
  caseSensitive: boolean;
  matched: boolean;
  matchCount: number;
  role: ObservationRole;
  excerpts: string[];
}

export interface SearchObservationInput {
  sourceId: string;
  query: string;
  matcherKind?: MatcherKind;
  target?: SearchTarget;
  caseSensitive?: boolean;
  matched: boolean;
  matchCount?: number;
  role?: ObservationRole;
  excerpts?: string[];
}

export interface EngineerDecision {
  sourceId: string;
  result: ResultLabel;
  /** Prevents an inferred/LLM suggestion from being silently compiled. */
  decidedBy: "engineer";
  evidenceObservationIds: string[];
}

export type RuleScopeKind = "analysis" | "project" | "customer" | "global";

export interface RuleScope {
  kind: RuleScopeKind;
  id?: string;
}

export interface RuleClause {
  id: string;
  presence: "present" | "absent";
  matcher: {
    kind: MatcherKind;
    pattern: string;
    caseSensitive: boolean;
    target: SearchTarget;
  };
  sourceObservationId: string;
  /** Explicit engineer-authored ordering; never inferred from search history. */
  order?: { afterClauseId: string };
}

export interface RecipeRule {
  id: string;
  label: Exclude<ResultLabel, "UNKNOWN">;
  status: "candidate" | "verified";
  scope: RuleScope;
  clauses: RuleClause[];
  /** Explicit engineer-controlled precedence; confidence never breaks a semantic tie. */
  priority: number;
  /** 0..1, descriptive only. */
  confidence: number;
  /** Number of engineer-confirmed examples supporting this rule. */
  repetition: number;
  createdFromSourceIds: string[];
}

export interface CandidateRuleOptions {
  scope?: RuleScope;
  priority?: number;
  repetition?: number;
  confidence?: number;
}

export interface LogDocument {
  id: string;
  text: string;
  fileName?: string;
  path?: string;
}

export type EvaluationExceptionCode =
  | "NO_MATCH"
  | "RULE_CONFLICT"
  | "INVALID_PATTERN"
  | "LOW_CONFIDENCE"
  | "MISSING_EVIDENCE"
  | "EVIDENCE_ERROR"
  | "INVALID_RULE";

export interface EvaluationException {
  code: EvaluationExceptionCode;
  message: string;
  ruleIds: string[];
}

export interface ClauseEvaluation {
  clauseId: string;
  satisfied: boolean;
  occurrenceCount: number;
  firstOccurrence?: EvidenceOccurrence;
  lastOccurrence?: EvidenceOccurrence;
  orderSatisfied?: boolean;
  error?: string;
}

export interface EvidenceOccurrence {
  target: SearchTarget;
  lineNumber?: number;
  columnStart: number;
  columnEnd: number;
  excerpt?: string;
  excerptTruncated?: boolean;
}

export interface MatchedRuleEvaluation {
  ruleId: string;
  label: Exclude<ResultLabel, "UNKNOWN">;
  clauseEvaluations: ClauseEvaluation[];
}

export interface DocumentEvaluation {
  sourceId: string;
  result: ResultLabel;
  selectedRuleId?: string;
  matchedRules: MatchedRuleEvaluation[];
  exceptions: EvaluationException[];
}

/** Serializable result of a local/backend search for one recipe clause. */
export interface PrecomputedClauseEvidence {
  clauseId: string;
  occurrenceCount?: number;
  firstOccurrence?: EvidenceOccurrence;
  lastOccurrence?: EvidenceOccurrence;
  error?: string;
}

/** Serializable evidence collected for one rule against one source. */
export interface PrecomputedRuleEvidence {
  ruleId: string;
  clauses: PrecomputedClauseEvidence[];
  error?: string;
}

export interface PrecomputedDocumentEvidence {
  sourceId: string;
  rules: PrecomputedRuleEvidence[];
}

export interface BatchException {
  sourceId: string;
  result: ResultLabel;
  exception: EvaluationException;
}

export interface BatchSummary {
  total: number;
  decisiveCount: number;
  counts: Record<ResultLabel, number>;
  evaluations: DocumentEvaluation[];
  exceptions: BatchException[];
}

export interface QuestionCandidate {
  id: string;
  prompt: string;
  affectedSourceIds: string[];
  severity: number;
  /** 0..1: how strongly known rules disagree or the cluster remains ambiguous. */
  conflict: number;
  options: ResultLabel[];
}

export interface PrioritizedQuestion extends QuestionCandidate {
  impact: number;
}
