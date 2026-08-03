# macOS 설치 및 제거

지원 환경은 macOS 12 Monterey 이상입니다. Universal 패키지는 Intel Mac과 Apple Silicon Mac을 지원합니다.

## 다운로드와 SHA-256 확인

1. Release에서 `Sequence-Control-Tower-macOS-Universal.dmg`를 받습니다.
2. 같은 Release에서 `SHA256SUMS-macOS.txt`를 받습니다.
3. Terminal에서 다음 명령을 실행합니다.

```bash
shasum -a 256 Sequence-Control-Tower-macOS-Universal.dmg
```

출력값과 `SHA256SUMS-macOS.txt`의 값이 같은지 확인합니다. Private 저장소는 GitHub 읽기 권한이 필요합니다.

## 설치

1. DMG를 엽니다.
2. `Sequence Control Tower`를 `Applications` 폴더로 옮깁니다.
3. Applications에서 앱을 실행합니다.
4. 필요한 경우 `설정`에서 사내 LLM 연결을 구성합니다.

앱 데이터와 LLM 연결 정보는 사용자별 Application Support 영역에 저장됩니다. 가져온 원본 로그는 수정하지 않습니다.

## Gatekeeper

Developer ID 서명과 notarization이 없는 빌드는 첫 실행 시 차단될 수 있습니다. 다운로드 출처, SHA-256, 회사 실행 정책을 확인한 경우에만 다음 절차를 진행합니다.

1. Applications에서 앱을 Control-클릭하고 `열기`를 선택합니다.
2. 확인 창에서 `열기`를 선택합니다.
3. 계속 차단되면 `시스템 설정 > 개인정보 보호 및 보안`의 해당 앱 안내를 확인합니다.

보안 기능을 전역으로 비활성화하지 마세요. 조직 배포판은 Developer ID Application 서명과 notarization이 필요합니다.

설치 후 폴더 가져오기와 검색 단축키는 [Log Workbench 사용 안내](00-log-workbench.md)를 참고하세요.

## 업데이트

1. 앱을 종료합니다.
2. 새 DMG의 SHA-256을 확인합니다.
3. 새 앱을 `Applications` 폴더에 복사하고 기존 앱을 교체합니다.

사용자 데이터는 업데이트 후에도 유지됩니다. 회사 백업 정책이 있으면 업데이트 전에 적용합니다.

## 제거

1. 앱을 종료합니다.
2. Applications의 `Sequence Control Tower`를 휴지통으로 옮깁니다.
3. 로컬 데이터도 삭제해야 하는 경우 회사 보존 정책과 백업 여부를 확인한 후 사용자 Library의 앱 지원 데이터를 삭제합니다.

로컬 데이터에는 가져온 로그와 판정 기록이 포함될 수 있습니다.
