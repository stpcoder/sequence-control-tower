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
