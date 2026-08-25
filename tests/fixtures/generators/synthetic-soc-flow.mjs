const pad = (value, size = 6) => String(value).padStart(size, '0')

function metadataValue(condition, key, fallback) {
  return new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'i').exec(condition)?.[1] ?? fallback
}

function bootTimer(index, cycle) {
  return pad((cycle - 1) * 8_000 + index * 17)
}

function firmwarePreamble({ run, condition, cycle, vendor }) {
  const channel = metadataValue(condition, 'CH', '0')
  const subChannel = metadataValue(condition, 'SUBCH', '0')
  const rank = metadataValue(condition, 'RANK', '0')
  const frequency = metadataValue(condition, 'FREQ', '9600MHz').replace(/MHz/i, '')
  const resetReason = cycle === 1 ? 'hard' : 'warm'
  const platform = vendor === 'mediatek' ? 'MTK24D' : 'SM8975'
  const fixed = [
    '',
    `B - ${bootTimer(0, cycle)} - ${cycle === 1 ? 'Power key pressed' : 'Warm reset asserted'}`,
    `B - ${bootTimer(1, cycle)} - Boot interface detected: UART`,
    `B - ${bootTimer(2, cycle)} - Reset reason: ${resetReason}`,
    `B - ${bootTimer(3, cycle)} - Platform: ${platform}`,
    `B - ${bootTimer(4, cycle)} - PMIC, Start`,
    `B - ${bootTimer(5, cycle)} - PMIC rails stable`,
    `B - ${bootTimer(6, cycle)} - Clock controller initialized`,
    `B - ${bootTimer(7, cycle)} - Boot media probe: UFS`,
    `B - ${bootTimer(8, cycle)} - UFS link startup complete`,
    `B - ${bootTimer(9, cycle)} - Secure boot policy loaded`,
    `B - ${bootTimer(10, cycle)} - Boot configuration selected: slot=_a`,
    `B - ${bootTimer(11, cycle)} - DDR topology CH=${channel} SUBCH=${subChannel} RANK=${rank}`,
    `B - ${bootTimer(12, cycle)} - Requested DDR data rate: ${frequency}MHz`,
    `B - ${bootTimer(13, cycle)} - ${vendor === 'mediatek' ? 'Preloader' : 'PBL'}, Start`,
    `B - ${bootTimer(14, cycle)} - ${vendor === 'mediatek' ? 'Preloader' : 'PBL'}, End`,
  ]
  const rails = ['VDD_CX', 'VDD_MX', 'VDD_DDR', 'VDDQ', 'VPP', 'VDD_APC']
  for (let index = 0; index < 84; index += 1) {
    const rail = rails[index % rails.length]
    const phase = ['enable', 'settle', 'measure', 'verify'][index % 4]
    fixed.push(`B - ${bootTimer(20 + index, cycle)} - PMIC ${rail} ${phase} sample=${index} status=OK`)
  }
  fixed.push(
    `B - ${bootTimer(108, cycle)} - ${vendor === 'mediatek' ? 'Preloader handoff' : 'XBL loader authentication'} complete`,
    `B - ${bootTimer(109, cycle)} - DDR training, Start`,
    `BOOT_CONTEXT run=${run} cycle=${cycle} ${condition}`,
  )
  return fixed
}

