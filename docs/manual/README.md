# Sequence Control Tower 사용자 매뉴얼

이 매뉴얼은 “버튼을 전부 설명하는 문서”가 아니라, 엔지니어가 새 Sequence를 기록하고 검토한 뒤 프로젝트 지식으로 남기는 가장 짧은 흐름을 안내합니다.

## 5분 시작 순서

1. [Windows 설치 및 제거](windows-installation.md)에 따라 설치형 또는 portable 앱을 준비합니다.
2. [Settings](05-settings.md)에서 사내 AI 연결과 적용 중인 사용량 제한을 확인합니다.
3. [Sequence Inbox](02-smart-intake.md)에 `.seq`를 추가하고 알고 있는 만큼만 짧게 코멘트합니다.
4. 분석 queue의 완료 또는 deterministic fallback 상태를 확인합니다.
5. [Semantic Review](03-sequence-review.md)에서 결과를 승인해 Wiki에 저장하고 [Knowledge Cases](06-knowledge-cases.md)에서 Markdown으로 내보냅니다. [Project Tower](01-project-control-tower.md)와 [Evaluation Agent](07-agent-interaction.md)는 향후 연결할 평가 지식 UX를 보여줍니다.
6. [Equipment Console](04-equipment-console.md)에서 원격 PC/실장기 모니터링 simulation을 확인합니다.

## 화면 표기 규칙

매뉴얼 스크린샷의 빨간 박스와 번호는 “먼저 확인하거나 조작할 곳”만 표시합니다. 장식 요소와 단순 상태 아이콘에는 번호를 붙이지 않습니다.

| 표기 | 의미 |
|---|---|
| 빨간 실선 박스 | 사용자가 클릭하거나 입력해야 하는 영역 |
| 빨간 점선 박스 | 결과를 반드시 확인해야 하는 영역 |
| `① ② ③` | 권장 조작 순서 |
| 회색 `참고` | 선택 사항 또는 고급 정보 |

지식 상태는 다음 의미로 사용합니다.

| 상태 | 의미 | 사용자의 행동 |
|---|---|---|
| Extracted | 파일에서 직접 확인한 사실 | 원문 근거가 맞는지 확인 |
| Inferred | Agent가 맥락으로 추론한 내용 | 승인·수정·보류 중 선택 |
| Verified | 엔지니어가 확인한 지식 | 이후 유사 Sequence에 재사용 |
| Unknown | 현재 자료로 알 수 없음 | 필요할 때만 질문에 답변 |

## PoC 범위

현재 PoC는 파일/폴더 import, SHA-256 원본 보존, 로컬 SEQ 분석, 최소 evidence redaction, 사내 LLM queue와 fallback, 실제 Inbox·Semantic Review, 승인형 Wiki 저장과 Markdown 내보내기까지 Windows UI에 연결합니다. 이 화면들은 실제 데이터가 없을 때만 sample fallback을 표시합니다. Project Tower와 Evaluation Agent 대화는 sample data 기반 UX demo이고, Equipment Console도 실제 Serial 제어가 아닌 **모니터링 UX simulation**입니다. 실제 장비 제어에는 별도의 Windows Equipment Agent와 안전 정책이 필요합니다.

## 문제 해결

- AI 응답이 늦어도 화면을 닫거나 파일을 다시 올릴 필요가 없습니다. 로컬 분석 결과는 먼저 저장되고 AI 작업은 queue 상태로 남아야 합니다.
- 같은 파일을 다시 올렸다면 SHA-256이 동일한 원본은 중복 저장하지 않고 기존 기록으로 안내합니다.
- 추론이 틀렸다면 단순히 삭제하기보다 수정 또는 보류 사유를 남겨야 이후 제안이 개선됩니다.
- 원본 SEQ, 로그, API key가 포함된 화면은 외부 공유용 스크린샷에 노출하지 마세요.
