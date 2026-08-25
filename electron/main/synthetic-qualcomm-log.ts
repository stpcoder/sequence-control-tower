/**
 * Deterministic, privacy-safe demo capture. Stage names follow public AOSP boot
 * architecture; UEFI] command behaviour follows the engineer-provided lab flow.
 * No line is copied from a production or vendor capture.
 */
export type SyntheticOutcome = 'PASS' | 'TEST_FAIL' | 'TRAINING_FAIL' | 'SYSTEM_HALT' | 'SYSTEM_REBOOT'

const value = (condition: string, key: string, fallback: string): string =>
  new RegExp(`(?:^|\\s)${key}=([^\\s]+)`, 'i').exec(condition)?.[1] ?? fallback

function powerAndTraining(run: string, condition: string, cycle: number, fail = false): string[] {
  const ch = Number(value(condition, 'CH', '0')) || 0
  const subch = Number(value(condition, 'SUBCH', '0')) || 0
  const rank = Number(value(condition, 'RANK', '0')) || 0
  const dq = Number(value(condition, 'DQ', '9')) || 9
  const freq = value(condition, 'FREQ', '9600MHz').replace(/MHz/i, '')
  const offset = (cycle - 1) * 8_000
  const time = (index: number) => String(offset + index * 17).padStart(6, '0')
  const lines = [
    '',
    `B - ${time(0)} - ${cycle === 1 ? 'Power key pressed' : 'Warm reset asserted'}`,
    `B - ${time(1)} - Reset reason: ${cycle === 1 ? 'hard' : 'warm'}`,
    `B - ${time(2)} - PBL, Start`,
    `B - ${time(3)} - PMIC rails stable`,
    `B - ${time(4)} - UFS link startup complete`,
    `B - ${time(5)} - Secure boot policy loaded`,
    `B - ${time(6)} - Boot slot selected: _a`,
    `B - ${time(7)} - XBL loader authentication complete`,
    `B - ${time(8)} - DDR topology CH=${ch} SUBCH=${subch} RANK=${rank}`,
    `B - ${time(9)} - Requested DDR data rate: ${freq}MHz`,
    `B - ${time(10)} - DDR training, Start`,
    `BOOT_CONTEXT run=${run} cycle=${cycle} ${condition}`,
  ]
  const phases = ['CA', 'write-leveling', 'read-gate', 'read-eye', 'write-eye', 'VrefDQ', 'DCC', 'deskew']
  const frequencies = [200, 451, 768, 1353, 2133, 3200, 4266, 5333]
  const count = fail ? 2_700 : 620
  for (let index = 0; index < count; index += 1) {
    const lane = index % 32
    const phase = phases[Math.floor(index / 64) % phases.length]
    lines.push(`DDR_TRAIN phase=${phase} freq=${frequencies[Math.floor(index / 128) % frequencies.length]}MHz CH=${index % 4} SUBCH=${Math.floor(index / 4) % 2} RANK=${Math.floor(index / 8) % 2} DQ=${lane} left=${18 + (index % 19)} right=${20 + (index % 23)} vref=${36 + (index % 25)} result=PASS`)
    if (index % 89 === 0) lines.push(`DDR_PHY snapshot=${index} pll=LOCKED impedance=${34 + (index % 7)}ohm temp=${44 + (index % 9)}C`)
  }
  if (fail) lines.push(
    `DDR_TRAIN phase=read-eye freq=${freq}MHz CH=${ch} SUBCH=${subch} RANK=${rank} DQ=${dq} left=0 right=1 result=FAIL`,
    `TRAINING_FAIL CH=${ch} SUBCH=${subch} RANK=${rank} DQ=${dq} reason=window-collapsed`,
    'DDR training recovery exhausted',
    'SYSTEM_HALT',
  )
  else lines.push('DDR training summary: CA=PASS WL=PASS RG=PASS RE=PASS WE=PASS VREF=PASS', 'TRAINING_PASS')
  return lines
}

function uefiSetup(condition: string): string[] {
  const vdd = value(condition, 'VDD', '1.295V').replace(/V$/i, '')
  const mode = value(condition, 'TM', 'DEFAULT')
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
    `dtvs 1: EVALUATION  VDD=${vdd}V  TM=${mode}`,
    'dtvs 2: LOW_MARGIN  VDD=1.275V  TM=MARGIN_LOW',
    'dtvs 3: HIGH_MARGIN  VDD=1.315V  TM=MARGIN_HIGH',
    'dtvs 4: RESTORE  VDD=AUTO  TM=DEFAULT',
    'UEFI]',
    'UEFI] dtvs 1',
    `DTVS option 1 selected: VDD=${vdd}V TM=${mode}`,
    'DTVS setting saved for the next boot',
    'UEFI]',
    'UEFI] reset',
    'ResetSystem requested: warm reset',
  ]
}

