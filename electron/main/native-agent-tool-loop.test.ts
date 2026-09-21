import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAgentService } from './native-agent-service'
import { NativeAgentStore } from './native-agent-store'
import type { LlmToolRequest } from './llm-service'
import type { NativeAgentSessionView } from '../shared/contracts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
const tool = (name: string, args: unknown = {}) => ({ content: '', toolCalls: [{ id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] })
const project = { id: 'p', name: 'P', artifacts: [{ sourceId: 's1', artifactId: 'a1', rootId: 'r', relativePath: 'run.log' }, { sourceId: 's2', artifactId: 'a2', rootId: 'r2', relativePath: 'other.log' }] }
async function setup(responses: Array<unknown>, openCode = false) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-dialogue-')); dirs.push(dir)
  const store = new NativeAgentStore(dir)
  const execute = vi.fn(async (_projectId: string, call: { name: string; args?: unknown }, sources: string[]) => ({ name: call.name, label: call.name, summary: `${call.name} 완료`, data: call.name === 'source_list' ? { sources: [{ sourceId: 's1', fileName: 'run.log' }] } : { line: 14, result: 'PASS' }, evidenceSourceIds: sources }))
  const complete = vi.fn(async (_prompt: string, _signal: AbortSignal, _stage: unknown, _request: LlmToolRequest) => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    if (!response) throw new Error('테스트 응답 없음')
    return response
  })
  const opencode = { available: vi.fn(async () => openCode), send: vi.fn(), abort: vi.fn(async () => undefined) }
  const deps = { store, tools: { execute }, projects: { get: vi.fn(async () => project) }, artifacts: { list: vi.fn(async () => []) }, llm: { complete }, opencode }
  const service = new NativeAgentService(deps as never)
  await service.initialize()
  const session = await service.create('p', undefined, 'r', ['s1'])
  return { service, store, session, execute, complete, opencode, deps, dir }
}
async function settled(service: NativeAgentService, id: string, status: NativeAgentSessionView['status'] = 'idle') {
  await vi.waitFor(async () => expect((await service.get(id))?.status).toBe(status))
  return (await service.get(id))!
}

