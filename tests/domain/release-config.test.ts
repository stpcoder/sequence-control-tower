import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop release configuration", () => {
  it("pins Windows x64 targets and validates stable release assets", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const manual = await readFile("docs/manual/windows-installation.md", "utf8");

    expect(packageJson.scripts["dist:win"]).toContain("--x64");
    expect(packageJson.build.win.target).toEqual(["nsis", "portable", "zip"]);
    expect(workflow).toContain("Sequence-Control-Tower-Setup.exe");
    expect(workflow).toContain("Sequence-Control-Tower-Portable.exe");
    expect(workflow).toContain("Sequence-Control-Tower-Windows.zip");
    expect(workflow).toContain("WINDOWS-SIGNING-NOTICE.txt");
    expect(workflow).toContain("$machine -ne 0x8664");
    expect(manual).toContain("SmartScreen");
    expect(manual).toContain("Ctrl+O");
    expect(manual).toContain("설정 → 앱 → 설치된 앱");
  });

  it("pins an unsigned Universal macOS package and verifies both architectures and archives", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const workflow = await readFile(".github/workflows/release-macos.yml", "utf8");
    const manual = await readFile("docs/manual/macos-installation.md", "utf8");

    expect(packageJson.scripts["dist:mac"]).toContain("--universal");
    expect(packageJson.build.mac).toMatchObject({ identity: null, target: ["dmg", "zip"] });
    expect(workflow).toContain('lipo "$executable" -verify_arch x86_64 arm64');
    expect(workflow).toContain("hdiutil verify");
    expect(workflow).toContain("unzip -tq");
    expect(workflow).toContain("LSMinimumSystemVersion");
    expect(workflow).toContain("GATEKEEPER-NOTICE-macOS.txt");
    expect(manual).toContain("macOS 12 Monterey 이상");
    expect(manual).toContain("서명하거나 Apple에 공증하지 않았습니다");
  });

  it("keeps native folder pickers multi-select on both desktop platforms", async () => {
    const ipc = await readFile("electron/main/ipc.ts", "utf8");
    expect(ipc).toMatch(/properties:\s*\['openDirectory',\s*'multiSelections'\]/);
  });
});
