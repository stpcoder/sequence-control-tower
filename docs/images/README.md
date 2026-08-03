# 매뉴얼 스크린샷 제작 사양

이 폴더에는 최종 앱 화면을 캡처한 뒤 빨간 박스와 번호를 추가한 이미지를 둡니다. 현재 Markdown 매뉴얼이 참조하는 파일은 다음과 같습니다.

| 파일 | 화면 | 빨간 박스 |
|---|---|---|
| `manual-00-log-workbench.jpg` | Log Workbench | ① 로그 폴더와 파일 ② 검색·근거 표시 ③ 판정·Recipe 저장 |
| `manual-01-project-tower.jpg` | Project Tower | ① 목적/핵심 판단 ② 평가 계보 ③ Knowledge gaps |
| `manual-02-intake.jpg` | Sequence Inbox | ① 파일/폴더 가져오기 ② 분류 대기함 ③ Agent 질문 |
| `manual-03-review.jpg` | Semantic Review | ① Change story ② Semantic Diff ③ Finding |
| `manual-04-equipment-console.jpg` | Equipment Console | ① 슬롯 상태 ② Run timeline ③ Live safety |
| `manual-05-settings.jpg` | Settings | ① 사내 LLM 연결 ② rate/latency 보호 |
| `manual-06-knowledge-cases.jpg` | Knowledge Cases | ① 승인된 지식 요약 ② 근거 사례 |
| `manual-07-agent-panel.jpg` | Evaluation Agent | ① 현재 context ② 근거 ③ 빠른 답변 ④ 입력/queue |

## 캡처 규격

- Windows 11 또는 macOS, 앱 창 1440×900 기준으로 캡처
- JPEG, 1× scale, 브라우저/디버거/개인 경로가 보이지 않게 정리
- 빨간색 `#E5484D`, 3px 실선, 8px radius
- 번호 원은 빨간 배경과 흰색 굵은 글자, 지름 28px
- 입력 대상은 실선, 확인 대상은 `6px 4px` 점선
- 박스는 실제 control에서 바깥쪽으로 6~10px 여백
- 하나의 이미지에 4개를 넘는 callout을 두지 않음
- 실제 고객사명, 제품명, Sequence, API key, 사내 URL은 demo data로 교체

각 이미지는 UI가 최종 확정된 뒤 생성합니다. 레이아웃이 바뀌면 기존 이미지를 억지로 편집하지 말고 같은 창 크기에서 다시 캡처하세요.
