export type KnowledgeStatus = "extracted" | "inferred" | "verified" | "unknown";

export type ProvenanceKind =
  | "source"
  | "filename"
  | "user-comment"
  | "heuristic"
  | "normalization"
  | "derived"
  | "user-verified";

export interface SourceRange {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface Provenance {
  kind: ProvenanceKind;
  sourceId: string;
  range?: SourceRange;
  excerpt?: string;
  rule?: string;
  note?: string;
}

/**
 * A value in the knowledge base is never silently presented as fact.
 * `status`, `confidence`, and `provenance` travel with it all the way to the UI.
 */
export interface EvidenceValue<T> {
  value: T | null;
  status: KnowledgeStatus;
  /** 0..1. Extracted values can still have less than 1 confidence when syntax is ambiguous. */
  confidence: number;
  provenance: Provenance[];
}

export interface SequenceSource {
  id: string;
  filename: string;
  content: string;
  userComment?: string;
  projectId?: string;
  createdAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ParseWarning {
  code: "UNTERMINATED_COMMAND" | "EMPTY_HEADER" | "UNRECOGNIZED_LINE";
  message: string;
  range: SourceRange;
}

export interface SequenceCommand {
  id: string;
  index: number;
  raw: string;
  text: string;
  terminated: boolean;
  range: SourceRange;
}

export interface LooseText {
  text: string;
  range: SourceRange;
  reason: "comment" | "preamble" | "unrecognized";
}

export interface SequenceBlock {
  id: string;
  index: number;
  header: string;
  rawHeader: string;
  synthetic: boolean;
  range: SourceRange;
  commands: SequenceCommand[];
  notes: LooseText[];
}

export interface ParsedSequence {
  source: SequenceSource;
  blocks: SequenceBlock[];
  looseText: LooseText[];
  warnings: ParseWarning[];
  stats: {
    lineCount: number;
    blockCount: number;
    commandCount: number;
    terminatedCommandCount: number;
  };
}

export interface VoltageSetting {
  rail: string;
  volts: number;
  original: string;
}

export type EccMode = "enabled" | "disabled" | "mixed" | "unknown";
export type ClockMode = "fixed" | "sweep" | "mixed" | "unknown";

export interface ClockSetting {
  mode: ClockMode;
  valuesMHz: number[];
  rawValues: string[];
}

export interface PatternSetting {
  mode: "full" | "selected" | "mixed" | "unknown";
  values: string[];
}

export interface CommandFamily {
  family: string;
  executable: string;
  count: number;
}

export interface ExtractedCondition {
  key: string;
  value: string;
  normalizedKey: string;
}

export interface SequenceDNA {
  conditions: EvidenceValue<ExtractedCondition[]>;
  temperaturesC: EvidenceValue<number[]>;
  voltages: EvidenceValue<VoltageSetting[]>;
  ecc: EvidenceValue<EccMode>;
  clocks: EvidenceValue<ClockSetting>;
  patterns: EvidenceValue<PatternSetting>;
  blockCount: EvidenceValue<number>;
  commandCount: EvidenceValue<number>;
  commandFamilies: EvidenceValue<CommandFamily[]>;
}

export interface TokenReplacement {
  kind:
    | "timestamp"
    | "date"
    | "duration"
    | "uuid"
    | "hex-address"
    | "process-id"
    | "thread-id"
    | "custom";
  original: string;
  replacement: string;
  start: number;
  end: number;
  ruleId: string;
}

export interface NormalizationRule {
  id: string;
  kind: TokenReplacement["kind"];
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

export interface NormalizationOptions {
  customRules?: NormalizationRule[];
  lowercase?: boolean;
  collapseWhitespace?: boolean;
  preserveLineBreaks?: boolean;
}

export interface NormalizationResult {
  text: string;
  replacements: TokenReplacement[];
}

export interface SequenceFingerprint {
  sourceId: string;
  exactHash: string;
  structuralHash: string;
  normalizedText: string;
  tokens: string[];
  shingles: string[];
  blockSignatures: string[];
  familyHistogram: Record<string, number>;
}

export interface SimilarityBreakdown {
  overall: number;
  tokenJaccard: number;
  shingleJaccard: number;
  structure: number;
  commandFamilies: number;
  dna: number;
}

export interface DnaChange {
  field: keyof SequenceDNA;
  kind: "added" | "removed" | "changed" | "unchanged";
  before: unknown;
  after: unknown;
  significance: "critical" | "high" | "medium" | "low" | "none";
  explanation: string;
}

export interface CommandChange {
  kind: "added" | "removed" | "changed" | "unchanged";
  before?: SequenceCommand;
  after?: SequenceCommand;
  normalizedBefore?: string;
  normalizedAfter?: string;
}

export interface BlockChange {
  kind: "added" | "removed" | "changed" | "unchanged";
  before?: SequenceBlock;
  after?: SequenceBlock;
  similarity: number;
  commandChanges: CommandChange[];
  important: boolean;
}

export interface SemanticDiff {
  baseSourceId: string;
  targetSourceId: string;
  summary: string;
  dnaChanges: DnaChange[];
  blockChanges: BlockChange[];
  statistics: {
    blocksAdded: number;
    blocksRemoved: number;
    blocksChanged: number;
    commandsAdded: number;
    commandsRemoved: number;
    commandsChanged: number;
  };
}

export interface SequenceAnalysis {
  parsed: ParsedSequence;
  dna: SequenceDNA;
  fingerprint: SequenceFingerprint;
  completeness: number;
  clarificationQuestions: ClarificationQuestion[];
}

export interface ClarificationQuestion {
  id: string;
  priority: "high" | "medium" | "low";
  question: string;
  reason: string;
  relatedFields: Array<keyof SequenceDNA | "purpose" | "parent">;
  choices?: Array<{ id: string; label: string }>;
}

export interface ParentCandidate {
  sourceId: string;
  filename: string;
  score: number;
  confidence: number;
  similarity: SimilarityBreakdown;
  reasons: string[];
  warnings: string[];
  provenance: Provenance[];
  requiresConfirmation: boolean;
}

export interface ParentRecommendationOptions {
  limit?: number;
  minimumScore?: number;
  requireEarlierTimestamp?: boolean;
  sameProjectBoost?: number;
}
