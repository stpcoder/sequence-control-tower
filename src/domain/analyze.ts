import { extractSequenceDNA } from "./dna";
import { fingerprintSequence } from "./fingerprint";
import { parseSequence } from "./parser";
import type { ClarificationQuestion, SequenceAnalysis, SequenceDNA, SequenceSource } from "./types";

const CORE_FIELDS: Array<keyof SequenceDNA> = ["temperaturesC", "voltages", "ecc", "clocks", "patterns"];

export interface AnalyzeOptions {
  maxQuestions?: number;
  askPurposeWhenMissing?: boolean;
}

export function buildClarificationQuestions(
  source: SequenceSource,
  dna: SequenceDNA,
  options: AnalyzeOptions = {},
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  if (options.askPurposeWhenMissing !== false && !source.userComment?.trim()) {
    questions.push({
      id: `${source.id}:purpose`,
      priority: "high",
      question: "이 Sequence를 만든 직접적인 평가 목적은 무엇인가요?",
      reason: "파일에서 조건은 추출할 수 있지만, 왜 이 조합을 선택했는지는 확인할 수 없습니다.",
      relatedFields: ["purpose"],
    });
  }

  if (dna.ecc.value === "mixed") {
    questions.push({
      id: `${source.id}:ecc-mixed`,
      priority: "high",
      question: "ECC Enable과 Disable 명령이 모두 있습니다. 의도한 비교 평가인가요?",
      reason: "한 Sequence 안에서 상충되는 ECC 설정을 발견했습니다.",
      relatedFields: ["ecc"],
      choices: [
        { id: "comparison", label: "의도한 ECC 비교" },
        { id: "override", label: "뒤 명령이 최종 설정" },
        { id: "mistake", label: "Sequence 작성 오류" },
      ],
    });
  }

  for (const field of CORE_FIELDS) {
    const value = dna[field];
    if (value.status !== "unknown" && value.confidence < 0.7) {
      questions.push({
        id: `${source.id}:${field}:confidence`,
        priority: "medium",
        question: `${field} 추출값이 실제 평가 조건과 일치하나요?`,
        reason: `파일명 또는 느슨한 텍스트에만 근거해 확신도가 ${Math.round(value.confidence * 100)}%입니다.`,
        relatedFields: [field],
      });
    }
  }

  return questions
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority])
    .slice(0, options.maxQuestions ?? 3);
}

function calculateCompleteness(dna: SequenceDNA, hasPurpose: boolean): number {
  const values = CORE_FIELDS.map((field) => (dna[field].status === "unknown" ? 0 : dna[field].confidence));
  values.push(hasPurpose ? 1 : 0);
  values.push(dna.blockCount.value !== null ? 1 : 0);
  values.push(dna.commandFamilies.value?.length ? 1 : 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeSequence(source: SequenceSource, options: AnalyzeOptions = {}): SequenceAnalysis {
  const parsed = parseSequence(source);
  const dna = extractSequenceDNA(parsed);
  return {
    parsed,
    dna,
    fingerprint: fingerprintSequence(parsed, dna),
    completeness: calculateCompleteness(dna, Boolean(source.userComment?.trim())),
    clarificationQuestions: buildClarificationQuestions(source, dna, options),
  };
}
