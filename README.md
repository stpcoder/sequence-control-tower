<p align="center">
  <img src="build/icon.png" width="88" alt="Sequence Control Tower icon">
</p>

# Sequence Control Tower · Log Workbench

여러 폴더의 긴 `.log`를 하나씩 열어 `Ctrl+F`로 판정하고 Excel에 다시 옮기던 일을 줄이는 Windows/macOS용 local-first 데스크톱 앱입니다. Notepad++의 검색, Excel의 결과표, Spotfire의 marking/drill-down 중 현장 로그 분석에 필요한 흐름만 남겼습니다.

[![CI](https://github.com/stpcoder/sequence-control-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/stpcoder/sequence-control-tower/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/stpcoder/sequence-control-tower?display_name=tag&sort=semver)](https://github.com/stpcoder/sequence-control-tower/releases/latest)

[![Windows 설치형 다운로드](https://img.shields.io/badge/Windows-설치형_다운로드-0A66C2?style=for-the-badge&logo=windows11&logoColor=white)](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Setup.exe)
[![Windows 포터블 다운로드](https://img.shields.io/badge/Windows-포터블_다운로드-30363D?style=for-the-badge&logo=windows11&logoColor=white)](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Portable.exe)
[![macOS Universal 다운로드](https://img.shields.io/badge/macOS-Universal_DMG-1F6FEB?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-macOS-Universal.dmg)

[Windows ZIP](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Windows.zip) · [macOS ZIP](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-macOS-Universal.zip) · [모든 Release](https://github.com/stpcoder/sequence-control-tower/releases)

> 저장소가 private이면 다운로드에도 해당 GitHub 저장소의 읽기 권한이 필요합니다. 현재 자동 배포본은 조직 인증서가 없으면 Windows SmartScreen 또는 macOS Gatekeeper 경고가 표시될 수 있습니다.

![Log Workbench](docs/images/manual-00-log-workbench.png)

## 핵심 업무 흐름

```text
여러 로그 폴더 선택
  → 현재 파일/전체 파일 검색
  → 판정에 사용할 검색만 명시적으로 선택
  → PASS / DIAG_FAIL / TEST_FAIL / TRAINING_FAIL / HALT / REBOOT 판정
  → 로컬 규칙으로 전체 로그 한 번에 검사
  → 예외만 이유와 원문 위치에서 재검토
  → 1 log = 1 row 결과표와 조건별 패턴
  → CSV/TSV로 Excel 전달
```

Excel과의 차이는 단순히 diff를 보여주는 데 있지 않습니다. 각 결과에 사용한 규칙 revision, 엔지니어 판정, 근거 줄, 예외 이유를 함께 보존하고, 결과표나 패턴 셀에서 원본 로그로 다시 돌아갈 수 있습니다.

## 실제 구현된 기능

- Windows에서 여러 폴더를 동시에 선택하고 하위 `.log`를 재귀 수집
- 한 번에 최대 10,000개 로그, 동일 내용은 한 벌만 저장하면서 실제 파일 출처는 각각 유지
- 240줄 단위 지연 로딩 로그 뷰어와 절대 줄 번호 이동
- 현재 로그/전체 로그 literal·regex·대소문자·단어 단위 스트리밍 검색
- `Ctrl+O`, `Ctrl+F`, `Ctrl+Shift+F`, `Enter`, `Shift+Enter`, `F3`, `Shift+F3`, `Esc`
- 탐색용 검색과 판정 근거 분리: 사용자가 선택하지 않은 검색은 규칙이 되지 않음
- 두 개 이상의 marker에 대해 엔지니어가 명시한 앞뒤 순서 검사
- 모든 marker를 corpus당 한 번에 검사하고 first/last line provenance 보존
- `PASS`, `DIAG_FAIL`, `TEST_FAIL`, `TRAINING_FAIL`, `SYSTEM_HALT`, `SYSTEM_REBOOT`, `INCOMPLETE`, `UNKNOWN`, `EXCLUDED`
- 규칙 충돌·근거 누락·검색 실패는 추측하지 않고 `UNKNOWN/검토 필요`
- 예외 목록에서 이유 확인 후 가능한 경우 첫 근거 줄로 이동
- Results: 1 log = 1 row, 검색/필터/정렬, 200행 pagination, CSV와 Excel용 TSV
- 파일명/상대경로에서 Sample·온도·Mode 후보 추출, 후보를 클릭해 엔지니어 승인
- Patterns: 결과 분포, Sample/온도/Mode 피벗, cell marking → 필터된 로그 → 원문
- 판정·규칙·batch 결과·metadata 승인을 원자적 Evaluation DB의 immutable revision으로 보존
- 같은 경로의 파일 내용(SHA)이 바뀌면 이전 판정을 자동 상속하지 않고 새 revision을 검토 대상으로 분리

## 왜 LLM이 기본 경로에 없는가

대량 로그 import, 검색, 규칙 판정, 결과표, 패턴 집계는 전부 로컬 코드로 동작하며 LLM 호출 수는 기본 `0`입니다. 사내 OpenAI-compatible API는 사용자가 의미 설명을 명시적으로 요청할 때만 구조화되고 redacted된 evidence를 받습니다. 원문 전체, 절대경로, API key는 prompt에 넣지 않습니다.

지원하는 운영 조건:

- vLLM/OpenAI-compatible `/v1`
- Qwen, GLM 등 gateway가 제공하는 정확한 model ID
- Bearer API key
- RPM/TPM local queue
- timeout, 취소, 429/503 `Retry-After`, bounded retry
- 잘못된 JSON·빈 응답·2MiB 초과 응답의 안전한 실패
- LLM 장애 시 deterministic local fallback

Settings의 `연결 확인 · 모델 찾기`를 눌렀을 때만 `/models`를 한 번 조회합니다. 앱 시작, 폴더 import, 검색, 로컬 판정 시에는 조회하지 않습니다.

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| `SEQ_LLM_BASE_URL` | 없음 | 사내 OpenAI-compatible `/v1` URL |
| `SEQ_LLM_MODEL` | 없음 | served model ID |
| `SEQ_LLM_API_KEY` | 없음 | Bearer token |
| `SEQ_LLM_RPM` | `8` | 앱 프로세스별 분당 요청 제한 |
| `SEQ_LLM_TPM` | `80000` | 보수적으로 추정한 분당 token 제한 |
| `SEQ_LLM_TIMEOUT_MS` | `60000` | attempt별 timeout |
| `SEQ_LLM_MAX_RETRIES` | `2` | 일시 오류 최대 재시도 |

## 저장 구조와 보안

- Artifact DB: content hash 원본, 크기, 확장자, 안전한 source inventory
- Evaluation DB: 프로젝트별 엔지니어 판정, 규칙 revision, batch outcome/exception, metadata 승인
- localStorage: 기존 PoC 규칙과 UI 상태의 호환 계층

Evaluation DB에는 로그 원문·excerpt·절대경로·secret을 저장하지 않습니다. `sourceKey`는 main process에서 SHA-256 hash로 바꿔 저장하며, 판정은 정확한 artifact SHA와 결합됩니다. 손상되거나 지원하지 않는 DB는 덮어쓰지 않고 `.corrupt-*` 또는 `.unsupported-*` 백업으로 보존합니다. stale write는 `expectedRevision`으로 차단하고 한 번 재동기화합니다.

실제 회사 로그나 인증 정보를 저장소에 커밋하지 마세요. 회사의 데이터 분류·LLM 전송·코드 서명 정책이 이 앱의 기본 방어보다 우선합니다.

## 설치

일반 사용자는 Node.js가 필요하지 않습니다.

- Windows 10/11 x64: 위의 Setup 또는 Portable 다운로드
- macOS 12 이상: Intel과 Apple Silicon을 포함한 Universal DMG

자세한 내용은 [Windows 설치·제거 가이드](docs/manual/windows-installation.md)와 [macOS 설치 가이드](docs/manual/macos-installation.md)를 참고하세요.

경고 없는 조직 배포에는 다음이 필요합니다.

- Windows: 조직 신뢰 Authenticode code-signing certificate
- macOS: Apple Developer ID Application signing과 notarization

## 개발과 검증

요구 사항은 Node.js 22 LTS와 npm 10 이상입니다.

```bash
git clone https://github.com/stpcoder/sequence-control-tower.git
cd sequence-control-tower
npm ci
npm run dev
```

```bash
npm run typecheck
npm test
RUN_LOG_SCALE=1 npm test -- tests/domain/artifact-scale.test.ts
npm run build
npm run dist:win
npm run dist:mac
```

실장 SoC 회귀 자산은 `tests/fixtures/soc-logs/`에 있습니다. 정상 PASS뿐 아니라 DIAG/TEST/TRAINING fail, halt, reboot, marker 충돌·역순·누락, 온도/VDD 불일치, 잘못된 filename, NUL, CRLF, truncated/4MiB line 등 33개 시나리오를 포함합니다. 샘플은 실제 회사 데이터가 아닌 합성 데이터입니다.

## 배포 자동화

- `CI`: typecheck, tests, production build
- `Windows Release`: x64 NSIS Setup, Portable, ZIP, PE architecture/ZIP integrity/AuthentiCode 상태/SHA-256
- `macOS Release`: Universal DMG/ZIP, Intel+arm64 slice, minimum macOS 12, DMG/ZIP integrity/SHA-256

tag는 `package.json` 버전과 정확히 같아야 합니다.

```bash
git tag v0.4.0
git push origin v0.4.0
```

[Release 운영 가이드](docs/releasing.md)에서 코드 서명 secret과 수동 배포 절차를 확인할 수 있습니다.

## 현재 남은 범위

- 폴더 import의 세부 진행률/취소 UI
- 수 GB 로그를 반복 이동할 때 사용할 sparse line index
- metadata extractor 자체의 승인·편집과 여러 행 일괄 승인
- 실제 사내 VPN/private CA/vLLM endpoint 실기 연결
- 깨끗한 Windows 10/11 PC에서 설치·업데이트·제거 smoke test
- 조직 인증서를 사용한 Windows/macOS 서명 배포

실제 Serial 장비 제어와 원격 PC control tower는 이 버전의 주 경로가 아닙니다. 로그 분석 흐름이 먼저 현업 시간을 줄이는지 검증한 뒤 별도의 허용 명령·장비 식별·중단 정책을 갖춘 agent로 연결하는 것이 다음 단계입니다.
