# 엔지니어 워크플로 corpus 검증

## 목적

`tests/fixtures/engineer-workflow/`는 엔지니어의 반복 검증 흐름을 고정하는 결정적 합성 로그 corpus다. 다음 항목을 검증한다.

- 샘플·온도·모드·실행 번호 축의 조합
- 부트 단계별 결과 판정
- 같은 조건의 Run1→Run2 전이 판정
- 결과 라벨과 filename metadata의 일치

manifest는 [`tests/fixtures/engineer-workflow/manifest.json`](../../tests/fixtures/engineer-workflow/manifest.json)이다.

## 축과 filename

축은 다음 값으로 고정한다.

| 축 | 값 |
| --- | --- |
| sample(자재) | `DHCST-89`, `DHCST-90`, `DHCST-91`, `DHCST-92` |
| temperature | `-40C`, `25C`, `85C` |
| mode | `DIAG`, `STRESS` |
| run | `1`, `2` |

filename 형식은 다음과 같다.

```text
26-08-20-09-00-01_UTF02A-2_Ch8_SM8975_1_-40_0.75_EVA_EN_SKEW-SS_TM-DIAG_RUN1_9600MHZ_COM74_DHCST-89_C_SystemHalt.log
```

파일명은 `날짜_UTF02A-2_실장기채널_SoC_평가번호_온도_전압_EVA_ECC_사용자조건_주파수_COM_자재_평가Step_결과.log` 순서다. `sample`과 `자재`는 같은 값으로 취급한다.

각 `sample|temperature|mode` 조합은 `comparisonKey`가 되며 Run1과 Run2가 한 쌍을 이룬다. 전체 수량은 `4 × 3 × 2 × 2 = 48`개다.

## 정확한 48개 matrix

표의 각 행은 두 fixture를 나타낸다. `Run1 결과`와 `Run2 결과`를 합쳐 48개 fixture의 기대 결과를 명시한다.

| sample | temperature | mode | Run1 결과 | Run2 결과 | pairTransition |
| --- | --- | --- | --- | --- | --- |
| `DHCST-89` | `-40C` | `DIAG` | `SYSTEM_HALT` | `PASS` | `RECOVERY` |
| `DHCST-89` | `-40C` | `STRESS` | `PASS` | `PASS` | `STABLE_PASS` |
| `DHCST-89` | `25C` | `DIAG` | `DIAG_FAIL` | `PASS` | `RECOVERY` |
| `DHCST-89` | `25C` | `STRESS` | `PASS` | `TEST_FAIL` | `REGRESSION` |
| `DHCST-89` | `85C` | `DIAG` | `TRAINING_FAIL` | `TRAINING_FAIL` | `STABLE_FAILURE` |
| `DHCST-89` | `85C` | `STRESS` | `SYSTEM_REBOOT` | `PASS` | `RECOVERY` |
| `DHCST-90` | `-40C` | `DIAG` | `TEST_FAIL` | `PASS` | `RECOVERY` |
| `DHCST-90` | `-40C` | `STRESS` | `PASS` | `SYSTEM_REBOOT` | `REGRESSION` |
| `DHCST-90` | `25C` | `DIAG` | `INCOMPLETE` | `PASS` | `RECOVERY` |
| `DHCST-90` | `25C` | `STRESS` | `SYSTEM_HALT` | `SYSTEM_HALT` | `STABLE_FAILURE` |
| `DHCST-90` | `85C` | `DIAG` | `UNKNOWN` | `PASS` | `RECOVERY` |
| `DHCST-90` | `85C` | `STRESS` | `PASS` | `PASS` | `STABLE_PASS` |
| `DHCST-91` | `-40C` | `DIAG` | `PASS` | `PASS` | `STABLE_PASS` |
| `DHCST-91` | `-40C` | `STRESS` | `DIAG_FAIL` | `DIAG_FAIL` | `STABLE_FAILURE` |
| `DHCST-91` | `25C` | `DIAG` | `TRAINING_FAIL` | `PASS` | `RECOVERY` |
| `DHCST-91` | `25C` | `STRESS` | `PASS` | `INCOMPLETE` | `REGRESSION` |
| `DHCST-91` | `85C` | `DIAG` | `TEST_FAIL` | `SYSTEM_HALT` | `STABLE_FAILURE` |
| `DHCST-91` | `85C` | `STRESS` | `PASS` | `PASS` | `STABLE_PASS` |
| `DHCST-92` | `-40C` | `DIAG` | `SYSTEM_REBOOT` | `PASS` | `RECOVERY` |
| `DHCST-92` | `-40C` | `STRESS` | `PASS` | `PASS` | `STABLE_PASS` |
| `DHCST-92` | `25C` | `DIAG` | `SYSTEM_HALT` | `SYSTEM_REBOOT` | `STABLE_FAILURE` |
| `DHCST-92` | `25C` | `STRESS` | `UNKNOWN` | `UNKNOWN` | `STABLE_FAILURE` |
| `DHCST-92` | `85C` | `DIAG` | `INCOMPLETE` | `INCOMPLETE` | `STABLE_FAILURE` |
| `DHCST-92` | `85C` | `STRESS` | `PASS` | `PASS` | `STABLE_PASS` |

