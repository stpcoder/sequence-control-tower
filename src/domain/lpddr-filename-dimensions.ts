import type { ProjectEquipmentProfile, ProjectEvaluationDimensions } from '../../electron/shared/contracts'
import type { ResultLabel } from './workbench'
import { detectSocFilenameContext, type SocFilenameContext } from './soc-profile'
import { explicitLpddrConditions } from './lpddr-evaluation-baseline'

const fileBaseName = (value: string): string => value.replace(/\\/g, '/').split('/').at(-1) ?? value
const safeName = (value: string): string => fileBaseName(value)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 512)
const capture = (name: string, expression: RegExp): string | undefined => expression.exec(name)?.[1]
const captures = (name: string, expression: RegExp): string[] => [...name.matchAll(expression)].map((match) => match[1]).filter(Boolean)
const decimal = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value.replace(/[pP]/g, '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

export interface PositionalLabFilename {
  equipmentChannel: string
  gridId: string
  temperatureC: number
  vdd: number
  eccMode: string
  customCondition?: string
  material: string
  evaluationStep?: string
  frequencyMHz?: number
  outcome: ResultLabel
}

const positionalOutcome = (value: string | undefined): ResultLabel | undefined => {
  const token = value?.replace(/[^a-z0-9]/gi, '').toUpperCase()
  if (!token) return undefined
  if (token === 'PASS') return 'PASS'
  if (token === 'HDIAGREBOOT' || token === 'HIDAGREBOOT' || token === 'SYSTEMREBOOT' || token === 'REBOOT') return 'SYSTEM_REBOOT'
  if (token === 'MBEFAIL' || token === 'HDIAGFAIL' || token === 'HIDAGFAIL' || token === 'DIAGFAIL') return 'DIAG_FAIL'
  if (token === 'TRAININGFAIL' || token === 'TRFAIL') return 'TRAINING_FAIL'
  if (token === 'SYSTEMHALT' || token === 'HALT') return 'SYSTEM_HALT'
  if (token === 'TESTFAIL' || token === 'FAIL') return 'TEST_FAIL'
  return undefined
}

/**
 * Parses the lab's underscore-delimited capture convention without guessing
 * unrelated numeric tokens. The layout is anchored by Ch*, SoC, numeric
 * evaluation/temperature/VDD fields, ECC and COM*.
 */
export function parsePositionalLabFilename(fileName: string): PositionalLabFilename | undefined {
  const stem = fileBaseName(fileName).replace(/\.[^.]+$/, '')
  const tokens = stem.split('_').map((token) => token.trim()).filter(Boolean)
  const channelIndex = tokens.findIndex((token) => /^CH\d+$/i.test(token))
  if (channelIndex < 0 || channelIndex + 8 >= tokens.length) return undefined
  const soc = tokens[channelIndex + 1]
  const gridId = tokens[channelIndex + 2]
  const temperature = tokens[channelIndex + 3]
  const voltage = tokens[channelIndex + 4]
  const eccMode = tokens[channelIndex + 6]
  if (!/^(?:SM-?\d{3,5}|SDM-?\d{3,5}|MSM-?\d{3,5}|MTK-?[A-Z0-9-]+)$/i.test(soc)) return undefined
  if (!/^\d+$/.test(gridId) || !/^-?\d{1,3}(?:\.\d+)?$/.test(temperature) || !/^\d+(?:[p.]\d+)?$/i.test(voltage)) return undefined
  if (!/^(?:EN|DIS|ENABLE|DISABLE|ON|OFF|ECCON|ECCOFF)$/i.test(eccMode)) return undefined
  const comIndex = tokens.findIndex((token, index) => index > channelIndex + 6 && /^COM\d+$/i.test(token))
  if (comIndex < 0 || comIndex + 1 >= tokens.length) return undefined
  const outcomeIndex = tokens.length - 1
  const outcome = positionalOutcome(tokens[outcomeIndex])
  if (!outcome || outcomeIndex <= comIndex + 1) return undefined
  const conditions = tokens.slice(channelIndex + 7, comIndex)
  const frequency = conditions.map((token) => /^(\d{3,5})(?:MHZ|MT|MTPS)$/i.exec(token)?.[1]).find(Boolean)
  const stepTokens = tokens.slice(comIndex + 2, outcomeIndex)
  return {
    equipmentChannel: tokens[channelIndex].replace(/^CH/i, ''),
    gridId,
    temperatureC: Number(temperature),
    vdd: Number(voltage.replace(/[pP]/g, '.')),
    eccMode: eccMode.toUpperCase(),
    ...(conditions.length ? { customCondition: conditions.join('_') } : {}),
    material: tokens[comIndex + 1].toUpperCase(),
    ...(stepTokens.length ? { evaluationStep: stepTokens.join('_').toUpperCase() } : {}),
    ...(frequency ? { frequencyMHz: Number(frequency) } : {}),
    outcome,
  }
}

export function extractLpddrFilenameOutcome(fileName: string): ResultLabel | undefined {
  return parsePositionalLabFilename(fileName)?.outcome
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
  const positional = parsePositionalLabFilename(name)
  const explicitConditions = explicitLpddrConditions(name)
  const temperature = capture(name, /(?:^|[_\-.])(?:TEMP|T)(?:=|_)?(-?\d{1,3})(?:C)?(?:[_\-.]|$)/i)
  const vdd = capture(name, /(?:^|[_\-.])VDD(?:=|_|-)?(\d+(?:[p.]\d+)?)(?:V)?(?:[_\-.]|$)/i)
  const frequency = capture(name, /(?:^|[_\-.])(?:FREQ|F)(?:=|_|-)?(\d{3,5})(?:MHZ|MT)?(?:[_\-.]|$)/i)
    ?? capture(name, /(?:^|[_\-.])(\d{3,5})MT(?:[_\-.]|$)/i)
  const pattern = capture(name, /(?:^|[_\-.])(?:PATTERN|PAT)(?:=|_|-)?([A-Z0-9][A-Z0-9_-]*?)(?=[_.-](?:DQ|BL|CH|CHANNEL|SUBCH|SCH|CS|RANK|RK|BANK|BG|ROW|COL|FREQ|TEMP|VDD|SKEW|TSKEW|TM|MODE|PASS|FAIL|HALT|REBOOT|TRAIN)(?:=|_|-)?|\.LOG$|$)/i)
  const samples = captures(name, /(?:^|[_\-.])(?:SAMPLE|SMP)(?:=|_|-)?([A-Z0-9]+(?:-[A-Z0-9]+)*?)(?=[_.-](?:SAMPLE|SMP)(?:=|_|-)|[_.]|$)/gi)
  const explicitMaterial = capture(name, /(?:^|[_\-.])(?:MATERIAL|MAT)(?:=|_|-)([A-Z0-9-]+)/i)
  // In this workflow "material" and "Sample" are the same physical identifier.
  // Preserve both contract fields as aliases, but never infer different values.
  const materialSample = samples.length === 1 ? samples[0].toUpperCase() : explicitMaterial ?? positional?.material
  const soc = projectSocContext(name, profiles)
  const prefixedSkew = capture(name, /(?:^|[_\-.])SKEW(?:=|_|-)?([A-Z][A-Z0-9-]*)(?=[_.]|$)/i)
  const standardSkew = capture(name, /(?:^|[_\-.])(TT|SS|SF|FS|FF)(?=[_.-]|$)/i)
  const parsedTemperature = decimal(temperature)
  const parsedVdd = decimal(vdd)
  const parsedFrequency = decimal(frequency)
  const parsedTestMode = capture(name, /(?:^|[_\-.])(?:TM|MODE)(?:=|_|-)?([A-Z0-9-]+)/i)?.toUpperCase()
  return {
    ...explicitConditions,
    skew: (prefixedSkew ?? standardSkew)?.toUpperCase(),
    lot: capture(name, /(?:^|[_\-.])LOT(?:=|_|-)?([A-Z0-9-]+)/i),
    material: materialSample,
    die: capture(name, /(?:^|[_\-.])DIE(?:=|_|-)?([A-Z0-9-]+)/i),
    sample: materialSample,
    bl: capture(name, /(?:^|[_\-.])BL(?:=|_|-)?(\d+)/i),
    dq: capture(name, /(?:^|[_\-.])DQ(?:=|_|-)?(\d+)/i),
    // Positional Ch8 is the tester/equipment channel, not a DRAM fail address.
    channel: positional ? undefined : capture(name, /(?:^|[_\-.])(?:CH|CHANNEL)(?:=|_|-)?(\d+)/i),
    subChannel: capture(name, /(?:^|[_\-.])(?:SUBCH|SUBCHANNEL|SCH)(?:=|_|-)?(\d+)/i),
    chipSelect: capture(name, /(?:^|[_\-.])(?:CS|CHIPSELECT)(?:=|_|-)?(\d+)/i),
    rank: capture(name, /(?:^|[_\-.])(?:RANK|RK)(?:=|_|-)?(\d+)/i),
    bank: capture(name, /(?:^|[_\-.])BANK(?:=|_|-)?(\d+)/i),
    bankGroup: capture(name, /(?:^|[_\-.])(?:BG|BANKGROUP)(?:=|_|-)?(\d+)/i),
    row: capture(name, /(?:^|[_\-.])ROW(?:=|_|-)?([A-F0-9x]+)/i),
    column: capture(name, /(?:^|[_\-.])(?:COL|COLUMN)(?:=|_|-)?([A-F0-9x]+)/i),
    writeData: capture(name, /(?:^|[_\-.])(?:WR|WRITE)(?:=|_|-)?([A-F0-9x]+)/i),
    readData: capture(name, /(?:^|[_\-.])(?:RD|READ)(?:=|_|-)?([A-F0-9x]+)/i),
    pattern,
    equipmentChannel: positional?.equipmentChannel,
    gridId: positional?.gridId,
    eccMode: positional?.eccMode,
    customCondition: positional?.customCondition,
    evaluationStep: positional?.evaluationStep,
    frequencyMHz: parsedFrequency ?? positional?.frequencyMHz ?? explicitConditions.frequencyMHz,
    temperatureC: parsedTemperature ?? positional?.temperatureC ?? explicitConditions.temperatureC,
    vdd: parsedVdd ?? positional?.vdd ?? explicitConditions.vdd,
    timingSkewPs: decimal(capture(name, /(?:^|[_\-.])(?:TSKEW|TIMINGSKEW)(?:=|_|-)?(-?\d+(?:[p.]\d+)?)(?:PS)?/i)),
    testMode: parsedTestMode ?? explicitConditions.testMode,
    ...(soc.vendor === 'unknown' ? {} : { socVendor: soc.vendor, socModel: soc.socModel, bootProfileId: soc.bootProfileId }),
  }
}
