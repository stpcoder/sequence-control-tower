# macOS 설치

이 문서는 GitHub Release에서 받은 Sequence Control Tower Universal 앱을 macOS 12 Monterey 이상에서 사용하는 방법을 설명합니다. Universal 패키지는 Intel Mac과 Apple Silicon Mac을 모두 지원하며, 일반 사용자는 Node.js나 개발 도구를 설치할 필요가 없습니다.

## 다운로드와 무결성 확인

1. Release의 `Sequence-Control-Tower-macOS-Universal.dmg`를 받습니다.
2. 같은 Release의 `SHA256SUMS-macOS.txt`를 받습니다.
3. Terminal에서 다운로드 폴더로 이동해 `shasum -a 256 Sequence-Control-Tower-macOS-Universal.dmg`를 실행하고 목록의 값과 비교합니다.

private 저장소라면 GitHub 읽기 권한이 있는 계정으로 로그인해야 다운로드할 수 있습니다.

## 설치

1. DMG를 엽니다.
2. `Sequence Control Tower`를 `Applications` 폴더로 옮깁니다.
3. Applications에서 앱을 실행합니다.

앱 데이터와 LLM 설정은 사용자별 Application Support 영역에 저장되며, 가져온 원본 로그는 덮어쓰지 않습니다.

## 현재 unsigned PoC의 첫 실행

현재 GitHub Actions 빌드는 Apple Developer ID로 서명하거나 Apple에 공증하지 않았습니다. 따라서 Gatekeeper가 개발자를 확인할 수 없다는 이유로 첫 실행을 차단할 수 있습니다.

회사 보안 정책이 이 unsigned PoC 실행을 허용하고 다운로드 출처와 SHA-256을 확인한 경우에만 다음을 진행하세요.

1. Finder의 Applications에서 앱을 Control-클릭하고 `열기`를 선택합니다.
2. 다시 `열기`가 표시되면 확인합니다.
3. 여전히 차단되면 시스템 설정의 `개인정보 보호 및 보안`에서 해당 앱의 `확인 없이 열기` 안내를 검토합니다. macOS 버전에 따라 문구는 다를 수 있습니다.

보안 경고를 무력화하는 전역 명령은 사용하지 마세요. 현업 배포판은 Developer ID Application 인증서로 서명하고 notarization을 완료해야 합니다.

## macOS 단축키

| 동작 | 단축키 |
|---|---|
| 로그 폴더 열기 | `⌘O` |
| 현재 로그 찾기 | `⌘F` |
| 전체 로그 찾기 | `⌘⇧F` |
| LLM·저장소 설정 | `⌘,` |

상단 메뉴에는 macOS 표준 Application, File, Edit, View, Window, Help 메뉴가 제공됩니다.

## 제거

1. 앱을 종료합니다.
2. Applications의 `Sequence Control Tower`를 휴지통으로 옮깁니다.
3. 로컬 작업공간 데이터까지 제거해야 한다면 회사 보존 정책을 먼저 확인한 뒤 사용자 Library의 앱 지원 데이터를 별도로 정리합니다. 원본 평가 로그가 포함될 수 있으므로 자동 삭제하지 않습니다.
