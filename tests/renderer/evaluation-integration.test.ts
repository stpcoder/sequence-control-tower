import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvaluationStore } from '../../electron/main/evaluation-store'
import type {
  EvaluationProjectSnapshot,
  EvaluationRecipeRule,
  EvaluationSaveDecisionInput,
} from '../../electron/shared/contracts'
import { hydrateEvaluation, projectEvidenceCounts, projectMetadataApprovals } from '../../src/App'
import { patternMatrix, projectLogRecords } from '../../src/state/logRecords'
import type { WorkbenchFile } from '../../src/views/WorkbenchView'

const roots: string[] = []
const PROJECT = 'log-workbench'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SOURCE_ID = `${SHA_A}:source-exact`
const SOURCE_KEY = 'root:opaque-root\u001flot-01/LOT12_S01_85C_DIAG.log'

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'renderer-evaluation-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function file(artifactId = SHA_A, id = SOURCE_ID): WorkbenchFile {
  return {
    id,
    artifactId,
    sourceKey: SOURCE_KEY,
    rootId: 'opaque-root',
    name: 'LOT12_S01_85C_DIAG.log',
    relativePath: 'lot-01/LOT12_S01_85C_DIAG.log',
    origin: 'Qualcomm logs'
  }
}

function haltRule(): EvaluationRecipeRule {
  return {
    id: 'halt-rule',
    label: 'SYSTEM_HALT',
    status: 'verified',
    scope: { kind: 'project' },
    clauses: [
      {
        id: 'stress-started',
        presence: 'present',
        matcher: { kind: 'literal', pattern: 'stressapp', caseSensitive: false, target: 'content' },
        sourceObservationId: 'observation-stress'
      },
      {
        id: 'pass-absent',
        presence: 'absent',
        matcher: { kind: 'literal', pattern: '@PASS', caseSensitive: true, target: 'content' },
        sourceObservationId: 'observation-pass'
      }
    ],
    priority: 10,
    confidence: 0.95,
    repetition: 1,
    createdFromSourceIds: [SOURCE_ID]
  }
}

function recordsFromSnapshot(snapshot: EvaluationProjectSnapshot, files: WorkbenchFile[]) {
  const hydrated = hydrateEvaluation(files, snapshot)
  const approvals = projectMetadataApprovals(hydrated, snapshot)
  const evidenceCounts = projectEvidenceCounts(hydrated, snapshot)
  return {
    hydrated,
    records: projectLogRecords(hydrated, evidenceCounts, approvals),
    matrix: patternMatrix(projectLogRecords(hydrated, evidenceCounts, approvals), 'temperature')
  }
}

