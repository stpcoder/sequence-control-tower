# 긴 SoC 합성 로그 검증

`tests/fixtures/long-soc`에는 6개의 합성 로그가 있습니다. 각 로그는 7,500~9,100줄이며 실제 벤더 캡처가 아닙니다.

## 포함 시나리오

- Qualcomm 계열: PASS, Test fail/Fast fail, Training fail
- MediaTek 계열: PASS, Watchdog reboot, System halt
- SKEW, Lot, Die, Sample, 온도, VDD, 주파수, Mode, Pattern
- Channel, Sub Channel, Rank, Bank Group, Bank, Row, Column, DQ, BL
- UART·kernel·thermal·storage·UI trace가 섞인 긴 배경 로그

## 공개 구조 참고

- Android Bootloader 개요: https://source.android.com/docs/core/architecture/bootloader
- Android Boot reason: https://source.android.com/docs/core/architecture/bootloader/boot-reason
- Qualcomm Linux 부팅 구성 문서: https://docs.qualcomm.com/bundle/publicresource/topics/80-80022-27/configure_and_secure_boot_with_systemd_boot_and_uki.html
- MediaTek Android 통신과 UART: https://genio.mediatek.com/doc/android/sw/android/get-started/communication.html
- MediaTek Ubuntu bootloader 구성: https://genio.mediatek.com/doc/ubuntu/customization/customize-bootloader.html
- Linux EDAC: https://docs.kernel.org/6.6/driver-api/edac.html
- Linux RAS: https://docs.kernel.org/6.11/admin-guide/RAS/main.html
- Linux ramoops: https://docs.kernel.org/admin-guide/ramoops.html

공개 문서의 단계 구조와 일반적인 RAS 필드만 참고했습니다. 문자열과 타임라인은 테스트용으로 새로 생성했습니다.

## 재생성 및 검증

```bash
node tests/fixtures/generators/generate-long-soc-corpus.mjs
npx vitest run tests/domain/long-soc-corpus.test.ts
```

검증은 전체 파일을 메모리에 올려 LLM으로 보내지 않습니다. ArtifactService가 파일을 스트리밍하여 marker를 한 번 검사하고, 필요한 검색 위치와 최대 24줄 근거 창만 Agent에 제공합니다.

## 장문 로그 UX 검증

현재 corpus는 6개 파일, 총 49,900줄입니다. 다음 흐름을 실제 앱과 자동 테스트에서 함께 확인합니다.

1. 로그를 열면 첫 구간이 즉시 표시됩니다.
2. `Ctrl+F`로 파일 전체 일치 개수를 계산하고 마지막 검색 결과까지 이동합니다.
3. `Ctrl+G`로 아직 화면에 읽지 않은 8,000번째 줄을 바로 엽니다.
4. `Alt+Z`로 긴 한 줄의 줄 바꿈을 켜고 끕니다.
5. 검색 순서와 범위는 관찰 기록으로 남고, 엔지니어가 저장한 항목만 판정 절차가 됩니다.
6. 저장한 절차는 같은 평가 폴더에서 재사용하고, 다른 폴더에서는 SoC·부팅 프로파일·Mode·Pattern이 맞을 때 수정 가능한 후보로 표시합니다.
7. Agent는 선택한 평가 폴더의 파일명 조건, 콘솔 입력, 상태 marker, 검색 기록과 평가 이력을 읽습니다.
8. Agent가 요청한 문자열만 검색하고 최대 24줄 근거 구간을 읽어 결과와 다음 평가를 제안합니다.

## 상용 도구와의 조작 기준

- VS Code: [찾기, 검색 기록, 줄 이동, 줄 바꿈](https://code.visualstudio.com/docs/editing/codebasics)과 [Explorer·Quick Open](https://code.visualstudio.com/docs/editing/userinterface)의 익숙한 조작을 기준으로 삼습니다.
- Notepad++: [Find in Files, Search results, Word wrap](https://npp-user-manual.org/docs/user-interface/)의 파일별 검색 흐름을 기준으로 삼습니다.
- Spotfire: [Cross Table](https://docs.tibco.com/pub/spotfire/6.5.0/doc/html/cross/cross_how_to_use_the_cross_table.htm)과 [Excel 내보내기](https://docs.tibco.com/pub/sfire-analyst/14.2.0/doc/html/en-US/TIB_sfire_client/client/topics/en-US/exporting_to_excel.html)의 가로·세로 집계 흐름을 기준으로 삼습니다.

Sequence Control Tower는 원본 로그를 읽기 전용으로 유지합니다. 바꾸기는 작업 사본에 기록되며 원본 파일에는 쓰지 않습니다. 폴더 하나를 평가 하나로 처리하여 검색, 판정, 결과표, Agent 대화와 평가 이력이 같은 범위를 사용하도록 검증합니다.
