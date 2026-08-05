#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultOutput = resolve(scriptDirectory, '..', '..', 'qualcomm-bringup')
const generatorId = 'qualcomm-bringup-corpus-v1'
const stage = {
  powerOn: 'SYN_POWER_ON',
  uefiEnter: 'SYN_UEFI_ENTER',
  uefiExit: 'SYN_UEFI_EXIT',
  osBootStart: 'SYN_OS_BOOT_START',
  osReady: 'SYN_OS_READY',
}

const temperatures = ['-40', '0', '25', '85', '105', '125']
const voltages = ['0.70', '0.75', '0.80', '0.90']
const modes = ['DIAG', 'TEST', 'NORMAL', 'UEFI']
const materials = ['H9K', 'K4P', 'Q2X', 'R7M']

function parseOutput(argv) {
  const outputArgument = argv.find((argument) => argument === '--output' || argument.startsWith('--output='))
  if (!outputArgument) return defaultOutput
  if (outputArgument === '--output') {
    const value = argv[argv.indexOf(outputArgument) + 1]
    if (!value) throw new Error('--output requires a directory')
    return resolve(value)
  }
  const value = outputArgument.slice('--output='.length)
  if (!value) throw new Error('--output requires a directory')
  return resolve(value)
}

function metadataFor(index) {
  return {
    sample: `QBR-${String(index + 1).padStart(3, '0')}`,
    material: materials[index % materials.length],
    tempC: temperatures[index % temperatures.length],
    mode: modes[index % modes.length],
    vdd: voltages[index % voltages.length],
    run: String((index % 4) + 1).padStart(3, '0'),
  }
}

function filenameFor(metadata, variant) {
  const { sample, material, tempC, mode, vdd, run } = metadata
  const temp = `${tempC}C`
  const vddToken = vdd.replace('.', 'p')
  switch (variant % 8) {
    case 0:
      return `${sample}__MAT=${material}__TEMP=${temp}__MODE=${mode}__VDD=${vddToken}__RUN=${run}.log`
    case 1:
      return `LOT-SYN.SAMPLE=${sample}.MATERIAL=${material}.TEMP=${temp}.MODE=${mode}.VDD=${vddToken}.RUN=${run}.log`
    case 2:
      return `${sample}-${material}-${temp}-${mode}-VDD${vddToken}-R${run}.log`
    case 3:
      return `${sample}__mat=${material}__temp=${temp}__mode=${mode.toLowerCase()}__vdd=${vddToken}__run=${run}.log`
    case 4:
      return `${sample}_${material}_${temp}_${mode}_VDD${vddToken}_run${run}.log`
    case 5:
      return `capture-${sample}+MAT-${material}+TEMP-${temp}+MODE-${mode}+VDD-${vddToken}+RUN-${run}.log`
    case 6:
      return `session-${run}/${sample}__MATERIAL=${material}__TEMP=${temp}__MODE=${mode}__VDD=${vddToken}.log`
    default:
      return `${sample}__MATERIAL-${material}__T=${temp}__M=${mode}__V=${vddToken}__${run}.log`
  }
}

function address(index, offset = 0) {
  return `0x${(0x10000000 + index * 0x1000 + offset).toString(16).padStart(8, '0')}`
}

function hexValue(index, offset, width = 8) {
  const digits = width === 16 ? 16 : 8
  return `0x${(0x51000000 + index * 0x101 + offset).toString(16).padStart(digits, '0')}`
}

function tskhynixBaseline(index) {
  const repeated = address(index, 0x40)
  return [
    `tSKHYNIX_MARCH_BASELINE, ADDR=${repeated}, AP=1, IDX=0x2, CS=1, BK=3, ROW=0x1234, COL=0x40, WR=${hexValue(index, 0x11)}, RD=${hexValue(index, 0x11)};`,
    `tSKHYNIX_RANDOM_BASELINE ADDR=${address(index, 0x80)} AP=0 IDX=3 CS=0 BK=2 ROW=0x2000 COL=0x80 WR=0x1122334455667788 RD=0x1122334455667788;`,
  ]
}

