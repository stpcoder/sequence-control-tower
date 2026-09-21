# LLM과 OpenCode

## LLM 연결

`설정`에서 다음 값을 입력합니다.

- API 주소
- 모델 ID
- API 키 또는 인증 토큰
- 분당 요청 수 (RPM)
- 분당 토큰 수 (TPM)
- 응답 제한 시간
- 재시도 횟수

![LLM 설정](./images/08-settings.jpg)

`저장`을 누른 뒤 `모델 확인`을 실행합니다. 사내 vLLM, OpenAI-compatible API, Vertex AI OpenAI-compatible 엔드포인트를 사용할 수 있습니다.

`모델 확인`은 `GET /models` 연결만 검사합니다. 실제 분석은 `POST /chat/completions`를 사용하므로 모델 목록이 보여도 Chat Completions 권한이나 응답 형식이 맞지 않으면 분석은 실패할 수 있습니다.

## 느린 LLM 처리

- 요청 시작 상태를 즉시 표시합니다.
- 분석은 백그라운드에서 실행합니다.
- 실행 중 화면을 이동할 수 있습니다.
- timeout과 429 응답은 설정된 횟수만큼 재시도합니다.
- 재시도와 최종 실패에는 HTTP 상태, 서버 오류 코드와 메시지를 표시합니다. API 키와 토큰은 가려집니다.
- 실패한 분석은 같은 세션에서 다시 시도할 수 있습니다.
- 로컬 검색, 규칙, 판정, 내보내기는 LLM 없이 사용할 수 있습니다.

## OpenCode

앱은 `SEQ_OPENCODE_PATH`, 사용자 설치 경로, 시스템 `PATH` 순서로 OpenCode를 찾습니다. OpenCode Agent가 앱의 읽기 전용 분석 도구를 여러 단계로 호출합니다. OpenCode가 한 요청에서 시작되지 않으면 같은 세션의 호환 경로가 로컬 도구 근거를 보존하며, 다음 요청에서 다시 OpenCode를 사용합니다.

OpenCode는 앱에 포함된 `lpddr-failure-analysis` Skill을 사용합니다. Skill에는 Sample–Skew–Grid–Sequence 구조, Qualcomm/MediaTek 부팅 단계, Hdiag 판정, Fail address, RT, 가속·개선·Side effect 검증 기준이 들어 있습니다.

자유 질문, 결과 정리와 평가 이력 제안은 하나의 OpenCode 대화에서 이어집니다. Agent는 같은 프로젝트 평가 폴더 ID와 source 범위를 유지하며, 구조화된 평가안도 같은 대화에서 생성합니다.

답변의 `확인 과정`을 열면 실행한 도구와 결과 요약을 확인할 수 있습니다.

## 전송 범위

LLM에는 사용자 질문, 구조화된 프로젝트 조건, 도구가 조회한 근거를 전달합니다. 앱은 200K 컨텍스트 모델을 기준으로 요청을 구성하며 지원 범위 안의 대화나 폴더 로그를 조용히 잘라내지 않습니다. 범위를 넘으면 일부만 분석하지 않고 오류를 표시합니다. 원본 로그 전체, API 키, 토큰, 불필요한 절대경로는 전달하지 않습니다.