describe('model-driven Agent conversation', () => {
  it('selects tools from model calls, feeds each result back, and asks a custom question that survives restart', async () => {
    const h = await setup([
      tool('source_list'), tool('evaluation_state_get'), tool('log_read_window', { sourceId: 's1', startLine: 14, lineCount: 8 }),
      tool('ask_user', { prompt: '14행은 PASS인데 이력은 실패입니다. 재평가 후의 기록인가요?', choices: ['재평가 후 결과', '다른 차수의 결과'] }),
    ])
    expect(h.execute).not.toHaveBeenCalled()
    await h.service.send(h.session.id, '이 평가는 왜 이렇게 됐어?', ['s1'])
    const waiting = await settled(h.service, h.session.id, 'waiting_question')
    expect(h.execute.mock.calls.map((call) => call[1].name)).toEqual(['source_list', 'evaluation_state_get', 'log_read_window'])
    expect(h.execute.mock.calls.every((call) => call[2].join() === 's1')).toBe(true)
    expect(h.complete.mock.calls[2][3].messages.some((message) => message.role === 'tool' && message.content?.includes('evaluation_state_get'))).toBe(true)
    expect(waiting.question).toMatchObject({ kind: 'agent', choices: ['재평가 후 결과', '다른 차수의 결과'] })
    const restartedStore = new NativeAgentStore(h.dir)
    const complete = vi.fn().mockResolvedValueOnce(tool('project_history_get')).mockResolvedValueOnce({ content: '재평가 후 기록으로 이해했습니다. 이력과 현재 판정의 시점이 다릅니다.' })
    const restarted = new NativeAgentService({ ...h.deps, store: restartedStore, llm: { complete } } as never)
    await restarted.initialize()
    expect((await restarted.get(h.session.id))?.question?.id).toBe(waiting.question?.id)
    await restarted.send(h.session.id, '첫 번째야. 재평가 후 결과로 정리해 줘', undefined, 'free_chat', undefined, waiting.question!.id)
    const done = await settled(restarted, h.session.id)
    expect(done.question).toBeUndefined()
    expect(done.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(complete.mock.calls[0][3].messages.some((message: { content: string }) => message.content.includes('다른 차수의 결과'))).toBe(true)
    expect(done.messages.at(-1)?.content).toContain('이력과 현재 판정')
    await expect(restarted.send(h.session.id, '재평가 후 결과', undefined, undefined, undefined, waiting.question!.id)).rejects.toThrow('이미 답변')
  })

  it('returns tool errors to the model so it can correct a failed call', async () => {
    const h = await setup([tool('write_file', { path: '/tmp/x' }), tool('source_list'), { content: '파일을 확인했습니다. 변경하지 않았습니다.' }])
    await h.service.send(h.session.id, '파일을 확인해 줘', ['s1'])
    await settled(h.service, h.session.id)
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.complete.mock.calls[1][3].messages.at(-1)?.content).toContain('허용되지 않은 도구')
  })

  it('accepts one concurrent send, retains user text on failure and retries without duplicating it', async () => {
    const h = await setup([new Error('LLM_REQUEST_TIMEOUT'), { content: '이어진 응답' }])
    const attempts = await Promise.allSettled([h.service.send(h.session.id, '첫 질문'), h.service.send(h.session.id, '두 번째 질문')])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const paused = await settled(h.service, h.session.id, 'paused')
    expect(paused.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    await h.service.retry(h.session.id)
    const done = await settled(h.service, h.session.id)
    expect(done.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('carries internal fallback and custom answers back to the same OpenCode conversation', async () => {
    const h = await setup([tool('ask_user', { prompt: '현재 결과와 이전 이력이 다릅니다. 어느 시점의 결과인가요?', choices: ['수정 전', '수정 후'] })], true)
    h.opencode.send.mockRejectedValueOnce(new Error('OPENCODE_FAILED')).mockResolvedValueOnce({ externalSessionId: 'ext', content: '수정 후 결과로 확인했습니다.', toolNames: [], toolTraces: [] })
    await h.service.send(h.session.id, '이력 내용이 이상해')
    const waiting = await settled(h.service, h.session.id, 'waiting_question')
    await h.service.send(h.session.id, '수정 후', undefined, undefined, undefined, waiting.question!.id)
    const done = await settled(h.service, h.session.id)
    expect(h.opencode.send.mock.calls[1][0].content).toContain('현재 결과와 이전 이력이 다릅니다')
    expect(h.opencode.send.mock.calls[1][0].content).toContain('수정 후')
    expect(done.backend).toBe('opencode')
  })

  it('ignores a late OpenCode answer after cancellation and permits a clean retry', async () => {
    const h = await setup([], true)
    let finish!: (value: unknown) => void
    h.opencode.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await h.service.send(h.session.id, '현재 이력을 읽어 줘')
    await vi.waitFor(() => expect(h.opencode.send).toHaveBeenCalled())
    const cancel = h.service.cancel(h.session.id)
    finish({ externalSessionId: 'ext', content: '늦게 온 응답', toolNames: [] })
    await cancel
    const stopped = await settled(h.service, h.session.id, 'paused')
    expect(stopped.messages.some((message) => message.content === '늦게 온 응답')).toBe(false)
    h.opencode.send.mockResolvedValueOnce({ externalSessionId: 'ext', content: '재시도한 응답', toolNames: [] })
    await h.service.retry(h.session.id)
    expect((await settled(h.service, h.session.id)).messages.at(-1)?.content).toBe('재시도한 응답')
  })

  it('preserves historical conversation text verbatim when reopening a session', async () => {
    const h = await setup([])
    await h.store.appendMessage(h.session.id, { role: 'assistant', content: '이전 기록에 어떤 문제가 있었나요? 사용자가 직접 작성한 내용을 비교하겠습니다.' })
    expect((await h.service.get(h.session.id))?.messages.at(-1)?.content).toBe('이전 기록에 어떤 문제가 있었나요? 사용자가 직접 작성한 내용을 비교하겠습니다.')
  })

  it('coalesces stop clicks and blocks retry until both the run and provider cancellation finish', async () => {
    const h = await setup([], true)
    let finish!: (value: unknown) => void
    let aborted!: () => void
    h.opencode.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    h.opencode.abort.mockImplementationOnce(() => new Promise<undefined>((resolve) => { aborted = () => resolve(undefined) }))
    await h.store.update(h.session.id, (session) => { session.externalSessionId = 'ext' })
    await h.service.send(h.session.id, '이력을 확인해 줘')
    await vi.waitFor(() => expect(h.opencode.send).toHaveBeenCalled())
    const cancel = h.service.cancel(h.session.id)
    expect(h.service.cancel(h.session.id)).toBe(cancel)
    await vi.waitFor(() => expect(h.opencode.abort).toHaveBeenCalled())
    finish({ externalSessionId: 'ext', content: '이미 중지된 응답', toolNames: [] })
    await settled(h.service, h.session.id, 'paused')
    await expect(h.service.retry(h.session.id)).rejects.toThrow('중지하고 있습니다')
    await expect(h.service.send(h.session.id, '새 요청')).rejects.toThrow('중지하고 있습니다')
    aborted()
    await cancel
    await h.service.cancel(h.session.id)
    expect((await h.service.get(h.session.id))?.messages.filter((message) => message.role === 'system')).toHaveLength(1)
    h.opencode.send.mockResolvedValueOnce({ externalSessionId: 'ext', content: '정상 재시도', toolNames: [] })
    await h.service.retry(h.session.id)
    expect((await settled(h.service, h.session.id)).messages.at(-1)?.content).toBe('정상 재시도')
  })

  it('renders an OpenCode-authored question without forcing unrelated tools first', async () => {
    const h = await setup([], true)
    h.opencode.send.mockResolvedValueOnce({ externalSessionId: 'ext', toolNames: [], content: '<sct-question>{"prompt":"이전 기록은 어느 평가 차수에 해당하나요?","choices":["1차","2차"]}</sct-question>' })
    await h.service.send(h.session.id, '이전 기록의 차수를 수정해 줘')
    const waiting = await settled(h.service, h.session.id, 'waiting_question')
    expect(waiting.messages.at(-1)).toMatchObject({ content: '이전 기록은 어느 평가 차수에 해당하나요?', question: { choices: ['1차', '2차'] } })
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('retains a model-authored rule proposal as an uncommitted change across restart', async () => {
    const proposal = { recipeId: 'recipe', baseRevision: 1, name: '종료', rationale: '종료 두 번', rules: [{ id: 'rule', label: 'PASS', scope: { kind: 'project' }, priority: 1, confidence: 1, clauses: [{ id: 'c', presence: 'present', occurrence: { kind: 'exact', count: 2 }, matcher: { kind: 'literal', target: 'content', pattern: 'END', caseSensitive: false } }] }] }
    const h = await setup([{ content: `<sct-rule-proposal>${JSON.stringify(proposal)}</sct-rule-proposal>` }, { content: '재평가 시 두 차수가 모두 끝났는지 확인하는 조건입니다.' }])
    await h.service.send(h.session.id, '종료 규칙을 두 번으로 수정해 줘')
    const done = await settled(h.service, h.session.id)
    expect(done.ruleProposal).toMatchObject(proposal)
    expect(done.messages.at(-1)?.content).toBe('규칙 수정안을 확인해 주세요.')
    const store = new NativeAgentStore(h.dir); await store.initialize()
    expect((await store.get(h.session.id))?.ruleProposal).toEqual(done.ruleProposal)
    await h.service.send(h.session.id, '왜 두 번이어야 해?')
    const followUp = await settled(h.service, h.session.id)
    expect(followUp.ruleProposal).toEqual(done.ruleProposal)
    expect(h.complete.mock.calls[1][3].messages.some((message) => message.role === 'system' && message.content?.includes('"count":2'))).toBe(true)
  })

  it('stops a model that keeps calling tools without finishing', async () => {
    const h = await setup(Array.from({ length: 12 }, () => tool('source_list')))
    await h.service.send(h.session.id, '필요한 근거를 확인해 줘')
    const paused = await settled(h.service, h.session.id, 'paused')
    expect(h.complete).toHaveBeenCalledTimes(10)
    expect(paused.failure).toContain('길어져')
    expect(paused.tools.filter((trace) => trace.state === 'completed')).toHaveLength(10)
  })
})