function stressLine(index, physical, read, reread, expected, cpu, lastWriterCpu, crc = false) {
  const outer = address(index, crc ? 0x600 : 0x500)
  const location = `(${physical}:DIMM Unknown)`
  const prefix = crc
    ? `Hardware Error: CRC check at ${outer}${location}: miscompare on CPU ${cpu}(<-${lastWriterCpu})`
    : `Hardware Error: miscompare on CPU ${cpu}(<-${lastWriterCpu}) at ${outer}${location}`
  return `${prefix}: read:${read}, reread:${reread} expected:${expected}. 'synthetic_pattern' read error. ddr_freq(write=3196 read=3200 reread=3204).`
}

function stressRecords(profile, index) {
  const repeated = address(index, 0x120)
  const records = ['STRESSAPP PASS']
  switch (profile) {
    case 'low-half-mismatch':
      records.push(stressLine(index, repeated, '0xAAAABBBB11112222', '0xAAAABBBBCCCCDDDD', '0xAAAABBBBCCCCDDDD', 6, 3))
      break
    case 'high-half-mismatch':
      records.push(stressLine(index, repeated, '0x11112222CCCCDDDD', '0xAAAABBBBCCCCDDDD', '0xAAAABBBBCCCCDDDD', 7, 4))
      break
    case 'both-half-mismatch':
      records.push(stressLine(index, repeated, '0x1111222233334444', '0xAAAABBBBCCCCDDDD', '0xAAAABBBBCCCCDDDD', 2, 1))
      break
    case 'repeated-address':
      records.push(stressLine(index, repeated, '0xAAAABBBB00000001', '0xAAAABBBB00000000', '0xAAAABBBB00000000', 3, 2))
      records.push(stressLine(index, repeated, '0xAAAABBBB00000002', '0xAAAABBBB00000000', '0xAAAABBBB00000000', 4, 2))
      records.push(stressLine(index, repeated, '0xAAAABBBB00000004', '0xAAAABBBB00000000', '0xAAAABBBB00000000', 5, 2))
      break
    case 'crc':
      records.push(stressLine(index, repeated, '0x00000000DEADBEEF', '0x00000000CAFEBABE', '0x00000000CAFEBABE', 5, 1, true))
      break
    case 'excluded':
      records.push(`STRESSAPP EXCLUDED physical=${repeated} reason=reserved-range;`)
      break
    case 'malformed':
      records.push('STRESSAPP MALFORMED physical=not-an-address expected=<missing> actual=0x00;')
      break
    default:
      break
  }
  return records
}

