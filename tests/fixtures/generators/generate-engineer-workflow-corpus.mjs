#!/usr/bin/env node

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultOutput = resolve(scriptDirectory, '..', 'engineer-workflow')
const generatorId = 'engineer-workflow-corpus-v2'

const samples = ['DHCST-89', 'DHCST-90', 'DHCST-91', 'DHCST-92']
const temperatures = ['-40C', '25C', '85C']
const modes = ['DIAG', 'STRESS']
const runs = [1, 2]
const skews = ['SS', 'SF', 'FS', 'FF']
const voltages = {
  '-40C': '0.75V',
  '25C': '0.80V',
  '85C': '0.90V',
}

// Each row is one Run1 -> Run2 comparison. The matrix deliberately includes
// all supported outcomes and all pair behaviours used by engineer workflows.
const outcomeMatrix = {
  'DHCST-89|-40C|DIAG': ['SYSTEM_HALT', 'PASS'],
  'DHCST-89|-40C|STRESS': ['PASS', 'PASS'],
  'DHCST-89|25C|DIAG': ['DIAG_FAIL', 'PASS'],
  'DHCST-89|25C|STRESS': ['PASS', 'TEST_FAIL'],
  'DHCST-89|85C|DIAG': ['TRAINING_FAIL', 'TRAINING_FAIL'],
  'DHCST-89|85C|STRESS': ['SYSTEM_REBOOT', 'PASS'],

  'DHCST-90|-40C|DIAG': ['TEST_FAIL', 'PASS'],
  'DHCST-90|-40C|STRESS': ['PASS', 'SYSTEM_REBOOT'],
  'DHCST-90|25C|DIAG': ['INCOMPLETE', 'PASS'],
  'DHCST-90|25C|STRESS': ['SYSTEM_HALT', 'SYSTEM_HALT'],
  'DHCST-90|85C|DIAG': ['UNKNOWN', 'PASS'],
  'DHCST-90|85C|STRESS': ['PASS', 'PASS'],

  'DHCST-91|-40C|DIAG': ['PASS', 'PASS'],
  'DHCST-91|-40C|STRESS': ['DIAG_FAIL', 'DIAG_FAIL'],
  'DHCST-91|25C|DIAG': ['TRAINING_FAIL', 'PASS'],
  'DHCST-91|25C|STRESS': ['PASS', 'INCOMPLETE'],
  'DHCST-91|85C|DIAG': ['TEST_FAIL', 'SYSTEM_HALT'],
  'DHCST-91|85C|STRESS': ['PASS', 'PASS'],

  'DHCST-92|-40C|DIAG': ['SYSTEM_REBOOT', 'PASS'],
  'DHCST-92|-40C|STRESS': ['PASS', 'PASS'],
  'DHCST-92|25C|DIAG': ['SYSTEM_HALT', 'SYSTEM_REBOOT'],
  'DHCST-92|25C|STRESS': ['UNKNOWN', 'UNKNOWN'],
  'DHCST-92|85C|DIAG': ['INCOMPLETE', 'INCOMPLETE'],
  'DHCST-92|85C|STRESS': ['PASS', 'PASS'],
}

const allowedOutcomes = new Set([
  'PASS',
  'DIAG_FAIL',
  'TEST_FAIL',
  'TRAINING_FAIL',
  'SYSTEM_HALT',
  'SYSTEM_REBOOT',
  'INCOMPLETE',
  'UNKNOWN',
])

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

function comparisonKey(sample, temperature, mode) {
  return `${sample}|${temperature}|${mode}`
}

function transitionFor(outcomes) {
  const [run1, run2] = outcomes
  if (run1 === 'PASS' && run2 === 'PASS') return 'STABLE_PASS'
  if (run1 !== 'PASS' && run2 === 'PASS') return 'RECOVERY'
  if (run1 === 'PASS' && run2 !== 'PASS') return 'REGRESSION'
  return 'STABLE_FAILURE'
}

function measuredTemperature(temperature, sampleIndex, run) {
  const target = Number.parseInt(temperature, 10)
  const offset = ((sampleIndex + run) % 3) - 1
  return `${(target + offset * 0.4).toFixed(1)}C`
}

