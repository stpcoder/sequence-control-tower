import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAgentService, planLpddrTools } from './native-agent-service'
import { NativeAgentStore } from './native-agent-store'

describe('planLpddrTools', () => {
  it('routes an evaluation-context question to bounded evidence tools', () => {
    const names = planLpddrTools('새 로그의 온도와 VDD, DQ별 불량률을 보고 과거 LPDDR5 유사 사례와 다음 평가를 추천해줘').map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['project_context_get', 'project_history_get', 'filename_dimensions_scan', 'pass_fail_scan', 'engineer_workflow_apply', 'failure_trends_get', 'similar_case_search']))
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('loads confirmed engineer procedures when evaluation purpose or search behavior matters', () => {
    const names = planLpddrTools('이 로그는 어떤 평가이고 예전에 Ctrl-F로 확인한 순서를 어떻게 적용해야 해?').map((item) => item.name)
    expect(names).toContain('engineer_workflow_memory_get')
    expect(names.length).toBeLessThanOrEqual(8)
  })

  it('binds workflow learning to an exact project source and parses only filename dimensions', async () => {
    const completeEvaluation = vi.fn(async () => ({ kind: 'ignored' as const }))
    const service = new NativeAgentService({
      store: { completeEvaluation },
      projects: { get: vi.fn(async (id: string) => id === 'p' ? {
        id: 'p', artifacts: [{ sourceId: 's1', artifactId: 'a1', relativePath: 'LPDDR6_T85_VDD1p295_DQ9.log' }],
      } : null) },
      artifacts: { list: vi.fn(async () => [{ id: 'a1', fingerprint: { structuralHash: 'seq-1', commandTokens: [], commandSignatures: [], parserVersion: 'x', lineCount: 1, blockCount: 0, commandCount: 0, facts: [] } }]) },
    } as never)
    await expect(service.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'PASS', evidenceLines: [8] })).resolves.toEqual({ kind: 'ignored' })
    expect(completeEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p', sourceId: 's1', result: 'PASS', evidenceLines: [8],
      dimensions: expect.objectContaining({ temperatureC: 85, vdd: 1.295, dq: '9' }),
    }))
    await expect(service.completeEvaluation({ projectId: 'p', sourceId: 'other', result: 'PASS' })).rejects.toThrow('프로젝트 범위')
  })

  it('asks once for an unknown command purpose and persists the engineer answer', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-command-question-')))
    await store.initialize()
    const result = (name: string, data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: ['s1'] })
    const service = new NativeAgentService({
      store,
      tools: { execute: vi.fn(async (_projectId: string, call: { name: string }) => call.name === 'filename_dimensions_scan'
        ? result(call.name, { rows: [{ commandSignatures: ['diagnostic:hdiag'], dimensions: { bootProfileId: 'qualcomm-default', socModel: 'SM-8975' } }] })
        : call.name === 'engineer_workflow_memory_get' ? result(call.name, { confirmed: [] }) : result(call.name)) },
      projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts: [{ sourceId: 's1', artifactId: 'a1', relativePath: 'SM-8975_SMP-01.log' }] })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    const created = await service.create('p')
    expect(created.question).toMatchObject({ kind: 'command-purpose', command: 'diagnostic:hdiag' })
    const answered = await service.send(created.id, '불량 검출용 Screening')
    expect(answered.question).toBeUndefined()
    expect(await store.commandKnowledge('p')).toEqual([expect.objectContaining({ purpose: '불량 검출용 Screening', socModel: 'SM-8975' })])
  })

  it('asks one profile question when the filename has no known SoC token', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-profile-question-')))
    await store.initialize()
    const result = (name: string, data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: ['s1'] })
    const service = new NativeAgentService({
      store,
      tools: { execute: vi.fn(async (_projectId: string, call: { name: string }) => call.name === 'filename_dimensions_scan'
        ? result(call.name, { rows: [{ sourceId: 's1', dimensions: {} }] })
        : call.name === 'engineer_workflow_memory_get' ? result(call.name, { confirmed: [] }) : result(call.name)) },
      projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts: [{ sourceId: 's1', artifactId: 'a1', relativePath: 'CUSTOM_BOARD_SMP-01.log' }] })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    const created = await service.create('p')
    expect(created.question).toMatchObject({ kind: 'boot-profile', sourceIds: ['s1'] })
    const answered = await service.send(created.id, 'MediaTek · Post-PBL/LK')
    expect(answered.question).toBeUndefined()
    expect(await store.profileBindings('p')).toEqual([expect.objectContaining({ vendor: 'mediatek', sourceIds: ['s1'] })])
  })
})
