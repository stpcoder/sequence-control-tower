import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMediatekLog, buildQualcommLog } from './synthetic-soc-flow.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const output = join(here, '..', 'long-soc')

const scenarios = [
  {
    file: '26-08-24-09-00-01_UTF02A-2_Ch8_SM8975_1_25_1.295_EVA_EN_SKEW-SS_LOT-LA_DIE03_DEFAULT_9600MHZ_TM-HDIAG_PAT-PRBS31_DQ9_BL16_DRAMCH0_SCH1_RK0_BG2_BANK5_ROW0x2A_COL0x14_COM74_DHCST-101_C_Pass.log',
    vendor: 'qualcomm', expected: 'PASS', lineCount: 8_200, run: 'SM8975_PASS_01',
    condition: 'TEMP=25C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=PRBS31 DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
    meta: 'META SKEW=SS LOT=LA DIE=03 SAMPLE=DHCST-101 TEMP=25C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=PRBS31 DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
  },
  {
    file: '26-08-24-09-10-01_UTF02A-2_Ch8_SM8975_2_85_1.275_EVA_EN_SKEW-SF_LOT-LA_DIE03_DEFAULT_9600MHZ_TM-HDIAG_PAT-WR_DQ9_BL16_DRAMCH0_SCH1_RK0_BG2_BANK5_ROW0x2A_COL0x14_COM74_DHCST-102_C_Fail.log',
    vendor: 'qualcomm', expected: 'TEST_FAIL', lineCount: 9_100, run: 'SM8975_FAIL_02',
    condition: 'TEMP=85C VDD=1.275V FREQ=9600MHz TM=HDIAG PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
    meta: 'META SKEW=SF LOT=LA DIE=03 SAMPLE=DHCST-102 TEMP=85C VDD=1.275V FREQ=9600MHz TM=HDIAG PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
  },
  {
    file: '26-08-24-09-20-01_UTF02A-2_Ch6_SM8850_3_-20_1.275_EVA_EN_SKEW-FF_LOT-LB_DIE11_DEFAULT_8533MHZ_TM-BOOT_PAT-TRAIN_DQ20_BL32_DRAMCH1_SCH0_RK1_BG1_BANK3_ROW0x18_COL0x08_COM62_DHCST-103_C_TrainingFail.log',
    vendor: 'qualcomm', expected: 'TRAINING_FAIL', lineCount: 7_600, run: 'SM8850_TRAINING_FAIL_03',
    condition: 'TEMP=-20C VDD=1.275V FREQ=8533MHz TM=BOOT PATTERN=TRAIN DQ=20 BL=32 CH=1 SUBCH=0 RANK=1 BG=1 BANK=3 ROW=0x18 COL=0x08',
    meta: 'META SKEW=FF LOT=LB DIE=11 SAMPLE=DHCST-103 TEMP=-20C VDD=1.275V FREQ=8533MHz TM=BOOT PATTERN=TRAIN DQ=20 BL=32 CH=1 SUBCH=0 RANK=1 BG=1 BANK=3 ROW=0x18 COL=0x08',
  },
  {
    file: '26-08-24-10-00-01_UTF02A-2_Ch4_MTK24D_4_25_1.295_EVA_EN_SKEW-SS_LOT-LC_DIE05_DEFAULT_8533MHZ_TM-HDIAG_PAT-PRBS7_DQ4_BL8_DRAMCH1_SCH0_RK0_BG0_BANK2_ROW0x31_COL0x10_COM44_DHCST-201_C_Pass.log',
    vendor: 'mediatek', expected: 'PASS', lineCount: 8_300, run: 'MTK24D_PASS_04',
    condition: 'TEMP=25C VDD=1.295V FREQ=8533MHz TM=HDIAG PATTERN=PRBS7 DQ=4 BL=8 CH=1 SUBCH=0 RANK=0 BG=0 BANK=2 ROW=0x31 COL=0x10',
    meta: 'META SKEW=SS LOT=LC DIE=05 SAMPLE=DHCST-201 TEMP=25C VDD=1.295V FREQ=8533MHz TM=HDIAG PATTERN=PRBS7 DQ=4 BL=8 CH=1 SUBCH=0 RANK=0 BG=0 BANK=2 ROW=0x31 COL=0x10',
  },
  {
    file: '26-08-24-10-10-01_UTF02A-2_Ch5_MTK5D_5_105_1.275_EVA_EN_SKEW-FS_LOT-LC_DIE06_DEFAULT_8533MHZ_TM-STRESS_PAT-MARCH_DQ12_BL8_DRAMCH1_SCH1_RK0_BG3_BANK7_ROW0x44_COL0x20_COM45_DHCST-202_C_HdiagReboot.log',
    vendor: 'mediatek', expected: 'SYSTEM_REBOOT', lineCount: 8_800, run: 'MTK5D_REBOOT_05',
    condition: 'TEMP=105C VDD=1.275V FREQ=8533MHz TM=STRESS PATTERN=MARCH DQ=12 BL=8 CH=1 SUBCH=1 RANK=0 BG=3 BANK=7 ROW=0x44 COL=0x20',
    meta: 'META SKEW=FS LOT=LC DIE=06 SAMPLE=DHCST-202 TEMP=105C VDD=1.275V FREQ=8533MHz TM=STRESS PATTERN=MARCH DQ=12 BL=8 CH=1 SUBCH=1 RANK=0 BG=3 BANK=7 ROW=0x44 COL=0x20',
  },
  {
    file: '26-08-24-10-20-01_UTF02A-2_Ch4_MTK24D_6_85_1.295_EVA_EN_SKEW-SS_LOT-LD_DIE09_DEFAULT_9600MHZ_TM-HDIAG_PAT-ROWHAMMER_DQ9_BL16_DRAMCH0_SCH1_RK1_BG2_BANK5_ROW0x7F_COL0x30_COM44_DHCST-203_C_SystemHalt.log',
    vendor: 'mediatek', expected: 'SYSTEM_HALT', lineCount: 7_900, run: 'MTK24D_HALT_06',
    condition: 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=ROW_HAMMER DQ=9 BL=16 CH=0 SUBCH=1 RANK=1 BG=2 BANK=5 ROW=0x7F COL=0x30',
    meta: 'META SKEW=SS LOT=LD DIE=09 SAMPLE=DHCST-203 TEMP=85C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=ROW_HAMMER DQ=9 BL=16 CH=0 SUBCH=1 RANK=1 BG=2 BANK=5 ROW=0x7F COL=0x30',
  },
]

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const scenario of scenarios) {
  const build = scenario.vendor === 'qualcomm' ? buildQualcommLog : buildMediatekLog
  await writeFile(join(output, scenario.file), build({
    run: scenario.run, condition: scenario.condition, outcome: scenario.expected, lineCount: scenario.lineCount,
    header: ['# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', scenario.meta],
  }), 'utf8')
}

await writeFile(join(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 2, synthetic: true, generator: 'stateful-power-training-uefi-android-v2',
  description: 'Synthetic Power-on → Training → firmware prompt → Android → console → Hdiag corpus. It contains no vendor capture.',
  scenarios: scenarios.map(({ file, vendor, expected, lineCount }) => ({ file, vendor, expected, lineCount })),
}, null, 2)}\n`, 'utf8')