function tskhynixRecords(profile, index) {
  const repeated = address(index, 0x2c0)
  switch (profile) {
    case 'repeated-address':
      return [
        `tSKHYNIX_SAME_ADDRESS_0, ADDR=${repeated}, AP=1, IDX=0x2, CS=1, BK=3, ROW=0x1234, COL=0x2c0, WR=0x11223344, RD=0x11223345;`,
        `tSKHYNIX_SAME_ADDRESS_1 ADDR=${repeated} AP=1 IDX=0x2 CS=1 BK=3 ROW=0x1234 COL=0x2c0 WR=0x11223344 RD=0x11223346;`,
      ]
    case '32-bit':
      return [`tSKHYNIX_MARCH_32, ADDR=${address(index, 0x200)}, AP=1, IDX=0x2, CS=1, BK=3, ROW=0x1234, COL=0x200, WR=0xFFFFFFFF, RD=0x00000000;`]
    case '64-bit':
      return [`tSKHYNIX_RANDOM_64 ADDR=${address(index, 0x240)} AP=0 IDX=3 CS=0 BK=2 ROW=0x2000 COL=0x240 WR=0xAAAABBBBCCCCDDDD RD=0x1111222233334444;`]
    case 'alias':
      return [`tSKHYNIX_ALIAS_CONTEXT, ADDRESS=${address(index, 0x280)}, AP=0x1, INDEX=0x2, CS=0x1, BANK=0x3, ROW=0x1234, COLUMN=0x280, EXPECTED=0x0BADCAFE, ACTUAL=0x0BADCAFF;`]
    case 'equal-values':
      return [`tSKHYNIX_EQUAL_BASELINE, ADDR=${address(index, 0x2c0)}, WR=0xDEADBEEF, RD=0xDEADBEEF;`]
    case 'missing-fields':
      return [
        `tSKHYNIX_MISSING_WRITE, ADDR=${address(index, 0x300)}, RD=0x05060708;`,
        `tSKHYNIX_MISSING_READ, ADDR=${address(index, 0x340)}, WR=0x01020304;`,
      ]
    case 'misaligned':
      return [`tSKHYNIX_MISALIGNED ADDR=${address(index, 0x303)} WR=0x01020304 RD=0x05060708;`]
    case 'overlong':
      return [`tSKHYNIX_OVERLONG ADDR=${address(index, 0x380)} WR=0x${'1234567890abcdef'.repeat(3)} RD=0x${'fedcba0987654321'.repeat(3)};`]
    case 'composite':
      return [
        `tSKHYNIX_COMPOSITE_32, ADDR=${address(index, 0x400)}, AP=1, IDX=0x2, CS=1, BK=3, ROW=0x1234, COL=0x400, WR=0x00000000, RD=0x00000001;`,
        `tSKHYNIX_COMPOSITE_64 ADDR=${address(index, 0x440)} AP=0 IDX=3 CS=0 BK=2 ROW=0x2000 COL=0x440 WR=0xFFFF0000FFFF0000 RD=0xEEEE0000EEEE0000;`,
        `tSKHYNIX_COMPOSITE_ALIAS, ADDRESS=${address(index, 0x480)}, AP=1, INDEX=2, CS=1, BANK=3, ROW=0x1234, COLUMN=0x480, EXPECTED=0x11111111, ACTUAL=0x11111110;`,
      ]
    default:
      return []
  }
}

function memoryRecords(profile, index) {
  return [...stressRecords(profile, index), ...tskhynixBaseline(index), ...tskhynixRecords(profile, index)]
}

function stagesFor(family, variant) {
  if (family === 'pass' || family === 'filename-variants' || family === 'memory-records' || family === 'metadata-mismatch') {
    return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, stage.osReady]
  }
  if (family === 'uefi-failure') {
    if (variant % 3 === 0) return [stage.powerOn, stage.uefiEnter, 'SYN_UEFI_FAIL']
    if (variant % 3 === 1) return [stage.powerOn, stage.uefiEnter, 'SYN_UEFI_TIMEOUT']
    return [stage.powerOn, stage.uefiEnter]
  }
  if (family === 'uefi-exit') {
    return variant % 2 === 0
      ? [stage.powerOn, stage.uefiEnter, 'SYN_UEFI_EXIT_FAILED']
      : [stage.powerOn, stage.uefiEnter, stage.osBootStart]
  }
  if (family === 'os-failure') {
    if (variant % 3 === 0) return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, 'SYN_OS_PANIC']
    if (variant % 3 === 1) return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, 'SYN_OS_HALT']
    return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart]
  }
  if (family === 'reboot-recovered') {
    if (variant < 8) return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, 'SYN_WATCHDOG_RESET']
    return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, 'SYN_WATCHDOG_RESET', stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, stage.osReady]
  }
  if (family === 'stale-conflict') return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, stage.osReady]
  if (family === 'multiple-runs') return [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, stage.osReady, stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart]
  return []
}