manifest의 결과 수량은 `PASS 23`, `DIAG_FAIL 3`, `TEST_FAIL 3`, `TRAINING_FAIL 3`, `SYSTEM_HALT 5`, `SYSTEM_REBOOT 4`, `INCOMPLETE 4`, `UNKNOWN 3`이다. 전이 수량은 `RECOVERY 16`, `STABLE_PASS 12`, `REGRESSION 6`, `STABLE_FAILURE 14`이다.

## 부트 단계 의미

로그의 marker는 다음 순서와 의미를 사용한다.

| 단계 | marker | 의미 |
| --- | --- | --- |
| 전원 인가 | `POWER_ON state=asserted;` | 전원 시퀀스가 시작됐다. |
| 펌웨어 진입 | `UEFI entry firmware=SYN-UEFI-01;` | 펌웨어 진입이 기록됐다. |
| UEFI handoff | `ExitBootServices status=success;` | UEFI에서 OS로 제어권을 넘겼다. |
| OS boot start | `OS boot start loader=SYN-OS-01;` | OS 부트 단계가 시작됐다. |
| test stage | `stressapp start`, `stressapp heartbeat` | 테스트 실행과 heartbeat가 기록됐다. |
| HIDAG 실행 | `HIDAG START mode={mode};` | 요청 모드의 HIDAG 실행이 시작됐다. |
| 정상 종료 | `HIDAG END result=PASS;`, `@PASS;` | 테스트와 로그 캡처가 정상 종료됐다. |

`UNKNOWN`은 UEFI handoff 이후의 종료 증거가 부족하거나 캡처가 모호한 상태다. `SYSTEM_HALT`는 `UEFI_HANDOFF` 또는 `HIDAG_EXECUTION`에서 정지한 상태다. `INCOMPLETE`는 `CAPTURE_STOPPED`가 기록되고 terminal 결과가 없는 상태다. `SYSTEM_REBOOT`는 `WATCHDOG_RESET`과 `SYSTEM_REBOOT`가 기록된 상태다.

## outcome 정의

| outcome | 정의 |
| --- | --- |
| `PASS` | stressapp 완료, `HIDAG END result=PASS`, `@PASS`가 기록됐다. |
| `DIAG_FAIL` | `HIDAG_DIAGNOSTIC` 단계에서 `DIAG_FAIL`이 기록됐다. |
| `TEST_FAIL` | `STRESSAPP_MEMORY` 단계에서 `TEST_FAIL`이 기록됐다. |
| `TRAINING_FAIL` | `DDR_TRAINING` 단계에서 `TRAINING_FAIL`이 기록됐다. |
| `SYSTEM_HALT` | `UEFI_HANDOFF` 또는 `HIDAG_EXECUTION`에서 정지 증거가 기록됐다. |
| `SYSTEM_REBOOT` | `WATCHDOG_RECOVERY` 단계의 watchdog reset과 reboot가 기록됐다. |
| `INCOMPLETE` | `CAPTURE_STOPPED`가 기록되고 terminal 결과가 없다. |
| `UNKNOWN` | `UNCLASSIFIED_CAPTURE_END`와 ambiguous capture 상태가 기록됐다. |

