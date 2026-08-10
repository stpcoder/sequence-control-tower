import { describe, expect, it } from 'vitest'
import { EvaluationAgentRuntime, proposalToEvaluationMemory, type LogReader, type OpenAiCompatibleEvaluationProvider } from '../../src/domain/evaluation-agent'

function setup(actions: string[]) {
  const prompts: string[] = []; let index = 0
  const reader: LogReader = {
    listFiles: async () => [{ id: 'a', name: 'lpddr_BL16_DQ8_CH0_BG1_6400MT_TEMP85C_VDD1.1_DIAG.log', lineCount: 6_500, metadata: { bl: '16', dq: '8', channel: '0', bankGroup: '1', frequencyMHz: 6400, temperatureC: 85, vdd: 1.1, testMode: 'DIAG' } }],
    search: async () => [{ line: 201, text: 'FAIL pattern=checkerboard bank=3 skew=12ps' }],
    lineWindow: async (_id, _start, count) => Array.from({ length: 6_500 }, (_, i) => i === 6_499 ? 'late secret should never reach prompt' : `line ${i + 1}`).slice(0, count)
  }
  const provider: OpenAiCompatibleEvaluationProvider = { complete: async (prompt) => { prompts.push(prompt); return { content: actions[index++] ?? '{"action":"complete"}', model: 'fake-openai' } } }
  return { runtime: new EvaluationAgentRuntime(reader, provider), prompts }
}

describe('EvaluationAgentRuntime', () => {
  it('keeps only dimensions shared by every selected log in aggregate context', async () => {
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [
        { id: 'a', name: 'a.log', metadata: { testMode: 'HDIAG', vdd: 1.295, temperatureC: 25 } },
        { id: 'b', name: 'b.log', metadata: { testMode: 'HDIAG', vdd: 1.315, temperatureC: 85 } },
      ],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async () => ({ content: '{"action":"complete"}' }) })
    const session = await runtime.start('common-dimensions')
    expect(session.context.dimensions).toEqual({ testMode: 'HDIAG' })
  })
  it('plans bounded metadata/search/window evidence and requires human acceptance', async () => {
    const { runtime, prompts } = setup(['{"action":"search","fileId":"a","query":"FAIL"}', '{"action":"window","fileId":"a","startLine":195,"lineCount":999}', '{"action":"propose","outcome":"TEST_FAIL","purpose":"screening","dimensions":{"pattern":"checkerboard","bank":"3","subChannel":"1","timingSkewPs":"12"},"rationale":"failure evidence","evidenceIds":["search-1","window-2"]}'])
    const session = await runtime.start('s1')
    expect(session.status).toBe('waiting_confirmation')
    expect(session.proposal).toMatchObject({ outcome: 'TEST_FAIL', dimensions: { bank: '3', subChannel: '1', timingSkewPs: '12' } })
    expect(session.evidence.find((item) => item.kind === 'window')?.excerpt?.split('\n')).toHaveLength(24)
    expect(prompts.every((prompt) => prompt.length <= 8_000)).toBe(true)
    expect(prompts.join('\n')).not.toContain('late secret')
    const accepted = await runtime.resume(session, { confirm: 'accept' }); expect(accepted.status).toBe('completed')
    const memory = proposalToEvaluationMemory(accepted, { projectId: 'p1', hypothesisId: 'h1', nodeId: 'n1', evidenceId: (id) => `persisted-${id}` })
    expect(memory?.node.purpose).toBe('screening')
    expect(memory?.node.status).toBe('fail')
    expect(memory?.node).toMatchObject({ interpretation: 'failure evidence', authorship: 'agent', reviewState: 'proposed' })
    expect(memory?.evidence[0]).toMatchObject({ logRef: 'a', id: 'persisted-search-1' })
  })

  it('asks only an explicit high-impact ambiguity and persists a resumable transcript', async () => {
    const { runtime } = setup(['{"action":"ask","dimension":"testMode","impact":"high","question":"Which test mode generated this log?"}', '{"action":"propose","outcome":"PASS","dimensions":{"testMode":"READ"},"rationale":"mode supplied by engineer"}'])
    const session = await runtime.start('s2')
    expect(session.status).toBe('waiting_question'); expect(session.question?.impact).toBe('high')
    const resumed = await runtime.resume(session, { answer: 'READ' })
    expect(resumed.status).toBe('waiting_confirmation'); expect(resumed.context.dimensions.testMode).toBe('READ')
    expect(resumed.transcript.some((item) => item.type === 'answer')).toBe(true)
  })

  it('rejects low-impact questions and ends tool loops with a reviewable safe fallback', async () => {
    const { runtime } = setup(['{"action":"ask","dimension":"temperatureC","impact":"low","question":"temperature?"}'])
    expect((await runtime.start('s3')).status).toBe('failed')
    const looping = setup(Array(10).fill('{"action":"search","fileId":"a","query":"FAIL"}')).runtime
    const session = await looping.start('s4')
    expect(session.status).toBe('waiting_confirmation')
    expect(session.failure).toBeUndefined()
    expect(session.proposal).toMatchObject({ outcome: 'UNKNOWN', purpose: 'characterization' })
  })

  it('accepts only evidence-bound per-source outcomes', async () => {
    const { runtime } = setup(['{"action":"search","fileId":"a","query":"FAIL"}', '{"action":"propose","outcome":"TEST_FAIL","rationale":"mixed project","evidenceIds":["search-1"],"sourceAssessments":[{"sourceId":"a","outcome":"TEST_FAIL","evidenceIds":["search-1"]},{"sourceId":"unknown","outcome":"PASS","evidenceIds":["search-1"]}]}'])
    const session = await runtime.start('s5')
    expect(session.proposal?.sourceAssessments).toEqual([{ sourceId: 'a', outcome: 'TEST_FAIL', evidenceIds: ['search-1'] }])
  })
})
