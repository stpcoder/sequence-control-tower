---
layout: home
title: Sequence Control Tower 매뉴얼

hero:
  name: Sequence Control Tower
  text: 로그 분석 작업 매뉴얼
  tagline: 폴더 등록부터 검색, 판정, 결과 내보내기, Agent 분석, 평가 이력 저장까지 설명합니다.
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
    details: 조건을 가로·세로로 배치해 FAIL률을 확인하고, Excel용 표 또는 Spotfire용 원본 CSV로 공유합니다.
  - title: 평가 이력
    details: 평가 폴더의 목적, 결과, 조건, 정성 해석을 기록합니다.
---

## 기본 작업 순서

1. 프로젝트를 선택합니다.
2. 평가 로그가 들어 있는 폴더를 연결합니다.
3. 로그를 검색하고 판정 근거를 확인합니다.
4. 반복할 검색 조건을 분석 규칙으로 저장합니다.
5. 결과를 검토하고 표를 내보냅니다.
6. Agent의 해석을 확인하고 평가 이력에 저장합니다.

원본 `.log` 파일은 수정되지 않습니다. 프로젝트 설정, 검색 절차, 판정, Agent 대화, 평가 이력은 별도 데이터로 저장됩니다.
