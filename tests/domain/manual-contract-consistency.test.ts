import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_COLUMNS, EVIDENCE_EXPORT_COLUMNS } from "../../src/state/logRecords";

const repositoryRoot = resolve(".");
const workbenchManualPath = resolve(repositoryRoot, "docs/manual/00-log-workbench.md");
const settingsManualPath = resolve(repositoryRoot, "docs/manual/05-settings.md");

describe("Luna manual export and LLM settings contract", () => {
  it("documents the current export fields and optional evidence columns", async () => {
    const manual = await readFile(workbenchManualPath, "utf8");

    for (const field of DEFAULT_EXPORT_COLUMNS) {
      expect(manual).toContain(`\`${field}\``);
    }
    for (const field of EVIDENCE_EXPORT_COLUMNS) {
      expect(manual).toContain(`\`${field}\``);
    }
    expect(manual).not.toContain("sample_candidate");
    expect(manual).not.toContain("temperature_candidate");
    expect(manual).not.toContain("mode_candidate");
    expect(manual).toContain("`열 선택`");
    expect(manual).toContain("`근거`");
  });

  it("documents the current Timeout range and TPM behavior", async () => {
    const manual = await readFile(settingsManualPath, "utf8");

    expect(manual).toContain("`Timeout`은 5~300초 범위입니다.");
    expect(manual).toContain("기본값은 60초입니다.");
    expect(manual).toContain("`TPM`은 1,201~10,000,000 범위입니다.");
    expect(manual).toContain("기본값은 80,000입니다.");
    expect(manual).toContain("응답 예약 1,200토큰과 최소 프롬프트 1토큰");
    expect(manual).not.toContain("30~90초");
    expect(manual).not.toContain("timeout은");
  });
});
