import type {
  EngineerDecision,
  RecipeRule,
  ResultLabel,
  RuleClause,
  RuleScope,
  SearchObservation,
} from "../domain/workbench";

export const LOG_WORKBENCH_SCHEMA_VERSION = 1 as const;
export const MAX_PERSISTED_OBSERVATIONS = 2_000;
export const MAX_PERSISTED_DECISIONS = 10_000;
export const MAX_PERSISTED_RULES = 500;
export const MAX_PERSISTED_RECIPES = 100;

const STORAGE_PREFIX = "sequence-control-tower:log-workbench:v1:";
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_QUERY_LENGTH = 512;
const MAX_NAME_LENGTH = 120;

export interface LogWorkbenchRecipeMetadata {
  id: string;
  name: string;
  revision: number;
  updatedAt?: string;
}

export interface LogWorkbenchRecipe {
  metadata: LogWorkbenchRecipeMetadata;
  rules: RecipeRule[];
}

export interface LogWorkbenchPersistedState {
  schemaVersion: typeof LOG_WORKBENCH_SCHEMA_VERSION;
  observations: SearchObservation[];
  decisions: EngineerDecision[];
  recipes: LogWorkbenchRecipe[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type LoadStatus = "empty" | "loaded" | "corrupt" | "unsupported-version";

export interface LoadLogWorkbenchResult {
  status: LoadStatus;
  state: LogWorkbenchPersistedState;
}

export interface SaveLogWorkbenchResult {
  ok: boolean;
  state: LogWorkbenchPersistedState;
  error?: string;
}

const resultLabels = new Set<ResultLabel>([
  "PASS",
  "DIAG_FAIL",
  "TEST_FAIL",
  "TRAINING_FAIL",
  "SYSTEM_HALT",
  "SYSTEM_REBOOT",
  "INCOMPLETE",
  "UNKNOWN",
  "EXCLUDED",
]);

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
  let probe = value.trim();
  // Search UI may compile a literal into ^(?:...), \b(?:...), or nested
  // non-capturing/flag groups. Remove only leading regex syntax, never data.
  for (let index = 0; index < 8; index += 1) {
    const next = probe
      .replace(/^\^/, "")
      .replace(/^\\A/, "")
      .replace(/^\\b/, "")
      .replace(/^\(\?:/, "")
      .replace(/^\(\?[dgimsuvy-]+:/i, "")
      .replace(/^\(+/, "");
    if (next === probe) break;
    probe = next;
  }
  const slashNormalized = probe.replace(/^\\\//, "/");
  return (
    /^[a-zA-Z]:(?:[\\/]|\\{2,})/.test(probe) ||
    /^\\{2,}[^\\]+\\/.test(probe) ||
    slashNormalized.startsWith("/")
  );
}

function resemblesSecret(value: string): boolean {
  return (
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value) ||
    /\bsk-[A-Za-z0-9._-]{12,}\b/i.test(value) ||
    /\b(?:api[_ -]?key|token)\s*[:=-]\s*[A-Za-z0-9._~+/=-]{12,}\b/i.test(value)
  );
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (isAbsolutePath(value) || resemblesSecret(value) || value.length > MAX_IDENTIFIER_LENGTH) {
    return `id-${stableHash(value)}`;
  }
  return value;
}

function safeSingleLine(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximumLength || /[\r\n]/.test(trimmed)) return null;
  if (isAbsolutePath(trimmed) || resemblesSecret(trimmed)) return null;
  return trimmed;
}

function safeNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(minimum, value));
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(safeIdentifier).filter((item): item is string => item !== null))];
}

