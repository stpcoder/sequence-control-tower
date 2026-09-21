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
    const prompts: string[] = []
    const runtime = new EvaluationAgentRuntime({
      listFiles: async () => [
        { id: 'a', name: 'a.log', metadata: { testMode: 'HDIAG', vdd: 1.295, temperatureC: 25 } },
        { id: 'b', name: 'b.log', metadata: { testMode: 'HDIAG', vdd: 1.315, temperatureC: 85 } },
      ],
      search: async () => [], lineWindow: async () => [],
    }, { complete: async (prompt) => { prompts.push(prompt); return { content: '{"action":"complete"}' } } })
    const session = await runtime.start('common-dimensions')
    expect(session.context.dimensions).toEqual({ testMode: 'HDIAG' })
    expect(session.question).toBeUndefined()
    expect(session.status).toBe('waiting_confirmation')
    expect(prompts[0]).toContain('ENGINEER-CONFIRMED EVALUATION INTENT: missing')
  })
  it('lets the planner ask one evidence-specific purpose question after inspection and carries the answer into analysis', async () => {
    const { runtime, prompts } = setup([
      '{"action":"ask","field":"evaluationIntent","impact":"high","question":"파일명에는 DIAG가 있고 DQ8 FAIL이 확인되지만 이전 FAIL 재현인지 검출 조건 탐색인지 구분되지 않습니다. 어느 쪽인가요?","choices":["이전 FAIL 재현","불량 검출 조건 탐색"]}',
      '{"action":"propose","outcome":"TEST_FAIL","dimensions":{"dq":"8"},"rationale":"DQ8 failure"}',
    ])
    const session = await runtime.start('intent-first')
    expect(session).toMatchObject({ status: 'waiting_question', question: { field: 'evaluationIntent', impact: 'high' } })
    expect(session.question?.prompt).toContain('DQ8 FAIL')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('ENGINEER-CONFIRMED EVALUATION INTENT: missing')
    const resumed = await runtime.resume(session, { answer: '불량 검출 가속 조건 확인' })
    expect(resumed).toMatchObject({ status: 'waiting_confirmation', proposal: { purpose: 'screening' } })
    expect(resumed.context.evaluationIntent).toBe('불량 검출 가속 조건 확인')
    expect(prompts[1]).toContain('ENGINEER-CONFIRMED EVALUATION INTENT: 불량 검출 가속 조건 확인')
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
    expect(prompts.every((prompt) => prompt.length <= 800_000)).toBe(true)
    expect(prompts.every((prompt) => prompt.includes('FOLDER SUMMARY') && prompt.includes('REPRESENTATIVE FILES') && prompt.includes('BOUNDED EVIDENCE'))).toBe(true)
    expect(prompts.join('\n')).not.toContain('late secret')
    const accepted = await runtime.resume(session, { confirm: 'accept' }); expect(accepted.status).toBe('completed')
    const memory = proposalToEvaluationMemory(accepted, { projectId: 'p1', hypothesisId: 'h1', nodeId: 'n1', evidenceId: (id) => `persisted-${id}` })
    expect(memory?.node.purpose).toBe('screening')
    expect(memory?.node.status).toBe('fail')
    expect(memory?.node).toMatchObject({ authorship: 'agent', reviewState: 'proposed' })
    expect(memory?.node.interpretation).toContain('failure evidence')
    expect(memory?.node.report).toMatchObject({
      purpose: { state: 'agent-proposed' }, results: { state: 'computed', total: 1 },
      interpretation: { state: 'agent-proposed' }, trends: { state: 'agent-proposed' }, nextPlan: { state: 'agent-proposed' },
    })
    expect(memory?.evidence[0]).toMatchObject({ logRef: 'a', id: 'persisted-search-1' })
  })

  it('asks only an explicit high-impact ambiguity and persists a resumable transcript', async () => {
    const { runtime } = setup(['{"action":"ask","dimension":"testMode","impact":"high","question":"Which test mode generated this log?"}', '{"action":"propose","outcome":"PASS","dimensions":{"testMode":"READ"},"rationale":"mode supplied by engineer"}'])
    const session = await runtime.start('s2', { evaluationIntent: '메모리 테스트 확인' })
    expect(session.status).toBe('waiting_question'); expect(session.question?.impact).toBe('high')
    const resumed = await runtime.resume(session, { answer: 'READ' })
    expect(resumed.status).toBe('waiting_confirmation'); expect(resumed.context.dimensions.testMode).toBe('READ')
    expect(resumed.transcript.some((item) => item.type === 'answer')).toBe(true)
    expect(resumed.transcript.filter((item) => item.type === 'clarification-question')).toHaveLength(1)
  })

  it('rejects a second clarification in the same run instead of turning analysis into a questionnaire', async () => {
    const { runtime } = setup([
      '{"action":"ask","field":"evaluationIntent","impact":"high","question":"DQ8 FAIL은 재현 평가인가요, 검출 평가인가요?"}',
      '{"action":"ask","dimension":"testMode","impact":"high","question":"Test Mode도 알려주세요."}',
    ])
    const first = await runtime.start('one-question-budget')
    expect(first.status).toBe('waiting_question')
    const resumed = await runtime.resume(first, { answer: '동일 조건 재현' })
    expect(resumed.status).toBe('waiting_confirmation')
    expect(resumed.question).toBeUndefined()
    expect(resumed.transcript.some((item) => item.type === 'question-rejected')).toBe(true)
  })

  it('rejects a generic purpose intake question even when a provider emits it', async () => {
    const { runtime } = setup(['{"action":"ask","field":"evaluationIntent","impact":"high","question":"이번 폴더에서 확인하려는 평가 목적은 무엇인가요?"}'])
    const result = await runtime.start('no-generic-intake')
    expect(result.status).toBe('waiting_confirmation')
    expect(result.question).toBeUndefined()
    expect(result.transcript.some((item) => item.type === 'question-rejected')).toBe(true)
  })

  it('persists an engineer answer as the folder purpose in evaluation history memory', async () => {
    const { runtime } = setup([
      '{"action":"ask","field":"evaluationIntent","impact":"high","question":"VPERI-UP과 이전 FAIL 조건이 함께 보여 재현 평가와 개선 효과 확인이 모두 가능합니다. 어느 목적에 가깝나요?","choices":["동일 불량 재현","개선 효과 확인"]}',
      '{"action":"propose","outcome":"TEST_FAIL","purpose":"verification","rationale":"개선 조건에서도 DQ8 FAIL이 남음","report":{"purpose":"VPERI-UP 개선 효과 확인"}}',
    ])
    const questioned = await runtime.start('purpose-memory')
    const proposed = await runtime.resume(questioned, { answer: 'VPERI-UP 개선 효과 확인' })
    const completed = await runtime.resume(proposed, { confirm: 'accept' })
    const memory = proposalToEvaluationMemory(completed, {
      projectId: 'p', hypothesisId: 'h', nodeId: 'n', evidenceId: (id) => `e-${id}`,
    })
    expect(memory?.node.name).toBe('VPERI-UP 개선 효과 확인')
    expect(memory?.node.report?.purpose.text).toBe('VPERI-UP 개선 효과 확인')
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
    expect(session.proposal?.rationale).toContain('1개 로그의 확정 판정이 모두 TEST_FAIL')
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
    expect(proposed.proposal?.report?.results).toMatchObject({ total: 2, byOutcome: { PASS: 1, SYSTEM_HALT: 1 }, state: 'computed' })
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
