import type { SequenceAnalysis, SequenceDNA, SequenceFingerprint, SimilarityBreakdown } from "./types";

function jaccard<T>(left: Iterable<T>, right: Iterable<T>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / (a.size + b.size - intersection);
}

function cosine(left: Record<string, number>, right: Record<string, number>): number {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  if (!keys.size) return 1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (const key of keys) {
    const a = left[key] ?? 0;
    const b = right[key] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function approximateNumberSet(left: number[], right: number[], tolerance: number): number {
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  const matches = left.filter((value) => right.some((candidate) => Math.abs(value - candidate) <= tolerance)).length;
  return (2 * matches) / (left.length + right.length);
}

export function dnaSimilarity(left: SequenceDNA, right: SequenceDNA): number {
  const scores: Array<{ score: number; weight: number } | null> = [
    left.temperaturesC.value !== null && right.temperaturesC.value !== null
      ? {
          score: approximateNumberSet(left.temperaturesC.value, right.temperaturesC.value, 0.5),
          weight: 1.2,
        }
      : null,
    left.voltages.value !== null && right.voltages.value !== null
      ? {
          score: approximateNumberSet(
            left.voltages.value.map(({ volts }) => volts),
            right.voltages.value.map(({ volts }) => volts),
            0.005,
          ),
          weight: 1.2,
        }
      : null,
    left.ecc.status !== "unknown" && right.ecc.status !== "unknown"
      ? { score: left.ecc.value === right.ecc.value ? 1 : 0, weight: 0.8 }
      : null,
    left.clocks.value !== null && right.clocks.value !== null
      ? {
          score:
            0.35 * (left.clocks.value.mode === right.clocks.value.mode ? 1 : 0) +
            0.65 * approximateNumberSet(left.clocks.value.valuesMHz, right.clocks.value.valuesMHz, 1),
          weight: 1.1,
        }
      : null,
    left.patterns.value !== null && right.patterns.value !== null
      ? {
          score:
            0.35 * (left.patterns.value.mode === right.patterns.value.mode ? 1 : 0) +
            0.65 * jaccard(left.patterns.value.values, right.patterns.value.values),
          weight: 0.9,
        }
      : null,
    left.blockCount.value !== null && right.blockCount.value !== null
      ? {
          score:
            Math.min(left.blockCount.value, right.blockCount.value) /
            Math.max(1, left.blockCount.value, right.blockCount.value),
          weight: 0.6,
        }
      : null,
  ];
  const known = scores.filter((item): item is { score: number; weight: number } => item !== null);
  if (!known.length) return 0.5;
  return known.reduce((sum, item) => sum + item.score * item.weight, 0) / known.reduce((sum, item) => sum + item.weight, 0);
}

export function compareFingerprints(
  left: SequenceFingerprint,
  right: SequenceFingerprint,
  leftDna?: SequenceDNA,
  rightDna?: SequenceDNA,
): SimilarityBreakdown {
  const tokenJaccard = jaccard(left.tokens, right.tokens);
  const shingleJaccard = jaccard(left.shingles, right.shingles);
  const structure =
    left.structuralHash === right.structuralHash
      ? 1
      : 0.65 * jaccard(left.blockSignatures, right.blockSignatures) +
        0.35 *
          (Math.min(left.blockSignatures.length, right.blockSignatures.length) /
            Math.max(1, left.blockSignatures.length, right.blockSignatures.length));
  const commandFamilies = cosine(left.familyHistogram, right.familyHistogram);
  const dna = leftDna && rightDna ? dnaSimilarity(leftDna, rightDna) : 0.5;
  // Revision lineage often expands one baseline block into several condition
  // blocks. Command-family and DNA similarity therefore carry more weight than
  // literal three-token shingles, which correctly remain strict for near-copy search.
  const overall =
    tokenJaccard * 0.22 + shingleJaccard * 0.13 + structure * 0.15 + commandFamilies * 0.25 + dna * 0.25;
  return { overall, tokenJaccard, shingleJaccard, structure, commandFamilies, dna };
}

export function sequenceSimilarity(left: SequenceAnalysis, right: SequenceAnalysis): SimilarityBreakdown {
  return compareFingerprints(left.fingerprint, right.fingerprint, left.dna, right.dna);
}
