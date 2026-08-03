import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../electron/main/artifact-service'
import type { ArtifactEvidenceSpec } from '../../electron/shared/contracts'
import {
  evaluatePrecomputedEvidence,
  type RecipeRule,
  type ResultLabel,
  type RuleClause,
} from '../../src/domain/workbench'

type Scenario = {
  id: string
  path?: string
  fixtureKind?: 'generated'
  generator?: string
  expected: { result: ResultLabel; needsReview: boolean }
  metadata?: Record<string, string | null>
  markers: string[]
  orderedMarkers?: string[]
  absentMarkers?: string[]
  duplicateGroup?: string
  reviewReason?: string
}

type Manifest = { schemaVersion: number; scenarios: Scenario[] }

const fixtureRoot = resolve('tests/fixtures/soc-logs')
const manifestPath = join(fixtureRoot, 'manifest.json')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
}

function clause(ruleId: string, name: string, pattern: string, presence: RuleClause['presence'] = 'present', after?: string): RuleClause {
  return {
    id: `${ruleId}-${name}`,
    presence,
    matcher: { kind: 'literal', pattern, caseSensitive: true, target: 'content' },
    sourceObservationId: `fixture-${ruleId}-${name}`,
    ...(after ? { order: { afterClauseId: `${ruleId}-${after}` } } : {}),
  }
}

function rule(id: string, label: Exclude<ResultLabel, 'UNKNOWN'>, clauses: RuleClause[], priority = 10): RecipeRule {
  return {
    id,
    label,
    status: 'verified',
    scope: { kind: 'project', id: 'synthetic-soc-fixtures' },
    clauses,
    priority,
    confidence: 1,
    repetition: 10,
    createdFromSourceIds: ['synthetic-fixture'],
  }
}

/** Deliberately small engineer-authored recipe: the fixture never asks an LLM to classify raw logs. */
const rules: RecipeRule[] = [
  rule('pass', 'PASS', [
    clause('pass', 'stress', 'STRESSAPP PASS'),
    clause('pass', 'hidag-start', 'HIDAG START', 'present', 'stress'),
    clause('pass', 'hidag-end', 'HIDAG END', 'present', 'hidag-start'),
    clause('pass', 'pass', '@PASS', 'present', 'hidag-end'),
    clause('pass', 'fail', '@FAIL', 'absent'),
    clause('pass', 'diag', 'DIAG_FAIL', 'absent'),
    clause('pass', 'test', 'TEST_FAIL', 'absent'),
    clause('pass', 'training', 'TRAINING_FAIL', 'absent'),
    clause('pass', 'reboot', 'SYSTEM_REBOOT', 'absent'),
    clause('pass', 'truncated', 'LOG_CAPTURE_TRUNCATED', 'absent'),
  ]),
  rule('diag', 'DIAG_FAIL', [
    clause('diag', 'stress', 'STRESSAPP PASS'),
    clause('diag', 'hidag-start', 'HIDAG START', 'present', 'stress'),
    clause('diag', 'diag', 'DIAG_FAIL', 'present', 'hidag-start'),
    clause('diag', 'fail', '@FAIL', 'present', 'diag'),
    clause('diag', 'pass', '@PASS', 'absent'),
  ]),
  rule('test', 'TEST_FAIL', [
    clause('test', 'stress', 'STRESSAPP PASS'),
    clause('test', 'hidag-start', 'HIDAG START', 'present', 'stress'),
    clause('test', 'test', 'TEST_FAIL', 'present', 'hidag-start'),
    clause('test', 'fail', '@FAIL', 'present', 'test'),
    clause('test', 'pass', '@PASS', 'absent'),
  ]),
  rule('training', 'TRAINING_FAIL', [
    clause('training', 'stress', 'STRESSAPP PASS'),
    clause('training', 'hidag-start', 'HIDAG START', 'present', 'stress'),
    clause('training', 'training', 'TRAINING_FAIL', 'present', 'hidag-start'),
    clause('training', 'fail', '@FAIL', 'present', 'training'),
    clause('training', 'pass', '@PASS', 'absent'),
  ], 20),
  rule('halt', 'SYSTEM_HALT', [
    clause('halt', 'stress', 'STRESSAPP PASS'),
    clause('halt', 'hidag-start', 'HIDAG START', 'present', 'stress'),
    clause('halt', 'hidag-end', 'HIDAG END', 'absent'),
    clause('halt', 'pass', '@PASS', 'absent'),
    clause('halt', 'fail', '@FAIL', 'absent'),
    clause('halt', 'diag', 'DIAG_FAIL', 'absent'),
    clause('halt', 'test', 'TEST_FAIL', 'absent'),
    clause('halt', 'training', 'TRAINING_FAIL', 'absent'),
    clause('halt', 'reboot', 'SYSTEM_REBOOT', 'absent'),
    clause('halt', 'truncated', 'LOG_CAPTURE_TRUNCATED', 'absent'),
  ]),
  rule('reboot', 'SYSTEM_REBOOT', [
    clause('reboot', 'reboot', 'SYSTEM_REBOOT'),
    clause('reboot', 'boot', 'BOOT_COMPLETE', 'present', 'reboot'),
    clause('reboot', 'pass', '@PASS', 'absent'),
  ], 20),
  rule('incomplete', 'INCOMPLETE', [
    clause('incomplete', 'start', 'HIDAG START'),
    clause('incomplete', 'truncated', 'LOG_CAPTURE_TRUNCATED', 'present', 'start'),
    clause('incomplete', 'pass', '@PASS', 'absent'),
    clause('incomplete', 'fail', '@FAIL', 'absent'),
  ], 30),
]