function trainingTrace({ condition, cycle, fail = false, detailLines = 720 }) {
  const requestedChannel = Number(metadataValue(condition, 'CH', '0')) || 0
  const requestedSubChannel = Number(metadataValue(condition, 'SUBCH', '0')) || 0
  const requestedRank = Number(metadataValue(condition, 'RANK', '0')) || 0
  const requestedDq = Number(metadataValue(condition, 'DQ', '9')) || 9
  const frequencies = [200, 451, 768, 1353, 2133, 3200, 4266, 5333]
  const phases = ['CA', 'write-leveling', 'read-gate', 'read-eye', 'write-eye', 'VrefDQ', 'DCC', 'deskew']
  const lines = []
  for (let index = 0; index < detailLines; index += 1) {
    const channel = index % 4
    const subChannel = Math.floor(index / 4) % 2
    const rank = Math.floor(index / 8) % 2
    const byte = Math.floor(index / 16) % 4
    const phase = phases[Math.floor(index / 64) % phases.length]
    const frequency = frequencies[Math.floor(index / 128) % frequencies.length]
    const left = 18 + ((index * 7 + cycle) % 21)
    const right = 19 + ((index * 11 + cycle) % 23)
    const vref = 36 + ((index * 5 + cycle) % 25)
    lines.push(`DDR_TRAIN phase=${phase} freq=${frequency}MHz CH=${channel} SUBCH=${subChannel} RANK=${rank} BYTE=${byte} left=${left} right=${right} vref=${vref} result=PASS`)
    if (index % 97 === 0) lines.push(`DDR_PHY register snapshot index=${index} pll=LOCKED impedance=${34 + (index % 7)}ohm temp=${44 + (index % 9)}C`)
  }
  if (fail) {
    lines.push(
      `DDR_TRAIN phase=read-eye freq=${frequencies.at(-1)}MHz CH=${requestedChannel} SUBCH=${requestedSubChannel} RANK=${requestedRank} BYTE=${Math.floor(requestedDq / 8)} left=0 right=1 vref=63 result=FAIL`,
      `TRAINING_FAIL CH=${requestedChannel} SUBCH=${requestedSubChannel} RANK=${requestedRank} DQ=${requestedDq} reason=window-collapsed`,
      'DDR training recovery exhausted',
      'SYSTEM_HALT',
    )
  } else {
    lines.push('DDR training summary: CA=PASS WL=PASS RG=PASS RE=PASS WE=PASS VREF=PASS', 'TRAINING_PASS')
  }
  return lines
}

function uefiInteraction(condition) {
  const vdd = metadataValue(condition, 'VDD', '1.295V').replace(/V$/i, '')
  const testMode = metadataValue(condition, 'TM', 'DEFAULT')
  return [
    'UEFI firmware initialization complete',
    'UEFI]',
    'UEFI]',
    'UEFI] erase ddr',
    'Delete DRAM training information from persistent storage',
    'DRAM training information deleted: SUCCESS',
    'UEFI]',
    'UEFI] dtvs',
    'dtvs 0: DEFAULT  VDD=1.295V  TM=DEFAULT',
    `dtvs 1: EVALUATION  VDD=${vdd}V  TM=${testMode}`,
    'dtvs 2: LOW_MARGIN  VDD=1.275V  TM=MARGIN_LOW',
    'dtvs 3: HIGH_MARGIN  VDD=1.315V  TM=MARGIN_HIGH',
    'dtvs 4: RESTORE  VDD=AUTO  TM=DEFAULT',
    'UEFI]',
    'UEFI] dtvs 1',
    `DTVS option 1 selected: VDD=${vdd}V TM=${testMode}`,
    'DTVS setting saved for the next boot',
    'UEFI]',
    'UEFI] reset',
    'ResetSystem requested: warm reset',
  ]
}