function expectedFor(family, variant) {
  if (family === 'memory-records') {
    const profile = familyDetails(family, variant)
    if (['low-half-mismatch', 'high-half-mismatch', 'both-half-mismatch', 'repeated-address', 'crc', '32-bit', '64-bit', 'alias', 'composite'].includes(profile)) return 'TEST_FAIL'
    if (['excluded', 'malformed', 'missing-fields', 'misaligned', 'overlong'].includes(profile)) return 'UNKNOWN'
    return 'PASS'
  }
  if (family === 'pass' || family === 'filename-variants' || family === 'metadata-mismatch') return 'PASS'
  if (family === 'uefi-failure') return variant % 3 === 2 ? 'SYSTEM_HALT' : 'UEFI_FAIL'
  if (family === 'uefi-exit') return 'UEFI_EXIT_FAIL'
  if (family === 'os-failure') return variant % 3 === 0 ? 'OS_PANIC' : variant % 3 === 1 ? 'SYSTEM_HALT' : 'INCOMPLETE'
  if (family === 'reboot-recovered') return variant < 8 ? 'SYSTEM_REBOOT' : 'PASS'
  return 'UNKNOWN'
}

function reviewFor(family, variant) {
  return family === 'stale-conflict' || family === 'multiple-runs' || family === 'metadata-mismatch' || (family === 'reboot-recovered' && variant >= 8) || (family === 'memory-records' && ['excluded', 'malformed', 'missing-fields', 'misaligned', 'overlong'].includes(familyDetails(family, variant)))
}

function metadataMismatchOracleFor(family, variant, metadata) {
  if (family !== 'metadata-mismatch') return null
  const detail = familyDetails(family, variant)
  if (detail === 'temperature') {
    return { kind: 'expected-vs-observed', field: 'temperature', expected: metadata.tempC, observed: '62.1' }
  }
  if (detail === 'vdd') {
    return { kind: 'expected-vs-observed', field: 'vdd', expected: metadata.vdd, observed: '0.72' }
  }
  if (detail === 'mode') {
    return { kind: 'expected-vs-observed', field: 'mode', expected: metadata.mode, observed: 'DIAG' }
  }
  return { kind: 'filename-vs-content', field: 'mode', filename: metadata.mode, content: 'DIAG' }
}

function parserOracleFor(family, variant) {
  if (family !== 'memory-records') return null
  const profile = familyDetails(family, variant)
  const oracle = {
    expectedStressappRows: 0,
    expectedTskhynixRows: 0,
    expectedStressappRecords: 0,
    expectedTskhynixRecords: 0,
    expectedParserError: null,
  }
  if (profile === 'low-half-mismatch' || profile === 'high-half-mismatch' || profile === 'crc') {
    oracle.expectedStressappRows = 1
    oracle.expectedStressappRecords = 1
  }
  if (profile === 'both-half-mismatch') {
    oracle.expectedStressappRows = 2
    oracle.expectedStressappRecords = 1
  }
  if (profile === 'repeated-address') {
    oracle.expectedStressappRows = 3
    oracle.expectedStressappRecords = 3
    oracle.expectedTskhynixRows = 2
    oracle.expectedTskhynixRecords = 2
  }
  if (profile === '32-bit') {
    oracle.expectedTskhynixRows = 1
    oracle.expectedTskhynixRecords = 1
  }
  if (profile === '64-bit') {
    oracle.expectedTskhynixRows = 2
    oracle.expectedTskhynixRecords = 1
  }
  if (profile === 'alias') {
    oracle.expectedTskhynixRows = 1
    oracle.expectedTskhynixRecords = 1
  }
  if (profile === 'misaligned') oracle.expectedParserError = 'misaligned-address'
  if (profile === 'overlong') oracle.expectedParserError = 'overlong-value'
  if (profile === 'composite') {
    oracle.expectedTskhynixRows = 4
    oracle.expectedTskhynixRecords = 3
  }
  return oracle
}

