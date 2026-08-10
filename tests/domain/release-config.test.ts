import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("desktop release configuration", () => {
  it("pins Windows x64 targets and validates stable release assets", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const manual = await readFile("docs/manual/06-설치-문제-해결.md", "utf8");
    const mainProcess = await readFile("electron/main/index.ts", "utf8");

    expect(packageJson.scripts["dist:win"]).toContain("--x64");
    expect(packageJson.build.win.target).toEqual(["nsis", "portable", "zip"]);
    expect(mainProcess).toMatch(/title:\s*'Sequence Control Tower'/);
    expect(workflow).toContain("Sequence-Control-Tower-Setup.exe");
    expect(workflow).toContain("Sequence-Control-Tower-Portable.exe");
    expect(workflow).toContain("Sequence-Control-Tower-Windows.zip");
    expect(workflow).toContain("WINDOWS-SIGNING-NOTICE.txt");
    expect(workflow).toContain("$machine -ne 0x8664");
    expect(manual).toContain("조직 서명이 없는 빌드는 SmartScreen 경고를 표시할 수 있습니다.");
    expect(manual).toContain("기존 설치가 있으면 제거 후 재설치 옵션을 사용할 수 있습니다.");
  });

  it("contracts the assisted NSIS upgrade confirmation", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const installer = await readFile("build/installer.nsh", "utf8");

    expect(packageJson.build.appId).toBe("com.stpcoder.sequencecontroltower");
    expect(packageJson.build.nsis.include).toBe("build/installer.nsh");
    expect(installer).toContain("!macro customInit");
    expect(installer).toContain('ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation');
    expect(installer).toContain('ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation');
    expect(installer).toContain("An existing Sequence Control Tower installation was detected.");
    expect(installer).toContain("electron-builder will remove the previous app binaries before installing this version.");
    expect(installer).toContain("Your user app data will be preserved.");
    expect(installer).toContain("MB_YESNO");
    expect(installer).toContain("SetErrorLevel 1223");
    expect(installer).toContain("Quit");
    expect(installer).not.toMatch(/\b(?:RMDir|DeleteRegKey)\b/);
  });

  it("pins an unsigned Universal macOS package and verifies both architectures and archives", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const workflow = await readFile(".github/workflows/release-macos.yml", "utf8");
    const manual = await readFile("docs/manual/06-설치-문제-해결.md", "utf8");

    expect(packageJson.scripts["dist:mac"]).toContain("--universal");
    expect(packageJson.build.mac).toMatchObject({ identity: null, target: ["dmg", "zip"] });
    expect(workflow).toContain('lipo "$executable" -verify_arch x86_64 arm64');
    expect(workflow).toContain("hdiutil verify");
    expect(workflow).toContain("unzip -tq");
    expect(workflow).toContain("LSMinimumSystemVersion");
    expect(workflow).toContain("GATEKEEPER-NOTICE-macOS.txt");
    expect(manual).toContain("Apple Silicon과 Intel Mac에서 같은 Universal 빌드를 사용합니다.");
    expect(manual).toContain("조직 notarization이 없는 빌드는 Gatekeeper 경고를 표시할 수 있습니다.");
  });

  it("keeps native folder pickers multi-select on both desktop platforms", async () => {
    const ipc = await readFile("electron/main/ipc.ts", "utf8");
    expect(ipc).toMatch(/properties:\s*\['openDirectory',\s*'multiSelections'\]/);
  });
});