function androidBootLines({ condition, target = 2_300 }) {
  const bootReason = metadataValue(condition, 'BOOT_REASON', 'warm')
  const fixed = [
    'UEFI firmware initialization complete',
    'UEFI]',
    'UEFI] exit',
    'UEFI: loading boot_a',
    'UEFI: Android Verified Boot slot=_a verification=green',
    'UEFI: loading vendor_boot_a, init_boot_a and dtbo_a',
    'UEFI: ExitBootServices',
    'EFI stub: Booting Linux Kernel...',
    'EFI stub: Using DTB from configuration table',
    '[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x000f0510]',
    '[    0.000000] Linux version 6.1.0-sct-gki (synthetic@builder) #1 SMP PREEMPT',
    `[    0.000000] Kernel command line: console=ttyMSM0,115200n8 androidboot.slot_suffix=_a androidboot.bootreason=${bootReason}`,
    '[    0.000000] Machine model: Synthetic mobile validation platform',
    '[    0.000000] Reserved memory: created DMA memory pool',
    '[    0.000000] GICv3: GIC: Using split EOI/Deactivate mode',
    '[    0.000000] arch_timer: cp15 timer running at 19.20MHz',
    '[    0.000000] smp: Bringing up secondary CPUs ...',
    '[    0.042631] pinctrl core: initialized pinctrl subsystem',
    '[    0.061204] NET: Registered PF_NETLINK/PF_ROUTE protocol family',
    '[    0.083118] audit: initializing netlink subsys (disabled)',
    '[    0.102410] Serial: AMBA PL011 UART driver',
    '[    0.130055] msm_serial: console setup on ttyMSM0',
    '[    0.191004] ufshcd: UFS controller initialized',
    '[    0.224001] VFS: Mounted root (ramfs filesystem) readonly',
    '[    0.241108] Run /init as init process',
    '[    0.252104] init: init first stage started!',
    '[    0.260803] init: Loading Android SELinux policy',
    '[    0.311288] init: Using Android DT directory /proc/device-tree/firmware/android/',
    '[    0.369011] init: First stage mount completed',
    '[    0.418776] init: init second stage started!',
    '[    0.442910] init: Using Android property workspace',
    '[    0.501993] ueventd: ueventd started!',
  ]
  const kernelDevices = ['qcom-spmi-pmic', 'ufs-qcom', 'arm-smmu', 'qcom-cpufreq-hw', 'qcom-rng', 'qcom-pon', 'qcom-tsens', 'qcom-battmgr', 'qcom-iommu', 'qcom-icc', 'qcom-pdc', 'qcom-watchdog']
  const services = ['servicemanager', 'hwservicemanager', 'vndservicemanager', 'vold', 'apexd', 'logd', 'lmkd', 'keystore2', 'statsd', 'netd', 'zygote', 'surfaceflinger', 'audioserver', 'cameraserver', 'vendor.memory-hal', 'vendor.power-hal']
  const lines = [...fixed]
  let index = 0
  while (lines.length < target) {
    const seconds = (0.55 + index * 0.0037).toFixed(6).padStart(11, ' ')
    const variant = index % 10
    if (variant === 0) lines.push(`[${seconds}] ${kernelDevices[index % kernelDevices.length]}: probe instance=${index % 7} status=ready`)
    else if (variant === 1) lines.push(`[${seconds}] init: Parsing file /vendor/etc/init/${services[index % services.length]}.rc`)
    else if (variant === 2) lines.push(`[${seconds}] init: starting service '${services[index % services.length]}' pid=${300 + index}`)
    else if (variant === 3) lines.push(`[${seconds}] binder: transaction=${index} node=${index % 64} completed`)
    else if (variant === 4) lines.push(`[${seconds}] ueventd: device /devices/platform/soc/${index % 48} permissions applied`)
    else if (variant === 5) lines.push(`[${seconds}] selinux: avc policy lookup class=${['file', 'dir', 'binder', 'chr_file'][index % 4]} result=allowed`)
    else if (variant === 6) lines.push(`[${seconds}] ufshcd: tag=${index % 32} lun=${index % 8} command complete status=0`)
    else if (variant === 7) lines.push(`[${seconds}] thermal: zone=${index % 6} temp=${42000 + (index % 13000)} trip=normal`)
    else if (variant === 8) lines.push(`[${seconds}] healthd: battery level=${70 + (index % 25)} voltage=${3900 + (index % 280)} temperature=${280 + (index % 90)}`)
    else lines.push(`[${seconds}] ActivityManager: Start proc ${1000 + index}:${services[index % services.length]}/u0a${index % 90}`)
    index += 1
  }
  lines.push(
    '[    8.920114] bootstat: canonical boot reason: warm',
    '[    9.104882] init: processing action (sys.boot_completed=1)',
    '[    9.220711] AndroidRuntime: BOOT_COMPLETED broadcast queued',
    'console:/ #',
  )
  return lines
}