function failurePoint(outcome, sampleIndex, run) {
  if (outcome === 'DIAG_FAIL') return 'HIDAG_DIAGNOSTIC'
  if (outcome === 'TEST_FAIL') return 'STRESSAPP_MEMORY'
  if (outcome === 'TRAINING_FAIL') return 'DDR_TRAINING'
  if (outcome === 'SYSTEM_REBOOT') return 'WATCHDOG_RECOVERY'
  if (outcome === 'INCOMPLETE') return 'CAPTURE_STOPPED'
  if (outcome === 'UNKNOWN') return 'UNCLASSIFIED_CAPTURE_END'
  if (outcome === 'SYSTEM_HALT') return (sampleIndex + run) % 2 === 0 ? 'UEFI_HANDOFF' : 'HIDAG_EXECUTION'
  return null
}

function reachedTestStage(outcome, sampleIndex, run) {
  if (outcome === 'UNKNOWN') return false
  if (outcome === 'SYSTEM_HALT' && (sampleIndex + run) % 2 === 0) return false
  return true
}

const outcomeSuffix = {
  PASS: 'Pass',
  DIAG_FAIL: 'MbeFail',
  TEST_FAIL: 'Fail',
  TRAINING_FAIL: 'TrainingFail',
  SYSTEM_HALT: 'SystemHalt',
  SYSTEM_REBOOT: 'HdiagReboot',
  INCOMPLETE: 'Incomplete',
  UNKNOWN: 'Unknown',
}

function labFilename({ sample, sampleIndex, temperature, temperatureIndex, mode, modeIndex, run, outcome }) {
  const evaluationNo = sampleIndex * 12 + temperatureIndex * 4 + modeIndex * 2 + run
  const second = String(evaluationNo).padStart(2, '0')
  const voltage = voltages[temperature].replace(/V$/i, '')
  const temperatureValue = temperature.replace(/C$/i, '')
  return [
    `26-08-${String(20 + sampleIndex).padStart(2, '0')}-09-00-${second}`,
    'UTF02A-2', `Ch${8 + sampleIndex}`, 'SM8975', evaluationNo,
    temperatureValue, voltage, 'EVA', 'EN', `SKEW-${skews[sampleIndex]}`,
    `TM-${mode}`, `RUN${run}`, '9600MHZ', `COM${74 + sampleIndex}`,
    sample, 'C', outcomeSuffix[outcome],
  ].join('_') + '.log'
}

function logFor({ sample, sampleIndex, temperature, mode, run, outcome, pairTransition }) {
  const vdd = voltages[temperature]
  const measured = measuredTemperature(temperature, sampleIndex, run)
  const key = comparisonKey(sample, temperature, mode)
  const failure = failurePoint(outcome, sampleIndex, run)
  const testStageReached = reachedTestStage(outcome, sampleIndex, run)
  const lines = [
    '# SYNTHETIC_METADATA',
    `SAMPLE=${sample};`,
    `TEMP=${temperature};`,
    `MODE=${mode};`,
    `RUN=${run};`,
    `COMPARISON_KEY=${key};`,
    `EXPECTED_RESULT=${outcome};`,
    `PAIR_TRANSITION=${pairTransition};`,
    `TARGET_TEMPERATURE=${temperature};`,
    `MEASURED_TEMPERATURE=${measured};`,
    `VDD=${vdd};`,
    `REQUESTED_TEST_MODE=${mode};`,
    `OBSERVED_TEST_MODE=${mode};`,
    'INFO pmic_sequence=nominal;',
    'DEBUG refclk_lock=1;',
    'POWER_ON state=asserted;',
    'UEFI entry firmware=SYN-UEFI-01;',
  ]

  if (outcome === 'SYSTEM_HALT' && !testStageReached) {
    lines.push(`FAILURE_POINT=${failure};`, 'INFO console_state=halted;')
    return `${lines.join('\n')}\n`
  }

  if (outcome !== 'UNKNOWN') {
    lines.push('ExitBootServices status=success;')
    lines.push('OS boot start loader=SYN-OS-01;')
  }

  if (testStageReached) {
    lines.push('stressapp start profile=synthetic-memory;', 'stressapp heartbeat=stable;')
    if (outcome === 'TEST_FAIL') {
      lines.push(`FAILURE_POINT=${failure};`, 'TEST_FAIL bank=SYN-BANK-01;')
      return `${lines.join('\n')}\n`
    } else {
      lines.push('stressapp completed result=PASS;')
    }
    lines.push(`HIDAG START mode=${mode};`)
    if (outcome === 'PASS') {
      lines.push('HIDAG END result=PASS;', '@PASS;')
    } else if (outcome === 'DIAG_FAIL') {
      lines.push(`FAILURE_POINT=${failure};`, 'DIAG_FAIL code=SYN-DIAG-07;')
    } else if (outcome === 'TRAINING_FAIL') {
      lines.push(`FAILURE_POINT=${failure};`, 'TRAINING_FAIL lane=SYN-LANE-01;')
    } else if (outcome === 'SYSTEM_REBOOT') {
      lines.push(`FAILURE_POINT=${failure};`, 'WATCHDOG_RESET reason=synthetic-timeout;', 'SYSTEM_REBOOT;')
    } else if (outcome === 'SYSTEM_HALT') {
      lines.push(`FAILURE_POINT=${failure};`, 'INFO console_state=halted;')
    } else if (outcome === 'INCOMPLETE') {
      lines.push(`FAILURE_POINT=${failure};`, 'INFO capture_state=stopped-before-terminal;')
    } else if (outcome === 'UNKNOWN') {
      lines.push('INFO capture_state=ambiguous;')
    }
  } else if (outcome === 'UNKNOWN') {
    lines.push(`FAILURE_POINT=${failure};`, 'INFO capture_state=ambiguous;')
  }

  return `${lines.join('\n')}\n`
}

