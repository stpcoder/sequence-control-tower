import type { SearchObservation, SearchObservationInput } from "./types";

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeQuery(query: string): string {
  return query.trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function observationIdentity(input: SearchObservationInput): string {
  const query = normalizeQuery(input.query);
  return [
    input.sourceId,
    input.target ?? "content",
    input.matcherKind ?? "literal",
    input.caseSensitive ?? false,
    query,
  ].join("\u001f");
}

export function createObservation(input: SearchObservationInput): SearchObservation {
  const query = normalizeQuery(input.query);
  if (!query) {
    throw new Error("Search query must not be empty.");
  }

  const matchCount = Math.max(0, Math.floor(input.matchCount ?? (input.matched ? 1 : 0)));
  return {
    id: `obs-${stableHash(observationIdentity({ ...input, query }))}`,
    sourceId: input.sourceId,
    query,
    matcherKind: input.matcherKind ?? "literal",
    target: input.target ?? "content",
    caseSensitive: input.caseSensitive ?? false,
    matched: input.matched,
    matchCount,
    role: input.role ?? "search_history",
    excerpts: uniqueStrings(input.excerpts ?? []),
  };
}

/**
 * Records a search without promoting it implicitly. If the same search is
 * explicitly recorded later as decision evidence, that deliberate role wins.
 */
export function recordObservation(
  observations: readonly SearchObservation[],
  input: SearchObservationInput,
): SearchObservation[] {
  const next = createObservation(input);
  const existingIndex = observations.findIndex((observation) => observation.id === next.id);

  if (existingIndex < 0) {
    return [...observations, next];
  }

  const existing = observations[existingIndex];
  const merged: SearchObservation = {
    ...existing,
    matched: next.matched,
    matchCount: next.matchCount,
    role:
      existing.role === "decision_evidence" || next.role === "decision_evidence"
        ? "decision_evidence"
        : "search_history",
    excerpts: uniqueStrings([...existing.excerpts, ...next.excerpts]),
  };

  return observations.map((observation, index) => (index === existingIndex ? merged : observation));
}

export function selectDecisionEvidence(
  observations: readonly SearchObservation[],
  observationIds: readonly string[],
): SearchObservation[] {
  const selected = new Set(observationIds);
  return observations.map((observation) =>
    selected.has(observation.id) ? { ...observation, role: "decision_evidence" } : observation,
  );
}