function sanitizeObservation(value: unknown): SearchObservation | null {
  if (!isRecord(value)) return null;
  const id = safeIdentifier(value.id);
  const sourceId = safeIdentifier(value.sourceId);
  const query = safeSingleLine(value.query, MAX_QUERY_LENGTH);
  if (!id || !sourceId || !query) return null;
  if (value.matcherKind !== "literal" && value.matcherKind !== "regex") return null;
  if (value.target !== "content" && value.target !== "file_name" && value.target !== "path") return null;
  if (value.role !== "search_history" && value.role !== "decision_evidence") return null;
  if (typeof value.caseSensitive !== "boolean" || typeof value.matched !== "boolean") return null;
  const matchCount = safeNumber(value.matchCount, 0, Number.MAX_SAFE_INTEGER);
  if (matchCount === null) return null;

  return {
    id,
    sourceId,
    query,
    matcherKind: value.matcherKind,
    target: value.target,
    caseSensitive: value.caseSensitive,
    matched: value.matched,
    matchCount: Math.floor(matchCount),
    role: value.role,
    // Context snippets are intentionally memory-only, even when harmless-looking.
    excerpts: [],
  };
}

function sanitizeDecision(value: unknown): EngineerDecision | null {
  if (!isRecord(value)) return null;
  const sourceId = safeIdentifier(value.sourceId);
  if (!sourceId || value.decidedBy !== "engineer") return null;
  if (typeof value.result !== "string" || !resultLabels.has(value.result as ResultLabel)) return null;
  return {
    sourceId,
    result: value.result as ResultLabel,
    decidedBy: "engineer",
    evidenceObservationIds: safeStringArray(value.evidenceObservationIds),
  };
}

function sanitizeScope(value: unknown): RuleScope | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "analysis" && value.kind !== "project" && value.kind !== "customer" && value.kind !== "global") {
    return null;
  }
  const id = value.id === undefined ? undefined : safeIdentifier(value.id);
  if (value.id !== undefined && !id) return null;
  return id ? { kind: value.kind, id } : { kind: value.kind };
}

function sanitizeClause(value: unknown): RuleClause | null {
  if (!isRecord(value) || !isRecord(value.matcher)) return null;
  const id = safeIdentifier(value.id);
  const sourceObservationId = safeIdentifier(value.sourceObservationId);
  const pattern = safeSingleLine(value.matcher.pattern, MAX_QUERY_LENGTH);
  if (!id || !sourceObservationId || !pattern) return null;
  if (value.presence !== "present" && value.presence !== "absent") return null;
  if (value.matcher.kind !== "literal" && value.matcher.kind !== "regex") return null;
  if (value.matcher.target !== "content" && value.matcher.target !== "file_name" && value.matcher.target !== "path") return null;
  if (typeof value.matcher.caseSensitive !== "boolean") return null;
  const afterClauseId = value.order === undefined
    ? undefined
    : isRecord(value.order) ? safeIdentifier(value.order.afterClauseId) : null;
  if (afterClauseId === null) return null;

  return {
    id,
    presence: value.presence,
    matcher: {
      kind: value.matcher.kind,
      pattern,
      caseSensitive: value.matcher.caseSensitive,
      target: value.matcher.target,
    },
    sourceObservationId,
    ...(afterClauseId ? { order: { afterClauseId } } : {}),
  };
}

function sanitizeRule(value: unknown): RecipeRule | null {
  if (!isRecord(value)) return null;
  const id = safeIdentifier(value.id);
  const scope = sanitizeScope(value.scope);
  if (!id || !scope) return null;
  if (typeof value.label !== "string" || value.label === "UNKNOWN" || !resultLabels.has(value.label as ResultLabel)) return null;
  if (value.status !== "candidate" && value.status !== "verified") return null;
  if (!Array.isArray(value.clauses) || value.clauses.length === 0) return null;
  const clauses = value.clauses.map(sanitizeClause).filter((clause): clause is RuleClause => clause !== null);
  if (clauses.length !== value.clauses.length) return null;
  const priority = safeNumber(value.priority, -10_000, 10_000);
  const confidence = safeNumber(value.confidence, 0, 1);
  const repetition = safeNumber(value.repetition, 1, Number.MAX_SAFE_INTEGER);
  if (priority === null || confidence === null || repetition === null) return null;

  return {
    id,
    label: value.label as RecipeRule["label"],
    status: value.status,
    scope,
    clauses,
    priority: Math.floor(priority),
    confidence,
    repetition: Math.floor(repetition),
    createdFromSourceIds: safeStringArray(value.createdFromSourceIds),
  };
}