function androidBoot(condition: string, count = 2_100): string[] {
  const lines = [
    'UEFI firmware initialization complete',
    'UEFI]',
    'UEFI] exit',
    'UEFI: loading boot_a, vendor_boot_a, init_boot_a and dtbo_a',
    'UEFI: Android Verified Boot verification=green',
    'UEFI: ExitBootServices',
    'EFI stub: Booting Linux Kernel...',
    '[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x000f0510]',
    '[    0.000000] Linux version 6.1.0-sct-gki (synthetic@builder) #1 SMP PREEMPT',
    '[    0.000000] Kernel command line: console=ttyMSM0 androidboot.slot_suffix=_a androidboot.bootreason=warm',
    '[    0.042631] pinctrl core: initialized pinctrl subsystem',
    '[    0.102410] msm_serial: console setup on ttyMSM0',
    '[    0.191004] ufshcd: UFS controller initialized',
    '[    0.224001] VFS: Mounted root (ramfs filesystem) readonly',
    '[    0.241108] Run /init as init process',
    '[    0.252104] init: init first stage started!',
    '[    0.260803] init: Loading Android SELinux policy',
    '[    0.369011] init: First stage mount completed',
    '[    0.418776] init: init second stage started!',
    '[    0.501993] ueventd: ueventd started!',
  ]
  const devices = ['qcom-spmi-pmic', 'ufs-qcom', 'arm-smmu', 'qcom-cpufreq-hw', 'qcom-rng', 'qcom-pon', 'qcom-tsens', 'qcom-watchdog']
  const services = ['servicemanager', 'hwservicemanager', 'vold', 'apexd', 'logd', 'lmkd', 'keystore2', 'statsd', 'netd', 'zygote', 'surfaceflinger', 'audioserver']
  for (let index = 0; lines.length < count; index += 1) {
    const clock = (0.55 + index * 0.0037).toFixed(6).padStart(11, ' ')
    const variant = index % 8
    if (variant === 0) lines.push(`[${clock}] ${devices[index % devices.length]}: probe instance=${index % 7} status=ready`)
    else if (variant === 1) lines.push(`[${clock}] init: Parsing file /vendor/etc/init/${services[index % services.length]}.rc`)
    else if (variant === 2) lines.push(`[${clock}] init: starting service '${services[index % services.length]}' pid=${300 + index}`)
    else if (variant === 3) lines.push(`[${clock}] binder: transaction=${index} node=${index % 64} completed`)
    else if (variant === 4) lines.push(`[${clock}] ueventd: /devices/platform/soc/${index % 48} permissions applied`)
    else if (variant === 5) lines.push(`[${clock}] ufshcd: tag=${index % 32} lun=${index % 8} command complete status=0`)
    else if (variant === 6) lines.push(`[${clock}] thermal: zone=${index % 6} temp=${42000 + (index % 13000)} trip=normal`)
    else lines.push(`[${clock}] ActivityManager: Start proc ${1000 + index}:${services[index % services.length]}/u0a${index % 90}`)
  }
  lines.push(
    '[    8.920114] bootstat: canonical boot reason: warm',
    '[    9.104882] init: processing action (sys.boot_completed=1)',
    `EVALUATION_CONDITION ${condition}`,
    'console:/ #',
  )
  return lines
}

function testBody(condition: string, count: number): string[] {
  const frequency = value(condition, 'FREQ', '9600MHz').replace(/MHz/i, '')
  const pattern = value(condition, 'PATTERN', 'WR')
  const mode = value(condition, 'TM', 'HDIAG')
  const lines = [
    `console:/ # setddrclk ${frequency}`,
    `DDR frequency fixed at ${frequency}MHz`,
    `console:/ # hdiag --mode ${mode} --pattern ${pattern} --loops 200`,
    `HIDAG START mode=${mode} pattern=${pattern} loops=200`,
    'console:/ # stressapptest -M 4096 -s 600',
    'stressapptest: start memory=4096MB duration=600s',
    'console:/ # sleep 20',
  ]
  for (let index = 0; lines.length < count; index += 1) {
    const variant = index % 6
    if (variant === 0) lines.push(`HIDAG progress loop=${Math.floor(index / 32) + 1}/200 pattern=${pattern} CH=${index % 4} SUBCH=${Math.floor(index / 4) % 2}`)
    else if (variant === 1) lines.push(`HIDAG address sweep BG=${Math.floor(index / 4) % 4} BK=${index % 8} ROW=0x${(0x20 + index % 0x5f).toString(16)} COL=0x${(0x08 + index % 0x70).toString(16)} compare=PASS`)
    else if (variant === 2) lines.push(`HIDAG lane margin DQ=${index % 32} BL=${(index % 4) * 8} eye=${21 + index % 17}ps status=PASS`)
    else if (variant === 3) lines.push(`stressapptest: worker=${index % 16} copied=${1024 + index}MB errors=0`)
    else if (variant === 4) lines.push(`RAS MC${index % 4}: scrub cycle=${index} corrected=0 uncorrected=0`)
    else lines.push(`thermal: memory_zone temp=${47000 + index % 16000} target=stable`)
  }
  return lines
}

export function buildSyntheticQualcommLog(input: {
  run: string
  condition: string
  outcome: SyntheticOutcome
  terminalLines: string[]
  lineCount?: number
}): string {
  const lineCount = input.lineCount ?? 7_600
  const lines = [
    '# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture',
    `META RUN=${input.run} ${input.condition}`,
    ...powerAndTraining(input.run, input.condition, 1),
    ...uefiSetup(input.condition),
    ...powerAndTraining(input.run, input.condition, 2, input.outcome === 'TRAINING_FAIL'),
  ]
  if (input.outcome === 'TRAINING_FAIL') {
    while (lines.length < lineCount) lines.splice(lines.length - 4, 0, `DDR_PHY recovery trace step=${lines.length} lane=${lines.length % 32} status=retry`)
    return `${lines.slice(0, lineCount).join('\n')}\n`
  }
  lines.push(...androidBoot(input.condition))
  lines.push(...testBody(input.condition, Math.max(12, lineCount - lines.length - input.terminalLines.length)))
  lines.push(...input.terminalLines)
  return `${lines.slice(0, lineCount).join('\n')}\n`
}
