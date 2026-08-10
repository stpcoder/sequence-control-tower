import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const output = join(here, '..', 'long-soc')

const noise = (line, vendor) => {
  const clock = (line * 0.0137).toFixed(6).padStart(12, ' ')
  const messages = vendor === 'qualcomm'
    ? [
        `pmic_arb: transaction ${line % 64} complete`,
        `qcom_smem: item=${line % 128} state=ready`,
        `msm_serial: rx=${line % 17} tx=${line % 11}`,
        `sched: cpu${line % 8} task=worker/${line % 31}`,
        `ufs: queue=${line % 16} doorbell=0x${(line % 255).toString(16)}`,
        `thermal: zone=${line % 5} temp=${42000 + (line % 9000)}`,
      ]
    : [
        `mtk-pmic: rail=${line % 12} state=stable`,
        `preloader: trace=${line % 256} uart=${line % 4}`,
        `mtk-msdc: host=${line % 2} cmd=${line % 64}`,
        `sched: cpu${line % 8} task=kworker/${line % 29}`,
        `mbraink: sample=${line % 100} idle=${line % 7}`,
        `thermal: zone=${line % 5} temp=${41000 + (line % 10000)}`,
      ]
  const message = messages[line % messages.length]
  if (line % 173 === 0) return `[${clock}] UI_TRACE click=${line % 9} pane=log-view selection=${line % 23}`
  if (line % 257 === 0) return `[${clock}] DEBUG serial chunk=${line} bytes=${64 + (line % 128)}`
  if (line % 389 === 0) return `[${clock}] WARN retryable transport latency=${90 + (line % 700)}ms`
  return `[${clock}] ${message}`
}

