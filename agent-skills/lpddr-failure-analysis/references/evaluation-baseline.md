# LPDDR 평가 및 불량분석 기준

## 1. 데이터 계층

- 프로젝트: 같은 제품·고객·개발 목표의 전체 이력이다.
- 평가 폴더: 재현, 가속 조건, 개선 조건, Side effect, 안정성 확인 등 하나의 평가 목적을 담는다.
- Sample: 실제 평가 자재다. 이 시스템에서 `자재`와 `Sample`은 같은 식별자이며 별도 축으로 세지 않는다. Lot와 Die는 별도 값으로 함께 보존한다.
- SKEW: 기본 corner는 TT, SS, SF, FS, FF다. 프로젝트에 따라 일부만 사용하거나 다른 표기를 사용할 수 있다.
- Grid: 한 번 전원을 인가해 부팅, Training, 테스트를 수행하고 종료하는 단위다.
- Sequence: Grid에서 실행할 명령 순서와 온도, VDD, 주파수, Test Mode를 정한다.

SKEW별 Sample 수와 반복 횟수는 같다고 가정하지 않는다. 로그 파일과 Grid의 관계도 확인 없이 1:1로 가정하지 않는다.

### 위치형 파일명

`..._Ch8_SM8975_1_25_1.00_EVA_EN_DEFAULT_5333MHZ_COM74_DHCST-89_C_Pass.log` 형식은 다음처럼 읽는다.

- `Ch8`: 실장기 채널. Hdiag 본문의 DRAM Fail Channel과 다르다.
- `SM8975`: SoC, `1`: 평가 번호/Grid 후보, `25`: 온도, `1.00`: VDD
- `EVA`: 내부 구분값으로 분석 축에서 제외, `EN`: ECC
- `DEFAULT_5333MHZ`: 사용자 조건, `COM74`: PC 포트이므로 분석에서 제외
- `DHCST-89`: 자재(Sample), `C`: 평가 Step, `Pass`: 결과

파일명 마지막 결과는 Pass, HdiagReboot, MbeFail, Fail 등을 정규화하되, 로그 본문에 더 강한 실패 근거가 있으면 본문 판정을 우선한다.

## 2. Grid 조건

각 Grid에서 다음 값을 독립적으로 기록한다.

- Sample, SKEW, Lot, Die
- 실장기 벤더와 SoC/보드 모델
- 온도 수치와 Hot/Room/Cold 조건
- VDD 수치와 HVDD/NVDD/LVDD 조건
- 주파수와 주파수 고정 명령
- Test Mode와 적용 명령
- Sequence signature와 반복 번호

4-Corner는 명시된 프로젝트 정의가 없으면 다음 조합으로만 사용한다.

- HH: Hot + HVDD
- CH: Cold + HVDD
- HL: Hot + LVDD
- CL: Cold + LVDD

숫자 온도나 VDD만으로 corner를 임의 분류하지 않는다.

## 3. 부팅과 Training

- Qualcomm: Power on → Training → UEFI → OS 순서를 기본 profile로 사용한다. UEFI에서 DTVS/VDD/Test Mode를 설정하고 erase DDR, reset 후 적용하는 Sequence가 있을 수 있다.
- MediaTek: Power on → Training과 Post-PBL/LK/LK2 → OS 계열 profile을 사용한다. 실제 보드 profile의 marker 순서를 우선한다.
- Training Fail은 UEFI 또는 LK 계열 이후 테스트 실패가 아니라, OS 진입 전 메모리 초기화 실패로 분리한다.

서로 다른 벤더의 stage를 억지로 대입하지 않는다.

## 4. Hdiag 결과와 Fail 주소

종료 상태를 PASS, TEST/DIAG FAIL, TRAINING FAIL, SYSTEM HALT, SYSTEM REBOOT, INCOMPLETE로 분리한다. Hdiag가 시작됐지만 @PASS/@FAIL 없이 로그가 끝나면 Halt 후보로 둔다.

Fail 본문에서 다음 값을 event 단위로 추출한다.

