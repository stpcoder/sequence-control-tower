# Sequence Control Tower 사용자 매뉴얼

이 매뉴얼은 “버튼을 전부 설명하는 문서”가 아니라, 엔지니어가 새 Sequence를 기록하고 검토한 뒤 프로젝트 지식으로 남기는 가장 짧은 흐름을 안내합니다.

## 5분 시작 순서

1. [Settings](05-settings.md)에서 데이터 저장 위치와 사내 AI 연결을 확인합니다.
2. [Sequence Inbox](02-smart-intake.md)에 `.seq`를 추가하고 알고 있는 만큼만 짧게 코멘트합니다.
3. [Semantic Review](03-sequence-review.md)에서 추출 사실, 추론, 미확인 정보를 구분해 검토합니다.
4. 의미 있는 부모 후보와 변경 이유만 승인합니다. 모르는 항목은 억지로 채우지 않습니다.
5. [Project Tower](01-project-control-tower.md)에서 Sequence가 평가 흐름에 올바르게 연결됐는지 확인합니다.
6. [Equipment Console](04-equipment-console.md)에서 원격 PC/실장기 모니터링 UX를 확인합니다.
7. 승인된 사례는 [Knowledge Cases](06-knowledge-cases.md)에서 찾고, 필요한 순간에는 [Evaluation Agent](07-agent-interaction.md)와 짧게 대화합니다.

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

현재 PoC는 SEQ 파싱, Sequence DNA, 유사도, Semantic Diff, 부모 후보, 로컬 저장, Markdown Wiki export와 AI review 흐름을 검증합니다. Equipment Console은 실제 Serial 제어가 아닌 **모니터링 UX 시뮬레이션**입니다. 실제 장비 제어에는 별도의 Windows Equipment Agent와 안전 정책이 필요합니다.

## 문제 해결

- AI 응답이 늦어도 화면을 닫거나 파일을 다시 올릴 필요가 없습니다. 로컬 분석 결과는 먼저 저장되고 AI 작업은 queue 상태로 남아야 합니다.
- 같은 파일을 다시 올렸다면 SHA-256이 동일한 원본은 중복 저장하지 않고 기존 기록으로 안내합니다.
- 추론이 틀렸다면 단순히 삭제하기보다 수정 또는 보류 사유를 남겨야 이후 제안이 개선됩니다.
- 원본 SEQ, 로그, API key가 포함된 화면은 외부 공유용 스크린샷에 노출하지 마세요.
