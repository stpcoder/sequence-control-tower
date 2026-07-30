# Windows Release 운영 가이드

## 자동 배포

`package.json`의 version과 같은 `v` tag를 push하면 Windows Release workflow가 실행됩니다.

```bash
npm version 0.2.0
git push origin main --follow-tags
```

Workflow는 Windows에서 type-check/test/build 후 다음 고정 이름으로 Release asset을 게시합니다.

- `Sequence-Control-Tower-Setup.exe`
- `Sequence-Control-Tower-Portable.exe`
- `Sequence-Control-Tower-Windows.zip`
- `SHA256SUMS.txt`

고정 이름은 README의 `/releases/latest/download/...` 링크가 버전마다 바뀌지 않게 합니다. `package.json` version과 tag가 다르면 잘못된 바이너리 배포를 막기 위해 workflow가 중단됩니다.

## 수동 배포

수동 실행도 이미 원격에 존재하는 tag만 빌드합니다. 먼저 tag를 생성해 push한 뒤 GitHub에서 **Actions → Windows Release → Run workflow**를 선택하고 같은 `v0.2.0` tag를 입력합니다.

```bash
git tag -a v0.2.0 -m "Sequence Control Tower v0.2.0"
git push origin v0.2.0
```

Workflow는 현재 선택한 branch가 아니라 입력한 tag commit을 checkout합니다. tag가 없거나 tag의 `package.json` version과 입력값이 다르면 중단됩니다. pre-release를 선택한 경우 `/releases/latest/download` 링크의 대상이 되지 않을 수 있으므로 일반 사용자에게는 Release 페이지 링크를 전달합니다.

## Windows 코드 서명

서명 인증서가 있다면 repository Actions secrets에 아래를 등록합니다.

| Secret | 값 |
|---|---|
| `WIN_CSC_LINK` | base64로 인코딩한 `.pfx` 또는 접근 가능한 보안 URL |
| `WIN_CSC_KEY_PASSWORD` | 인증서 비밀번호 |

electron-builder가 `CSC_LINK`, `CSC_KEY_PASSWORD`로 읽으며 인증서가 없을 때는 unsigned PoC를 생성합니다. unsigned 앱은 Windows SmartScreen 경고가 나타날 수 있으므로 현업 배포 전에는 회사의 코드 서명·보안 검토 절차를 완료해야 합니다.

인증서 파일이나 비밀번호를 저장소, workflow YAML, Release asset에 직접 넣지 마세요.

## 배포 후 확인

1. Release asset 네 개가 모두 게시됐는지 확인합니다.
2. `SHA256SUMS.txt`로 다운로드한 파일 hash를 확인합니다.
3. 깨끗한 Windows 10/11 PC에서 설치형과 portable을 각각 실행합니다.
4. 앱 실행, SEQ import, 로컬 분석, AI 미설정 fallback을 smoke-test합니다.
5. 코드 서명을 사용한다면 실행 파일 속성의 Digital Signatures를 확인합니다.