function hdiagLines({ condition, target }) {
  const frequency = metadataValue(condition, 'FREQ', '9600MHz').replace(/MHz/i, '')
  const pattern = metadataValue(condition, 'PATTERN', metadataValue(condition, 'PAT', 'WR'))
  const testMode = metadataValue(condition, 'TM', 'HDIAG')
  const channel = Number(metadataValue(condition, 'CH', '0')) || 0
  const lines = [
    `console:/ # setddrclk ${frequency}`,
    `DDR frequency fixed at ${frequency}MHz`,
    `console:/ # hdiag --mode ${testMode} --pattern ${pattern} --loops 200`,
    `HIDAG START mode=${testMode} pattern=${pattern} loops=200`,
    'console:/ # stressapptest -M 4096 -s 600',
    'stressapptest: start memory=4096MB duration=600s',
    'console:/ # sleep 20',
  ]
  let index = 0
  const patterns = [pattern, 'MARCH_C', 'PRBS7', 'PRBS31', 'WALKING_1', 'WALKING_0', 'CHECKERBOARD']
  while (lines.length < target) {
    const loop = Math.floor(index / 32) + 1
    const subChannel = Math.floor(index / 8) % 2
    const rank = Math.floor(index / 16) % 2
    const bankGroup = Math.floor(index / 4) % 4
    const bank = index % 8
    const row = `0x${(0x20 + (index % 0x5f)).toString(16).toUpperCase()}`
    const col = `0x${(0x08 + ((index * 4) % 0x70)).toString(16).toUpperCase()}`
    const variant = index % 8
    if (variant === 0) lines.push(`HIDAG progress loop=${loop}/200 pattern=${patterns[loop % patterns.length]} CH=${channel} SUBCH=${subChannel} RANK=${rank}`)
    else if (variant === 1) lines.push(`HIDAG address sweep BG=${bankGroup} BK=${bank} ROW=${row} COL=${col} compare=PASS`)
    else if (variant === 2) lines.push(`HIDAG lane margin DQ=${index % 32} BL=${(index % 4) * 8} eye=${21 + (index % 17)}ps status=PASS`)
    else if (variant === 3) lines.push(`stressapptest: worker=${index % 16} copied=${1024 + index}MB errors=0`)
    else if (variant === 4) lines.push(`RAS MC${channel}: scrub cycle=${index} corrected=0 uncorrected=0`)
    else if (variant === 5) lines.push(`thermal: memory_zone temp=${47000 + (index % 16000)} target=stable`)
    else if (variant === 6) lines.push(`sched: cpu${index % 8} hdiag_worker/${index % 16} runtime=${1000 + index}us`)
    else lines.push(`ufs: queue=${index % 16} background_io=${index % 5} status=complete`)
    index += 1
  }
  return lines
}

function terminalLines(outcome, condition) {
  const channel = metadataValue(condition, 'CH', '0')
  const subChannel = metadataValue(condition, 'SUBCH', '0')
  const rank = metadataValue(condition, 'RANK', '0')
  const bankGroup = metadataValue(condition, 'BG', '2')
  const bank = metadataValue(condition, 'BANK', '5')
  const row = metadataValue(condition, 'ROW', '0x2A')
  const col = metadataValue(condition, 'COL', '0x14')
  const dq = metadataValue(condition, 'DQ', '9')
  const bl = metadataValue(condition, 'BL', '16')
  const pattern = metadataValue(condition, 'PATTERN', metadataValue(condition, 'PAT', 'WR'))
  const fail = `CH=${channel} SUBCH=${subChannel} CS=0 RK=${rank} BG=${bankGroup} BK=${bank} ROW=${row} COL=${col} WR=0x55 RD=0x15 DQ=${dq} BL=${bl}`
  const edac = `EDAC MC${channel}: UE Channel:${channel} SubChannel:${subChannel} Rank:${rank} BankGroup:${bankGroup} Bank:${bank} Row:${row} Column:${col} DQ:${dq} BL:${bl}`
  if (outcome === 'PASS') return [
    ...(/^PRBS31$/i.test(pattern) ? [edac.replace('UE ', 'CE ')] : []),
    'stressapptest PASS', 'HIDAG END result=PASS', '@PASS', 'TEST COMPLETE',
  ]
  if (outcome === 'DIAG_FAIL') return [edac, `HIDAG ERROR ${fail}`, 'DIAG_FAIL code=HDIAG_COMPARE', '@FAIL', 'TEST COMPLETE']
  if (outcome === 'TEST_FAIL') return [edac, `HIDAG @FAIL pattern=${pattern} ${fail}`, `HIDAG @FAIL pattern=${pattern} ${fail.replace(`ROW=${row}`, 'ROW=0x3B')}`, 'FAST_FAIL threshold reached', '@FAIL', 'TEST COMPLETE']
  if (outcome === 'SYSTEM_REBOOT') return [edac, `HIDAG ERROR ${fail}`, 'watchdog: hdiag heartbeat timeout', 'WATCHDOG bite detected', 'REBOOT_REASON=watchdog', 'SYSTEM_REBOOT']
  if (outcome === 'SYSTEM_HALT') return [edac, `HIDAG ERROR ${fail}`, 'hdiag heartbeat stopped without terminal marker', 'SYSTEM_HALT']
  if (outcome === 'INCOMPLETE') return ['HIDAG progress loop=41/200', 'CAPTURE_STOPPED before terminal result', 'INCOMPLETE']
  return ['capture ended after console handoff without PASS or FAIL', 'UNCLASSIFIED_CAPTURE_END', 'UNKNOWN']
}

