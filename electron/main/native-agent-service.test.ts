import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enforceWorkflowProvenance, hasConfirmedWorkflowEvidence, NativeAgentService, planLpddrTools } from './native-agent-service'
import { NativeAgentStore } from './native-agent-store'

describe('planLpddrTools', () => {
  it('routes a standalone frequency or VDD comparison to the deterministic trend tool', () => {
    expect(planLpddrTools('9600MHz와 8533MHz, VDD별 결과를 비교해줘').map((item) => item.name)).toContain('failure_trends_get')
  })

  it('never promotes raw Ctrl-F history to an engineer-confirmed workflow', () => {
    const raw = [{ name: 'engineer_workflow_apply', label: '', summary: '확정된 분석 절차 없음', data: { rows: [] }, evidenceSourceIds: [] }] as never
    expect(hasConfirmedWorkflowEvidence(raw)).toBe(false)
    expect(enforceWorkflowProvenance('엔지니어가 확정한 순서 POST_PBL → LK → @PASS', false)).toBe('최근 검색에서 관찰된 미확정 순서 POST_PBL → LK → @PASS')
    const confirmed = [{ name: 'engineer_workflow_memory_get', label: '', summary: '', data: { confirmed: [{ id: 'w1' }] }, evidenceSourceIds: [] }] as never
    expect(hasConfirmedWorkflowEvidence(confirmed)).toBe(true)
    expect(enforceWorkflowProvenance('엔지니어가 확정한 순서 POST_PBL → LK → @PASS', true)).toContain('엔지니어가 확정한 순서')
  })

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

  it('onboards and retains an Agent session inside one evaluation folder', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-folder-session-')))
    const execute = vi.fn(async (_projectId: string, call: { name: string }, sourceIds: string[]) => ({
      name: call.name, label: call.name, summary: call.name,
      data: call.name === 'filename_dimensions_scan' ? { rows: [{ sourceId: 's1', dimensions: { socVendor: 'qualcomm' } }] }
        : call.name === 'console_transcript_scan' ? { ambiguous: [] }
          : call.name === 'engineer_workflow_memory_get' ? { confirmed: [] } : {},
      evidenceSourceIds: sourceIds,
    }))
    const scopedProject = {
      id: 'p', name: 'P', artifacts: [
        { sourceId: 's1', rootId: 'folder-a', artifactId: 'a1', relativePath: 'a.log' },
        { sourceId: 's2', rootId: 'folder-b', artifactId: 'a2', relativePath: 'b.log' },
      ],
    }
    const service = new NativeAgentService({
      store, tools: { execute }, projects: { get: vi.fn(async () => scopedProject) }, artifacts: { list: vi.fn(async () => []) },
      llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    await service.initialize()
    const session = await service.create('p', undefined, 'folder-a', ['s1'])
    expect(session.evaluationScopeId).toBe('folder-a')
    expect(execute.mock.calls.every((call) => JSON.stringify(call[2]) === JSON.stringify(['s1']))).toBe(true)
    await expect(service.create('p', undefined, 'folder-a', ['s2'])).rejects.toThrow('평가 폴더 로그 범위')
  })

  it('reuses confirmed knowledge only when both project scopes exist', async () => {
    const reuseConfirmedKnowledge = vi.fn(async () => ({ workflows: 2, commandKnowledge: 1, consolePromptRules: 1 }))
    const service = new NativeAgentService({
      store: { reuseConfirmedKnowledge },
      projects: { get: vi.fn(async (id: string) => ['source', 'target'].includes(id) ? { id } : null) },
    } as never)
    await expect(service.reuseConfirmedKnowledge({ sourceProjectId: 'source', targetProjectId: 'target' }))
      .resolves.toEqual({ workflows: 2, commandKnowledge: 1, consolePromptRules: 1 })
    expect(reuseConfirmedKnowledge).toHaveBeenCalledWith('source', 'target')
    await expect(service.reuseConfirmedKnowledge({ sourceProjectId: 'source', targetProjectId: 'missing' })).rejects.toThrow('프로젝트')
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

  it('asks for an ambiguous console prompt once and persists the project decision', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-console-question-')))
    await store.initialize()
    const result = (name: string, data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: ['s1'] })
    const execute = vi.fn(async (_projectId: string, call: { name: string }) => {
      if (call.name === 'filename_dimensions_scan') return result(call.name, { rows: [{ sourceId: 's1', dimensions: { socVendor: 'qualcomm' } }] })
      if (call.name === 'console_transcript_scan') {
        const learned = (await store.consolePromptRules('p')).length > 0
        return result(call.name, { ambiguous: learned ? [] : [{ sourceId: 's1', lineNumber: 44, promptSignature: 'bare-root-hash', promptKind: 'bare-root', command: 'sleep 20' }] })
      }
      if (call.name === 'engineer_workflow_memory_get') return result(call.name, { confirmed: [] })
      return result(call.name)
    })
    const service = new NativeAgentService({
      store, tools: { execute },
      projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts: [{ sourceId: 's1', artifactId: 'a1', relativePath: 'SM-8975_SMP-01.log' }] })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    const created = await service.create('p')
    expect(created.question).toMatchObject({ kind: 'console-role', command: 'sleep 20' })
    const answered = await service.send(created.id, '입력 명령 · 형식 기억')
    expect(answered.question).toBeUndefined()
    expect(await store.consolePromptRules('p')).toEqual([expect.objectContaining({ promptSignature: 'bare-root-hash', role: 'input' })])
  })
})
