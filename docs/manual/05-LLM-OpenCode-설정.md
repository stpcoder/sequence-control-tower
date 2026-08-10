# LLM·OpenCode 설정

## OpenAI-compatible LLM 연결

`설정`에서 다음 값을 입력합니다.

- `Base URL`: OpenAI-compatible API 주소
- `Model`: vLLM 또는 Gateway가 제공하는 model ID
- `API key`: 필요한 경우 입력
- `RPM`: 분당 요청 수
- `TPM`: 분당 token 수
- `응답 시간 (초)`: 한 요청의 제한 시간
- `Retries`: 재시도 횟수

`모델 목록 확인`은 사용자가 눌렀을 때만 `/models`를 조회합니다. 연결이 확인되면 `연결됨`으로 표시됩니다.

`응답 시간 (초)`는 5~300초 범위이며 기본값은 60초입니다. `TPM`은 1,201~10,000,000 범위이며 기본값은 80,000입니다. 최소값은 응답 예약 1,200토큰과 최소 프롬프트 1토큰을 합친 값입니다. `Retries`는 0~5 범위이며 기본값은 2입니다.

사내 vLLM의 GLM, Qwen과 같은 모델은 OpenAI-compatible chat completion과 tool calling을 지원하는 model ID를 사용합니다.

## Vertex AI 연결

Vertex AI의 OpenAI-compatible endpoint를 사용하는 경우 `Base URL`과 Vertex model ID를 입력합니다. macOS에서 활성 `gcloud` 계정 또는 Application Default Credentials가 있으면 앱이 기존 인증을 사용할 수 있습니다. 인증 정보가 없거나 만료되면 연결이 실패하며, 앱이 새 권한을 자동 생성하지 않습니다.

Gemini 3 계열은 global Vertex endpoint를 사용합니다. 조직 Gateway가 별도 주소를 제공하면 조직 주소를 우선 사용합니다.

OpenCode와 Vertex를 함께 사용할 때 앱은 Vertex endpoint의 project·location을 판별하여 OpenCode의 native `google-vertex` provider로 연결합니다. 이 경로는 Gemini 3 계열의 multi-step tool calling에 필요한 thought signature를 유지합니다. Vertex endpoint이지만 Application Default Credentials를 찾지 못하면 OpenAI-compatible 경로를 시도하고, 실패 시 내부 하네스로 전환합니다.

## 느린 LLM 처리

- RPM과 TPM을 호출 전에 로컬에서 예약합니다.
- 429, 일시 오류, timeout은 설정한 횟수만큼 재시도합니다.
- 실행 중에는 다른 페이지로 이동해도 대화가 프로젝트에 남습니다.
- 사용자가 `중지`할 수 있고, 실패한 요청은 `재시도`할 수 있습니다.
- 앱 재시작 시 실행 중이던 대화는 일시정지 상태로 복원됩니다.
- LLM이 끝내 실패해도 로컬 도구의 조건, 판정, 분모 결과는 보존됩니다.

## OpenCode 설치와 동작 확인

앱은 다음 순서로 OpenCode 실행 파일을 찾습니다.

1. `SEQ_OPENCODE_PATH`
2. 사용자 OpenCode 기본 설치 경로
3. 시스템 `PATH`

OpenCode가 있으면 입력창 아래 상태 점의 제목이 `OpenCode`로 표시됩니다. 질문 후 대화의 `근거`를 열어 `project_context_get`, `pass_fail_scan`, `failure_trends_get` 같은 도구가 실행됐는지 확인합니다. 한 답변에서 여러 단계로 호출한 도구도 같은 대화 기록에 합쳐집니다.

OpenCode 실행은 앱 전용 XDG 폴더로 격리됩니다. 개인 `~/.config/opencode` plugin, AGENTS.md, 명령 설정은 제품 Agent에 합쳐지지 않습니다. OpenCode가 실패하면 세션 backend가 내부 하네스로 바뀌고 같은 읽기 전용 도구로 요청을 완료합니다.

## 전송 범위와 보안

로컬에서 처리:

- 폴더 수집과 hash
- 검색과 정규식
- marker 판정
- 조건별 분자·분모 계산
- 규칙 적용과 내보내기

LLM에 전달:

- 사용자의 질문
- 프로젝트의 구조화된 조건과 이력 요약
- 선택한 source ID
- 검색으로 좁힌 최대 24줄 근거 구간

LLM에 전달하지 않음:

- 원본 로그 전체
- API key와 token
- 불필요한 절대경로

회사 데이터 분류 정책에서 외부 전송이 허용되지 않으면 사내 endpoint만 사용하십시오.
