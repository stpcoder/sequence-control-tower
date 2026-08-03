import { evaluateDocument, isDecisiveResult, type EvaluateOptions } from "./engine";
import type {
  BatchSummary,
  DocumentEvaluation,
  LogDocument,
  PrioritizedQuestion,
  QuestionCandidate,
  RecipeRule,
  ResultLabel,
} from "./types";

const labels: readonly ResultLabel[] = [
  "PASS",
  "DIAG_FAIL",
  "TEST_FAIL",
  "TRAINING_FAIL",
  "SYSTEM_HALT",
  "SYSTEM_REBOOT",
  "INCOMPLETE",
  "UNKNOWN",
  "EXCLUDED",
];

function emptyCounts(): Record<ResultLabel, number> {
  return Object.fromEntries(labels.map((label) => [label, 0])) as Record<ResultLabel, number>;
}

export function aggregateBatchResults(evaluations: readonly DocumentEvaluation[]): BatchSummary {
  const counts = emptyCounts();
  for (const evaluation of evaluations) counts[evaluation.result] += 1;

  return {
    total: evaluations.length,
    decisiveCount: evaluations.filter((evaluation) => isDecisiveResult(evaluation.result)).length,
    counts,
    evaluations: [...evaluations],
    exceptions: evaluations.flatMap((evaluation) =>
      evaluation.exceptions.map((exception) => ({
        sourceId: evaluation.sourceId,
        result: evaluation.result,
        exception,
      })),
    ),
  };
}

export function evaluateBatch(
  documents: readonly LogDocument[],
  rules: readonly RecipeRule[],
  options: EvaluateOptions = {},
): BatchSummary {
  return aggregateBatchResults(documents.map((document) => evaluateDocument(document, rules, options)));
}

function normalizedQuestion(question: QuestionCandidate): PrioritizedQuestion {
  const affectedSourceIds = [...new Set(question.affectedSourceIds)];
  const severity = Math.min(5, Math.max(0, question.severity));
  const conflict = Math.min(1, Math.max(0, question.conflict));
  return {
    ...question,
    affectedSourceIds,
    severity,
    conflict,
    options: [...new Set(question.options)],
    impact: affectedSourceIds.length * severity * conflict,
  };
}

/**
 * Returns at most three cluster-level questions. A caller cannot accidentally
 * turn this into one prompt per file by requesting a higher limit.
 */
export function limitQuestionsByImpact(
  questions: readonly QuestionCandidate[],
  requestedLimit = 3,
): PrioritizedQuestion[] {
  const limit = Math.min(3, Math.max(0, Math.floor(requestedLimit)));
  const byId = new Map<string, PrioritizedQuestion>();

  for (const question of questions) {
    const normalized = normalizedQuestion(question);
    const existing = byId.get(normalized.id);
    if (!existing || normalized.impact > existing.impact) byId.set(normalized.id, normalized);
  }

  return [...byId.values()]
    .sort((left, right) => right.impact - left.impact || left.id.localeCompare(right.id))
    .slice(0, limit);
}
