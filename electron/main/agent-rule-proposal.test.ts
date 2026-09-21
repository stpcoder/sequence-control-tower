import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvaluationStore } from './evaluation-store'
import { extractAgentRuleProposal, prepareAgentRuleSave, normalizeAgentRuleProposal, agentRuleSummary } from '../../src/domain/agent-rule-proposal'
import type { EvaluationRecipeRule } from '../shared/contracts'

const rule: EvaluationRecipeRule = { id: 'r', label: 'PASS', status: 'verified', scope: { kind: 'project' }, priority: 1, confidence: 1, repetition: 1, createdFromSourceIds: [], clauses: [{ id: 'c', presence: 'present', matcher: { kind: 'literal', target: 'content', pattern: 'END', caseSensitive: true } }] }
describe('reviewed Agent rule edits', () => {
  it('saves the reviewed condition as an actual revision and rejects replay or stale proposals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-rule-save-'))
    try {
      const store = new EvaluationStore(dir)
      const original = await store.saveRecipe({ projectId: 'p', expectedRevision: 0, recipeId: 'recipe', name: '종료 확인', rules: [rule] })
      const changed = { ...rule, clauses: [{ ...rule.clauses[0], occurrence: { kind: 'exact', count: 2 } }] }
      const reply = extractAgentRuleProposal(`종료가 두 번 나올 때 PASS로 제안합니다.<sct-rule-proposal>${JSON.stringify({ recipeId: 'recipe', baseRevision: 1, name: '종료 확인', rationale: '두 차수 종료 확인', rules: [changed] })}</sct-rule-proposal>`)
      expect(reply.content).not.toContain('sct-rule-proposal')
      const proposal = { id: 'proposal', ...reply.proposal! }
      expect((await store.snapshot('p')).revision).toBe(original.snapshot.revision)
      const saved = await store.saveRecipe(prepareAgentRuleSave(original.snapshot, proposal, 'p'))
      expect(saved.recipe.rules[0].clauses[0].occurrence).toEqual({ kind: 'exact', count: 2 })
      expect(saved.recipe.revision).toBe(2)
      expect(() => prepareAgentRuleSave(saved.snapshot, proposal, 'p')).toThrow('규칙이 변경')
      const fresh = new EvaluationStore(dir)
      expect((await fresh.snapshot('p')).recipes.at(-1)?.rules[0].clauses[0].occurrence?.count).toBe(2)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('does not expose malformed rule JSON as a saveable change', () => {
    const result = extractAgentRuleProposal('확인했습니다.<sct-rule-proposal>{"rules":[]}</sct-rule-proposal>')
    expect(result.proposal).toBeUndefined()
    expect(result.content).toContain('저장할 수 없습니다')
  })
})


describe('invalid Agent rule ordering', () => {
  it.each(['self', 'cycle', 'absence', 'filename', 'minimum-zero'] as const)('rejects %s before exposing a save button', (kind) => {
    const changed = structuredClone(rule)
    changed.clauses.push({ ...structuredClone(rule.clauses[0]), id: 'second', order: { afterClauseId: 'c' } })
    if (kind === 'self') changed.clauses[0].order = { afterClauseId: 'c' }
    if (kind === 'cycle') changed.clauses[0].order = { afterClauseId: 'second' }
    if (kind === 'absence') changed.clauses[0].presence = 'absent'
    if (kind === 'filename') changed.clauses[0].matcher.target = 'file_name'
    if (kind === 'minimum-zero') changed.clauses[0].occurrence = { kind: 'atLeast', count: 0 }
    expect(normalizeAgentRuleProposal({ recipeId: 'recipe', baseRevision: 1, name: '규칙', rationale: '검토', rules: [changed] })).toBeUndefined()
  })
  it('rejects invalid order through the save API as well, preserving the last revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-rule-order-'))
    try {
      const store = new EvaluationStore(dir)
      const original = await store.saveRecipe({ projectId: 'p', expectedRevision: 0, name: '규칙', rules: [rule] })
      const invalid = structuredClone(rule)
      invalid.clauses[0].order = { afterClauseId: 'c' }
      await expect(store.saveRecipe({ projectId: 'p', expectedRevision: original.snapshot.revision, recipeId: original.recipe.recipeId, name: '규칙', rules: [invalid] })).rejects.toThrow('순서')
      expect((await store.snapshot('p')).revision).toBe(original.snapshot.revision)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('shows the exact scope and predecessor pattern in the review', () => {
    const changed = structuredClone(rule)
    changed.scope.id = 'folder-a'
    changed.clauses.push({ ...structuredClone(rule.clauses[0]), id: 'second', matcher: { ...rule.clauses[0].matcher, pattern: 'PASS' }, order: { afterClauseId: 'c' } })
    expect(agentRuleSummary(changed)).toContain('프로젝트 범위 (folder-a)')
    expect(agentRuleSummary(changed)).toContain('“END” 다음')
  })
})
