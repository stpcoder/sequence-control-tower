import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvaluationAgentSkillPolicy } from '../../src/domain/evaluation-agent'

export const LPDDR_FAILURE_ANALYSIS_SKILL_ID = 'lpddr-failure-analysis'
const POLICY_START = '<!-- SCT_EVALUATION_RUNTIME_POLICY_START'
const POLICY_END = '<!-- SCT_EVALUATION_RUNTIME_POLICY_END -->'

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
}

/** Reads the same packaged Skill that OpenCode loads and extracts its bounded
 * evaluation contract for the provider-neutral result/history runtime. */
export function evaluationPolicyFromSkill(markdown: string): EvaluationAgentSkillPolicy {
  const start = markdown.indexOf(POLICY_START)
  const headerEnd = start >= 0 ? markdown.indexOf('-->', start) : -1
  const end = headerEnd >= 0 ? markdown.indexOf(POLICY_END, headerEnd + 3) : -1
  if (start < 0 || headerEnd < 0 || end < 0) throw new Error('LPDDR_FAILURE_ANALYSIS_SKILL_POLICY_MISSING')
  const header = markdown.slice(start, headerEnd + 3)
  const version = /version=([^\s>]+)/i.exec(header)?.[1] ?? ''
  const instructions = clean(markdown.slice(headerEnd + 3, end), 3_000)
  const required = [
    /selected folder as one evaluation/i,
    /locally calculated Pass\/Fail/i,
    /RT means the same Sample/i,
    /side-effect candidate/i,
    /numerator and denominator/i,
    /engineer confirms/i,
  ]
  if (!version || !instructions || required.some((rule) => !rule.test(instructions))) {
    throw new Error('LPDDR_FAILURE_ANALYSIS_SKILL_POLICY_INVALID')
  }
  return { id: LPDDR_FAILURE_ANALYSIS_SKILL_ID, version: clean(version, 40), source: 'bundled-skill', instructions }
}

export async function loadEvaluationPolicyFromSkill(skillRoot: string): Promise<EvaluationAgentSkillPolicy> {
  const markdown = await readFile(join(skillRoot, LPDDR_FAILURE_ANALYSIS_SKILL_ID, 'SKILL.md'), 'utf8')
  return evaluationPolicyFromSkill(markdown)
}