function sanitizeRecipe(value: unknown, remainingRuleCapacity: number): LogWorkbenchRecipe | null {
  if (!isRecord(value) || !isRecord(value.metadata) || !Array.isArray(value.rules)) return null;
  const id = safeIdentifier(value.metadata.id);
  const name = safeSingleLine(value.metadata.name, MAX_NAME_LENGTH);
  const revision = safeNumber(value.metadata.revision, 1, Number.MAX_SAFE_INTEGER);
  if (!id || !name || revision === null) return null;
  const updatedAt = value.metadata.updatedAt === undefined
    ? undefined
    : safeSingleLine(value.metadata.updatedAt, 64) ?? undefined;
  const rules = value.rules
    .map(sanitizeRule)
    .filter((rule): rule is RecipeRule => rule !== null)
    .slice(-remainingRuleCapacity);

  return {
    metadata: { id, name, revision: Math.floor(revision), ...(updatedAt ? { updatedAt } : {}) },
    rules,
  };
}

function dedupeById<T>(items: readonly T[], getId: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const id = getId(item);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(item);
    }
  }
  return result.reverse();
}

export function emptyLogWorkbenchState(): LogWorkbenchPersistedState {
  return { schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION, observations: [], decisions: [], recipes: [] };
}

/** Creates a non-identifying, deterministic storage key for each project. */
export function logWorkbenchStorageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${stableHash(projectId)}`;
}

export function sanitizeLogWorkbenchState(value: unknown): LogWorkbenchPersistedState {
  if (!isRecord(value)) return emptyLogWorkbenchState();

  const observations = (Array.isArray(value.observations) ? value.observations : [])
    .map(sanitizeObservation)
    .filter((item): item is SearchObservation => item !== null);
  const decisions = (Array.isArray(value.decisions) ? value.decisions : [])
    .map(sanitizeDecision)
    .filter((item): item is EngineerDecision => item !== null);

  let remainingRules = MAX_PERSISTED_RULES;
  const reversedRecipes = (Array.isArray(value.recipes) ? value.recipes : [])
    .slice(-MAX_PERSISTED_RECIPES)
    .reverse();
  const recipes: LogWorkbenchRecipe[] = [];
  for (const rawRecipe of reversedRecipes) {
    const recipe = sanitizeRecipe(rawRecipe, remainingRules);
    if (!recipe) continue;
    remainingRules -= recipe.rules.length;
    recipes.push(recipe);
    if (remainingRules === 0) break;
  }

  return {
    schemaVersion: LOG_WORKBENCH_SCHEMA_VERSION,
    observations: dedupeById(observations, (item) => item.id).slice(-MAX_PERSISTED_OBSERVATIONS),
    decisions: decisions.slice(-MAX_PERSISTED_DECISIONS),
    recipes: recipes.reverse(),
  };
}

export function saveLogWorkbenchState(
  storage: StorageLike,
  projectId: string,
  value: unknown,
): SaveLogWorkbenchResult {
  const state = sanitizeLogWorkbenchState(value);
  try {
    storage.setItem(logWorkbenchStorageKey(projectId), JSON.stringify(state));
    return { ok: true, state };
  } catch (error) {
    return { ok: false, state, error: error instanceof Error ? error.message : "Storage write failed" };
  }
}

export function loadLogWorkbenchState(storage: StorageLike, projectId: string): LoadLogWorkbenchResult {
  const raw = storage.getItem(logWorkbenchStorageKey(projectId));
  if (raw === null) return { status: "empty", state: emptyLogWorkbenchState() };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { status: "corrupt", state: emptyLogWorkbenchState() };
    if (parsed.schemaVersion !== LOG_WORKBENCH_SCHEMA_VERSION) {
      return { status: "unsupported-version", state: emptyLogWorkbenchState() };
    }
    return { status: "loaded", state: sanitizeLogWorkbenchState(parsed) };
  } catch {
    return { status: "corrupt", state: emptyLogWorkbenchState() };
  }
}
