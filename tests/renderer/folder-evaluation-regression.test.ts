import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvaluationStore } from '../../electron/main/evaluation-store'
import { getActiveEvaluationDecisions, type EvaluationProjectSnapshot, type EvaluationRecipeRule } from '../../electron/shared/contracts'
import { appliedBatchRulesByFolder, createLatestProjectSaveQueue, hydrateEvaluation } from '../../src/App'
import { evaluationRuleResolver } from '../../src/domain/evaluation-rules'
import { projectLogRecords } from '../../src/state/logRecords'
import { completedInspectionStates, inspectionSummary } from '../../src/state/inspectionStatus'
import { readViewDraft, writeViewDraft } from '../../src/state/viewDrafts'
import { resolvePrecomputedBatch, type WorkbenchFile } from '../../src/views/WorkbenchView'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const artifactId = 'a'.repeat(64)
const file: WorkbenchFile = { id: 'a', name: 'sample_Pass.log', artifactId, rootId: 'folder-a' }
const source = { sourceId: 'a', artifactId, sourceKey: 'root-a/sample.log' }
const rule: EvaluationRecipeRule = { id: 'same-id', label: 'PASS', status: 'verified', scope: { kind: 'analysis' }, clauses: [{ id: 'match', presence: 'present', matcher: { kind: 'literal', pattern: '@PASS', caseSensitive: true, target: 'content' }, occurrence: { kind: 'atLeast', count: 1 }, sourceObservationId: 'obs' }], priority: 1, confidence: 1, repetition: 1, createdFromSourceIds: ['a'] }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sct-folder-regression-')); roots.push(root)
  const store = new EvaluationStore(root)
  const saved = await store.saveRecipe({ projectId: 'p', expectedRevision: 0, recipeId: 'user-rule', name: 'PASS', rules: [rule] })
  const batch = await store.saveRecipeAndBatch({ projectId: 'p', expectedRevision: saved.snapshot.revision, recipe: { recipeId: 'active-batch-ruleset', name: 'Applied', rules: [rule] }, batch: { status: 'completed', outcomes: [{ source, result: 'PASS', outcomeSource: 'rule', matchedRuleId: rule.id }] } })
  return { root, store, snapshot: batch.snapshot }
}

