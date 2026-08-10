import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(".");
const quickStartPath = resolve("docs/manual/01-빠른-시작.md");
const workflowPath = resolve("docs/manual/02-로그-분석-규칙.md");
const agentPath = resolve("docs/manual/03-Agent-네이티브-분석.md");
const readmePath = resolve("docs/manual/README.md");

describe("Korean engineer workflow manual", () => {
  it("is linked from the manual index and keeps local links resolvable", async () => {
    const readme = await readFile(readmePath, "utf8");
    expect(readme).toContain("[Agent 네이티브 분석](03-Agent-네이티브-분석.md)");

    const links = [...readme.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(?:https?:|mailto:)/.test(target));
    await Promise.all(links.map((target) => access(resolve(repositoryRoot, "docs/manual", target))));

    expect(links).toHaveLength(6);
  });

  it("contains the current search labels and shortcuts used by the UI", async () => {
    const manual = await readFile(quickStartPath, "utf8");
    for (const label of [
      "로그 폴더 열기",
      "현재 로그 찾기",
      "열린 탭 찾기",
      "전체 로그 찾기",
      "결과",
      "결과 정리",
      "평가 이력",
      "Agent",
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

  it("documents behavior learning, bounded tools, RT, and proactive questions", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const agent = await readFile(agentPath, "utf8");
    expect(workflow).toContain("최근 8시간 안의 검색 중 마지막 20개");
    expect(workflow).toContain("두 개 이상의 서로 다른 검색");
    expect(workflow).toContain("건너뛴 후보는 학습에 사용하지 않습니다");
    expect(agent).toContain("Agent가 먼저 묻는 경우");
    expect(agent).toContain("동일 Sample·동일 Sequence");
    expect(agent).toContain("`미해결 RT`");
    expect(agent).toContain("최대 24줄");
    expect(agent).toContain("`engineer_workflow_apply`");
    expect(agent).toContain("OpenCode headless sidecar");
    expect(agent).toContain("내부 bounded 하네스");
  });

  it("states source-log immutability and human confirmation boundaries", async () => {
    const manual = `${await readFile(quickStartPath, "utf8")}\n${await readFile(agentPath, "utf8")}`;
    expect(manual).toMatch(/원본 로그 파일은 읽기 전용으로 열립니다/);
    expect(manual).toContain("Agent가 결과나 평가 이력을 임의로 확정하지 않습니다.");
  });
});
