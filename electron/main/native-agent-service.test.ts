import { describe, expect, it, vi } from 'vitest'
import { NativeAgentService, planLpddrTools } from './native-agent-service'

describe('planLpddrTools', () => {
  it('routes an evaluation-context question to bounded evidence tools', () => {
    const names = planLpddrTools('새 로그의 온도와 VDD, DQ별 불량률을 보고 과거 LPDDR5 유사 사례와 다음 평가를 추천해줘').map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['project_context_get', 'project_history_get', 'filename_dimensions_scan', 'pass_fail_scan', 'engineer_workflow_apply', 'failure_trends_get', 'similar_case_search']))
    expect(names.length).toBeLessThanOrEqual(7)
  })

  it('loads confirmed engineer procedures when evaluation purpose or search behavior matters', () => {
    const names = planLpddrTools('이 로그는 어떤 평가이고 예전에 Ctrl-F로 확인한 순서를 어떻게 적용해야 해?').map((item) => item.name)
    expect(names).toContain('engineer_workflow_memory_get')
    expect(names.length).toBeLessThanOrEqual(7)
  })

  it('binds workflow learning to an exact project source and parses only filename dimensions', async () => {
    const completeEvaluation = vi.fn(async () => ({ kind: 'ignored' as const }))
    const service = new NativeAgentService({
      store: { completeEvaluation },
      projects: { get: vi.fn(async (id: string) => id === 'p' ? {
        id: 'p', artifacts: [{ sourceId: 's1', relativePath: 'LPDDR6_T85_VDD1p295_DQ9.log' }],
      } : null) },
    } as never)
    await expect(service.completeEvaluation({ projectId: 'p', sourceId: 's1', result: 'PASS', evidenceLines: [8] })).resolves.toEqual({ kind: 'ignored' })
    expect(completeEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p', sourceId: 's1', result: 'PASS', evidenceLines: [8],
      dimensions: expect.objectContaining({ temperatureC: 85, vdd: 1.295, dq: '9' }),
    }))
    await expect(service.completeEvaluation({ projectId: 'p', sourceId: 'other', result: 'PASS' })).rejects.toThrow('프로젝트 범위')
  })
})
