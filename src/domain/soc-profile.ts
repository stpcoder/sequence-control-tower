export type SocVendor = 'qualcomm' | 'mediatek' | 'unknown'

export type BootStageKind =
  | 'power-on' | 'pbl' | 'xbl' | 'abl' | 'uefi' | 'exit-boot'
  | 'post-pbl' | 'lk' | 'lk2' | 'training' | 'os' | 'memory-test'

export interface BootStageDefinition {
  id: BootStageKind
  label: string
  aliases: readonly string[]
  optional?: boolean
}

export interface BootProfileDefinition {
  id: 'qualcomm-default' | 'mediatek-default'
  vendor: Exclude<SocVendor, 'unknown'>
  label: string
  stages: readonly BootStageDefinition[]
}

export interface SocFilenameContext {
  vendor: SocVendor
  socModel?: string
  bootProfileId?: BootProfileDefinition['id']
  confidence: number
  evidence?: string
  explicitRetest: boolean
  attemptNo?: number
}

export const BOOT_PROFILES: readonly BootProfileDefinition[] = [
  {
    id: 'qualcomm-default', vendor: 'qualcomm', label: 'Qualcomm',
    stages: [
      { id: 'power-on', label: 'Power on', aliases: ['POWER ON', 'POWER_ON', 'PLATFORM INIT'] },
      { id: 'pbl', label: 'PBL', aliases: ['PBL'] },
      { id: 'xbl', label: 'XBL', aliases: ['XBL'], optional: true },
      { id: 'abl', label: 'ABL', aliases: ['ABL'], optional: true },
      { id: 'uefi', label: 'UEFI', aliases: ['UEFI', 'EDK2', 'DXE', 'BDS'] },
      { id: 'exit-boot', label: 'Exit boot', aliases: ['EXITBOOTSERVICES', 'EXIT BOOT SERVICES', 'UEFI EXIT'] },
      { id: 'training', label: 'Training', aliases: ['TRAINING', 'WRITE LEVEL', 'READ GATE', 'WCK SYNC'] },
      { id: 'os', label: 'OS', aliases: ['ANDROID', 'LINUX', 'KERNEL', 'OS READY'] },
      { id: 'memory-test', label: 'Memory test', aliases: ['STRESSAPP', 'HIDAG', 'HI_DIAG', 'MEMTESTER'] },
    ],
  },
  {
    id: 'mediatek-default', vendor: 'mediatek', label: 'MediaTek',
    stages: [
      { id: 'power-on', label: 'Power on', aliases: ['POWER ON', 'POWER_ON', 'PLATFORM INIT'] },
      { id: 'post-pbl', label: 'Post-PBL', aliases: ['POST-PBL', 'POST_PBL', 'POST PBL'] },
      { id: 'lk', label: 'LK', aliases: ['LK', 'LITTLE KERNEL'] },
      { id: 'lk2', label: 'LK2', aliases: ['LK2', 'LK 2'], optional: true },
      { id: 'training', label: 'Training', aliases: ['TRAINING', 'WRITE LEVEL', 'READ GATE', 'WCK SYNC'] },
      { id: 'os', label: 'OS', aliases: ['ANDROID', 'LINUX', 'KERNEL', 'OS READY'] },
      { id: 'memory-test', label: 'Memory test', aliases: ['STRESSAPP', 'HIDAG', 'HI_DIAG', 'MEMTESTER'] },
    ],
  },
] as const

const basename = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1) ?? value
const normalizedModel = (prefix: string, value: string): string => `${prefix}-${value.toUpperCase().replace(/^[-_]+/, '').replace(/_/g, '-')}`

/** Filename metadata is a candidate. The caller must retain its confidence and
 * may ask once before persisting a project-specific binding. */
export function detectSocFilenameContext(fileName: string): SocFilenameContext {
  const name = basename(fileName).slice(0, 300)
  const qualcomm = /(?:^|[^A-Z0-9])(?:QUALCOMM|QCOM|QC)?[ _.-]*(SM|SDM|MSM)[ _.-]?([0-9]{3,5})(?:[^A-Z0-9]|$)/i.exec(name)
  const mediatek = /(?:^|[^A-Z0-9])(?:MEDIATEK|MTK)[ _.-]?([0-9]{1,3}D|MT[0-9]{3,5}|DIMENSITY[ _.-]?[0-9]{3,5})(?:[^A-Z0-9]|$)/i.exec(name)
  const explicitRetest = /(?:^|[_. -])(?:RT|RETEST|RE-TEST)[_. -]?(\d+)?(?:[_. -]|$)/i.exec(name)
  const run = /(?:^|[_. -])(?:RUN|ATTEMPT)[_. =-]?(\d+)(?:[_. -]|$)/i.exec(name)
  const attemptNo = Number(explicitRetest?.[1] ?? run?.[1])
  if (qualcomm && !mediatek) return {
    vendor: 'qualcomm', socModel: normalizedModel(qualcomm[1], qualcomm[2]), bootProfileId: 'qualcomm-default',
    confidence: 0.98, evidence: qualcomm[0].trim(), explicitRetest: Boolean(explicitRetest),
    ...(Number.isSafeInteger(attemptNo) && attemptNo > 0 ? { attemptNo } : {}),
  }
  if (mediatek && !qualcomm) return {
    vendor: 'mediatek', socModel: normalizedModel('MTK', mediatek[1]), bootProfileId: 'mediatek-default',
    confidence: 0.98, evidence: mediatek[0].trim(), explicitRetest: Boolean(explicitRetest),
    ...(Number.isSafeInteger(attemptNo) && attemptNo > 0 ? { attemptNo } : {}),
  }
  return {
    vendor: 'unknown', confidence: qualcomm && mediatek ? 0 : 0.2,
    evidence: qualcomm && mediatek ? 'conflicting SoC tokens' : undefined,
    explicitRetest: Boolean(explicitRetest),
    ...(Number.isSafeInteger(attemptNo) && attemptNo > 0 ? { attemptNo } : {}),
  }
}

export function bootProfile(profileId: string | undefined): BootProfileDefinition | undefined {
  return BOOT_PROFILES.find((profile) => profile.id === profileId)
}

/** Removes outcome/attempt tokens but preserves engineering conditions. It is
 * a fallback identity when a parsed sequence fingerprint is unavailable. */
export function normalizedEvaluationStem(fileName: string): string {
  return basename(fileName)
    .replace(/\.[^.]+$/, '')
    .replace(/(?:^|[_. -])(?:RT|RETEST|RE-TEST|RUN|ATTEMPT)[_. =-]?\d*(?=[_. -]|$)/gi, '_')
    .replace(/(?:^|[_. -])(?:PASS|FAIL|HALT|REBOOT|INCOMPLETE)(?=[_. -]|$)/gi, '_')
    .replace(/[_. -]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}
