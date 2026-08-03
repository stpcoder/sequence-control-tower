# 합성 SoC 실장 평가 로그 시나리오

`tests/fixtures/soc-logs/`는 고객사·실장기·자재 정보를 전혀 포함하지 않는 합성 corpus다. 목표는 다음의 반복 업무를 안전하게 재현하는 것이다.

1. 여러 폴더에서 로그를 읽는다.
2. Notepad++에서 하던 marker 검색과 순서 확인을 로컬 evidence로 남긴다.
3. 검증된 Recipe가 있을 때만 PASS/FAIL 계열을 판정한다.
4. Excel/Spotfire로 옮기기 전에 filename·환경·판정 근거·검토 대상을 한 행으로 만든다.

## Corpus와 실행

- 물리 `.log`: 32개
- manifest 시나리오: 33개 (4 MiB 초과 단일 행은 generator 1개)
- manifest: [`tests/fixtures/soc-logs/manifest.json`](../../tests/fixtures/soc-logs/manifest.json)
- 검증: `npx vitest --config tests/domain/vitest.config.ts run tests/domain/soc-log-scenarios.test.ts`

4 MiB 초과 행은 저장소 크기를 키우지 않는다. 필요할 때 다음처럼 생성한다.

```sh
node tests/fixtures/soc-logs/generators/over-4mib-single-line.mjs /tmp/over-4mib.log
```

## Coverage

| 영역 | 시나리오 | 기대 처리 |
| --- | --- | --- |
| 정상 완료 | 7개, Unicode·공백 경로와 다양한 filename delimiter 포함 | `PASS` |
| 명시적 실패 | DIAG, TEST/TR, TRAINING | 각 fail label |
| 실행 중단 | stressapp 후 HIDAG terminal marker 부재 | 검증된 rule에서만 `SYSTEM_HALT` |
| 재시작 | watchdog/power-cycle의 명시적 reboot marker | `SYSTEM_REBOOT` |
| 터미널 marker 위험 | PASS/FAIL 동시, stale marker, 역순, bare `@FAIL` | `UNKNOWN` + 검토 |
| 환경 조건 | target/readback 온도·전압, mode 미삽입 | PASS 여부와 별도로 검토 후보 |
| 캡처 품질 | truncated tail, 빈 로그, binary NUL, CRLF, 4 MiB 초과 행 | `INCOMPLETE` 또는 fail-closed `UNKNOWN` |
| 출처 보존 | 같은 content / 다른 sample·파일명 | content 1개 + source row 2개 |
| 파일명 | `__`, `--`, `.`, `-`, `+`, nested path, malformed | metadata rule 후보 및 검토 대상 |

Manifest에는 각 파일의 `expected.result`, `expected.needsReview`, metadata, marker 존재/부재, marker 순서, 위험 이유가 들어 있다. 그러므로 나중에 고객사별 recipe를 추가해도 raw log를 LLM에 보내지 않고 그 recipe의 회귀 검증에 재사용할 수 있다.

## 현재 제품에 의도적으로 남긴 safety gap

아래는 자동 PASS/FAIL로 만들면 위험한 사례다. Fixture가 먼저 이 gap을 고정하며, UI 또는 Recipe 엔진에서 해당 guard가 구현되기 전에는 반드시 검토 대상으로 유지해야 한다.

| Gap | 위험한 이유 | 필요한 제품 기능 |
| --- | --- | --- |
| `BOOT_COMPLETE`가 두 번 | marker 존재만으로는 정상 재시작인지 stale log concat인지 알 수 없다 | marker count 비교와 run/session segmentation |
| filename의 TEMP/VDD와 readback 불일치 | `@PASS`가 있어도 조건 자체가 틀렸을 수 있다 | metadata ↔ log value 비교 constraint, tolerance 설정 |
| `MODE_INSERTED=0` | 완료 marker가 mode 적용 실패를 숨긴다 | negative signal precedence 및 required-mode check |
| `INCOMPLETE` | terminal result 부재가 재시도 가능한 캡처 오류인지 장비 halt인지 다르다 | INCOMPLETE를 review queue로 보내는 정책 |
| stale PASS/FAIL | 파일 append 또는 이전 실행의 marker가 뒤섞일 수 있다 | test-start anchor 이후 terminal marker만 허용하는 run boundary |

이 문서의 rule 예시는 고객사 공통 규칙이 아니다. 현업 엔지니어가 marker와 precedence를 확인해 `candidate`에서 `verified`로 승격한 경우에만 자동 판정에 쓰는 것이 원칙이다.