function fixtureFor(sample, sampleIndex, temperature, temperatureIndex, mode, modeIndex, run) {
  const key = comparisonKey(sample, temperature, mode)
  const outcomes = outcomeMatrix[key]
  if (!outcomes) throw new Error(`Missing outcome matrix row: ${key}`)
  const outcome = outcomes[run - 1]
  const pairTransition = transitionFor(outcomes)
  if (!allowedOutcomes.has(outcome)) throw new Error(`Unsupported outcome: ${outcome}`)
  return {
    relativePath: labFilename({ sample, sampleIndex, temperature, temperatureIndex, mode, modeIndex, run, outcome }),
    sample,
    temperature,
    mode,
    run,
    outcome,
    expectedResult: outcome,
    pairTransition,
    comparisonKey: key,
    content: logFor({ sample, sampleIndex, temperature, mode, run, outcome, pairTransition }),
  }
}

function createFixtures() {
  const fixtures = []
  samples.forEach((sample, sampleIndex) => {
    temperatures.forEach((temperature, temperatureIndex) => {
      modes.forEach((mode, modeIndex) => {
        runs.forEach((run) => {
          fixtures.push(fixtureFor(sample, sampleIndex, temperature, temperatureIndex, mode, modeIndex, run))
        })
      })
    })
  })
  return fixtures
}

function countsBy(fixtures, key) {
  return fixtures.reduce((counts, fixture) => {
    counts[fixture[key]] = (counts[fixture[key]] ?? 0) + 1
    return counts
  }, {})
}

function manifestFor(fixtures) {
  return {
    generatorId,
    schemaVersion: 1,
    title: 'Privacy-safe deterministic engineer workflow corpus',
    privacy: 'All identifiers, addresses, temperatures, voltages, and records are synthetic and deterministic.',
    axes: { samples, temperatures, modes, runs },
    fixtureCount: fixtures.length,
    outcomeCounts: countsBy(fixtures, 'outcome'),
    pairTransitionCounts: countsBy(fixtures, 'pairTransition'),
    fixtures: fixtures.map(({ content, ...fixture }) => fixture),
  }
}

async function cleanOutputDirectory(outputDirectory) {
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
}

async function main() {
  const outputDirectory = parseOutput(process.argv.slice(2))
  const fixtures = createFixtures()
  if (fixtures.length !== 48) throw new Error(`Expected 48 fixtures, got ${fixtures.length}`)

  await cleanOutputDirectory(outputDirectory)
  for (const fixture of fixtures) {
    await writeFile(join(outputDirectory, fixture.relativePath), fixture.content, 'utf8')
  }
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifestFor(fixtures), null, 2)}\n`, 'utf8')

  const files = await readdir(outputDirectory)
  console.log(`Generated ${fixtures.length} logs and manifest.json in ${outputDirectory}`)
  console.log(`Files on disk: ${files.length}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
