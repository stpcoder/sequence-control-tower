# Windows 설치 및 제거

지원 환경은 Windows 10/11 x64입니다. 일반 사용자는 Node.js나 개발 도구가 필요하지 않습니다.

## 다운로드

Private 저장소의 Release를 받으려면 저장소 읽기 권한이 필요합니다.

| 파일 | 용도 |
|---|---|
| `Sequence-Control-Tower-Setup.exe` | 설치형 |
| `Sequence-Control-Tower-Portable.exe` | 단일 실행 파일 |
| `Sequence-Control-Tower-Windows.zip` | 폴더형 Portable |
| `SHA256SUMS.txt` | 무결성 확인값 |
| `WINDOWS-SIGNING-NOTICE.txt` | 코드 서명 상태 |

일반 PC에는 설치형을 사용합니다. 설치 권한이 없는 환경에는 Portable을 사용합니다.

## SHA-256 확인

실행 파일과 `SHA256SUMS.txt`를 같은 폴더에 저장하고 PowerShell에서 실행합니다.

```powershell
Get-FileHash .\Sequence-Control-Tower-Setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

두 값이 다르면 파일을 실행하지 말고 다시 다운로드하거나 배포 담당자에게 문의합니다.

## 설치형

1. `Sequence-Control-Tower-Setup.exe`를 실행합니다.
2. 설치 위치를 선택합니다.
3. 시작 메뉴 또는 바탕 화면에서 **Sequence Control Tower**를 실행합니다.
4. 필요한 경우 `설정`에서 사내 LLM 연결을 구성합니다.

기본 설치는 사용자 단위입니다. 회사 정책이 설치를 차단하면 IT 또는 배포 담당자에게 문의합니다. ARM64 Windows에서는 x64 호환 계층을 사용합니다.

## SmartScreen

조직 인증서로 서명되지 않은 빌드는 SmartScreen 경고를 표시할 수 있습니다. 다음 항목을 모두 확인한 경우에만 회사 정책에 따라 실행합니다.

- Release가 올바른 조직과 저장소에서 배포됨
- SHA-256이 `SHA256SUMS.txt`와 일치함
- 회사에서 해당 빌드 실행을 허용함

실행 선택지가 없거나 보안 제품이 차단하면 보호 기능을 끄지 말고 IT 담당자에게 문의합니다.

## Portable

### 단일 실행 파일

`Sequence-Control-Tower-Portable.exe`를 쓰기 가능한 폴더에 저장하고 실행합니다.

### ZIP

`Sequence-Control-Tower-Windows.zip`을 새 폴더에 완전히 압축 해제하고 `Sequence Control Tower.exe`를 실행합니다. ZIP 내부에서는 실행하지 마세요.

설정과 가져온 로그 데이터는 다음 사용자 데이터 폴더에 저장됩니다.

```text
%APPDATA%\Sequence Control Tower\sequence-intelligence
```

설치 후 폴더 가져오기와 검색 단축키는 [Log Workbench 사용 안내](00-log-workbench.md)를 참고하세요.

## 업데이트

1. 앱을 종료합니다.
2. 새 Release의 SHA-256을 확인합니다.
3. 설치형은 새 Setup을 실행합니다.
4. Portable은 실행 파일 또는 압축 해제 폴더를 새 버전으로 교체합니다.

사용자 데이터는 업데이트 후에도 유지됩니다. 회사 백업 정책이 있으면 업데이트 전에 적용합니다.

## 제거

### 설치형

Windows `설정 > 앱 > 설치된 앱 > Sequence Control Tower > 제거`를 선택합니다.

### Portable

앱을 종료하고 실행 파일 또는 압축 해제 폴더를 삭제합니다.

사용자 데이터는 자동으로 삭제되지 않을 수 있습니다. 완전 삭제가 필요한 경우 앱을 종료하고 필요한 데이터를 백업한 다음 아래 폴더를 삭제합니다.

```text
%APPDATA%\Sequence Control Tower\sequence-intelligence
```

이 작업은 되돌릴 수 없습니다. 회사 데이터 보존 정책과 삭제 대상 사용자 계정을 확인하세요.
