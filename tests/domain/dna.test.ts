import { describe, expect, it } from "vitest";
import { analyzeSequence } from "../../src/domain";

describe("Sequence DNA", () => {
  it("extracts evaluation conditions and retains evidence", () => {
    const analysis = analyzeSequence({
      id: "dna-1",
      filename: "QCOM_105C_boundary.seq",
      userComment: "고온 CLK 경계 평가",
      content: `# 105C VDD2H=0.91 ECC_EN CLK_9600 Pattern_1190
@TF set 105;
vdd2h 910;
ecc enable;
clk.sh -f 9600;
hdiag64 --pattern 1190;
# 105C CLK_10660 Pattern_6060
clk.sh -f 10660;
hdiag64 --pattern 6060;
`,
    });

    expect(analysis.dna.temperaturesC.value).toEqual([105]);
    expect(analysis.dna.voltages.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ rail: "VDD2H", volts: 0.91 })]),
    );
    expect(analysis.dna.ecc.value).toBe("enabled");
    expect(analysis.dna.clocks.value).toMatchObject({ mode: "fixed", valuesMHz: [9600, 10660] });
    expect(analysis.dna.patterns.value).toMatchObject({ mode: "selected", values: ["1190", "6060"] });
    expect(analysis.dna.commandFamilies.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ family: "diagnostic", count: 2 })]),
    );
    expect(analysis.dna.temperaturesC.provenance.some((item) => item.range?.startLine === 2)).toBe(true);
  });

  it("asks only high-value questions when purpose is absent or settings conflict", () => {
    const analysis = analyzeSequence({
      id: "dna-2",
      filename: "unknown.seq",
      content: "# ECC comparison\necc enable;\necc disable;",
    });
    expect(analysis.dna.ecc.value).toBe("mixed");
    expect(analysis.clarificationQuestions).toHaveLength(2);
    expect(analysis.clarificationQuestions.map((question) => question.relatedFields[0])).toEqual(["purpose", "ecc"]);
  });

  it("extracts space-separated CLK, pattern and EF tokens used by production sequences", () => {
    const analysis = analyzeSequence({
      id: "dna-3",
      filename: "105C_boundary.seq",
      userComment: "고온 경계 재평가",
      content: `#105_0.91_EVA_EF_10660
@TF set 105;
vdd2h 910;
ECC EF;
/data/clk.sh -f 9600 10000 10660;
/data/hdiag64 -r 1 -p 1190 6060 -mr8 0x23 0x23;
`,
    });

    expect(analysis.dna.ecc.value).toBe("disabled");
    expect(analysis.dna.clocks.value?.valuesMHz).toEqual([9600, 10000, 10660]);
    expect(analysis.dna.patterns.value?.values).toEqual(["1190", "6060"]);
  });
});
