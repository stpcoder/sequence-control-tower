import { describe, expect, it } from "vitest";
import { normalizeDynamicTokens } from "../../src/domain";

describe("dynamic token normalization", () => {
  it("removes run noise while preserving evaluation values", () => {
    const normalized = normalizeDynamicTokens(
      "[14:03:12.441] pid=12904 address=0x8a2f19 duration=1832ms CLK=10660 VDD=0.91",
    );
    expect(normalized.text).toContain("<TIMESTAMP>");
    expect(normalized.text).toContain("pid=<PID>");
    expect(normalized.text).toContain("address=<HEX>");
    expect(normalized.text).toContain("duration=<DURATION>");
    expect(normalized.text).toContain("CLK=10660 VDD=0.91");
    expect(normalized.replacements.map((replacement) => replacement.kind)).toEqual(
      expect.arrayContaining(["timestamp", "process-id", "hex-address", "duration"]),
    );
  });
});
