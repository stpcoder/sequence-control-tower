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
    expect(session.question?.field).toBe('evaluationIntent')
  })
  it('asks the folder intent before any provider call and carries the answer into analysis', async () => {
    const { runtime, prompts } = setup(['{"action":"propose","outcome":"TEST_FAIL","dimensions":{"dq":"8"},"rationale":"DQ8 failure"}'])
    const session = await runtime.start('intent-first')
    expect(session).toMatchObject({ status: 'waiting_question', question: { field: 'evaluationIntent', impact: 'high' } })
    expect(prompts).toHaveLength(0)
    const resumed = await runtime.resume(session, { answer: '불량 검출 가속 조건 확인' })
    expect(resumed).toMatchObject({ status: 'waiting_confirmation', proposal: { purpose: 'screening' } })
    expect(resumed.context.evaluationIntent).toBe('불량 검출 가속 조건 확인')
    expect(prompts[0]).toContain('ENGINEER-CONFIRMED EVALUATION INTENT: 불량 검출 가속 조건 확인')
  })
  it('records and sends the exact failure-analysis Skill contract applied to the run', async () => {
    const prompts: string[] = []
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [{ id: 'rt', name: 'SMP-01_RT2_FAIL.log', deterministicOutcome: 'TEST_FAIL' }],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async (prompt) => { prompts.push(prompt); return { content: '{"action":"complete"}' } } }, undefined, {
      id: 'lpddr-failure-analysis', version: 'test-contract-7', source: 'bundled-skill',
      instructions: 'RT uses the same Sample and conditions. Weak evidence remains pending. Engineer confirmation is required.',
    })
    const session = await runtime.start('skill-contract', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(session.context.analysisPolicy).toEqual({ id: 'lpddr-failure-analysis', version: 'test-contract-7', source: 'bundled-skill' })
    expect(session.transcript.some((item) => item.type === 'analysis-skill-applied')).toBe(true)
    expect(prompts[0]).toContain('APPLIED SKILL: lpddr-failure-analysis@test-contract-7 (bundled-skill)')
    expect(prompts[0]).toContain('Weak evidence remains pending')
  })
  it('plans bounded metadata/search/window evidence and requires human acceptance', async () => {
    const { runtime, prompts } = setup(['{"action":"search","fileId":"a","query":"FAIL"}', '{"action":"window","fileId":"a","startLine":195,"lineCount":999}', '{"action":"propose","outcome":"TEST_FAIL","purpose":"screening","dimensions":{"pattern":"checkerboard","bank":"3","subChannel":"1","timingSkewPs":"12"},"rationale":"failure evidence","evidenceIds":["search-1","window-2"]}'])
    const session = await runtime.start('s1', { evaluationIntent: '불량 검출 가속 조건 확인' })
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
    const session = await runtime.start('s2', { evaluationIntent: '메모리 테스트 확인' })
    expect(session.status).toBe('waiting_question'); expect(session.question?.impact).toBe('high')
    const resumed = await runtime.resume(session, { answer: 'READ' })
    expect(resumed.status).toBe('waiting_confirmation'); expect(resumed.context.dimensions.testMode).toBe('READ')
    expect(resumed.transcript.some((item) => item.type === 'answer')).toBe(true)
  })

  it('turns low-impact questions and tool loops into a reviewable safe fallback', async () => {
    const { runtime } = setup(['{"action":"ask","dimension":"temperatureC","impact":"low","question":"temperature?"}'])
    expect((await runtime.start('s3', { evaluationIntent: '온도 경향 확인' }))).toMatchObject({ status: 'waiting_confirmation', proposal: { outcome: 'UNKNOWN' } })
    const looping = setup(Array(10).fill('{"action":"search","fileId":"a","query":"FAIL"}')).runtime
    const session = await looping.start('s4', { evaluationIntent: '불량 경향 비교' })
    expect(session.status).toBe('waiting_confirmation')
    expect(session.failure).toBeUndefined()
    expect(session.proposal).toMatchObject({ outcome: 'UNKNOWN', purpose: 'characterization' })
  })

  it('turns a provider complete-without-proposal response into a visible UNKNOWN review', async () => {
    const { runtime } = setup(['{"action":"complete"}'])
    const session = await runtime.start('safe-complete', { evaluationIntent: '부팅과 Training 단계 도달 여부 확인' })
    expect(session).toMatchObject({ status: 'waiting_confirmation', proposal: { outcome: 'UNKNOWN', purpose: 'stage-verification' } })
    expect(session.proposal?.rationale).toContain('부팅과 Training 단계 도달 여부 확인')
    expect(session.proposal?.rationale).toContain('최종 Pass/Fail을 확정할 수 없습니다')
  })

  it('accepts fenced JSON and common action argument/params envelopes from compatible providers', async () => {
    const { runtime } = setup([
      '{"action":"search","params":{"fileId":"a","query":"FAIL"}}',
      '{"action":"window","arguments":{"fileId":"a","startLine":195,"lineCount":8}}',
      '```json\n{"action":"propose","outcome":"TEST_FAIL","purpose":"screening","dimensions":{"dq":"8"},"rationale":"DQ8 근거 확인","evidenceIds":["search-1"]}\n```',
    ])
    const session = await runtime.start('compatible-json', { evaluationIntent: '불량 검출 조건 확인' })
    expect(session).toMatchObject({ status: 'waiting_confirmation', proposal: { outcome: 'TEST_FAIL', purpose: 'screening', dimensions: { dq: '8' } } })
    expect(session.searches).toBe(1)
  })

  it('accepts the single-key propose envelope returned by compatible Gemini models', async () => {
    const { runtime } = setup([
      '{"propose":{"outcome":"TEST_FAIL","purpose":"reproduction","dimensions":{"dq":"8"},"rationale":"동일 조건 RT에서 DQ8 TEST_FAIL 재현","evidenceIds":["meta-a"]}}',
    ])
    const session = await runtime.start('gemini-propose-envelope', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(session).toMatchObject({
      status: 'waiting_confirmation',
      calls: 1,
      proposal: { outcome: 'TEST_FAIL', purpose: 'reproduction', dimensions: { dq: '8' }, rationale: '동일 조건 RT에서 DQ8 TEST_FAIL 재현' },
    })
    expect(session.transcript.some((item) => item.type === 'invalid-planner-response')).toBe(false)
  })

  it('keeps a deterministic local result when the provider cannot finish a proposal', async () => {
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [{ id: 'fail', name: 'RT2_FAIL.log', deterministicOutcome: 'TEST_FAIL', deterministicReason: '@FAIL marker' }],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async () => ({ content: '{"action":"complete"}' }) })
    const session = await runtime.start('deterministic-fallback', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(session).toMatchObject({
      status: 'waiting_confirmation',
      proposal: {
        outcome: 'TEST_FAIL', purpose: 'reproduction',
        sourceAssessments: [{ sourceId: 'fail', outcome: 'TEST_FAIL', evidenceIds: ['meta-fail'] }],
      },
    })
    expect(session.proposal?.rationale).toContain('1개 로그의 로컬 종료 marker 판정이 모두 TEST_FAIL')
  })

  it('allows only one qualitative search after every file already has a local outcome', async () => {
    let calls = 0
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [{ id: 'fail', name: 'RT2_FAIL.log', deterministicOutcome: 'TEST_FAIL', deterministicReason: '@FAIL marker' }],
      search: async () => [{ line: 44, text: '@FAIL DQ=9 BL=16' }], lineWindow: async () => [],
    }, { complete: async () => ({ content: calls++ === 0
      ? '{"action":"search","fileId":"fail","query":"@FAIL"}'
      : '{"action":"search","fileId":"fail","query":"@FAIL"}' }) })
    const session = await runtime.start('bounded-local-search', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(session).toMatchObject({ status: 'waiting_confirmation', calls: 2, searches: 1, proposal: { outcome: 'TEST_FAIL' } })
  })

  it('rejects planner-field names as redundant log searches', async () => {
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [{ id: 'fail', name: 'RT2_FAIL.log', deterministicOutcome: 'TEST_FAIL' }],
      search: async () => { throw new Error('search must not run') }, lineWindow: async () => [],
    }, { complete: async () => ({ content: '{"action":"search","params":{"fileId":"fail","query":"deterministicOutcome"}}' }) })
    const session = await runtime.start('redundant-local-search', { evaluationIntent: '동일 조건 재현(RT)' })
    expect(session).toMatchObject({ calls: 1, searches: 0, proposal: { outcome: 'TEST_FAIL' } })
    expect(session.transcript.some((item) => item.type === 'redundant-result-search')).toBe(true)
  })

  it('never leaves a blank review when the provider response is malformed', async () => {
    const { runtime } = setup(['```json {"action":"propose","outcome":"TRAINING_FAIL"'])
    const session = await runtime.start('truncated-provider-json', { evaluationIntent: '부팅·Training 단계 확인' })
    expect(session).toMatchObject({ status: 'waiting_confirmation', proposal: { outcome: 'UNKNOWN', purpose: 'stage-verification' } })
    expect(session.transcript.some((item) => item.type === 'invalid-planner-response')).toBe(true)
  })

  it('never lets one representative file overwrite mixed local folder outcomes', async () => {
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [
        { id: 'pass', name: 'pass.log', metadata: { testMode: 'HDIAG', temperatureC: 25, dq: '4' }, deterministicOutcome: 'PASS', deterministicReason: '@PASS marker' },
        { id: 'halt', name: 'halt.log', metadata: { testMode: 'RETENTION', temperatureC: 105, dq: '9' }, deterministicOutcome: 'SYSTEM_HALT', deterministicReason: 'CPU_HALT marker' },
      ],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async () => ({ content: '{"action":"propose","outcome":"PASS","rationale":"first file passed","evidenceIds":["meta-pass"]}' }) })
    const proposed = await runtime.start('mixed-folder', { evaluationIntent: '불량 경향 비교' })
    expect(proposed.proposal).toMatchObject({
      outcome: 'UNKNOWN',
      sourceAssessments: [
        { sourceId: 'pass', outcome: 'PASS', evidenceIds: ['meta-pass'] },
        { sourceId: 'halt', outcome: 'SYSTEM_HALT', evidenceIds: ['meta-halt'] },
      ],
    })
    expect(proposed.proposal?.rationale).toContain('PASS 1 · SYSTEM_HALT 1')
    expect(proposed.proposal?.rationale).not.toContain('first file passed')
    const accepted = await runtime.resume(proposed, { confirm: 'accept' })
    const persisted = proposalToEvaluationMemory(accepted, { projectId: 'p', hypothesisId: 'h', nodeId: 'n', evidenceId: (value) => `e-${value}` })
    expect(persisted?.node.status).toBe('inconclusive')
    expect(persisted?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ logRef: 'pass', result: 'PASS', status: 'pass', dimensions: expect.objectContaining({ temperatureC: 25, dq: '4' }) }),
      expect.objectContaining({ logRef: 'halt', result: 'SYSTEM_HALT', status: 'fail', dimensions: expect.objectContaining({ temperatureC: 105, dq: '9' }) }),
    ]))
  })

  it('accepts only evidence-bound per-source outcomes', async () => {
    const { runtime } = setup(['{"action":"search","fileId":"a","query":"FAIL"}', '{"action":"propose","outcome":"TEST_FAIL","rationale":"mixed project","evidenceIds":["search-1"],"sourceAssessments":[{"sourceId":"a","outcome":"TEST_FAIL","evidenceIds":["search-1"]},{"sourceId":"unknown","outcome":"PASS","evidenceIds":["search-1"]}]}'])
    const session = await runtime.start('s5', { evaluationIntent: '불량 경향 비교' })
    expect(session.proposal?.sourceAssessments).toEqual([{ sourceId: 'a', outcome: 'TEST_FAIL', evidenceIds: ['search-1'] }])
  })
})