function familyDetails(family, variant) {
  if (family === 'uefi-failure') return ['fail', 'timeout', 'halt'][variant % 3]
  if (family === 'uefi-exit') return variant % 2 === 0 ? 'failed-exit' : 'missing-exit'
  if (family === 'os-failure') return ['panic', 'halt', 'incomplete'][variant % 3]
  if (family === 'reboot-recovered') return variant < 8 ? 'reboot' : 'recovered'
  if (family === 'stale-conflict') return ['stale-terminal', 'pass-fail-conflict', 'stale-uefi', 'conflicting-exit'][variant % 4]
  if (family === 'multiple-runs') return 'two-runs'
  if (family === 'metadata-mismatch') return ['temperature', 'vdd', 'mode', 'filename-content'][variant % 4]
  if (family === 'filename-variants') return ['double-underscore', 'dot-delimited', 'hyphen-delimited', 'lowercase-keys', 'compact', 'plus-delimited', 'nested', 'mixed'][variant % 8]
  if (family === 'memory-records') return ['low-half-mismatch', 'high-half-mismatch', 'both-half-mismatch', 'repeated-address', 'crc', 'excluded', 'malformed', '32-bit', '64-bit', 'alias', 'equal-values', 'missing-fields', 'misaligned', 'overlong', 'composite', 'baseline'][variant]
  return 'canonical'
}

function lineForResult(family, variant, result, metadataMismatchOracle) {
  const lines = []
  if (family === 'reboot-recovered' && variant < 8) lines.push('SYN_WATCHDOG_RESET reason=synthetic-timeout;')
  if (family === 'stale-conflict') {
    if (variant % 4 === 1) lines.push('TERMINAL_RESULT=PASS; TERMINAL_RESULT=UEFI_FAIL;')
    if (variant % 4 === 3) lines.push('SYN_UEFI_EXIT; SYN_UEFI_EXIT_FAILED;')
  }
  if (family === 'multiple-runs') {
    lines.push('MULTIPLE_RUNS_IN_FILE=true;')
    lines.push('RUN_BOUNDARY=QBR-PRIMARY;')
  }
  if (metadataMismatchOracle?.kind === 'expected-vs-observed') {
    if (metadataMismatchOracle.field === 'temperature') lines.push(`TEMP_TARGET=${metadataMismatchOracle.expected}C; TEMP_READBACK=${metadataMismatchOracle.observed}C;`)
    if (metadataMismatchOracle.field === 'vdd') lines.push(`VDD_TARGET=${metadataMismatchOracle.expected}V; VDD_READBACK=${metadataMismatchOracle.observed}V;`)
    if (metadataMismatchOracle.field === 'mode') lines.push(`MODE_FILE=${metadataMismatchOracle.expected}; MODE_INSERTED=${metadataMismatchOracle.observed};`)
  }
  if (metadataMismatchOracle?.kind === 'filename-vs-content') {
    lines.push(`FILENAME_MODE=${metadataMismatchOracle.filename}; CONTENT_MODE=${metadataMismatchOracle.content};`)
  }
  if (family === 'os-failure' && variant % 3 === 0) lines.push('OS_PANIC reason=synthetic-kernel-watchdog;')
  if (family === 'os-failure' && variant % 3 === 1) lines.push('OS_HALT reason=synthetic-no-progress;')
  if (family === 'uefi-failure' && variant % 3 === 0) lines.push('UEFI_FAIL code=SYN_HANDOFF_REJECTED;')
  if (family === 'uefi-failure' && variant % 3 === 1) lines.push('UEFI_TIMEOUT after=synthetic-budget;')
  if (family === 'uefi-exit' && variant % 2 === 0) lines.push('UEFI_EXIT_STATUS=FAILED;')
  if (family === 'uefi-exit' && variant % 2 === 1) lines.push('UEFI_EXIT_STATUS=MISSING;')
  if (family === 'os-failure' && variant % 3 === 2) lines.push('LOG_CAPTURE_TRUNCATED=true;')
  if (family === 'multiple-runs') lines.push('TERMINAL_RESULT=UNKNOWN;')
  if (family === 'stale-conflict') lines.push('TERMINAL_RESULT=UNKNOWN;')
  if (family !== 'stale-conflict' && family !== 'multiple-runs') lines.push(`TERMINAL_RESULT=${result};`)
  return lines
}

