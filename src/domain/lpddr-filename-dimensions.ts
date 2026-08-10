import type { ProjectEquipmentProfile, ProjectEvaluationDimensions } from '../../electron/shared/contracts'
import { detectSocFilenameContext, type SocFilenameContext } from './soc-profile'

const fileBaseName = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1) ?? value
const safeName = (value: string): string => fileBaseName(value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 240)
const capture = (name: string, expression: RegExp): string | undefined => expression.exec(name)?.[1]
const captures = (name: string, expression: RegExp): string[] => [...name.matchAll(expression)].map((match) => match[1]).filter(Boolean)
const decimal = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value.replace(/[pP]/g, '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

export function projectSocContext(fileName: string, profiles: readonly ProjectEquipmentProfile[] = []): SocFilenameContext {
  const detected = detectSocFilenameContext(fileName)
  if (detected.vendor !== 'unknown') return detected
  const lower = fileBaseName(fileName).toLowerCase()
  const matched = profiles.find((profile) => [profile.alias, ...(profile.filenameAliases ?? []), ...(profile.socModels ?? [])]
    .some((alias) => alias.length >= 2 && lower.includes(alias.toLowerCase())))
  if (!matched || (matched.vendor !== 'qualcomm' && matched.vendor !== 'mediatek')) return detected
  return {
    vendor: matched.vendor,
    socModel: matched.socModels?.[0],
    bootProfileId: matched.profileId as 'qualcomm-default' | 'mediatek-default',
    confidence: 0.95,
    evidence: matched.alias,
    explicitRetest: detected.explicitRetest,
    ...(detected.attemptNo ? { attemptNo: detected.attemptNo } : {}),
  }
}

/** One deterministic filename vocabulary shared by the renderer tables and the native Agent. */
export function extractLpddrFilenameDimensions(fileName: string, profiles: readonly ProjectEquipmentProfile[] = []): ProjectEvaluationDimensions {
  const name = safeName(fileName)
  const temperature = capture(name, /(?:^|[_\-.])(?:TEMP|T)(?:=|_)?(-?\d{1,3})(?:C)?(?:[_\-.]|$)/i)
  const vdd = capture(name, /(?:^|[_\-.])VDD(?:=|_|-)?(\d+(?:[p.]\d+)?)(?:V)?(?:[_\-.]|$)/i)
  const frequency = capture(name, /(?:^|[_\-.])(?:FREQ|F)(?:=|_|-)?(\d{3,5})(?:MHZ|MT)?(?:[_\-.]|$)/i)
    ?? capture(name, /(?:^|[_\-.])(\d{3,5})MT(?:[_\-.]|$)/i)
  const pattern = capture(name, /(?:^|[_\-.])(?:PATTERN|PAT)(?:=|_|-)?([A-Z0-9-]+)/i)
    ?.replace(/-(?:DQ|BL|CH|CHANNEL|SUBCH|SCH|RANK|BANK|BG|ROW|COL|FREQ|TEMP|VDD|SKEW|TSKEW|TM|MODE|PASS|FAIL|HALT|TRAIN).*$/i, '')
  const samples = captures(name, /(?:^|[_\-.])(?:SAMPLE|SMP)(?:=|_|-)?([A-Z0-9]+(?:-[A-Z0-9]+)*?)(?=[_.-](?:SAMPLE|SMP)(?:=|_|-)|[_.]|$)/gi)
  const soc = projectSocContext(name, profiles)
  return {
    skew: capture(name, /(?:^|[_\-.])SKEW(?:=|_|-)?([A-Z][A-Z0-9-]*)(?=[_.]|$)/i),
    lot: capture(name, /(?:^|[_\-.])LOT(?:=|_|-)?([A-Z0-9-]+)/i),
    material: capture(name, /(?:^|[_\-.])(?:MAT|MATERIAL)(?:=|_|-)?([A-Z0-9-]+)/i),
    die: capture(name, /(?:^|[_\-.])DIE(?:=|_|-)?([A-Z0-9-]+)/i),
    sample: samples.length === 1 ? samples[0].toUpperCase() : undefined,
    bl: capture(name, /(?:^|[_\-.])BL(?:=|_|-)?(\d+)/i),
    dq: capture(name, /(?:^|[_\-.])DQ(?:=|_|-)?(\d+)/i),
    channel: capture(name, /(?:^|[_\-.])(?:CH|CHANNEL)(?:=|_|-)?(\d+)/i),
    subChannel: capture(name, /(?:^|[_\-.])(?:SUBCH|SUBCHANNEL|SCH)(?:=|_|-)?(\d+)/i),
    rank: capture(name, /(?:^|[_\-.])(?:RANK|RK)(?:=|_|-)?(\d+)/i),
    bank: capture(name, /(?:^|[_\-.])BANK(?:=|_|-)?(\d+)/i),
    bankGroup: capture(name, /(?:^|[_\-.])(?:BG|BANKGROUP)(?:=|_|-)?(\d+)/i),
    row: capture(name, /(?:^|[_\-.])ROW(?:=|_|-)?([A-F0-9x]+)/i),
    column: capture(name, /(?:^|[_\-.])(?:COL|COLUMN)(?:=|_|-)?([A-F0-9x]+)/i),
    pattern,
    frequencyMHz: decimal(frequency),
    temperatureC: decimal(temperature),
    vdd: decimal(vdd),
    timingSkewPs: decimal(capture(name, /(?:^|[_\-.])(?:TSKEW|TIMINGSKEW)(?:=|_|-)?(-?\d+(?:[p.]\d+)?)(?:PS)?/i)),
    testMode: capture(name, /(?:^|[_\-.])(?:TM|MODE)(?:=|_|-)?([A-Z0-9-]+)/i)?.toUpperCase(),
    ...(soc.vendor === 'unknown' ? {} : { socVendor: soc.vendor, socModel: soc.socModel, bootProfileId: soc.bootProfileId }),
  }
}
