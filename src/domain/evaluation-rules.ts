import { getActiveEvaluationRecipeRevisions, type EvaluationBatchRun, type EvaluationProjectSnapshot, type EvaluationRecipeRule } from '../../electron/shared/contracts'

/** The meaning of a rule, including count/order overrides applied by the editor. */
export function evaluationRuleSignature(rule: EvaluationRecipeRule): string {
  return JSON.stringify({
    id: rule.id, label: rule.label, scope: rule.scope, priority: rule.priority,
    confidence: rule.confidence, status: rule.status,
    clauses: rule.clauses.map((clause) => ({
      id: clause.id, presence: clause.presence,
      occurrence: clause.occurrence ?? { kind: clause.presence === 'absent' ? 'exact' : 'atLeast', count: clause.presence === 'absent' ? 0 : 1 },
      matcher: { kind: clause.matcher.kind, pattern: clause.matcher.pattern, target: clause.matcher.target, caseSensitive: clause.matcher.caseSensitive },
      after: clause.order?.afterClauseId ?? null,
    })),
  })
}

export function evaluationRuleResolver(snapshot: EvaluationProjectSnapshot) {
  const revisions = new Map(snapshot.recipes.map((recipe) => [recipe.id, recipe]))
  const owners = new Map<string, string>()
  snapshot.recipes.filter((recipe) => recipe.recipeId !== 'active-batch-ruleset')
    .forEach((recipe) => recipe.rules.forEach((rule) => owners.set(rule.id, recipe.recipeId)))
  const active = new Map(getActiveEvaluationRecipeRevisions(snapshot.recipes)
    .filter((recipe) => recipe.recipeId !== 'active-batch-ruleset').map((recipe) => [recipe.recipeId, recipe]))
  const storedRules = (batch: EvaluationBatchRun) => batch.recipeRevisionIds.flatMap((id) => revisions.get(id)?.rules ?? [])
  const currentRules = (batch: EvaluationBatchRun): EvaluationRecipeRule[] => {
    const rules = storedRules(batch).flatMap((rule) => {
      const owner = owners.get(rule.id)
      return owner ? active.get(owner)?.rules ?? [] : [rule]
    })
    return [...new Map(rules.map((rule) => [rule.id, rule])).values()]
  }
  const signature = (rules: EvaluationRecipeRule[]) => rules.map(evaluationRuleSignature).sort().join('\n')
  return {
    currentRules,
    isCurrent: (batch: EvaluationBatchRun) => batch.status === 'completed'
      && batch.recipeRevisionIds.every((id) => revisions.has(id))
      && signature(storedRules(batch)) === signature(currentRules(batch)),
  }
}