describe('renderer and EvaluationStore integration', () => {
  it('round-trips exact decision, immutable applied recipe, batch, metadata, Results, and Patterns', async () => {
    const root = await tempRoot()
    const store = new EvaluationStore(root)
    const bootstrap = await store.snapshot(PROJECT)

    const decision = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: bootstrap.revision,
      source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
      result: 'SYSTEM_HALT',
      evidenceRefs: [{ artifactId: SHA_A, lineNumber: 41 }]
    })
    const recipe = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: decision.snapshot.revision,
      recipeId: 'active-batch-ruleset',
      name: 'Applied batch rule set',
      rules: [haltRule()]
    })
    const batch = await store.saveBatch({
      projectId: PROJECT,
      expectedRevision: recipe.snapshot.revision,
      status: 'completed',
      recipeRevisionIds: [recipe.recipe.id],
      outcomes: [{
        source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
        result: 'SYSTEM_HALT',
        outcomeSource: 'engineer-preserved',
        matchedRuleId: 'halt-rule',
        evidenceRefs: [{ artifactId: SHA_A, lineNumber: 41, matcherId: 'stress-started' }]
      }]
    })
    const metadata = await store.approveMetadata({
      projectId: PROJECT,
      expectedRevision: batch.snapshot.revision,
      source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
      fieldKey: 'temperature',
      candidateValue: '85',
      approvedValue: '85.2',
      extractorId: 'default-filename-temperature-v1',
      approval: 'approved'
    })

    expect(batch.batch.recipeRevisionIds).toEqual([recipe.recipe.id])
    expect(batch.batch.outcomes[0].matchedRuleId).toBe(recipe.recipe.rules[0].id)
    expect(metadata.snapshot.decisions[0].evidenceRefs).toEqual([{ artifactId: SHA_A, lineNumber: 41 }])

    const beforeRemount = recordsFromSnapshot(metadata.snapshot, [file()])
    const restartedSnapshot = await new EvaluationStore(root).snapshot(PROJECT)
    const afterRemount = recordsFromSnapshot(restartedSnapshot, [file()])

    expect(afterRemount).toEqual(beforeRemount)
    expect(afterRemount.hydrated[0]).toMatchObject({ decision: 'SYSTEM_HALT', ruleResult: 'SYSTEM_HALT', ruleNeedsReview: false })
    expect(afterRemount.records[0]).toMatchObject({
      result: 'SYSTEM_HALT',
      resultSource: 'engineer',
      review: 'confirmed',
      evidenceCount: 1,
      temperature: { value: '85.2', state: 'approved' }
    })
    expect(afterRemount.matrix).toEqual([{ value: '85.2', total: 1, counts: { SYSTEM_HALT: 1 } }])
  })

  it('hydrates only an exact sourceId and artifactId and never inherits across SHA changes', async () => {
    const store = new EvaluationStore(await tempRoot())
    const saved = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 0,
      source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
      result: 'PASS'
    })
    const approved = await store.approveMetadata({
      projectId: PROJECT,
      expectedRevision: saved.snapshot.revision,
      source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
      fieldKey: 'mode',
      candidateValue: 'DIAG',
      approval: 'approved'
    })

    const exact = file()
    const changedSha = { ...file(SHA_B), decision: 'PASS' as const, ruleResult: 'PASS' as const }
    const changedSource = file(SHA_A, `${SHA_A}:source-other`)
    const hydrated = hydrateEvaluation([exact, changedSha, changedSource], approved.snapshot)

    expect(hydrated[0].decision).toBe('PASS')
    expect(hydrated[1]).not.toHaveProperty('decision')
    expect(hydrated[1]).not.toHaveProperty('ruleResult')
    expect(hydrated[2]).not.toHaveProperty('decision')
    expect(projectMetadataApprovals([changedSha, changedSource], approved.snapshot)).toEqual({})
  })

  it('removes optimistic or legacy result fields when a fresh durable snapshot does not contain them', async () => {
    const snapshot = await new EvaluationStore(await tempRoot()).snapshot(PROJECT)
    const optimistic = {
      ...file(),
      decision: 'PASS' as const,
      ruleResult: 'TEST_FAIL' as const,
      ruleNeedsReview: false
    }

    const [rolledBack] = hydrateEvaluation([optimistic], snapshot)
    expect(rolledBack).not.toHaveProperty('decision')
    expect(rolledBack).not.toHaveProperty('ruleResult')
    expect(rolledBack).not.toHaveProperty('ruleNeedsReview')
    expect(projectEvidenceCounts([optimistic], snapshot)).toEqual({})
  })

  it('retries a stale renderer mutation from a fresh snapshot exactly once', async () => {
    const store = new EvaluationStore(await tempRoot())
    const stale = await store.snapshot(PROJECT)
    await store.approveMetadata({
      projectId: PROJECT,
      expectedRevision: stale.revision,
      source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
      fieldKey: 'mode',
      candidateValue: 'DIAG',
      approval: 'approved'
    })

    let attempts = 0
    const operation = (snapshot: EvaluationProjectSnapshot) => {
      attempts += 1
      const input: EvaluationSaveDecisionInput = {
        projectId: PROJECT,
        expectedRevision: snapshot.revision,
        source: { sourceId: SOURCE_ID, artifactId: SHA_A, sourceKey: SOURCE_KEY },
        result: 'DIAG_FAIL'
      }
      return store.saveDecision(input)
    }

    let result
    try {
      result = await operation(stale)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('EVALUATION_REVISION_CONFLICT')) throw error
      result = await operation(await store.snapshot(PROJECT))
    }

    expect(attempts).toBe(2)
    expect(result.snapshot.revision).toBe(2)
    expect(result.decision.result).toBe('DIAG_FAIL')
    expect((await store.snapshot(PROJECT)).decisions).toEqual([result.decision])
  })
})
