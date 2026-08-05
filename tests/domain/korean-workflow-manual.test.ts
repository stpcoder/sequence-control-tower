import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const manualPath = resolve("docs/manual/70-실장-엔지니어-사용-시나리오.md");
const readmePath = resolve("docs/manual/README.md");

describe("Korean engineer workflow manual", () => {
  it("is linked from the manual index and keeps local links resolvable", async () => {
    const readme = await readFile(readmePath, "utf8");
    expect(readme).toContain("[70 실장 엔지니어 사용 시나리오](70-실장-엔지니어-사용-시나리오.md)");

    const links = [...readme.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(?:https?:|mailto:)/.test(target));
    await Promise.all(links.map((target) => access(resolve(repositoryRoot, "docs/manual", target))));

    const manual = await readFile(manualPath, "utf8");
    const manualLinks = [...manual.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(?:https?:|mailto:)/.test(target));
    await Promise.all(manualLinks.map((target) => access(resolve(repositoryRoot, "docs/manual", target))));
  });

  it("contains the current Korean labels and shortcuts used by the UI", async () => {
    const manual = await readFile(manualPath, "utf8");
    for (const label of [
      "로그 폴더 열기",
      "현재 로그 찾기",
      "열린 탭 찾기",
      "전체 로그 찾기",
      "근거 거터",
      "원문 북마크",
      "결과",
      "분석 규칙 저장",
      "규칙 저장",
      "전체에 미리 적용",
      "예외 N개 확인",
      "결과표",
      "파일명, 폴더, 조건 검색",
      "검토",
      "폴더 범위",
      "초기화",
      "열 선택",
      "내보낼 열",
      "근거 수",
      "선택 근거 수",
      "TSV 복사",
      "CSV",
      "LLM 연결",
      "Base URL",
      "Model",
      "API key",
      "모델 목록 확인",
      "호출 제한",
      "RPM",
      "TPM",
      "Timeout",
      "Retries",
      "저장",
      "검토 메모 (선택)",
      "검토 실행",
      "검토 중",
      "취소",
    ]) {
      expect(manual, label).toContain(`\`${label}\``);
    }
    expect(manual).toContain("Ctrl+O");
    expect(manual).toContain("⌘O");
    expect(manual).toContain("Ctrl+F");
    expect(manual).toContain("⌘F");
    expect(manual).toContain("Ctrl+Alt+F");
    expect(manual).toContain("⌘⌥F");
    expect(manual).toContain("Ctrl+Shift+F");
    expect(manual).toContain("⌘⇧F");
  });

  it("has separate concrete workflows for the three personas and the requested fixtures", async () => {
    const manual = await readFile(manualPath, "utf8");
    expect(manual).toMatch(/## 1\. 검증 엔지니어: 여러 폴더 분류/);
    expect(manual).toMatch(/## 2\. Bring-up\/Debug 엔지니어: UEFI에서 OS까지 정지·재부팅·Training 실패 추적/);
    expect(manual).toMatch(/## 3\. 리포트 오너: 행·열·근거를 선택해 CSV\/TSV 만들기/);
    expect(manual).toContain("tests/fixtures/engineer-workflow/");
    expect(manual).toContain("tests/fixtures/qualcomm-bringup/");
    expect(manual).toContain("OpenAI-compatible vLLM");
    expect(manual).not.toContain("검토용 제안 · 판정은 엔지니어가 확정");
    expect(manual).not.toContain("검토용 제안입니다. PASS/FAIL 판정이나 규칙을 자동 적용하지 않습니다.");
    expect(manual).toContain("기대 결과");
    expect(manual).toContain("예외 처리");
  });

  it("states source-log immutability and avoids forbidden metaphor phrasing", async () => {
    const manual = await readFile(manualPath, "utf8");
    expect(manual).toMatch(/원본 로그 파일은 읽기 전용으로 열립니다/);
    expect(manual).toContain("원본 로그 파일은 내보내기 과정에서 변경되지 않습니다.");
    for (const phrase of ["아니라", "등대", "지도", "나침반", "다리 역할", "허브 역할"]) {
      expect(manual, phrase).not.toContain(phrase);
    }
  });
});