export function buildQualcommLog({ run, condition, outcome, lineCount = 7_600, header = [] }) {
  const firstBoot = firmwarePreamble({ run, condition, cycle: 1, vendor: 'qualcomm' })
  const firstTraining = trainingTrace({ condition, cycle: 1, detailLines: 640 })
  const setup = uefiInteraction(condition)
  const secondBoot = firmwarePreamble({ run, condition, cycle: 2, vendor: 'qualcomm' })
  const secondTrainingFail = outcome === 'TRAINING_FAIL'
  const failingDetailLines = Math.min(3_100, Math.max(800, lineCount - 2_400))
  const secondTraining = trainingTrace({ condition, cycle: 2, fail: secondTrainingFail, detailLines: secondTrainingFail ? failingDetailLines : 640 })
  const lines = [...header, ...firstBoot, ...firstTraining, ...setup, ...secondBoot, ...secondTraining]
  if (secondTrainingFail) {
    while (lines.length < lineCount) {
      const index = lines.length
      lines.splice(lines.length - 4, 0, `DDR_PHY recovery trace step=${index} CH=${index % 4} SUBCH=${Math.floor(index / 4) % 2} lane=${index % 32} status=retry`)
    }
    return `${lines.slice(0, lineCount).join('\n')}\n`
  }
  const androidTarget = Math.min(2_500, Math.max(1_000, Math.floor(lineCount * 0.3)))
  lines.push(...androidBootLines({ condition, target: androidTarget }))
  const terminal = terminalLines(outcome, condition)
  const testTarget = Math.max(12, lineCount - lines.length - terminal.length)
  lines.push(...hdiagLines({ condition, target: testTarget }), ...terminal)
  return `${lines.slice(0, lineCount).join('\n')}\n`
}

export function buildMediatekLog({ run, condition, outcome, lineCount = 7_600, header = [] }) {
  const lines = [...header, ...firmwarePreamble({ run, condition, cycle: 1, vendor: 'mediatek' })]
  const trainingFail = outcome === 'TRAINING_FAIL'
  lines.push(...trainingTrace({ condition, cycle: 1, fail: trainingFail, detailLines: trainingFail ? 2_800 : 720 }))
  if (trainingFail) return `${lines.slice(0, lineCount).join('\n')}\n`
  lines.push(
    'POST_PBL_ENTER',
    'LK: ENTER',
    'LK: loading boot_a and vendor_boot_a',
    'LK2: verified boot state=green',
    'LK2: booting Linux kernel',
    ...androidBootLines({ condition, target: Math.min(2_500, Math.max(1_000, Math.floor(lineCount * 0.3))) }).filter((line) => !/^UEFI/.test(line)),
  )
  const terminal = terminalLines(outcome, condition)
  const testTarget = Math.max(12, lineCount - lines.length - terminal.length)
  lines.push(...hdiagLines({ condition, target: testTarget }), ...terminal)
  return `${lines.slice(0, lineCount).join('\n')}\n`
}