function renderFixture(family, variant, metadata, result) {
  const stages = stagesFor(family, variant)
  const metadataMismatchOracle = metadataMismatchOracleFor(family, variant, metadata)
  const contentMode = metadataMismatchOracle?.kind === 'filename-vs-content' ? metadataMismatchOracle.content : metadata.mode
  const lines = [
    '# SYNTHETIC QUALCOMM-STYLE SOC BRING-UP CORPUS',
    '# Privacy-safe fixture; no production identifiers or proprietary records.',
    `CORPUS_ID=QBR-${String(variant + 1).padStart(3, '0')}-${family.toUpperCase()};`,
    `SAMPLE=${metadata.sample}; MATERIAL=${metadata.material}; TEMP=${metadata.tempC}C; MODE=${contentMode}; VDD=${metadata.vdd}V; RUN=${metadata.run};`,
    `SCENARIO_FAMILY=${family}; SCENARIO_VARIANT=${familyDetails(family, variant)};`,
    'FLOW_CONVENTION=SYN_POWER_ON>SYN_UEFI_ENTER>SYN_UEFI_EXIT>SYN_OS_BOOT_START>SYN_OS_READY;',
    '',
  ]
  if (family === 'reboot-recovered' && variant >= 8) {
    const resetIndex = stages.indexOf('SYN_WATCHDOG_RESET')
    lines.push('RUN_ID=001;')
    for (const marker of stages.slice(0, resetIndex + 1)) lines.push(`${marker};`)
    lines.push('RUN_ID=002;')
    for (const marker of stages.slice(resetIndex + 1)) lines.push(`${marker};`)
  } else {
    if (family === 'stale-conflict' && variant % 4 === 0) {
      lines.push('RUN_ID=PREVIOUS;', 'TERMINAL_RESULT=PASS;', 'RUN_BOUNDARY=CURRENT;')
    }
    if (family === 'stale-conflict' && variant % 4 === 2) {
      lines.push('RUN_ID=PREVIOUS;', 'SYN_UEFI_FAIL;', 'RUN_BOUNDARY=CURRENT;')
    }
    for (const marker of stages) lines.push(`${marker};`)
  }
  lines.push(...lineForResult(family, variant, result, metadataMismatchOracle))
  if (family === 'memory-records') {
    lines.push(...memoryRecords(familyDetails(family, variant), variant))
  } else {
    lines.push(...stressRecords('baseline', variant))
    lines.push(...tskhynixBaseline(variant))
  }
  lines.push('END_SYNTHETIC_RECORD=true;')
  let output = `${lines.join('\n')}\n`
  if (family === 'multiple-runs' && variant % 4 === 0) {
    output = output.slice(0, -'END_SYNTHETIC_RECORD=true;\n'.length)
    output += 'tSKHYNIX_ADDR=0x1000 WR=0x'
  }
  if (family === 'filename-variants' && variant % 4 === 0) output = output.replaceAll('\n', '\r\n')
  return output
}

function makeEntry(family, variant, index) {
  const metadata = metadataFor(index)
  const result = expectedFor(family, variant)
  const relativePath = join(family, filenameFor(metadata, variant)).replaceAll('\\', '/')
  return {
    relativePath,
    variant,
    scenarioFamily: family,
    scenarioVariant: familyDetails(family, variant),
    expectedTerminalResult: result,
    needsReview: reviewFor(family, variant),
    parserOracle: parserOracleFor(family, variant),
    metadataMismatchOracle: metadataMismatchOracleFor(family, variant, metadata),
    metadata,
    orderedStageMarkers: stagesFor(family, variant),
    features: [
      ...(family === 'memory-records' ? ['stressapptest', 'tSKHYNIX'] : []),
      ...(family === 'multiple-runs' || (family === 'reboot-recovered' && variant >= 8) ? ['multiple-runs'] : []),
      ...(family === 'filename-variants' ? ['filename-metadata-variation'] : []),
      ...(family === 'metadata-mismatch' ? ['temperature-vdd-mode-mismatch'] : []),
      ...(family === 'stale-conflict' ? ['stale-or-conflicting-markers'] : []),
      ...(family === 'filename-variants' && variant % 4 === 0 ? ['crlf'] : []),
      ...(family === 'multiple-runs' && variant % 4 === 0 ? ['truncated-final-line'] : []),
    ],
  }
}

