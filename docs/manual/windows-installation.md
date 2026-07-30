# Windows 설치 및 제거

이 문서는 GitHub Release에서 받은 Sequence Control Tower를 Windows 10/11 PC에서 사용하는 방법을 설명합니다. 일반 사용자는 Node.js나 개발 도구를 설치할 필요가 없습니다.

## 다운로드 전 확인

현재 GitHub 저장소는 private이므로 저장소 읽기 권한이 있는 계정으로 로그인해야 합니다. 권한이 없으면 Release와 직접 다운로드 링크가 `404`로 보일 수 있습니다.

Release에는 네 파일이 있습니다.

| 파일 | 용도 |
|---|---|
| `Sequence-Control-Tower-Setup.exe` | 일반 사용자용 설치 프로그램 |
| `Sequence-Control-Tower-Portable.exe` | 설치하지 않고 한 파일로 실행 |
| `Sequence-Control-Tower-Windows.zip` | 폴더 단위 portable 배포 |
| `SHA256SUMS.txt` | 다운로드 무결성 확인 |

처음 사용하는 PC에는 설치형을 권장합니다. 설치 권한이나 PC 정책 때문에 설치할 수 없을 때 portable을 사용하세요.

## SHA-256 확인

Release에서 실행 파일과 `SHA256SUMS.txt`를 같은 폴더에 다운로드합니다. PowerShell을 열고 다운로드 폴더에서 다음을 실행합니다.

```powershell
Get-FileHash .\Sequence-Control-Tower-Setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

두 곳의 hash가 정확히 같은지 확인합니다. Portable을 사용한다면 파일명을 `Sequence-Control-Tower-Portable.exe`로 바꿔 같은 방식으로 확인합니다. 값이 다르면 실행하지 말고 파일을 다시 받거나 배포 담당자에게 문의하세요.

## 설치형 사용

1. `Sequence-Control-Tower-Setup.exe`를 실행합니다.
2. 안내에 따라 설치 위치를 선택합니다.
3. 설치가 끝나면 바탕 화면 또는 시작 메뉴의 **Sequence Control Tower**를 실행합니다.
4. 앱의 **Settings**에서 사내 OpenAI-compatible endpoint를 설정합니다. LLM을 설정하지 않아도 로컬 SEQ 분석은 사용할 수 있습니다.

기본 구성은 사용자 단위 설치이므로 일반적으로 관리자 권한이 필요하지 않습니다. 회사 보안 정책이 설치를 차단하면 정책을 우회하지 말고 IT 또는 배포 담당자에게 문의하세요.

## SmartScreen 경고

PoC Release는 회사 코드 서명 인증서가 없으면 unsigned로 생성됩니다. 이 경우 Windows가 `Microsoft Defender SmartScreen에서 인식할 수 없는 앱의 시작을 차단했습니다`와 같은 경고를 표시할 수 있습니다.

다음 조건을 모두 만족할 때만 회사 정책에 따라 **추가 정보 → 실행**을 선택합니다.

- GitHub 저장소와 Release가 올바른 조직의 것인지 확인함
- SHA-256이 `SHA256SUMS.txt`와 일치함
- 회사에서 해당 PoC 실행을 허용함

`실행` 선택지가 없거나 보안 제품이 차단하면 보호 기능을 끄지 말고 IT 담당자에게 문의하세요. 예상하지 못한 경고나 hash 불일치가 있다면 실행하지 않습니다.

## Portable 실행

### 단일 EXE

`Sequence-Control-Tower-Portable.exe`를 쓰기 가능한 작업 폴더에 두고 실행합니다. 파일 자체는 설치하지 않지만, 설정과 가져온 artifact는 Windows 사용자 데이터 폴더에 저장됩니다.

### ZIP

`Sequence-Control-Tower-Windows.zip`을 새 폴더에 완전히 압축 해제한 뒤 폴더 안의 `Sequence Control Tower.exe`를 실행합니다. ZIP 내부에서 직접 실행하지 마세요.

Portable은 완전한 무설치·무기록 모드가 아닙니다. 설치형과 마찬가지로 앱 데이터는 일반적으로 아래에 남습니다.

```text
%APPDATA%\Sequence Control Tower\sequence-intelligence
```

## 업데이트

1. 실행 중인 Sequence Control Tower를 종료합니다.
2. 새 Release의 SHA-256을 확인합니다.
3. 설치형은 새 Setup을 실행해 기존 설치를 업데이트합니다.
4. Portable은 이전 실행 파일 또는 압축 해제 폴더를 새 버전으로 교체합니다.

사용자 데이터는 실행 파일과 별도 위치에 있으므로 일반적인 업데이트에서는 유지됩니다. 중요한 artifact는 업데이트 전에 회사 백업 정책에 따라 별도 보관하세요.

## 제거

### 설치형

Windows **설정 → 앱 → 설치된 앱 → Sequence Control Tower → 제거**를 선택합니다.

### Portable

앱을 종료한 뒤 `Sequence-Control-Tower-Portable.exe` 또는 ZIP을 압축 해제한 앱 폴더를 삭제합니다.

앱 제거 후에도 SEQ 원본, 분석 cache와 LLM 설정이 있는 사용자 데이터는 자동으로 삭제되지 않을 수 있습니다. 데이터를 완전히 제거해야 한다면 먼저 필요한 artifact를 백업하고 앱을 종료한 뒤 아래 폴더를 삭제합니다.

```text
%APPDATA%\Sequence Control Tower\sequence-intelligence
```

이 폴더 삭제는 되돌릴 수 없습니다. 공유 PC에서는 다른 사용자의 경로를 삭제하지 말고 회사 데이터 보존 정책을 먼저 확인하세요.