function evidenceSpecs(): ArtifactEvidenceSpec[] {
  const seen = new Set<string>()
  return rules.flatMap((item) => item.clauses).flatMap((item) => {
    const key = `${item.matcher.pattern}\0${item.matcher.target}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ id: key, query: item.matcher.pattern, mode: item.matcher.kind, caseSensitive: true, target: item.matcher.target }]
  })
}

function recipeEvidence(source: Awaited<ReturnType<ArtifactService['inspectEvidence']>>['sources'][number]) {
  const clauseSpecId = new Map<string, string>()
  rules.flatMap((item) => item.clauses).forEach((item) => clauseSpecId.set(item.id, `${item.matcher.pattern}\0${item.matcher.target}`))
  const evidenceBySpec = new Map(source.evidence.map((item) => [item.specId, item]))
  return {
    sourceId: source.sourceId,
    rules: rules.map((item) => ({
      ruleId: item.id,
      ...(source.error ? { error: source.error } : {}),
      clauses: item.clauses.map((itemClause) => {
        const evidence = evidenceBySpec.get(clauseSpecId.get(itemClause.id)!)
        return {
          clauseId: itemClause.id,
          ...(evidence?.occurrenceCount === undefined ? {} : { occurrenceCount: evidence.occurrenceCount }),
          ...(evidence?.firstOccurrence ? { firstOccurrence: evidence.firstOccurrence } : {}),
          ...(evidence?.lastOccurrence ? { lastOccurrence: evidence.lastOccurrence } : {}),
          ...(evidence?.error ? { error: evidence.error } : {}),
        }
      }),
    })),
  }
}

const policyGaps = new Set([
  'two-normal-boots-unsafe',
  'two-boots-with-pass-unsafe',
  'temperature-readback-mismatch',
  'voltage-readback-mismatch',
])

describe('synthetic SoC log scenario corpus', () => {
  it('keeps a complete, private, machine-readable scenario inventory', async () => {
    const data = await manifest()
    expect(data.schemaVersion).toBe(1)
    expect(data.scenarios).toHaveLength(33)
    expect(new Set(data.scenarios.map((item) => item.id)).size).toBe(data.scenarios.length)
    expect(data.scenarios.filter((item) => item.fixtureKind !== 'generated')).toHaveLength(32)

    for (const scenario of data.scenarios) {
      expect(scenario.expected.result).toMatch(/^(PASS|DIAG_FAIL|TEST_FAIL|TRAINING_FAIL|SYSTEM_HALT|SYSTEM_REBOOT|INCOMPLETE|UNKNOWN|EXCLUDED)$/)
      if (scenario.fixtureKind === 'generated') {
        expect(scenario.generator).toBeTruthy()
        expect(await readFile(join(fixtureRoot, scenario.generator!), 'utf8')).toContain('4 * 1024 * 1024 + 1')
        continue
      }
      expect(scenario.path).toBeTruthy()
      const contents = await readFile(join(fixtureRoot, scenario.path!))
      for (const marker of scenario.markers) expect(contents.toString('utf8')).toContain(marker)
      for (const marker of scenario.absentMarkers ?? []) expect(contents.toString('utf8')).not.toContain(marker)
      let cursor = -1
      const linePositions = (scenario.orderedMarkers ?? []).map((marker) => {
        cursor = contents.toString('utf8').indexOf(marker, cursor + 1)
        return cursor
      })
      expect(linePositions.every((position) => position >= 0)).toBe(true)
      expect(linePositions.every((position, index) => index === 0 || position > linePositions[index - 1])).toBe(true)
      for (const value of Object.values(scenario.metadata ?? {})) {
        if (!value) continue
        const fileName = scenario.path!.split('/').at(-1)!
        expect(fileName.includes(value) || fileName.includes(value.replace('.', 'p'))).toBe(true)
      }
    }
    const crlf = await readFile(join(fixtureRoot, 'environment/SMP-Y25__MAT=K4P__TEMP=125C__MODE=DIAG__VDD=0p70__hot-pass-crlf.log'))
    expect(crlf.includes(Buffer.from('\r\n'))).toBe(true)
  })

  it('preserves source rows, duplicate provenance, bounded evidence, and verified marker outcomes without an LLM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soc-log-scenarios-'))
    temporaryRoots.push(root)
    const service = new ArtifactService(join(root, 'private-artifacts'))
    await service.initialize()
    const imported = await service.importFolder(fixtureRoot, { extensions: ['log'], maxFiles: 100 })
    expect(imported.failures).toEqual([])
    expect(imported.skippedCount).toBeGreaterThanOrEqual(2)
    expect(imported.artifacts).toHaveLength(31)

    const sources = (await service.list()).flatMap((record) => (record.sources ?? []).map((source) => ({
      sourceId: source.relativePath,
      artifactId: record.id,
      rootId: source.rootId,
      relativePath: source.relativePath,
    })))
    expect(sources).toHaveLength(32)
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => { calls += 1; throw new Error('network must not be called') }) as typeof fetch
    let inspected: Awaited<ReturnType<ArtifactService['inspectEvidence']>>
    try {
      inspected = await service.inspectEvidence({ sources, specs: evidenceSpecs() })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(calls).toBe(0)
    expect(inspected.sources).toHaveLength(32)
    expect(JSON.stringify(inspected)).not.toContain(root)

    const data = await manifest()
    const byPath = new Map(inspected.sources.map((item) => [item.sourceId, item]))
    for (const scenario of data.scenarios.filter((item) => item.path)) {
      const source = byPath.get(scenario.path!)
      expect(source, scenario.id).toBeDefined()
      const evaluation = evaluatePrecomputedEvidence(recipeEvidence(source!), rules)
      if (!policyGaps.has(scenario.id)) expect(evaluation.result, scenario.id).toBe(scenario.expected.result)
      if (scenario.expected.result === 'UNKNOWN') expect(evaluation.result === 'UNKNOWN' || policyGaps.has(scenario.id), scenario.id).toBe(true)
      for (const item of source!.evidence) expect(item.firstOccurrence?.excerpt.length ?? 0).toBeLessThanOrEqual(322)
    }

    const duplicates = data.scenarios.filter((item) => item.duplicateGroup === 'same-pass-content')
    const duplicateSources = duplicates.map((item) => byPath.get(item.path!)!)
    expect(new Set(duplicateSources.map((item) => item.artifactId)).size).toBe(1)
    expect(duplicateSources.map((item) => item.fileName)).toHaveLength(2)
    expect(byPath.get('edge/SMP-BIN29__MAT=H9K__TEMP=25C__MODE=DIAG__VDD=0p80__binary.log')?.evidence
      .some((item) => item.error?.includes('이진 파일'))).toBe(true)
  }, 30_000)
})
