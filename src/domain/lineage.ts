import { sequenceSimilarity } from "./similarity";
import type {
  ParentCandidate,
  ParentRecommendationOptions,
  SequenceAnalysis,
} from "./types";

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calibratedConfidence(score: number): number {
  // Parentage is an interpretation, not a file fact. Deliberately capped below 1.
  if (score >= 0.93) return 0.92;
  if (score >= 0.84) return 0.86;
  if (score >= 0.72) return 0.76;
  if (score >= 0.6) return 0.63;
  return Math.max(0.25, score * 0.85);
}

/**
 * Suggests likely parents but never silently verifies lineage. The caller should
 * present high-value candidates for one-click engineer confirmation.
 */
export function recommendParentCandidates(
  target: SequenceAnalysis,
  candidates: SequenceAnalysis[],
  options: ParentRecommendationOptions = {},
): ParentCandidate[] {
  const targetTime = timestamp(target.parsed.source.createdAt);
  const sameProjectBoost = options.sameProjectBoost ?? 0.035;
  const minimumScore = options.minimumScore ?? 0.45;
  const scored: ParentCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.parsed.source.id === target.parsed.source.id) continue;
    // Byte-equivalent files are duplicates, not a meaningful revision edge.
    if (candidate.fingerprint.exactHash === target.fingerprint.exactHash) continue;
    const candidateTime = timestamp(candidate.parsed.source.createdAt);
    const warnings: string[] = [];
    if (options.requireEarlierTimestamp && targetTime !== null && candidateTime !== null && candidateTime > targetTime) continue;

    const similarity = sequenceSimilarity(candidate, target);
    let score = similarity.overall;
    const reasons: string[] = [];
    if (similarity.structure >= 0.8) reasons.push(`Block 구조 ${Math.round(similarity.structure * 100)}% 유사`);
    if (similarity.commandFamilies >= 0.9) reasons.push("동일한 Command 계열 구성");
    if (similarity.dna >= 0.75) reasons.push("평가 조건이 같은 계열");
    if (similarity.shingleJaccard >= 0.65) reasons.push("명령 흐름의 대부분이 일치");

    const sameProject =
      Boolean(target.parsed.source.projectId) &&
      target.parsed.source.projectId === candidate.parsed.source.projectId;
    if (sameProject) {
      score += sameProjectBoost;
      reasons.push("동일 프로젝트");
    }
    if (targetTime !== null && candidateTime !== null) {
      if (candidateTime <= targetTime) {
        score += 0.015;
        reasons.push("대상 Sequence보다 먼저 생성됨");
      } else {
        score -= 0.08;
        warnings.push("후보 파일 생성 시각이 대상보다 늦습니다.");
      }
    } else {
      warnings.push("생성 시각이 없어 선후 관계를 검증할 수 없습니다.");
    }
    score = Math.max(0, Math.min(1, score));
    if (score < minimumScore) continue;
    scored.push({
      sourceId: candidate.parsed.source.id,
      filename: candidate.parsed.source.filename,
      score,
      confidence: calibratedConfidence(score),
      similarity,
      reasons: reasons.length ? reasons : ["일부 명령 및 구조가 유사"],
      warnings,
      provenance: [
        {
          kind: "heuristic",
          sourceId: target.parsed.source.id,
          rule: "lineage-similarity-v1",
          note: `${candidate.parsed.source.filename}과의 구조·조건·명령 유사도`,
        },
      ],
      requiresConfirmation: true,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const limited = scored.slice(0, options.limit ?? 5);
  if (limited.length > 1 && limited[0].score - limited[1].score < 0.06) {
    limited[0].warnings.push("상위 두 후보의 점수가 비슷해 엔지니어 확인이 필요합니다.");
    limited[0].confidence = Math.max(0.25, limited[0].confidence - 0.1);
  }
  return limited;
}
