<p align="center">
  <img src="build/icon.png" width="88" alt="Sequence Control Tower icon">
</p>

# Sequence Control Tower

**평가용 Git + Sequence Intelligence + 원격 실장기 Control Tower**를 하나의 Windows 데스크톱 경험으로 묶은 PoC입니다.

[![CI](https://github.com/stpcoder/sequence-control-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/stpcoder/sequence-control-tower/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/stpcoder/sequence-control-tower?display_name=tag&sort=semver)](https://github.com/stpcoder/sequence-control-tower/releases/latest)

[![Windows 설치형 다운로드](https://img.shields.io/badge/Windows-설치형_다운로드-0A66C2?style=for-the-badge&logo=windows11&logoColor=white)](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Setup.exe)
[![Windows 포터블 다운로드](https://img.shields.io/badge/Windows-포터블_다운로드-30363D?style=for-the-badge&logo=windows11&logoColor=white)](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Portable.exe)

[ZIP 다운로드](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/Sequence-Control-Tower-Windows.zip) · [SHA-256 확인](https://github.com/stpcoder/sequence-control-tower/releases/latest/download/SHA256SUMS.txt) · [모든 Release 보기](https://github.com/stpcoder/sequence-control-tower/releases)

> 이 저장소는 현재 private입니다. 다운로드하려면 `stpcoder/sequence-control-tower` 읽기 권한이 있는 GitHub 계정으로 로그인해야 합니다. 위 링크는 공개 배포 링크가 아니며, 외부 `shields.io` 최신 버전 배지는 private 저장소 정보를 표시하지 못할 수 있습니다.
>
> 저장소를 다른 GitHub 조직이나 이름으로 옮기면 위 배지와 다운로드 링크의 `stpcoder/sequence-control-tower`를 함께 변경해야 합니다.

처음 설치하거나 portable 배포판을 사용하려면 [Windows 설치 및 제거 가이드](docs/manual/windows-installation.md)를 먼저 확인하세요.

![Semantic Review — 평가 목적, 의미 기반 diff, 근거 기반 Finding](docs/images/manual-03-review.jpg)

## 왜 필요한가

평가 현장에는 이미 수많은 `.seq`가 있지만, 대개 “왜 이 Sequence를 만들었는가”, “어느 파일에서 파생됐는가”, “그 결과 무엇을 알게 됐는가”가 파일 안에 남아 있지 않습니다. Excel은 알고 있는 사실을 사람이 다시 입력해야 하고, Git diff는 바뀐 줄은 보여줘도 평가 의도와 결과의 의미까지 설명하지 못합니다.

Sequence Control Tower는 파일을 무리하게 해석하지 않습니다. 파일에서 확인된 사실, AI가 추론한 맥락, 엔지니어가 승인한 지식을 구분하고, 꼭 필요한 정보가 없을 때만 짧게 질문합니다.

```text
SEQ 수집 → 문법/조건 추출 → 유사 Sequence와 계보 탐색
        → 의미 기반 변경 요약 → 필요한 질문 → 엔지니어 승인
        → 프로젝트의 평가 기록과 다음 행동으로 축적
```

단순한 빨간색/초록색 diff가 아니라 다음의 **평가 서사**를 함께 보존하는 것이 목표입니다.

- 무엇을 확인하기 위해 평가했는가
- 이전 Sequence에서 어떤 조건을 왜 바꿨는가
- 어떤 결과와 이상 징후가 발생했는가
- 그 판단을 뒷받침하는 원본 근거는 어디인가
- 다음 평가에서는 무엇을 확인해야 하는가

## 현재 PoC 범위

Windows 앱에서 현재 실제로 연결된 기능은 다음과 같습니다.

- 파일·폴더 선택과 SHA-256 content-addressed 원본 보존
- 선택 사항인 짧은 사용자 코멘트를 포함한 분석 작업 등록과 상태 표시
- 로컬 TypeScript 엔진의 SEQ 문법 파싱, Sequence DNA·fingerprint 추출과 유사 후보 계산
- OpenAI-compatible API용 Electron backend queue, cache, timeout, RPM/TPM 제한과 deterministic fallback
- 원본 본문을 제외한 최소 evidence 구성과 identifier·secret의 deterministic redaction
- Base URL, model, API key의 로컬 저장과 환경 변수 override
- 가져온 파일, 분석 queue와 결과를 실제 Inbox·Semantic Review에 반영
- 유사 부모 후보, Sequence DNA, 의미 변경, 근거와 필요한 질문 표시
- 엔지니어 승인 내용을 로컬 Knowledge Wiki에 저장하고 Obsidian Markdown으로 내보내기
- 앱 재시작 시 content-addressed artifact와 Wiki 목록 복원

Project Tower와 Evaluation Agent 대화는 제품 방향을 검증하는 **sample data 기반 UX demo**입니다. Inbox·Semantic Review·Knowledge Cases는 실제 데이터가 있으면 그 결과를 우선 표시하고, 데이터가 없거나 분석 전이면 sample fallback을 보여줍니다. Equipment Console도 실제 장비가 아닌 **모니터링 simulation**입니다. 실제 Serial 제어, 원격 PC 연결, 전원·Flash·중단 기능은 이번 PoC 범위에 포함하지 않습니다.

### 1. Project Control Tower

고객사별 Campaign, Sequence revision, Run, Finding을 한 흐름으로 보는 목표 UX입니다. 현재 Project Tower는 sample project를 사용하며 실제로 가져온 파일의 계보를 자동 반영하는 단계는 아직 포함하지 않습니다.

### 2. Smart Intake

SEQ 파일 또는 폴더를 선택하고 “고온 fail 때문에 clk를 나눈 버전”처럼 짧은 메모를 남기면 원본을 보존하고 분석 queue에 등록합니다. 완료 상태와 LLM/fallback 여부, 추출 DNA, 유사 부모 후보, 필요한 질문을 같은 Inbox에서 확인할 수 있습니다.

### 3. Sequence Review

화면의 중심을 원시 line diff가 아니라 아래 네 가지로 구성했습니다. 실제 분석 항목을 선택하면 그 결과를 표시하며, 승인 버튼은 로컬 Knowledge Wiki 저장 API에 연결됩니다. 실제 데이터가 없을 때만 sample interaction을 보여줍니다.

- `Sequence DNA`: 온도, 전압, ECC, CLK, Pattern, Block 등 확인된 조건
- `Meaningful changes`: 실행 의미가 달라진 변경만 묶은 Semantic Diff
- `Agent brief`: 추정 목적, 근거, 확신도, 미확인 항목
- `Engineer decision`: 승인, 수정 또는 보류와 그 이유

AI 설명에는 추출 근거와 변경 항목을 연결하고, 모르는 목적은 `Unknown`으로 남깁니다. 사용자가 승인하기 전에는 `Verified` 지식으로 저장하지 않습니다.

### 4. Equipment Console

원격 데스크톱을 네 개씩 열지 않고 PC·slot별 핵심 상태를 요약하는 목표 UX입니다.

> Equipment Console의 상태는 모니터링 UX를 검증하기 위한 demo/simulation입니다. 실제 장비에서 전원, Flash, Serial 명령을 실행하기 전에는 Windows Equipment Agent, 대상 장비 식별, 허용 명령, 중단 조건을 별도 정책 계층으로 구현해야 합니다.

## AI를 쓰는 방식

사내 OpenAI-compatible API는 **설명과 질문이 실제 가치를 더할 때만** 사용합니다. 파싱, hash, 중복 제거, 유사도 후보 축소, 알려진 규칙 판정은 로컬 코드가 담당하는 것이 기본입니다.

```text
SEQ 원본
  └─ 로컬 parser로 facts와 변경 후보 추출
      └─ 사용자 코멘트 또는 부모 diff가 있을 때만 LLM 검토
          ├─ 원본 앞/뒤 및 임의 command 본문은 전송하지 않음
          ├─ redacted 파일명·project context·사용자 코멘트와 구조화된 evidence만 구성
          ├─ 구조 count·command family·facts·semantic changes 포함
          ├─ fact별 provenance는 최대 160자의 redacted 근거만 포함
          └─ API 사용 불가: 로컬 deterministic summary로 완료
```

이 분리는 사내 API의 TPM/RPM 제한과 특정 시간대의 긴 지연에도 UI가 멈추지 않게 하기 위함입니다. 전송 전 email, IP/MAC, UUID, serial/ADB ID, 긴 hex·identifier, 사용자 경로와 명시적 secret을 deterministic rule로 치환합니다. Redaction은 방어 계층이지 회사의 데이터 분류 정책을 대신하지 않으므로, 사내 LLM 전송이 허용된 SEQ만 분석해야 합니다.

## Windows에서 설치

일반 사용자는 Node.js를 설치할 필요가 없습니다. 위의 **Windows 설치형 다운로드** 또는 **포터블 다운로드**를 사용하세요. 배포판은 현재 코드 서명되지 않을 수 있으므로 다운로드 출처와 SHA-256을 확인한 뒤 회사 정책에 따라 실행해야 합니다.

설치형, SmartScreen, portable/ZIP, 업데이트와 제거 방법은 [Windows 설치 및 제거 가이드](docs/manual/windows-installation.md)에 정리돼 있습니다.

## 개발 환경에서 실행

요구 사항:

- Node.js 22 LTS
- npm 10 이상
- Windows 10/11 권장(개발 UI는 macOS/Linux에서도 실행 가능)

```bash
git clone https://github.com/stpcoder/sequence-control-tower.git
cd sequence-control-tower
npm ci
npm run dev
```

검증과 패키징:

```bash
npm run typecheck
npm test
npm run build
npm run dist:win
```

Windows 산출물은 `release/` 아래에 생성됩니다.

## 사내 OpenAI-compatible API 설정

앱의 **Settings → AI Gateway**에서 연결 정보를 입력하고 적용 중인 요청 정책을 확인합니다.

| 설정 | 예시 | 설명 |
|---|---|---|
| Base URL | `https://llm.company.local/v1` | OpenAI-compatible `/v1` endpoint |
| Model | 사내 제공 모델명 | Chat Completions에서 사용할 모델 |
| API Key | 사내 발급 키 | 로그나 저장소에 기록하지 않음 |
| Timeout | `60s` | 환경 변수로 관리하며 지연 시 요청을 해제하고 fallback/재시도 |
| RPM / TPM | 사내 할당량 | 환경 변수로 관리하며 요청 큐의 속도 제한에 사용 |

Base URL, model, API key는 Settings에서 저장할 수 있습니다. 운영 PC에서 중앙 관리하려면 환경 변수로 덮어쓸 수 있으며, 환경 변수로 관리되는 항목은 UI에 노출하더라도 사용자가 바꾸지 못하게 하는 것이 안전합니다.

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| `SEQ_LLM_BASE_URL` | 없음 | `/v1`을 포함한 compatible API base URL |
| `SEQ_LLM_MODEL` | 없음 | 사내 모델명 |
| `SEQ_LLM_API_KEY` | 없음 | Bearer API key |
| `SEQ_LLM_RPM` | `8` | 분당 최대 요청 수 |
| `SEQ_LLM_TPM` | `80000` | 분당 추정 token 한도 |
| `SEQ_LLM_TIMEOUT_MS` | `60000` | 요청 timeout(ms) |
| `SEQ_LLM_MAX_RETRIES` | `2` | 429/일시 오류 최대 재시도 횟수 |

API key는 Electron main process에서만 다루며 renderer로 반환하지 않습니다. OS 암호화 저장소를 사용할 수 없으면 평문으로 저장하지 않고 해당 실행 session에서만 유지합니다.

Settings의 상태 새로고침은 endpoint에 시험 요청을 보내지 않고 이 PC에 적용된 설정을 다시 읽습니다. 실제 연결은 Sequence 분석 요청에서 확인되며, 실패하면 로컬 deterministic summary로 완료됩니다. 인증서, proxy, endpoint 정책은 사내 보안 기준을 따르세요.

## 데이터와 보안 원칙

- 업로드된 원본 SEQ와 로그는 덮어쓰지 않고 content hash로 식별합니다.
- 추출된 사실과 AI 추론, 엔지니어 승인을 서로 다른 상태로 저장합니다.
- LLM에는 원본 Sequence 본문 대신 redacted 파일명·project context·사용자 코멘트, 구조 count, command family, 추출 facts, Semantic Change와 fact별 최대 160자의 redacted provenance만 전송합니다.
- API key, token, 장비 인증 정보는 Git, 화면 캡처, 진단 로그에 포함하지 않습니다.
- 외부 SaaS로 자동 업로드하지 않는 local-first 구성을 기본으로 합니다.
- Agent가 제안한 목적·부모·PASS/FAIL은 사람의 승인 전까지 확정 사실이 아닙니다.

샘플이나 실제 회사 데이터를 저장소에 커밋하지 마세요. Release를 배포하기 전에는 생성된 `SHA256SUMS.txt`와 회사의 코드 서명 정책을 함께 확인하세요.

## GitHub Actions와 Release

- `CI`: 모든 branch push와 Pull Request에서 Windows 기준 type-check, test, build를 실행합니다.
- `Windows Release`: `v*` tag push 또는 Actions의 수동 실행으로 NSIS 설치형, portable 실행 파일, ZIP, SHA-256 목록을 게시합니다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

수동 배포는 먼저 원격에 tag를 push한 뒤 GitHub의 **Actions → Windows Release → Run workflow**에서 같은 tag를 입력합니다. Workflow는 branch가 아니라 입력한 tag commit을 checkout해 빌드합니다. 고정된 asset 이름을 사용하므로 README의 최신 다운로드 버튼은 새 버전에서도 그대로 동작합니다.

모든 버전과 Release note는 [Releases](https://github.com/stpcoder/sequence-control-tower/releases)에서 확인할 수 있습니다.

버전 일치, 수동 배포와 Windows 코드 서명은 [Release 운영 가이드](docs/releasing.md)를 참고하세요.

## 사용자 매뉴얼

[Windows 설치 및 제거](docs/manual/windows-installation.md)와 화면별 빨간 박스 사용 가이드는 [docs/manual](docs/manual/README.md)을 참고하세요.

## 권장 다음 단계

PoC에서는 한 고객사 프로젝트의 대표 SEQ 100~300개로 아래를 먼저 검증하는 것이 좋습니다.

1. 주요 조건이 실제 문법에서 안정적으로 추출되는가
2. 부모·유사 Sequence 후보가 엔지니어 관점에서 납득되는가
3. Agent 질문 수가 적으면서도 분류 품질을 올리는가
4. 새 Sequence를 이해하고 기록하는 시간이 기존 Excel 대비 줄어드는가
5. 원격 PC 네 대의 현재 상태와 확인 필요 항목을 10초 안에 파악할 수 있는가

PoC의 성공은 “AI가 모든 목적을 맞혔다”가 아니라, **확실한 것은 자동으로 구조화하고 불확실한 것은 가장 적은 질문으로 확인해 다음 평가에서 재사용 가능한 지식으로 남겼는가**로 판단합니다.