const scenarios = [
  {
    file: 'LPDDR6_SM-8975_SKEW-SS_LOT-LA_DIE03_SMP-Q01_T25_VDD1p295_F9600_TM-HDIAG_PAT-PRBS31_DQ9_BL16_CH0_SCH1_RK0_BG2_BANK5_ROW0x2A_COL0x14_PASS.log',
    vendor: 'qualcomm', expected: 'PASS', lineCount: 8200,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=SS LOT=LA DIE=03 SAMPLE=Q01 TEMP=25C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=PRBS31 DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
      30: 'POWER_ON', 110: 'PBL: ENTER', 170: 'PBL_EXIT', 260: 'XBL: ENTER', 390: 'XBL_EXIT', 520: 'ABL: ENTER', 690: 'ABL_EXIT', 820: 'UEFI: ENTER', 1040: 'UEFI> memory_training --channel 0 --subchannel 1', 1100: 'TRAINING START CH=0 SUBCH=1 RANK=0', 1280: 'TRAINING_PASS', 1510: 'UEFI ExitBootServices', 1780: 'OS_READY Linux boot complete', 1810: '# set_rail VDD 1.295', 1820: '# sleep 20', 2950: 'HIDAG START pattern=PRBS31', 7130: 'EDAC MC0: corrected error location: channel:0 slot:1 row:0x2A bank:5', 8170: 'HIDAG @PASS', 8180: '@PASS', 8190: 'SEQUENCE COMPLETE',
    },
  },
  {
    file: 'LPDDR6_SM-8975_SKEW-SF_LOT-LA_DIE03_SMP-Q02_T85_VDD1p275_F9600_TM-HDIAG_PAT-WR_DQ9_BL16_CH0_SCH1_RK0_BG2_BANK5_ROW0x2A_COL0x14_FAIL.log',
    vendor: 'qualcomm', expected: 'TEST_FAIL', lineCount: 9100,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=SF LOT=LA DIE=03 SAMPLE=Q02 TEMP=85C VDD=1.275V FREQ=9600MHz TM=HDIAG PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=1 RANK=0 BG=2 BANK=5 ROW=0x2A COL=0x14',
      40: 'POWER_ON', 120: 'PBL: ENTER', 190: 'PBL_EXIT', 310: 'XBL: ENTER', 450: 'XBL_EXIT', 600: 'ABL: ENTER', 760: 'ABL_EXIT', 900: 'UEFI: ENTER', 1180: 'TRAINING START CH=0 SUBCH=1 RANK=0', 1420: 'TRAINING_PASS', 1680: 'UEFI ExitBootServices', 2050: 'OS_READY Linux boot complete', 2130: '# hdiag --pattern WR --loops 200', 2280: 'HIDAG START pattern=WR', 6740: 'EDAC MC0: 1 UE memory read error address 0x000000002a140, Channel:0 SubChannel:1 Rank:0 BankGroup:2 Bank:5 Row:0x2A Column:0x14 DQ:9 BL:16', 6760: 'FAST_FAIL threshold reached', 6770: 'HIDAG @FAIL', 6780: '@FAIL', 6800: 'SEQUENCE COMPLETE',
    },
  },
  {
    file: 'LPDDR6_SM-8850_SKEW-FF_LOT-LB_DIE11_SMP-Q03_T-20_VDD1p275_F8533_TM-BOOT_PAT-TRAIN_DQ20_BL32_CH1_SCH0_RK1_BG1_BANK3_ROW0x18_COL0x08_TRAIN_FAIL.log',
    vendor: 'qualcomm', expected: 'TRAINING_FAIL', lineCount: 7600,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=FF LOT=LB DIE=11 SAMPLE=Q03 TEMP=-20C VDD=1.275V FREQ=8533MHz TM=BOOT PATTERN=TRAIN DQ=20 BL=32 CH=1 SUBCH=0 RANK=1 BG=1 BANK=3 ROW=0x18 COL=0x08',
      35: 'POWER_ON', 130: 'PBL: ENTER', 210: 'PBL_EXIT', 330: 'XBL: ENTER', 490: 'XBL_EXIT', 640: 'ABL: ENTER', 790: 'ABL_EXIT', 930: 'UEFI: ENTER', 1180: 'TRAINING START CH=1 SUBCH=0 RANK=1', 5840: 'DDR PHY: CA training window collapsed CH=1 SUBCH=0', 5860: 'TRAINING_FAIL CH=1 SUBCH=0 RANK=1 DQ=20', 5870: 'SYSTEM_HALT training recovery exhausted',
    },
  },
  {
    file: 'LPDDR6_MTK-24D_SKEW-SS_LOT-LC_DIE05_SMP-M01_T25_VDD1p295_F8533_TM-HDIAG_PAT-PRBS7_DQ4_BL8_CH1_SCH0_RK0_BG0_BANK2_ROW0x31_COL0x10_PASS.log',
    vendor: 'mediatek', expected: 'PASS', lineCount: 8300,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=SS LOT=LC DIE=05 SAMPLE=M01 TEMP=25C VDD=1.295V FREQ=8533MHz TM=HDIAG PATTERN=PRBS7 DQ=4 BL=8 CH=1 SUBCH=0 RANK=0 BG=0 BANK=2 ROW=0x31 COL=0x10',
      30: 'POWER_ON', 100: 'Boot ROM handoff', 180: 'PRELOADER START', 350: 'TRAINING START CH=1 SUBCH=0 RANK=0', 710: 'TRAINING_PASS', 820: 'POST_PBL_ENTER', 1050: 'POST_PBL_EXIT', 1200: 'LK: ENTER', 1510: 'LK_EXIT', 1810: 'OS_READY Linux boot complete', 1870: '# hdiag --pattern PRBS7', 2050: 'HIDAG START pattern=PRBS7', 8110: 'HIDAG @PASS', 8120: '@PASS', 8140: 'SEQUENCE COMPLETE',
    },
  },
  {
    file: 'LPDDR6_MTK-5D_SKEW-FS_LOT-LC_DIE06_SMP-M02_T105_VDD1p275_F8533_TM-STRESS_PAT-MARCH_DQ12_BL8_CH1_SCH1_RK0_BG3_BANK7_ROW0x44_COL0x20_REBOOT.log',
    vendor: 'mediatek', expected: 'SYSTEM_REBOOT', lineCount: 8800,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=FS LOT=LC DIE=06 SAMPLE=M02 TEMP=105C VDD=1.275V FREQ=8533MHz TM=STRESS PATTERN=MARCH DQ=12 BL=8 CH=1 SUBCH=1 RANK=0 BG=3 BANK=7 ROW=0x44 COL=0x20',
      30: 'POWER_ON', 100: 'Boot ROM handoff', 180: 'PRELOADER START', 340: 'TRAINING START CH=1 SUBCH=1 RANK=0', 650: 'TRAINING_PASS', 820: 'POST_PBL_ENTER', 1040: 'POST_PBL_EXIT', 1210: 'LK: ENTER', 1490: 'LK_EXIT', 1800: 'OS_READY Linux boot complete', 1910: '# stressapptest -M 4096 -s 3600', 2150: 'DIAG START stressapp', 7210: 'EDAC MC1: 1 UE address 0x0000000044200 Channel:1 SubChannel:1 Rank:0 BankGroup:3 Bank:7 Row:0x44 Column:0x20 DQ:12 BL:8', 7240: 'WATCHDOG bite detected', 7250: 'REBOOT_REASON=watchdog', 7300: 'POWER_ON', 7410: 'Boot ROM handoff',
    },
  },
  {
    file: 'LPDDR6_MTK-24D_SKEW-SS_LOT-LD_DIE09_SMP-M03_T85_VDD1p295_F9600_TM-HDIAG_PAT-ROW_HAMMER_DQ9_BL16_CH0_SCH1_RK1_BG2_BANK5_ROW0x7F_COL0x30_HALT.log',
    vendor: 'mediatek', expected: 'SYSTEM_HALT', lineCount: 7900,
    markers: {
      1: '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture', 2: 'META SKEW=SS LOT=LD DIE=09 SAMPLE=M03 TEMP=85C VDD=1.295V FREQ=9600MHz TM=HDIAG PATTERN=ROW_HAMMER DQ=9 BL=16 CH=0 SUBCH=1 RANK=1 BG=2 BANK=5 ROW=0x7F COL=0x30',
      30: 'POWER_ON', 100: 'Boot ROM handoff', 180: 'PRELOADER START', 350: 'TRAINING START CH=0 SUBCH=1 RANK=1', 720: 'TRAINING_PASS', 840: 'POST_PBL_ENTER', 1080: 'POST_PBL_EXIT', 1230: 'LK: ENTER', 1540: 'LK_EXIT', 1880: 'OS_READY Linux boot complete', 1970: '# hdiag --pattern ROW_HAMMER --bank 5', 2210: 'HIDAG START pattern=ROW_HAMMER', 7420: 'EDAC MC0: 1 UE address 0x000000007f300 Channel:0 SubChannel:1 Rank:1 BankGroup:2 Bank:5 Row:0x7F Column:0x30 DQ:9 BL:16', 7440: 'KERNEL PANIC memory controller uncorrectable error', 7450: 'SYSTEM_HALT',
    },
  },
]

await mkdir(output, { recursive: true })
for (const scenario of scenarios) {
  const lines = Array.from({ length: scenario.lineCount }, (_, index) => {
    const line = index + 1
    return scenario.markers[line] ?? noise(line, scenario.vendor)
  })
  await writeFile(join(output, scenario.file), `${lines.join('\n')}\n`, 'utf8')
}

await writeFile(join(output, 'manifest.json'), `${JSON.stringify({
  schemaVersion: 1,
  synthetic: true,
  description: 'Public boot-flow and Linux RAS terminology shaped synthetic corpus. It contains no vendor capture.',
  scenarios: scenarios.map(({ file, vendor, expected, lineCount }) => ({ file, vendor, expected, lineCount })),
}, null, 2)}\n`, 'utf8')