- Channel, Sub Channel, CS, BK/Bank, RK/Rank, BG/Bank Group
- Row, Col/Column
- WR, RD
- DQ, BL

조건별 FAIL률과 Fail-address 분포는 다른 통계다. 예를 들어 `Cold 4/5 FAIL`은 평가 조건 경향이고 `DQ0,1,2가 12/18 fail events`는 실패 위치 분포다. 두 분모를 섞지 않는다.

## 5. 분석 진행 순서

1. 최초 불량의 Sample, SKEW, Sequence, Grid 조건과 종료 상태를 확정한다.
2. 같은 Sample·Sequence·조건으로 RT를 수행해 재현성을 확인한다.
3. 온도, VDD, 주파수, Pattern 등의 가속 조건을 비교한다.
4. Test Mode 등 개선 조건을 적용해 기존 Fail signature가 줄었는지 확인한다.
5. 기존 DQ0/1/2가 사라져도 DQ5/6 등 새로운 signature가 생기면 Side effect 후보로 기록한다.
6. 개선 조건에서 목표 Sample/SKEW 범위를 반복 평가해 안정적인 전체 PASS를 확인한다.

Cold에서 악화되면 Hot 비교는 반증 조건이 될 수 있지만, 한 번의 반대 결과만으로 원인을 확정하지 않는다.

## 6. 계산과 표현

- 로그 파일 수: 수집된 `.log` 파일 수다. 평가 횟수나 Grid 수로 바꿔 부르지 않는다.
- Grid 수: 명시적 Grid 경계나 Grid ID가 확인된 평가 단위 수다. 로그 파일과 1:1로 가정하지 않는다.
- Sample 수: 중복 Sample ID를 제외한 수다.
- FAIL률: FAIL / (PASS + FAIL 확정 평가)다. UNKNOWN과 INCOMPLETE는 제외한다.
- Sample/SKEW coverage: SKEW별 Sample 수, 평가 횟수, PASS, FAIL, 미확인을 함께 표시한다.
- Fail-address event share: 특정 값의 event 수 / 추출된 전체 fail-address event 수다. 포함된 로그 수도 같이 표시한다.

원인과 상관관계를 구별한다. 단순 집중은 가설이며, 반대 조건과 반복 평가가 있어야 개선 또는 기인을 확정할 수 있다.

## 7. 평가 이력 관계

- 불량 이슈: 동일하거나 강하게 연관된 Fail signature를 설명하는 가설이다. 평가 목적이 아니라 불량 단위다.
- 평가 노드: 연결 폴더 하나에 대응하는 한 번의 평가다.
- 기준 평가: 현재 프로젝트에 저장된 이슈의 시작점이다. 선행 기록이 없을 뿐이며 최초 불량이라고 단정하지 않는다.
- 최초 불량: 실제 최초 발생 로그나 엔지니어 확인이 있을 때만 사용하는 별도 의미다.
- 동일 조건 RT: 같은 Sample, Sequence, 조건으로 앞선 FAIL을 반복한 평가다.
- 가속·조건 비교: 온도, VDD, 주파수, SKEW, Pattern 등을 바꿔 Worse/Better 경향을 비교한 평가다.
- 개선 조건: Test Mode나 조건을 바꿔 기존 Fail signature가 줄어드는지 본 평가다.
- 안정성 검증: 개선 조건을 목표 Sample/SKEW 범위에서 반복해 PASS 안정성을 본 평가다.
- Side effect 확인: 기존 signature는 사라졌지만 새로운 DQ/BL/Bank 등의 실패가 나타난 평가다.

온도, VDD, 주파수 또는 SKEW가 바뀌었다는 이유만으로 새 이슈를 만들지 않는다. 부팅/Training 실패와 Hdiag 실패처럼 단계가 다르거나, 충분한 근거에서 Test Mode·Pattern·Fail address signature가 다른 경우에 별도 이슈를 제안한다. 관계가 불분명하면 분류 대기로 보존하고 엔지니어 확인 전에는 기존 이슈에 자동 병합하지 않는다.