describe('folder evaluation regressions', () => {
  it.each(['occurrence', 'order'] as const)('invalidates unchanged rule IDs after %s edits, restores current conditions, and does not infer an old filename PASS', async (field) => {
    const { store, snapshot } = await setup()
    const edited = structuredClone(rule)
    if (field === 'occurrence') edited.clauses[0].occurrence = { kind: 'exact', count: 3 }
    else {
      edited.clauses.push({ ...edited.clauses[0], id: 'second', order: { afterClauseId: 'match' } })
    }
    const saved = await store.saveRecipe({ projectId: 'p', expectedRevision: snapshot.revision, recipeId: 'user-rule', name: 'PASS', rules: [edited] })
    const hydrated = hydrateEvaluation([file], saved.snapshot)
    expect(hydrated[0]).toMatchObject({ ruleStale: true, ruleNeedsReview: true })
    expect(hydrated[0].ruleResult).toBeUndefined()
    expect(projectLogRecords(hydrated)[0]).toMatchObject({ result: 'UNKNOWN', review: 'needs_review' })
    expect(appliedBatchRulesByFolder([file], saved.snapshot)['root:folder-a']).toEqual([edited])
  })

  it('archives a conflicting rule without retaining its conflict badge or reviving previous PASS', async () => {
    const { store, snapshot } = await setup()
    const conflict = await store.saveRecipeAndBatch({ projectId: 'p', expectedRevision: snapshot.revision, recipe: { recipeId: 'active-batch-ruleset', name: 'Applied', rules: [rule] }, batch: { status: 'completed', outcomes: [{ source, result: 'UNKNOWN', outcomeSource: 'unknown', exceptionCode: 'RULE_CONFLICT' }] } })
    const removed = await store.archiveRecipe({ projectId: 'p', expectedRevision: conflict.snapshot.revision, recipeId: 'user-rule' })
    const hydrated = hydrateEvaluation([file], removed.snapshot)[0]
    expect(hydrated).toMatchObject({ ruleStale: true })
    expect(hydrated.ruleExceptionCode).toBeUndefined()
    expect(hydrated.ruleResult).toBeUndefined()
  })

  it('resets manual overrides durably and permits automatic judgment afterward', async () => {
    const { root, store, snapshot } = await setup()
    const manual = await store.saveDecision({ projectId: 'p', expectedRevision: snapshot.revision, source, result: 'TEST_FAIL' })
    const reset = await store.saveDecision({ projectId: 'p', expectedRevision: manual.snapshot.revision, source, result: 'UNKNOWN', reset: true })
    expect(getActiveEvaluationDecisions(reset.snapshot.decisions)).toEqual([])
    expect(hydrateEvaluation([file], reset.snapshot)[0].decision).toBeUndefined()
    const reapplied = await store.saveRecipeAndBatch({ projectId: 'p', expectedRevision: reset.snapshot.revision, recipe: { recipeId: 'active-batch-ruleset', name: 'Applied', rules: [rule] }, batch: { status: 'completed', outcomes: [{ source, result: 'PASS', outcomeSource: 'rule', matchedRuleId: rule.id }] } })
    const restarted = await new EvaluationStore(root).snapshot('p')
    expect(restarted).toEqual(reapplied.snapshot)
    expect(getActiveEvaluationDecisions(restarted.decisions)).toEqual([])
    expect(projectLogRecords(hydrateEvaluation([file], restarted))[0].result).toBe('PASS')
  })

  it('resets both historical renderer and Agent identities in one revision', async () => {
    const { store, snapshot } = await setup()
    const renderer = await store.saveDecision({ projectId: 'p', expectedRevision: snapshot.revision, source, result: 'PASS' })
    const agent = await store.saveDecision({ projectId: 'p', expectedRevision: renderer.snapshot.revision, source: { ...source, sourceId: 'agent-source' }, result: 'TEST_FAIL' })
    const reset = await store.saveDecision({ projectId: 'p', expectedRevision: agent.snapshot.revision, source: { ...source, sourceId: 'agent-source' }, result: 'UNKNOWN', reset: true, resetSourceIds: ['a'] })
    expect(reset.snapshot.revision).toBe(agent.snapshot.revision + 1)
    expect(getActiveEvaluationDecisions(reset.snapshot.decisions)).toEqual([])
    expect(reset.snapshot.decisions.filter((item) => item.reset)).toHaveLength(2)
    await expect(store.saveDecision({ projectId: 'p', expectedRevision: reset.snapshot.revision, source, result: 'UNKNOWN', reset: true, resetSourceIds: ['not-this-log'] })).rejects.toThrow('원본 위치')
    expect((await store.snapshot('p')).revision).toBe(reset.snapshot.revision)
  })

  it('unapplies the last rule from one folder without affecting its sibling', async () => {
    const { store, snapshot } = await setup()
    const sibling = { ...file, id: 'b', rootId: 'folder-b' }
    const both: EvaluationProjectSnapshot = { ...snapshot, batches: snapshot.batches.map((batch) => ({ ...batch, outcomes: [...batch.outcomes, { ...batch.outcomes[0], source: { ...batch.outcomes[0].source, sourceId: 'b' } }] })) }
    const removed = await store.saveRecipeAndBatch({ projectId: 'p', expectedRevision: snapshot.revision, recipe: { recipeId: 'active-batch-ruleset', name: 'Applied', rules: [] }, batch: { status: 'completed', outcomes: [{ source, result: 'UNKNOWN', outcomeSource: 'unknown', exceptionCode: 'NO_MATCH' }] } })
    const latest = { ...removed.snapshot, batches: [...both.batches, removed.batch] }
    expect(appliedBatchRulesByFolder([file, sibling], latest)).toEqual({ 'root:folder-a': [], 'root:folder-b': [rule] })
    expect(evaluationRuleResolver(latest).isCurrent(removed.batch)).toBe(true)
    expect(resolvePrecomputedBatch([file], [], new Map(), {}).outcomes.a).toBe('UNKNOWN')
    await expect(store.saveRecipeAndBatch({ projectId: 'p', expectedRevision: removed.snapshot.revision, recipe: { recipeId: 'user-rule', name: 'Invalid', rules: [] }, batch: { status: 'completed', outcomes: [] } })).rejects.toThrow('규칙 개수')
  })

  it('keeps queued saves attached to their project even while switching A → B → A', async () => {
    let current = { id: 'A', revision: 1, value: '' }; let generation = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const seen: string[] = []
    const applied: string[] = []
    const queue = createLatestProjectSaveQueue(() => current, async (target, value: string) => {
      seen.push(`${target.id}:${target.revision}:${value}`)
      if (value === 'first') await gate
      return { ...target, revision: target.revision + 1, value }
    }, (saved) => { applied.push(saved.id + ':' + saved.value); current = saved }, (target) => target.id, () => generation)
    const first = queue('first'); const second = queue('second')
    await Promise.resolve()
    current = { id: 'B', revision: 10, value: '' }; generation++
    await queue('B-only')
    current = { id: 'A', revision: 1, value: '' }; generation++
    release(); await Promise.all([first, second])
    expect(seen).toEqual(['A:1:first', 'B:10:B-only', 'A:2:second'])
    expect(applied).toEqual(['B:B-only'])
    expect(current.value).toBe('')
  })

  it('distinguishes failed and missing scan responses from genuine empty results in the selected folder', () => {
    const states = completedInspectionStates(new Map([['s1', 'a'], ['s2', 'b'], ['s3', 'c']]), [{ sourceId: 's1' }, { sourceId: 's2', error: 'unreadable' }])
    expect(inspectionSummary(states, [{ id: 'a' }]).incomplete).toBe(false)
    expect(inspectionSummary(states, [{ id: 'b' }, { id: 'c' }]).errors).toHaveLength(2)
    expect(inspectionSummary({ a: { status: 'loading' } }, [{ id: 'a' }]).pending).toBe(1)
  })

  it('restores unsaved view drafts separately for each project and folder', () => {
    writeViewDraft('p1:folder-a:test', ['temperature', 'vdd'])
    writeViewDraft('p1:folder-b:test', ['sample'])
    expect(readViewDraft('p1:folder-a:test', ['new-saved-default'])).toEqual(['temperature', 'vdd'])
    expect(readViewDraft('p1:folder-b:test', [])).toEqual(['sample'])
    expect(readViewDraft('p2:folder-a:test', ['default'])).toEqual(['default'])
  })
})

