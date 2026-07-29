import { analyzeSequence } from "./analyze";
import { semanticDiff } from "./diff";
import { recommendParentCandidates } from "./lineage";
import type { ParentCandidate, SemanticDiff, SequenceAnalysis, SequenceSource } from "./types";

export const demoSequenceSources: readonly SequenceSource[] = [
  {
    id: "seq-baseline-v1",
    filename: "QCOM_LP5_baseline_25C_v1.seq",
    projectId: "qualcomm-product-a",
    createdAt: "2026-07-01T09:00:00+09:00",
    userComment: "기본 조건에서 전체 CLK와 Pattern 동작을 확인하는 baseline",
    content: `# Baseline_25C_VDD0.99_ECC_EN_CLK_SWEEP_PATTERN_FULL
@TF set 25;
vdd2h 990;
ecc enable;
clk.sh -lf 0 1 2 3 4;
hdiag64 --pattern full;

# Collect_Result
pull result.log;
`,
  },
  {
    id: "seq-high-temp-v2",
    filename: "QCOM_LP5_high_temp_105C_v2.seq",
    projectId: "qualcomm-product-a",
    createdAt: "2026-07-08T11:20:00+09:00",
    userComment: "baseline과 같은 조건으로 고온 영향 확인",
    content: `# High_Temperature_105C_VDD0.99_ECC_EN_CLK_SWEEP_PATTERN_FULL
@TF set 105;
vdd2h 990;
ecc enable;
clk.sh -lf 0 1 2 3 4;
hdiag64 --pattern full;

# Collect_Result
pull result.log;
`,
  },
  {
    id: "seq-boundary-v3",
    filename: "QCOM_LP5_105C_CLK_boundary_v3.seq",
    projectId: "qualcomm-product-a",
    createdAt: "2026-07-15T14:30:00+09:00",
    userComment: "고온 fail 때문에 CLK를 나눠본 버전",
    content: `# Boundary_105C_VDD0.91_ECC_EN_CLK_9600_PATTERN_1190
@TF set 105;
vdd2h 910;
ecc enable;
clk.sh -f 9600;
hdiag64 --pattern 1190;

# Boundary_105C_VDD0.91_ECC_EN_CLK_10000_PATTERN_6060
@TF set 105;
vdd2h 910;
ecc enable;
clk.sh -f 10000;
hdiag64 --pattern 6060;

# Boundary_105C_VDD0.91_ECC_EN_CLK_10660_PATTERN_6060
@TF set 105;
vdd2h 910;
ecc enable;
clk.sh -f 10660;
hdiag64 --pattern 6060;

# Collect_Result
pull result.log;
`,
  },
];

export interface DemoSequenceProject {
  sources: readonly SequenceSource[];
  analyses: SequenceAnalysis[];
  current: SequenceAnalysis;
  previous: SequenceAnalysis;
  diff: SemanticDiff;
  parentCandidates: ParentCandidate[];
}

/** Ready-to-render data for the Control Tower and Sequence Review screens. */
export function buildDemoSequenceProject(): DemoSequenceProject {
  const analyses = demoSequenceSources.map((source) => analyzeSequence(source));
  const current = analyses[analyses.length - 1];
  const previous = analyses[analyses.length - 2];
  return {
    sources: demoSequenceSources,
    analyses,
    current,
    previous,
    diff: semanticDiff(previous, current),
    parentCandidates: recommendParentCandidates(current, analyses.slice(0, -1), { limit: 3 }),
  };
}
