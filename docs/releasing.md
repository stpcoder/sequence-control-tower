# Windows/macOS Release 운영 가이드

## 자동 배포

`package.json`의 version과 같은 `v` tag를 push하면 Windows Release와 macOS Release workflow가 각각 실행되어 같은 GitHub Release에 운영체제별 asset을 추가합니다. 일반 branch에 commit을 push하면 CI가 type-check, test, production build를 자동 실행합니다.

```bash
git tag -a v0.10.0 -m "Sequence Control Tower v0.10.0"
git push origin main v0.10.0
```

Workflow는 Windows에서 type-check/test/build 후 다음 고정 이름으로 Release asset을 게시합니다.

- `Sequence-Control-Tower-Setup.exe`
- `Sequence-Control-Tower-Portable.exe`
- `Sequence-Control-Tower-Windows.zip`
- `SHA256SUMS.txt`
- `WINDOWS-SIGNING-NOTICE.txt`

macOS workflow는 macOS에서 동일 검증 후 다음 asset을 게시합니다.

- `Sequence-Control-Tower-macOS-Universal.dmg`
- `Sequence-Control-Tower-macOS-Universal.zip`
- `SHA256SUMS-macOS.txt`
- `GATEKEEPER-NOTICE-macOS.txt`

고정 이름은 README의 `/releases/latest/download/...` 링크가 버전마다 바뀌지 않게 합니다. 두 workflow는 `overwrite_files: false`로 이미 있는 같은 이름의 Release asset을 덮어쓰지 않습니다. `package.json` version과 tag가 다르면 잘못된 바이너리 배포를 막기 위해 workflow가 중단됩니다.

현재 설치 방법과 운영체제별 주의사항은 [설치와 문제 해결](manual/06-설치-문제-해결.md)에 정리합니다.

## 수동 배포

Windows 수동 실행도 이미 원격에 존재하는 tag만 빌드합니다. 먼저 현재 `package.json` version과 같은 tag를 생성해 push한 뒤 GitHub에서 **Actions → Windows Release → Run workflow**를 선택하고 같은 tag를 입력합니다. macOS workflow는 tag push로 자동 실행됩니다.

```bash
git tag -a v0.10.0 -m "Sequence Control Tower v0.10.0"
git push origin v0.10.0
```

Workflow는 현재 선택한 branch가 아니라 입력한 tag commit을 checkout합니다. tag가 없거나 tag의 `package.json` version과 입력값이 다르면 중단됩니다. pre-release를 선택한 경우 `/releases/latest/download` 링크의 대상이 되지 않을 수 있으므로 일반 사용자에게는 Release 페이지 링크를 전달합니다.

## Windows 코드 서명

서명 인증서가 있다면 repository Actions secrets에 아래를 등록합니다.

| Secret | 값 |
|---|---|
| `WIN_CSC_LINK` | base64로 인코딩한 `.pfx` 또는 접근 가능한 보안 URL |
| `WIN_CSC_KEY_PASSWORD` | 인증서 비밀번호 |

electron-builder가 `CSC_LINK`, `CSC_KEY_PASSWORD`로 읽으며 인증서가 없을 때는 unsigned PoC를 생성합니다. Workflow는 Setup과 portable의 Authenticode 상태를 확인해 `WINDOWS-SIGNING-NOTICE.txt`와 Actions summary에 기록합니다. unsigned 앱은 Windows SmartScreen 경고가 나타날 수 있으므로 현업 배포 전에는 회사의 코드 서명·보안 검토 절차를 완료해야 합니다.

인증서 파일이나 비밀번호를 저장소, workflow YAML, Release asset에 직접 넣지 마세요.

## macOS 서명과 공증

현재 macOS workflow는 `identity: null`과 `CSC_IDENTITY_AUTO_DISCOVERY=false`로 unsigned Universal 패키지를 만듭니다. 빌드와 DMG 설치 구조는 검증할 수 있지만 Gatekeeper는 첫 실행을 차단할 수 있습니다.

현업 배포 전에는 Apple Developer Program의 Developer ID Application 인증서로 앱을 서명하고 Apple notarization을 완료한 뒤 stapling까지 검증해야 합니다. 인증서와 app-specific password는 GitHub Actions secret으로만 주입하고 저장소나 Release asset에 포함하지 마세요. 정식 서명 전환 시에는 `identity: null` 설정과 unsigned 안내 파일도 함께 갱신해야 합니다.

## 배포 후 확인

1. Windows asset 다섯 개와 macOS asset 네 개가 모두 게시됐는지 확인합니다.
2. 운영체제별 SHA-256 목록으로 다운로드한 파일 hash를 확인합니다.
3. 깨끗한 x64 Windows 10/11 PC에서 설치형, portable, ZIP을 각각 실행하고 설치·업데이트·제거를 확인합니다.
4. Intel 또는 Apple Silicon의 macOS 12 이상에서 DMG 설치, `⌘O`, `⌘F`, `⌘⇧F`, `⌘,`를 확인합니다.
5. 앱 실행, 로그 폴더 등록, 검색·판정, Agent 내부 fallback을 smoke-test합니다.
6. 코드 서명을 사용한다면 Windows Digital Signatures와 macOS `codesign`/`spctl` 결과를 확인합니다.
