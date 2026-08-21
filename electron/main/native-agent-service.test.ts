import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enforceAgentScopeClaims, enforceEvidenceBoundHistory, enforceWorkflowProvenance, hasConfirmedWorkflowEvidence, isStandardCommandSignature, missingRequiredOpenCodeTools, NativeAgentService, openCodeToolPresentation, planLpddrTools, requiredOpenCodeTools } from './native-agent-service'
import { NativeAgentStore } from './native-agent-store'
import type { NativeAgentSessionView } from '../shared/contracts'

describe('planLpddrTools', () => {
  it('presents OpenCode tool traces as product language', () => {
    expect(openCodeToolPresentation('sct_pass_fail_scan')).toEqual({ name: 'pass_fail_scan', label: 'Pass/Fail 판정' })
    expect(openCodeToolPresentation('sct_evaluation_relation_suggest')).toEqual({ name: 'evaluation_relation_suggest', label: '평가 관계 제안' })
    expect(openCodeToolPresentation('unknown_internal_name')).toEqual({ name: 'unknown_internal_name', label: 'Agent 근거 확인' })
  })

  it('fails closed when a model promotes a project goal to an unconfirmed folder purpose', () => {
    const content = enforceAgentScopeClaims(
      '- **평가 목적**: VPERI 개선 전압 확인\n- DQ4 특정 위치 타겟\n- sct_log_search(source-a)',
      { evaluationNodes: [{
        id: 'n1', hypothesisId: 'h1', evaluationScopeId: 'folder-a', name: '고온 Retention 재현',
        purpose: 'characterization', status: 'inconclusive', reviewState: 'proposed', dimensions: {},
        interpretation: '105°C에서 2개 중 1개 Halt가 관찰됐습니다.',
      }] },
      'folder-a',
      ['source-a'],
    )
    expect(content).toContain('평가 목적 후보')
    expect(content).toContain('고온 Retention 재현')
    expect(content).not.toContain('개선 전압')
    expect(content).not.toContain('source-a')
    expect(content).not.toContain('sct_log_search')
    expect(content).toContain('로그 검색')
    expect(content).toContain('기록된 위치 조건')
  })

  it('never presents SKEW corner as die process variation', () => {
    const content = enforceAgentScopeClaims(
      '본 불량은 고온 환경 또는 Die 03 자체의 공정 편차(SKEW-SS)에 기인한 것으로 추정됩니다.\n공정 편차(SKEW-FFS)도 확인합니다.\nDie 04 자체의 공정 편차와 위치의 취약성을 의심합니다.\nPASS면 고온 기인성 불량으로 확정할 수 있습니다.\nFAIL이면 Die 04 자체의 고정성 불량으로 판정할 수 있습니다.',
      { evaluationNodes: [] },
      'folder-a',
    )
    expect(content).toContain('Die 03에 공통된 미확인 요인')
    expect(content).toContain('SKEW FFS 평가 corner 조건')
    expect(content).toContain('Die 04에 공통된 미확인 요인')
    expect(content).toContain('위치 조건과의 연관성')
    expect(content).toContain('고온 연관 가설을 지지할 수 있습니다')
    expect(content).toContain('Die 04에 공통된 미확인 요인 가설을 지지할 수 있습니다')
    expect(content).not.toContain('공정 편차')
    expect(content).not.toContain('위치의 취약성')
  })

  it('removes unsupported project-history numbers unless a history tool actually ran', () => {
    const answer = '- 현재 폴더는 9600MHz 단일 조건입니다. 과거 누적 데이터에서는 8533MHz 2/2, 9600MHz 4/6 FAIL입니다.\n- 다음 split 평가가 필요합니다.'
    expect(enforceEvidenceBoundHistory(answer, false)).toBe('- 현재 폴더는 9600MHz 단일 조건입니다.\n- 다음 split 평가가 필요합니다.')
    expect(enforceEvidenceBoundHistory(answer, true)).toContain('4/6 FAIL')
  })

  it('routes a standalone frequency or VDD comparison to the deterministic trend tool', () => {
    expect(planLpddrTools('9600MHz와 8533MHz, VDD별 결과를 비교해줘').map((item) => item.name)).toContain('failure_trends_get')
  })

  it('does not interrupt the engineer for standard test and condition commands', () => {
    expect(['shell:stressapptest', 'diagnostic:hdiag', 'shell:set_freq', 'voltage-control:set_rail', 'sleep 20']
      .every(isStandardCommandSignature)).toBe(true)
    expect(isStandardCommandSignature('vendor:tskhynix_eye_sweep')).toBe(false)
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

  it('requires exact workflow evidence before OpenCode compares or reuses another folder procedure', () => {
    expect(requiredOpenCodeTools('다른 평가 폴더에서 확정한 Ctrl-F 분석 절차를 현재 폴더에 호환 적용할 수 있어?'))
      .toEqual(['engineer_workflow_memory_get', 'engineer_workflow_apply'])
    expect(missingRequiredOpenCodeTools(
      ['engineer_workflow_memory_get', 'engineer_workflow_apply'],
      ['sct_project_history_get', 'sct_engineer_workflow_memory_get'],
    )).toEqual(['engineer_workflow_apply'])
  })

  it('requires project history and the bounded relation engine for branch questions', () => {
    expect(requiredOpenCodeTools('이 재현 평가를 기존 불량 브랜치의 RT로 연결해도 돼?'))
      .toEqual(['project_history_get', 'evaluation_relation_suggest'])
    expect(planLpddrTools('이 재현 평가를 기존 불량 브랜치의 RT로 연결해도 돼?').map((item) => item.name))
      .toEqual(expect.arrayContaining(['project_history_get', 'evaluation_relation_suggest']))
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
    await expect(service.send(session.id, ',         .', ['s1'])).rejects.toThrow('질문이나 확인할 로그 조건')
    expect((await store.get(session.id))?.messages.some((message) => message.content === ',         .')).toBe(false)
    await expect(service.create('p', undefined, 'folder-a', ['s2'])).rejects.toThrow('평가 폴더 로그 범위')
  })

  it('bounds long-log Agent initialization to 32 local source references', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-bounded-sources-')))
    const artifacts = Array.from({ length: 48 }, (_, index) => ({
      sourceId: `s-${index}`, rootId: 'folder-a', artifactId: `a-${index}`, relativePath: `${index}.log`,
    }))
    const execute = vi.fn(async (_projectId: string, call: { name: string }, sourceIds: string[]) => ({
      name: call.name, label: call.name, summary: call.name,
      data: call.name === 'filename_dimensions_scan' ? { rows: [] }
        : call.name === 'console_transcript_scan' ? { ambiguous: [] }
          : call.name === 'engineer_workflow_memory_get' ? { confirmed: [] } : {},
      evidenceSourceIds: sourceIds,
    }))
    const service = new NativeAgentService({
      store, tools: { execute }, projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    await service.initialize()
    await service.create('p', undefined, 'folder-a', artifacts.map((item) => item.sourceId))
    expect(execute).toHaveBeenCalled()
    expect(execute.mock.calls.every((call) => call[2].length === 32)).toBe(true)
  })

  it('keeps menu context in one folder session and returns a typed, uncommitted Results Summary proposal', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-analysis-view-')))
    const result = (name: string, sourceIds: string[], data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: sourceIds })
    const execute = vi.fn(async (_projectId: string, call: { name: string }, sourceIds: string[]) => result(
      call.name,
      sourceIds,
      call.name === 'filename_dimensions_scan' ? { rows: [{ sourceId: 's1', dimensions: { socVendor: 'qualcomm', skew: 'SS', dq: 9 } }] }
        : call.name === 'console_transcript_scan' ? { ambiguous: [] }
          : call.name === 'engineer_workflow_memory_get' ? { confirmed: [] }
            : call.name === 'failure_trends_get' ? { failAddress: { eventCount: 12, sourceCount: 4, distribution: [{ dimension: 'dq', value: '9', eventCount: 9 }] } }
              : {},
    ))
    const complete = vi.fn()
      .mockResolvedValueOnce({ content: 'DQ9 집중을 비교했습니다.\n<sct-analysis-view>{"dataBasis":"failure_address","rowAxes":["dq"],"columnAxes":["bl"],"aggregation":"fail_event_count","visualization":"heatmap","failOnly":true,"rationale":"DQ·BL 주소 집중을 확인합니다."}</sct-analysis-view>' })
      .mockResolvedValueOnce({ content: '선택한 결과의 분모를 다시 확인했습니다.' })
    const scopedProject = {
      id: 'p', name: 'P', artifacts: [{ sourceId: 's1', rootId: 'folder-a', artifactId: 'a1', relativePath: 'SM-8975_SS_DQ9.log' }],
      evaluationNodes: [{ id: 'n1', evaluationScopeId: 'folder-a', name: 'VPERI 재현', purpose: 'reproduction', interpretation: '동일 조건 RT', reviewState: 'confirmed' }],
    }
    const service = new NativeAgentService({
      store, tools: { execute }, projects: { get: vi.fn(async () => scopedProject) }, artifacts: { list: vi.fn(async () => []) },
      llm: { complete }, opencode: { available: vi.fn(async () => false) },
    } as never)
    await service.initialize()
    const session = await service.create('p', 'VPERI 분석', 'folder-a', ['s1'])
    const waitForIdle = () => new Promise<NativeAgentSessionView>((resolve) => {
      const unsubscribe = service.onUpdate((next) => {
        if (next.id === session.id && next.status === 'idle' && next.messages.at(-1)?.role === 'assistant') { unsubscribe(); resolve(next) }
      })
    })
    const firstIdle = waitForIdle()
    await service.send(session.id, '[SCT_ANALYSIS_VIEW_CONTEXT]\nDQ와 BL 집중을 보여줘', ['s1'], 'analysis_view')
    const proposed = await firstIdle
    expect(proposed.messages.find((message) => message.role === 'user' && message.content.includes('DQ와 BL'))).toMatchObject({ contextKind: 'analysis_view' })
    expect(proposed.messages.at(-1)?.content).toBe('DQ9 집중을 비교했습니다.')
    expect(proposed.analysisViewProposal).toMatchObject({ dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_event_count', visualization: 'heatmap' })

    const secondIdle = waitForIdle()
    await service.send(session.id, '선택한 PASS/FAIL 결과를 비교해줘', ['s1'], 'results')
    const continued = await secondIdle
    expect(continued.id).toBe(session.id)
    expect(continued.lastContextKind).toBe('results')
    expect(continued.messages.filter((message) => message.role === 'user').map((message) => message.contextKind)).toEqual(['analysis_view', 'results'])
    expect(continued.analysisViewProposal).toBeUndefined()
  })

  it('reuses a confirmed folder purpose without asking the engineer again', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-confirmed-purpose-')))
    await store.initialize()
    const result = (name: string, data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: ['s1'] })
    const service = new NativeAgentService({
      store,
      tools: { execute: vi.fn(async (_projectId: string, call: { name: string }) => call.name === 'filename_dimensions_scan'
        ? result(call.name, { rows: [{ sourceId: 's1', commandSignatures: ['shell:stressapptest', 'diagnostic:hdiag'], dimensions: { socVendor: 'qualcomm' } }] })
        : call.name === 'engineer_workflow_memory_get' ? result(call.name, { confirmed: [] })
          : call.name === 'console_transcript_scan' ? result(call.name, { ambiguous: [] }) : result(call.name)) },
      projects: { get: vi.fn(async () => ({
        id: 'p', name: 'P', artifacts: [{ sourceId: 's1', rootId: 'folder-a', artifactId: 'a1', relativePath: 'SM-8975.log' }],
        evaluationNodes: [{ id: 'n1', evaluationScopeId: 'folder-a', name: 'Screening', purpose: 'screening', interpretation: '85°C에서 2/2 FAIL', reviewState: 'confirmed' }],
      })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    const created = await service.create('p', undefined, 'folder-a', ['s1'])
    expect(created.evaluationIntent).toBe('불량 검출 강화')
    expect(created.question).toBeUndefined()
    expect(created.messages.at(-1)?.content).toContain('저장된 평가 목적: “불량 검출 강화”')
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
        ? result(call.name, { rows: [{ commandSignatures: ['vendor:tskhynix_eye_sweep'], dimensions: { bootProfileId: 'qualcomm-default', socModel: 'SM-8975' } }] })
        : call.name === 'engineer_workflow_memory_get' ? result(call.name, { confirmed: [] }) : result(call.name)) },
      projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts: [{ sourceId: 's1', artifactId: 'a1', relativePath: 'SM-8975_SMP-01.log' }] })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() }, opencode: { available: vi.fn(async () => false) },
    } as never)
    const created = await service.create('p')
    expect(created.question).toMatchObject({ kind: 'command-purpose', command: 'vendor:tskhynix_eye_sweep' })
    const initialAnswer = created.messages.at(-1)?.content ?? ''
    expect(initialAnswer).toContain('아래 한 가지만 확인해 주세요')
    expect(initialAnswer).not.toContain('어떤 목적의 평가인가요')
    const answered = await service.send(created.id, '불량 검출용 Screening')
    expect(answered.question).toMatchObject({ kind: 'evaluation-purpose' })
    expect(answered.messages.at(-1)?.content).toContain('평가 목적만 선택')
    const purposed = await service.send(answered.id, '불량 검출 강화')
    expect(purposed.question).toBeUndefined()
    expect(purposed.evaluationIntent).toBe('불량 검출 강화')
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
    expect(answered.question).toMatchObject({ kind: 'evaluation-purpose' })
    expect(await store.profileBindings('p')).toEqual([expect.objectContaining({ vendor: 'mediatek', sourceIds: ['s1'] })])
  })

  it('continues to the evaluation purpose after leaving an unknown boot profile unconfirmed', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-profile-skip-')))
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
    const answered = await service.send(created.id, '미확인으로 유지')
    expect(answered.question).toMatchObject({ kind: 'evaluation-purpose' })
    expect(answered.messages.at(-1)?.content).toContain('평가 목적만 선택')
    expect(await store.profileBindings('p')).toEqual([])
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
    expect(answered.question).toMatchObject({ kind: 'evaluation-purpose' })
    expect(await store.consolePromptRules('p')).toEqual([expect.objectContaining({ promptSignature: 'bare-root-hash', role: 'input' })])
  })

  it('publishes bounded OpenCode tool progress before the slow final answer and avoids duplicate traces', async () => {
    const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-opencode-progress-')))
    await store.initialize()
    const result = (name: string, data: unknown = {}) => ({ name, label: name, summary: name, data, evidenceSourceIds: ['s1'] })
    let releaseAnswer!: () => void
    const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve })
    const opencodeSend = vi.fn(async (input: { requiredToolNames?: string[]; onToolTrace?: (trace: { name: string; label: string; summary: string; evidenceSourceIds: string[] }) => void }) => {
      input.onToolTrace?.({ name: 'pass_fail_scan', label: 'internal label', summary: 'TEST_FAIL 2건', evidenceSourceIds: ['s1'] })
      await answerGate
      return {
        externalSessionId: 'external-1', content: '확인된 사실\n- FAIL 2건', toolNames: ['pass_fail_scan'],
        toolTraces: [{ name: 'pass_fail_scan', label: 'internal label', summary: 'TEST_FAIL 2건', evidenceSourceIds: ['s1'] }],
      }
    })
    const service = new NativeAgentService({
      store,
      tools: { execute: vi.fn(async (_projectId: string, call: { name: string }) => call.name === 'filename_dimensions_scan'
        ? result(call.name, { rows: [{ sourceId: 's1', commandSignatures: ['shell:stressapptest', 'diagnostic:hdiag'], dimensions: { socVendor: 'qualcomm' } }] })
        : call.name === 'engineer_workflow_memory_get' ? result(call.name, { confirmed: [] })
          : call.name === 'console_transcript_scan' ? result(call.name, { ambiguous: [] }) : result(call.name)) },
      projects: { get: vi.fn(async () => ({ id: 'p', name: 'P', artifacts: [{ sourceId: 's1', rootId: 'folder-a', artifactId: 'a1', relativePath: 'SM-8975_SMP-01.log' }], evaluationNodes: [] })) },
      artifacts: { list: vi.fn(async () => []) }, llm: { complete: vi.fn() },
      opencode: { available: vi.fn(async () => true), send: opencodeSend },
    } as never)
    const updates: Array<{ status: string; tools: Array<{ name: string; summary?: string }> }> = []
    service.onUpdate((session) => updates.push({ status: session.status, tools: session.tools }))
    const created = await service.create('p', undefined, 'folder-a', ['s1'])
    const purposed = await service.send(created.id, '부팅·Training 확인')
    expect(purposed.evaluationIntent).toBe('부팅·Training 확인')
    await service.send(created.id, 'FAIL 근거를 확인해줘', ['s1'])
    await vi.waitFor(() => expect(updates.some((update) => update.status === 'running'
      && update.tools.some((tool) => tool.name === 'pass_fail_scan' && tool.summary === 'TEST_FAIL 2건'))).toBe(true))
    releaseAnswer()
    await vi.waitFor(async () => expect((await service.get(created.id))?.status).toBe('idle'))
    const completed = await service.get(created.id)
    expect(completed?.tools.filter((tool) => tool.name === 'pass_fail_scan' && tool.summary === 'TEST_FAIL 2건')).toHaveLength(1)
    expect(opencodeSend).toHaveBeenCalledWith(expect.objectContaining({ requiredToolNames: ['pass_fail_scan'] }))
  })
})
