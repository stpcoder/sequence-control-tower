# Settings와 AI 연결

![Settings 화면 — 빨간 박스 ① 사내 LLM 연결, ② rate/latency 보호](../images/manual-05-settings.jpg)

Settings에서는 사내 OpenAI-compatible API 정보를 저장하고 현재 적용 중인 사용량 제한을 확인합니다. AI 연결이 없어도 로그 import, 검색, 규칙 판정, 결과표와 패턴은 모두 사용할 수 있습니다.

## 처음 설정

1. **① AI Gateway**에 Base URL, model과 API key를 입력하고 `설정 저장`을 선택합니다.
2. 적용되는 RPM, TPM, timeout과 cache 정책을 확인합니다.
3. `연결 확인 · 모델 찾기`는 입력한 Base URL의 `/models`를 한 번만 조회합니다. 앱 시작이나 로그 import 때 자동 호출하지 않습니다.

## 권장 요청 정책

- timeout은 UI를 무기한 막지 않도록 30~90초 범위에서 시작합니다.
- RPM/TPM은 다른 사내 사용자와 공유되는 한도를 고려해 환경 변수 `SEQ_LLM_RPM`, `SEQ_LLM_TPM`으로 여유 있게 설정합니다.
- 대량 import 시 각 파일마다 호출하지 않고 유사 Family를 먼저 묶습니다.
- timeout 후 즉시 반복 호출하지 않고 exponential backoff와 jitter를 사용합니다.
- 동일한 분석 입력은 content hash 기반 cache를 재사용합니다.

운영 PC에서는 `SEQ_LLM_BASE_URL`, `SEQ_LLM_MODEL`, `SEQ_LLM_API_KEY`, `SEQ_LLM_TIMEOUT_MS`, `SEQ_LLM_MAX_RETRIES` 환경 변수로 설정을 중앙 관리할 수 있습니다. 환경 변수가 있으면 저장된 앱 설정보다 우선합니다.

## 보안 확인

- API key가 화면에 평문으로 계속 보이지 않는지 확인합니다.
- 설정 export, Markdown Wiki와 진단 로그에 key가 포함되지 않아야 합니다.
- 앱은 원본 본문을 보내지 않고 최소 evidence에 deterministic redaction을 적용합니다. 그래도 회사 데이터 분류·전송 정책을 먼저 확인합니다.
- Endpoint와 인증서 오류가 있을 때 인증 검증을 무시하지 말고 관리자에게 문의합니다.

## 연결 상태 의미

| 상태 | 의미 | 행동 |
|---|---|---|
| Configured | Base URL과 model 저장됨 | 사용자가 AI 분석을 명시적으로 요청할 때 사용 |
| Rate limited | RPM/TPM 초과 | queue의 다음 시각까지 대기 |
| Timed out | 제한 시간 내 응답 없음 | 제한 횟수 재시도 후 로컬 fallback 결과 확인 |
| Offline | endpoint 접근 불가 | URL/VPN/사내망 확인 |
| Not configured | 설정 없음 | 로컬 전용 모드로 사용 |