## Run1·Run2 전이 의미

Run1과 Run2는 같은 `comparisonKey`의 두 실행이다. `pairTransition`은 두 결과를 순서대로 계산한다.

| pairTransition | 조건 | 의미 |
| --- | --- | --- |
| `STABLE_PASS` | `PASS → PASS` | 두 실행이 모두 PASS다. |
| `RECOVERY` | `non-PASS → PASS` | Run2에서 PASS로 회복됐다. |
| `REGRESSION` | `PASS → non-PASS` | Run2에서 PASS가 유지되지 않았다. |
| `STABLE_FAILURE` | `non-PASS → non-PASS` | 두 실행 결과가 `PASS` 이외 label이다. |

## 개인정보 경계

허용 데이터는 generator가 만든 결정적 합성값이다. sample ID, firmware ID, bank, lane, 주소, 온도, 전압, mode, 결과 label은 테스트 전용 값이다.

금지 데이터:

- 생산 로그와 실제 장비 식별자
- 고객·조직·사내 프로젝트 정보
- 실제 메모리 주소, secret, token, 인증 정보
- vendor 원문 로그의 복사본

fixture에 새 사례를 추가할 때도 합성값과 manifest oracle만 사용한다.

## 재생성

generator는 지정한 출력 디렉터리를 초기화한다. 체크인 fixture 경로를 지정하지 말고, 다음처럼 새 임시 디렉터리를 명시한다.

```sh
OUT_DIR="$(mktemp -d /tmp/engineer-workflow-corpus.XXXXXX)"
node tests/fixtures/generators/generate-engineer-workflow-corpus.mjs --output "$OUT_DIR"
echo "Generated corpus: $OUT_DIR"
```

기대 출력은 임시 디렉터리 안의 `.log` 48개와 `manifest.json` 1개다.

## 집중 테스트

로그 단계·결과 판정 회귀 테스트:

```sh
npx vitest --config tests/domain/vitest.config.ts run tests/domain/soc-log-scenarios.test.ts
```

## Qualcomm parser corpus와의 차이

| 항목 | 이 corpus | Qualcomm parser corpus |
| --- | --- | --- |
| 규모 | 48개 fixture, 24개 Run1·Run2 쌍 | 160개 fixture, 10개 scenario family |
| 중심 축 | sample × temperature × mode × run | scenario family × variant, filename·환경 변형 포함 |
| 검증 초점 | 부트 단계, 결과 label, Run1→Run2 전이 | UEFI·OS 실패, stale/conflict, 다중 실행, metadata mismatch, memory record parser |
| 결과 집합 | `PASS`, `DIAG_FAIL`, `TEST_FAIL`, `TRAINING_FAIL`, `SYSTEM_HALT`, `SYSTEM_REBOOT`, `INCOMPLETE`, `UNKNOWN` | `PASS`, `TEST_FAIL`, `UEFI_FAIL`, `SYSTEM_HALT`, `UEFI_EXIT_FAIL`, `OS_PANIC`, `INCOMPLETE`, `SYSTEM_REBOOT`, `UNKNOWN` |
| parser 연동 | workflow 결과와 pair oracle 검증 | stressapptest·tSKHYNIX grammar와 reference parser oracle 검증 |

Qualcomm parser corpus의 상세 문서는 [`docs/testing/qualcomm-synthetic-corpus.md`](qualcomm-synthetic-corpus.md)다.
