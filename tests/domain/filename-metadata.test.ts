import { describe, expect, it } from "vitest";
import { parseFilenameMetadata } from "../../src/domain/workbench/filenameMetadata";

describe("filename metadata parser", () => {
  it("parses labeled values from a basename across separators", () => {
    const result = parseFilenameMetadata("/captures/LOT.SAMPLE=QBR-090.TEMPERATURE=-40C.MODE=DIAG.GRID=2x4.log");

    expect(result.basename).toBe("LOT.SAMPLE=QBR-090.TEMPERATURE=-40C.MODE=DIAG.GRID=2x4");
    expect(result.sample.value).toBe("QBR-090");
    expect(result.temperature.value).toBe("-40");
    expect(result.mode.value).toBe("DIAG");
    expect(result.grid.value).toBe("2X4");
    expect(result.temperature.provenance[0]).toMatchObject({ source: "basename", rule: "temperature-label" });
    expect(result.sample.confidence).toBeGreaterThan(0.9);
  });

  it("supports short aliases, bare negative temperatures, and Windows paths", () => {
    const result = parseFilenameMetadata("C:\\lab\\S=H9K_T-40C_M=UEFI_G=16x1.seq");

    expect(result.basename).toBe("S=H9K_T-40C_M=UEFI_G=16x1");
    expect(result.sample.value).toBe("H9K");
    expect(result.temperature.value).toBe("-40");
    expect(result.mode.value).toBe("UEFI");
    expect(result.grid.value).toBe("16X1");
  });

  it("recognizes the unlabeled leading sample format used by repository fixtures", () => {
    const result = parseFilenameMetadata("SAMP-A__TEMP=25C__MODE=DIAG__RUN=1.log");

    expect(result.sample).toMatchObject({
      value: "SAMP-A",
      state: "extracted",
      provenance: [{ rule: "sample-leading-unlabeled" }]
    });
    expect(result.temperature.value).toBe("25");
    expect(result.mode.value).toBe("DIAG");
  });

  it("fails closed for missing values and conflicting repeated values", () => {
    const result = parseFilenameMetadata("SAMPLE=H9K_SAMPLE=R7M_TEMP=25C_TEMP=105C.log");

    expect(result.sample).toMatchObject({ value: null, state: "conflict", confidence: 0 });
    expect(result.sample.candidates).toEqual(["H9K", "R7M"]);
    expect(result.temperature).toMatchObject({ value: null, state: "conflict", confidence: 0 });
    expect(result.mode.state).toBe("unknown");
    expect(result.grid.state).toBe("unknown");
  });
});
