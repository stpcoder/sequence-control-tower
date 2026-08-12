import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluationPolicyFromSkill, LPDDR_FAILURE_ANALYSIS_SKILL_ID } from './failure-analysis-skill'
import { EvaluationAgentRuntime } from '../../src/domain/evaluation-agent'

describe('packaged LPDDR failure-analysis Skill policy', () => {
  it('extracts the bounded contract used by the evaluation runtime', async () => {
    const markdown = await readFile(resolve(process.cwd(), 'agent-skills/lpddr-failure-analysis/SKILL.md'), 'utf8')
    const policy = evaluationPolicyFromSkill(markdown)
    expect(policy).toMatchObject({ id: LPDDR_FAILURE_ANALYSIS_SKILL_ID, source: 'bundled-skill' })
    expect(policy.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(policy.instructions).toContain('selected folder as one evaluation')
    expect(policy.instructions).toContain('RT means the same Sample')
    expect(policy.instructions).toContain('side-effect candidate')
    expect(policy.instructions).toContain('numerator and denominator')

    const prompts: string[] = []
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [{ id: 'a', name: 'SM-8975_SMP-01_RT2_FAIL.log', deterministicOutcome: 'TEST_FAIL' }],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async (prompt) => { prompts.push(prompt); return { content: '{"action":"complete"}' } } }, undefined, policy)
    await runtime.start('packaged-skill', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(prompts[0]).toContain(`APPLIED SKILL: ${LPDDR_FAILURE_ANALYSIS_SKILL_ID}@${policy.version}`)
    expect(prompts[0]).toContain('FILES (metadata and local stage counts only)')
    expect(prompts[0]).toContain('BOUNDED EVIDENCE')
    expect(prompts[0]).toContain('meta-a')
    expect((await runtime.start('packaged-skill-fallback', { evaluationIntent: '동일 조건 재현(RT)' })).proposal?.outcome).toBe('TEST_FAIL')
  })

  it('fails closed when the packaged Skill loses its runtime contract', () => {
    expect(() => evaluationPolicyFromSkill('# generic chat instructions')).toThrow('POLICY_MISSING')
    expect(() => evaluationPolicyFromSkill('<!-- SCT_EVALUATION_RUNTIME_POLICY_START version=1 -->\nbe helpful\n<!-- SCT_EVALUATION_RUNTIME_POLICY_END -->')).toThrow('POLICY_INVALID')
  })
})
