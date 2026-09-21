import { evaluationRuleSignature } from './evaluation-rules'
import type { EvaluationProjectSnapshot, EvaluationRecipeRule, NativeAgentRuleProposal } from '../../electron/shared/contracts'

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const labels = new Set(['PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT', 'INCOMPLETE', 'EXCLUDED'])
export function normalizeAgentRuleProposal(value: unknown): Omit<NativeAgentRuleProposal, 'id'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as NativeAgentRuleProposal
  if (!text(raw.recipeId, 160) || !text(raw.name, 160) || !text(raw.rationale, 2000)
    || !Number.isSafeInteger(raw.baseRevision) || raw.baseRevision < 1 || raw.recipeId === 'active-batch-ruleset'
    || !Array.isArray(raw.rules) || !raw.rules.length || raw.rules.length > 20) return undefined
  const rules: EvaluationRecipeRule[] = []
  for (const rule of raw.rules) {
    if (!rule || !text(rule.id, 160) || !labels.has(rule.label) || !Array.isArray(rule.clauses) || !rule.clauses.length || rule.clauses.length > 20
      || !Number.isSafeInteger(rule.priority) || rule.priority < -10000 || rule.priority > 10000 || !Number.isFinite(rule.confidence) || rule.confidence < 0 || rule.confidence > 1
      || !rule.scope || !['analysis', 'project', 'customer', 'global'].includes(rule.scope.kind) || (rule.scope.id !== undefined && !text(rule.scope.id, 160))) return undefined
    const clauses: EvaluationRecipeRule['clauses'] = []
    for (const clause of rule.clauses) {
      if (!clause || !text(clause.id, 160) || !['present', 'absent'].includes(clause.presence)
        || !clause.matcher || !['literal', 'regex'].includes(clause.matcher.kind) || !text(clause.matcher.pattern, 1000)
        || !['content', 'file_name', 'path'].includes(clause.matcher.target) || typeof clause.matcher.caseSensitive !== 'boolean'
        || (clause.occurrence && (!['exact', 'atLeast'].includes(clause.occurrence.kind) || !Number.isSafeInteger(clause.occurrence.count) || clause.occurrence.count < 0))
        || (clause.order && !text(clause.order.afterClauseId, 160))) return undefined
      clauses.push({ id: clause.id, presence: clause.presence, matcher: { kind: clause.matcher.kind, pattern: clause.matcher.pattern, target: clause.matcher.target, caseSensitive: clause.matcher.caseSensitive }, ...(clause.occurrence ? { occurrence: clause.occurrence } : {}), ...(clause.order ? { order: clause.order } : {}) })
    }
    if (new Set(clauses.map((clause) => clause.id)).size !== clauses.length || clauses.some((clause) => clause.order && !clauses.some((other) => other.id === clause.order!.afterClauseId))) return undefined
    rules.push({ id: rule.id, label: rule.label, status: 'candidate', scope: { kind: rule.scope.kind, ...(rule.scope.id ? { id: rule.scope.id } : {}) }, clauses, priority: rule.priority, confidence: rule.confidence, repetition: 1, createdFromSourceIds: [] })
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) return undefined
  return { recipeId: raw.recipeId, baseRevision: raw.baseRevision, name: raw.name.trim(), rationale: raw.rationale.trim(), rules }
}

export function extractAgentRuleProposal(content: string) {
  let proposal: ReturnType<typeof normalizeAgentRuleProposal>
  let invalid = false
  const visible = content.replace(/<sct-rule-proposal>([\s\S]*?)<\/sct-rule-proposal>/g, (_, json: string) => {
    try { proposal ??= normalizeAgentRuleProposal(JSON.parse(json)); if (!proposal) invalid = true } catch { invalid = true }
    return ''
  }).trim()
  return { content: [visible, invalid ? '규칙 수정안의 형식이 올바르지 않아 저장할 수 없습니다. 조건을 다시 확인해 주세요.' : ''].filter(Boolean).join('\n\n'), proposal }
}

export function agentRuleSummary(rule: EvaluationRecipeRule): string {
  return `${rule.label} · 우선순위 ${rule.priority} · ${rule.scope.kind === 'project' ? '프로젝트' : rule.scope.kind} 범위 · ${rule.clauses.map((clause) => {
    const target = clause.matcher.target === 'content' ? '본문' : clause.matcher.target === 'file_name' ? '파일명' : '경로'
    const count = clause.occurrence ? `${clause.occurrence.kind === 'exact' ? '정확히' : '최소'} ${clause.occurrence.count}회` : clause.presence === 'absent' ? '없음' : '있음'
    return `${target} ${clause.matcher.kind === 'regex' ? '정규식 ' : ''}“${clause.matcher.pattern}” ${count}${clause.matcher.caseSensitive ? ' (대소문자 구분)' : ''}${clause.order ? ` · ${clause.order.afterClauseId} 다음` : ''}`
  }).join(' + ')}`
}

export function prepareAgentRuleSave(snapshot: EvaluationProjectSnapshot, proposal: NativeAgentRuleProposal, projectId: string) {
  const current = [...snapshot.recipes].reverse().find((recipe) => recipe.recipeId === proposal.recipeId)
  if (!current || current.archived || current.revision !== proposal.baseRevision) throw new Error('제안 이후 규칙이 변경되거나 삭제되었습니다. Agent에게 현재 규칙을 다시 읽고 수정안을 요청하세요.')
  if (current.rules.length !== proposal.rules.length || proposal.rules.some((rule) => !current.rules.some((before) => before.id === rule.id))) throw new Error('기존 규칙을 누락하거나 다른 규칙을 추가한 수정안입니다. 기존 규칙과 조건을 다시 확인해 주세요.')
  return { projectId, expectedRevision: snapshot.revision, recipeId: proposal.recipeId, name: proposal.name, rules: proposal.rules }
}

export function isAgentRuleProposalSaved(snapshot: EvaluationProjectSnapshot | null, proposal: NativeAgentRuleProposal): boolean {
  const current = [...(snapshot?.recipes ?? [])].reverse().find((recipe) => recipe.recipeId === proposal.recipeId)
  return Boolean(current && !current.archived && current.revision === proposal.baseRevision + 1 && current.name === proposal.name
    && current.rules.length === proposal.rules.length && current.rules.every((rule) => {
      const proposed = proposal.rules.find((item) => item.id === rule.id)
      return proposed && evaluationRuleSignature(proposed) === evaluationRuleSignature(rule)
    }))
}
