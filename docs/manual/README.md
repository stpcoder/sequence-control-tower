---
layout: home
title: Sequence Control Tower 매뉴얼

hero:
  name: Sequence Control Tower
  text: DRAM 불량 분석 작업 매뉴얼
  tagline: 로그 판정, 불량 경향, 원인 가설, 개선 평가와 프로젝트 이력을 한 흐름으로 설명합니다.
  actions:
    - theme: brand
      text: 설치와 프로젝트
      link: /01-설치와-프로젝트
    - theme: alt
      text: Agent 사용
      link: /05-Agent

features:
  - title: 로그 검색
    details: 긴 로그에서 문자열과 정규식을 찾고 결과 순서를 저장합니다.
  - title: 결과 정리
    details: 평가 결과와 실제 Fail address를 분리해 비교하고, 선택한 표·로그·주소 이벤트를 공유합니다.
  - title: 평가 이력
    details: 기준 평가, RT, 조건 비교, 개선, Side effect와 안정성 검증을 같은 불량 이슈에 연결합니다.
  - title: 불량 분석 Agent
    details: LPDDR 분석 Skill을 사용해 실패 단계, 조건별 불량률, Fail address와 기존 평가를 비교합니다.
---

## 기본 작업 순서

1. 프로젝트를 선택합니다.
2. 평가 로그가 들어 있는 폴더를 연결합니다.
3. 로그를 검색하고 판정 근거를 확인합니다.
4. 반복할 검색 조건을 분석 규칙으로 저장합니다.
5. 결과를 검토하고 표를 내보냅니다.
6. Agent가 제시한 원인 가설, 개선 점검과 다음 평가를 확인합니다.
7. 확정한 분석을 평가 이력과 다음 Harness에 저장합니다.

원본 `.log` 파일은 수정되지 않습니다. 프로젝트 설정, 검색 절차, 판정, Agent 대화, 평가 이력은 별도 데이터로 저장됩니다.