it('keeps unknown and excluded logs selectable without inflating PASS/FAIL or failure-rate denominators', async () => {
  const { buildPivotGrid } = await import('../../src/state/logRecords')
  const { formatPivotValue } = await import('../../src/views/PatternsView')
  const rows = projectLogRecords([
    { id: 'pass', name: 'PASS.log', decision: 'PASS' },
    { id: 'pending', name: 'pending.log', ruleStale: true },
    { id: 'excluded', name: 'excluded.log', decision: 'EXCLUDED' },
  ])
  const config = { rows: [], columns: [], filters: { query: '', result: 'all' as const, review: 'all' as const } }
  const grid = buildPivotGrid(rows, { ...config, aggregation: 'pass_fail' })
  expect(grid.cells[0][0].sourceIds).toEqual(['pass', 'pending', 'excluded'])
  expect(grid.total).toBe(1)
  expect(formatPivotValue(grid.total, 'pass_fail', grid.breakdown)).toBe('PASS · 미확인 1 · 제외 1')
  expect(buildPivotGrid(rows, { ...config, aggregation: 'fail_rate' }).breakdown?.definitiveCount).toBe(1)
})

it('preserves manual judgment when the last folder rule is unapplied', () => {
  const resolution = resolvePrecomputedBatch([file], [], new Map(), { a: 'PASS' })
  expect(resolution).toMatchObject({ outcomes: { a: 'PASS' }, exceptions: 0, conflictIds: [], exceptionIds: [] })
})

it('shows zoom controls for dense charts and leaves ordinary wheel scrolling alone', async () => {
  const { compactDataZoom } = await import('../../src/components/AnalysisChart')
  expect(compactDataZoom(4, 'horizontal')).toEqual([])
  expect(compactDataZoom(30, 'horizontal')).toEqual([
    expect.objectContaining({ type: 'inside', start: 0, end: 100, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false }),
    expect.objectContaining({ type: 'slider', start: 0, end: 100 }),
  ])
})

it('renders a scan failure and retry even without a saved harness, and disables exporting incomplete data', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { ResultsView } = await import('../../src/views/ResultsView')
  const records = projectLogRecords([{ id: 'unreadable', name: 'broken.log' }])
  const markup = renderToStaticMarkup(createElement(ResultsView, {
    records, project: null, onOpenFile: () => {}, onProjectUpdated: () => {},
    stageInspectionStates: { unreadable: { status: 'error', message: 'file unavailable' } }, onRetryInspections: () => {},
  }))
  expect(markup).toContain('1개 검사 실패')
  expect(markup).toContain('file unavailable')
  expect(markup).toContain('다시 검사')
  const exportButton = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('결과 1개 CSV'))
  expect(exportButton).toContain('disabled=""')
})

it('handles a recreated chart without old options and retains a zoomed range when options exist', async () => {
  const { restoreChartZoom } = await import('../../src/components/AnalysisChart')
  const option = { dataZoom: [{ id: 'horizontal-slider', type: 'slider', start: 0, end: 100 }], series: [] }
  expect(restoreChartZoom(option, undefined)).toEqual(option)
  expect(restoreChartZoom(option, { dataZoom: [{ id: 'horizontal-slider', start: 20, end: 45 }] }).dataZoom).toEqual([{ id: 'horizontal-slider', type: 'slider', start: 20, end: 45 }])
  expect(option.dataZoom[0].start).toBe(0)
})