const families = [
  'pass',
  'uefi-failure',
  'uefi-exit',
  'os-failure',
  'reboot-recovered',
  'stale-conflict',
  'multiple-runs',
  'metadata-mismatch',
  'filename-variants',
  'memory-records',
]

export function buildCorpus() {
  const fixtures = []
  for (const family of families) {
    for (let variant = 0; variant < 16; variant += 1) {
      const index = families.indexOf(family) * 16 + variant
      fixtures.push(makeEntry(family, variant, index))
    }
  }
  return fixtures
}

async function existingLogPaths(root, current = root) {
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const paths = []
  for (const entry of entries) {
    const destination = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Refusing generated output containing a symbolic link: ${destination}`)
    if (entry.isDirectory()) paths.push(...await existingLogPaths(root, destination))
    if (entry.isFile() && entry.name.endsWith('.log')) paths.push(destination.slice(root.length + 1).replaceAll('\\', '/'))
  }
  return paths
}

async function assertOwnedOutput(output, fixtures) {
  const existingLogs = await existingLogPaths(output)
  if (existingLogs.length === 0) return
  let previous
  try {
    previous = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('Refusing to write into a non-empty output without a valid corpus manifest')
  }
  const recognized = previous.generatorId === generatorId || previous.title === 'Privacy-safe deterministic Qualcomm-style SoC bring-up corpus'
  if (!recognized || !Array.isArray(previous.fixtures)) throw new Error('Refusing to write into an output not owned by this corpus generator')
  const previousPaths = new Set(previous.fixtures.map((fixture) => fixture.relativePath))
  const nextPaths = new Set(fixtures.map((fixture) => fixture.relativePath))
  const unowned = existingLogs.filter((path) => !previousPaths.has(path))
  const stale = [...previousPaths].filter((path) => path.endsWith('.log') && !nextPaths.has(path))
  if (unowned.length > 0) throw new Error(`Refusing to overwrite unowned log files: ${unowned.join(', ')}`)
  if (stale.length > 0) throw new Error(`Refusing to leave stale managed log files: ${stale.join(', ')}`)
}

export async function generate(outputDirectory = defaultOutput) {
  const output = resolve(outputDirectory)
  const fixtures = buildCorpus()
  await assertOwnedOutput(output, fixtures)
  await mkdir(output, { recursive: true })
  for (const fixture of fixtures) {
    const content = renderFixture(fixture.scenarioFamily, fixture.variant, fixture.metadata, fixture.expectedTerminalResult)
    const destination = join(output, fixture.relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf8')
  }
  const manifest = {
    generatorId,
    schemaVersion: 1,
    title: 'Privacy-safe deterministic Qualcomm-style SoC bring-up corpus',
    privacy: 'All identifiers, addresses, values, timestamps, and records are synthetic and deterministic.',
    flowConvention: [stage.powerOn, stage.uefiEnter, stage.uefiExit, stage.osBootStart, stage.osReady],
    flowConventionNotice: 'SYN_* markers are corpus conventions, NOT official Qualcomm strings.',
    fixtureCount: fixtures.length,
    fixtures,
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { output, fixtureCount: fixtures.length }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-qualcomm-bringup-corpus.mjs')) {
  const output = parseOutput(process.argv.slice(2))
  const result = await generate(output)
  console.log(`Generated ${result.fixtureCount} deterministic fixtures in ${result.output}`)
}
