import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  EvaluationDecisionRevision,
  EvaluationRecipeRule,
  EvaluationSaveDecisionInput,
  EvaluationSourceInput
} from '../shared/contracts'
import { EvaluationRevisionConflictError, EvaluationStore } from './evaluation-store'

const roots: string[] = []
const PROJECT = 'Qualcomm evaluation'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evaluation-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function source(artifactId = SHA_A, sourceId = `source-${artifactId.slice(0, 8)}`): EvaluationSourceInput {
  return {
    sourceId,
    artifactId,
    sourceKey: 'root:opaque-root\u001flot-01/sample.log'
  }
}

function rule(id = 'rule-pass'): EvaluationRecipeRule {
  return {
    id,
    label: 'PASS',
    status: 'verified',
    scope: { kind: 'project' },
    clauses: [{
      id: `${id}-pass`,
      presence: 'present',
      matcher: { kind: 'literal', pattern: '@PASS', caseSensitive: true, target: 'content' },
      sourceObservationId: `${id}-observation`
    }],
    priority: 10,
    confidence: 1,
    repetition: 1,
    createdFromSourceIds: ['source-a']
  }
}

describe('EvaluationStore', () => {
  it('persists an immediate engineer decision per project and never writes the raw source key', async () => {
    const root = await tempRoot()
    const store = new EvaluationStore(root)
    const saved = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(),
      result: 'SYSTEM_HALT',
      evidenceRefs: [{ artifactId: SHA_A, lineNumber: 42, columnStart: 3, columnEnd: 11, matcherId: 'watchdog' }]
    })

    expect(saved.snapshot.revision).toBe(1)
    expect(saved.decision).toMatchObject({
      revision: 1,
      result: 'SYSTEM_HALT',
      decidedBy: 'engineer',
      source: { sourceId: 'source-aaaaaaaa', artifactId: SHA_A }
    })
    expect(saved.decision.source.sourceKeyHash).toMatch(/^[a-f0-9]{64}$/)

    const restarted = new EvaluationStore(root)
    expect((await restarted.snapshot(PROJECT)).decisions).toEqual([saved.decision])
    expect((await restarted.snapshot('another project')).decisions).toEqual([])

    const serialized = await readFile(join(root, 'metadata', 'evaluations.json'), 'utf8')
    expect(serialized).not.toContain(PROJECT)
    expect(serialized).not.toContain('opaque-root')
    expect(serialized).not.toContain('sample.log')
  })

  it('validates occurrence conditions while saving recipe revisions', async () => {
    const store = new EvaluationStore(await tempRoot())
    await expect(store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      name: 'Exact occurrences',
      rules: [{ ...rule(), clauses: [{ ...rule().clauses[0], occurrence: { kind: 'exact', count: 2 } }] }]
    })).resolves.toMatchObject({ recipe: { rules: [{ clauses: [{ occurrence: { kind: 'exact', count: 2 } }] }] } })

    await expect(store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 1,
      name: 'Invalid occurrence',
      rules: [{ ...rule('invalid-occurrence'), clauses: [{ ...rule().clauses[0], occurrence: { kind: 'exact', count: -1 } }] }]
    })).rejects.toThrow('occurrence count')
  })

  it('allows path-like matcher patterns while retaining path protection on stored fields', async () => {
    const store = new EvaluationStore(await tempRoot())
    const pathPatterns = [
      '/var/log/lot-01/sample.log',
      'C:\\validation\\lot-01\\sample.log',
      '^\\\\server\\share\\sample.log'
    ]

    for (const [index, pattern] of pathPatterns.entries()) {
      await expect(store.saveRecipe({
        projectId: PROJECT,
        expectedRevision: index,
        name: `Path matcher ${index}`,
        rules: [{
          ...rule(`path-rule-${index}`),
          clauses: [{ ...rule().clauses[0], matcher: { kind: 'regex', pattern, caseSensitive: false, target: 'path' } }]
        }]
      })).resolves.toMatchObject({ recipe: { rules: [{ clauses: [{ matcher: { pattern } }] }] } })
    }

    await expect(store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: pathPatterns.length,
      name: 'Path matcher with protected project id',
      rules: [rule('protected-name')]
    })).resolves.toBeDefined()

    await expect(store.saveRecipe({
      projectId: '/Users/engineer/project',
      expectedRevision: pathPatterns.length + 1,
      name: 'Protected project path',
      rules: [rule('protected-project')]
    })).rejects.toThrow('절대 경로')

    await expect(store.saveDecision({
      projectId: PROJECT,
      expectedRevision: pathPatterns.length,
      source: { ...source(), sourceKey: 'C:\\validation\\lot-01\\sample.log' },
      result: 'PASS'
    })).rejects.toThrow('절대 경로')
  })

  it('uses optimistic project revisions to prevent stale renderer writes', async () => {
    const store = new EvaluationStore(await tempRoot())
    await store.saveDecision({ projectId: PROJECT, expectedRevision: 0, source: source(), result: 'PASS' })

    await expect(store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(),
      result: 'TEST_FAIL'
    })).rejects.toBeInstanceOf(EvaluationRevisionConflictError)

    const snapshot = await store.snapshot(PROJECT)
    expect(snapshot.revision).toBe(1)
    expect(snapshot.decisions).toHaveLength(1)
    expect(snapshot.decisions[0].result).toBe('PASS')
  })

  it('keeps decision history but does not supersede across an artifact SHA change', async () => {
    const store = new EvaluationStore(await tempRoot())
    const oldDecision = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(SHA_A, 'stable-source'),
      result: 'PASS'
    })
    const newDecision = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 1,
      source: source(SHA_B, 'stable-source'),
      result: 'SYSTEM_HALT'
    })

    expect(newDecision.decision.source.sourceKeyHash).toBe(oldDecision.decision.source.sourceKeyHash)
    expect(newDecision.decision.source.artifactId).not.toBe(oldDecision.decision.source.artifactId)
    expect(newDecision.decision.revision).toBe(1)
    expect(newDecision.decision.supersedesId).toBeUndefined()
    expect(newDecision.snapshot.decisions).toHaveLength(2)
  })

  it('persists immutable recipe, batch, exception, and metadata approval revisions', async () => {
    const root = await tempRoot()
    const store = new EvaluationStore(root)
    const recipeV1 = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      recipeId: 'pass-recipe',
      name: 'Pass detection',
      rules: [rule()]
    })
    const recipeV2 = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 1,
      recipeId: 'pass-recipe',
      name: 'Pass detection revised',
      rules: [rule('rule-pass-v2')]
    })
    expect(recipeV2.recipe).toMatchObject({ revision: 2, supersedesId: recipeV1.recipe.id })

    const batch = await store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipeV2.recipe.id],
      outcomes: [
        { source: source(SHA_A, 'source-pass'), result: 'PASS', outcomeSource: 'rule', matchedRuleId: 'rule-pass-v2' },
        { source: source(SHA_B, 'source-exception'), result: 'UNKNOWN', outcomeSource: 'unknown', exceptionCode: 'SEARCH_ERROR' }
      ]
    })
    expect(batch.batch).toMatchObject({ matchedCount: 1, exceptionCount: 1 })

    const metadataV1 = await store.approveMetadata({
      projectId: PROJECT,
      expectedRevision: 3,
      source: source(),
      fieldKey: 'temperature',
      candidateValue: '85',
      approval: 'approved'
    })
    const metadataV2 = await store.approveMetadata({
      projectId: PROJECT,
      expectedRevision: 4,
      source: source(),
      fieldKey: 'temperature',
      candidateValue: '85',
      approvedValue: '85.2',
      approval: 'approved'
    })
    expect(metadataV2.metadataApproval).toMatchObject({
      revision: 2,
      supersedesId: metadataV1.metadataApproval.id,
      approvedBy: 'engineer'
    })

    const restarted = await new EvaluationStore(root).snapshot(PROJECT)
    expect(restarted).toMatchObject({ revision: 5 })
    expect(restarted.recipes).toHaveLength(2)
    expect(restarted.batches[0].outcomes).toHaveLength(2)
    expect(restarted.metadataApprovals).toHaveLength(2)
  })

  it('rejects a batch whose matched rule is not in its immutable recipe revisions', async () => {
    const store = new EvaluationStore(await tempRoot())
    const recipeA = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      recipeId: 'recipe-a',
      name: 'Recipe A',
      rules: [rule('rule-a')]
    })
    const recipeB = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 1,
      recipeId: 'recipe-b',
      name: 'Recipe B',
      rules: [rule('rule-b')]
    })

    await expect(store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipeA.recipe.id],
      outcomes: [{
        source: source(),
        result: 'PASS',
        outcomeSource: 'rule',
        matchedRuleId: 'rule-b'
      }]
    })).rejects.toThrow('matchedRuleId가 참조한 recipe revision에 포함되어 있지 않습니다.')

    await expect(store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipeB.recipe.id],
      outcomes: [{ source: source(), result: 'PASS', outcomeSource: 'rule' }]
    })).rejects.toThrow('rule 결과에는 matchedRuleId가 필요합니다.')

    await expect(store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipeA.recipe.id],
      outcomes: [{
        source: source(),
        result: 'TEST_FAIL',
        outcomeSource: 'rule',
        matchedRuleId: 'rule-a'
      }]
    })).rejects.toThrow('rule 결과가 matched rule label과 일치하지 않습니다.')

    const snapshot = await store.snapshot(PROJECT)
    expect(snapshot.revision).toBe(2)
    expect(snapshot.batches).toEqual([])
  })

  it('atomically persists the candidate recipe and batch, including failure paths', async () => {
    const store = new EvaluationStore(await tempRoot())
    const candidate = {
      recipeId: 'active-batch-ruleset',
      name: 'Applied batch rule set',
      rules: [rule('atomic-rule')]
    }
    const invalidBatch = {
      status: 'completed' as const,
      outcomes: [{ source: source(), result: 'PASS' as const, outcomeSource: 'rule' as const }]
    }

    await expect(store.saveRecipeAndBatch({
      projectId: PROJECT,
      expectedRevision: 0,
      recipe: candidate,
      batch: invalidBatch
    })).rejects.toThrow('rule 결과에는 matchedRuleId가 필요합니다.')
    expect(await store.snapshot(PROJECT)).toMatchObject({ revision: 0, recipes: [], batches: [] })

    await store.saveDecision({ projectId: PROJECT, expectedRevision: 0, source: source(SHA_B, 'other-source'), result: 'PASS' })
    await expect(store.saveRecipeAndBatch({
      projectId: PROJECT,
      expectedRevision: 0,
      recipe: candidate,
      batch: {
        status: 'completed',
        outcomes: [{ source: source(), result: 'PASS', outcomeSource: 'rule', matchedRuleId: 'atomic-rule' }]
      }
    })).rejects.toBeInstanceOf(EvaluationRevisionConflictError)
    expect(await store.snapshot(PROJECT)).toMatchObject({ revision: 1, recipes: [], batches: [] })

    const saved = await store.saveRecipeAndBatch({
      projectId: PROJECT,
      expectedRevision: 1,
      recipe: candidate,
      batch: {
        status: 'completed',
        outcomes: [{ source: source(), result: 'PASS', outcomeSource: 'rule', matchedRuleId: 'atomic-rule' }]
      }
    })
    expect(saved.snapshot.revision).toBe(2)
    expect(saved.snapshot.recipes).toEqual([saved.recipe])
    expect(saved.snapshot.batches).toEqual([saved.batch])
    expect(saved.batch.recipeRevisionIds).toEqual([saved.recipe.id])
  })

  it('rejects stale batch outcomes that do not preserve an exact engineer decision', async () => {
    const store = new EvaluationStore(await tempRoot())
    const recipe = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      name: 'Pass recipe',
      rules: [rule('rule-pass')]
    })
    const decision = await store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 1,
      source: source(),
      result: 'SYSTEM_HALT'
    })

    await expect(store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipe.recipe.id],
      outcomes: [{ source: source(), result: 'PASS', outcomeSource: 'rule', matchedRuleId: 'rule-pass' }]
    })).rejects.toThrow('batch 결과가 exact engineer decision을 보존하지 않았습니다.')

    const saved = await store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 2,
      status: 'completed',
      recipeRevisionIds: [recipe.recipe.id],
      outcomes: [{
        source: source(),
        result: 'SYSTEM_HALT',
        outcomeSource: 'engineer-preserved',
        matchedRuleId: 'rule-pass',
        exceptionCode: 'RULE_CONFLICT',
        conflictingDecisionId: decision.decision.id
      }]
    })
    expect(saved.batch.outcomes[0].result).toBe('SYSTEM_HALT')
    expect(saved.snapshot.revision).toBe(3)
  })

  it('retains more than 10,000 decisions without truncation', async () => {
    const root = await tempRoot()
    const initial = new EvaluationStore(root)
    const projectIdHash = (await initial.snapshot(PROJECT)).projectIdHash
    const createdAt = '2026-08-04T00:00:00.000Z'
    const decisions: EvaluationDecisionRevision[] = Array.from({ length: 10_005 }, (_, index) => ({
      id: `decision-${index}`,
      revision: 1,
      source: {
        sourceId: `source-${index}`,
        artifactId: index.toString(16).padStart(64, '0'),
        sourceKeyHash: index.toString(16).padStart(64, 'f').slice(-64)
      },
      result: index % 2 ? 'PASS' : 'SYSTEM_HALT',
      decidedBy: 'engineer',
      evidenceRefs: [],
      createdAt
    }))
    await writeFile(join(root, 'metadata', 'evaluations.json'), JSON.stringify({
      schemaVersion: 1,
      projects: {
        [projectIdHash]: { revision: 10_005, decisions, recipes: [], batches: [], metadataApprovals: [] }
      }
    }))

    const restarted = new EvaluationStore(root)
    const loaded = await restarted.snapshot(PROJECT)
    expect(loaded.decisions).toHaveLength(10_005)

    const appended = await restarted.saveDecision({
      projectId: PROJECT,
      expectedRevision: 10_005,
      source: source(SHA_A, 'source-new'),
      result: 'DIAG_FAIL'
    })
    expect(appended.snapshot.decisions).toHaveLength(10_006)
    expect((await new EvaluationStore(root).snapshot(PROJECT)).decisions).toHaveLength(10_006)
  }, 20_000)

  it('persists more than 10,000 batch outcomes and exceptions through the public save path', async () => {
    const root = await tempRoot()
    const store = new EvaluationStore(root)
    const recipe = await store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      name: 'Large batch recipe',
      rules: [rule('large-batch-rule')]
    })
    const outcomes = Array.from({ length: 10_001 }, (_, index) => {
      const exception = index % 1_000 === 0
      return {
        source: {
          sourceId: `batch-source-${index}`,
          artifactId: index.toString(16).padStart(64, '0'),
          sourceKey: `root:opaque\u001fbatch/${index}.log`
        },
        result: exception ? 'UNKNOWN' as const : 'PASS' as const,
        outcomeSource: exception ? 'unknown' as const : 'rule' as const,
        ...(exception ? { exceptionCode: 'NO_MATCH' as const } : { matchedRuleId: 'large-batch-rule' })
      }
    })

    const saved = await store.saveBatch({
      projectId: PROJECT,
      expectedRevision: 1,
      status: 'completed',
      recipeRevisionIds: [recipe.recipe.id],
      outcomes
    })
    expect(saved.batch.outcomes).toHaveLength(10_001)
    expect(saved.batch.exceptionCount).toBe(11)
    expect(saved.batch.matchedCount).toBe(9_990)
    expect((await new EvaluationStore(root).snapshot(PROJECT)).batches[0].outcomes).toHaveLength(10_001)
  }, 20_000)

  it('rejects raw logs, excerpts, absolute paths, and secrets before a write', async () => {
    const root = await tempRoot()
    const store = new EvaluationStore(root)
    const rawLog = {
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(),
      result: 'PASS',
      rawLogText: 'boot\nstressapp\n@PASS'
    } as EvaluationSaveDecisionInput
    await expect(store.saveDecision(rawLog)).rejects.toThrow('저장할 수 없는 필드')

    const excerpt = {
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(),
      result: 'PASS',
      evidenceRefs: [{ artifactId: SHA_A, lineNumber: 1, excerpt: 'customer raw line' }]
    } as unknown as EvaluationSaveDecisionInput
    await expect(store.saveDecision(excerpt)).rejects.toThrow('저장할 수 없는 필드')

    await expect(store.saveRecipe({
      projectId: PROJECT,
      expectedRevision: 0,
      name: 'unsafe',
      rules: [{
        ...rule(),
        clauses: [{ ...rule().clauses[0], matcher: { ...rule().clauses[0].matcher, pattern: 'C:\\Customer\\secret.log' } }]
      }]
    })).resolves.toBeDefined()

    await expect(store.saveDecision({
      projectId: PROJECT,
      expectedRevision: 0,
      source: source(),
      result: 'PASS',
      token: 'Bearer abcdefghijklmnopqrstuvwxyz'
    } as EvaluationSaveDecisionInput)).rejects.toThrow('저장할 수 없는 필드')
    expect((await store.snapshot(PROJECT)).revision).toBe(1)
  })

  it.each([
    ['{bad json', 'recovered-corrupt', '.corrupt-'],
    [JSON.stringify({ schemaVersion: 1, projects: {}, rawLogText: 'boot @PASS' }), 'recovered-corrupt', '.corrupt-'],
    [JSON.stringify({ schemaVersion: 99, projects: {} }), 'recovered-unsupported-version', '.unsupported-']
  ] as const)('preserves and reports an invalid store: %s', async (raw, noticeKind, backupMarker) => {
    const root = await tempRoot()
    const metadata = join(root, 'metadata')
    await mkdir(metadata, { recursive: true })
    await writeFile(join(metadata, 'evaluations.json'), raw)

    const snapshot = await new EvaluationStore(root).snapshot(PROJECT)
    expect(snapshot.storageNotice?.kind).toBe(noticeKind)
    const backup = (await readdir(metadata)).find((name) => name.includes(backupMarker))
    expect(backup).toBeTruthy()
    expect(await readFile(join(metadata, backup!), 'utf8')).toBe(raw)
    expect(JSON.parse(await readFile(join(metadata, 'evaluations.json'), 'utf8'))).toEqual({ schemaVersion: 1, projects: {} })
  })
})
