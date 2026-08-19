import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAgentService } from './native-agent-service'
import { NativeAgentStore } from './native-agent-store'
import type { NativeAgentSessionView } from '../shared/contracts'

const project = {
  id: 'persona-project', name: 'LPDDR6 고객 평가', artifacts: [
    { sourceId: 'qc-1', rootId: 'qc-training', artifactId: 'a-qc', relativePath: 'SM-8975_SS_T25_NVDD_9600MHz.log' },
    { sourceId: 'mtk-1', rootId: 'mtk-reboot', artifactId: 'a-mtk', relativePath: 'MTK-24D_SF_RT2.log' },
    { sourceId: 'corner-1', rootId: 'four-corner', artifactId: 'a-c1', relativePath: 'SMP-01_SS_HH_9600MHz.log' },
    { sourceId: 'corner-2', rootId: 'four-corner', artifactId: 'a-c2', relativePath: 'SMP-01_SS_CL_9600MHz.log' },
  ],
  evaluationNodes: [
    { id: 'n-qc', evaluationScopeId: 'qc-training', name: 'QC Training 확인', purpose: 'stage-verification', reviewState: 'confirmed', dimensions: {} },
    { id: 'n-mtk', evaluationScopeId: 'mtk-reboot', name: 'MTK Reboot 재현', purpose: 'reproduction', reviewState: 'confirmed', dimensions: {} },
    { id: 'n-corner', evaluationScopeId: 'four-corner', name: '4-Corner 가속 조건', purpose: 'characterization', reviewState: 'confirmed', dimensions: {} },
  ],
}

function waitFor(
  service: NativeAgentService,
  sessionId: string,
  status: NativeAgentSessionView['status'],
): Promise<NativeAgentSessionView> {
  return new Promise((resolve) => {
    const unsubscribe = service.onUpdate((session) => {
      if (session.id === sessionId && session.status === status) {
        unsubscribe()
        resolve(session)
      }
    })
  })
}

async function harness(responses: Array<{ content: string } | Error>) {
  const store = new NativeAgentStore(await mkdtemp(join(tmpdir(), 'native-personas-')))
  const execute = vi.fn(async (_projectId: string, call: { name: string }, sourceIds: string[]) => ({
    name: call.name,
    label: call.name,
    summary: `${call.name} 완료`,
    data: call.name === 'filename_dimensions_scan'
      ? { rows: sourceIds.map((sourceId) => ({
          sourceId,
          commandSignatures: ['diagnostic:hdiag'],
          dimensions: sourceId.startsWith('mtk')
            ? { socVendor: 'mediatek', socModel: 'MTK-24D', bootProfileId: 'mediatek-default' }
            : { socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default' },
        })) }
      : call.name === 'engineer_workflow_memory_get' ? { confirmed: [] }
        : call.name === 'console_transcript_scan' ? { ambiguous: [] }
          : call.name === 'failure_trends_get' ? { denominators: { decided: sourceIds.length }, rows: [] }
            : {},
    evidenceSourceIds: sourceIds,
  }))
  const complete = vi.fn(async () => {
    const response = responses.shift() ?? { content: '근거 범위에서 확인했습니다.' }
    if (response instanceof Error) throw response
    return response
  })
  const service = new NativeAgentService({
    store,
    tools: { execute },
    projects: { get: vi.fn(async (id: string) => id === project.id ? project : null) },
    artifacts: { list: vi.fn(async () => []) },
    llm: { complete },
    opencode: { available: vi.fn(async () => false) },
  } as never)
  await service.initialize()
  return { service, store, execute, complete }
}

describe('Native Agent DRAM persona interactions', () => {
  it('keeps QC and MTK boot analysis in separate folder sessions and calls the correct tools', async () => {
    const { service, execute } = await harness([
      { content: 'QC Training은 UEFI 이전 근거를 기준으로 확인했습니다.' },
      { content: 'MTK는 LK와 LK2 이후 reboot marker를 기준으로 확인했습니다.' },
    ])

    const qc = await service.create(project.id, undefined, 'qc-training', ['qc-1'])
    execute.mockClear()
    const qcIdle = waitFor(service, qc.id, 'idle')
    await service.send(qc.id, 'SM-8975 QC에서 Training FAIL이 UEFI 이전인지 확인해줘', ['qc-1'], 'results')
    const qcResult = await qcIdle
    expect(qcResult.messages.at(-1)?.content).toContain('UEFI 이전')
    expect(execute.mock.calls.map((call) => call[1].name)).toEqual(expect.arrayContaining(['soc_boot_profile_scan', 'pass_fail_scan']))
    expect(execute.mock.calls.every((call) => JSON.stringify(call[2]) === JSON.stringify(['qc-1']))).toBe(true)

    const mtk = await service.create(project.id, undefined, 'mtk-reboot', ['mtk-1'])
    execute.mockClear()
    const mtkIdle = waitFor(service, mtk.id, 'idle')
    await service.send(mtk.id, 'MTK-24D LK, LK2, OS와 console 명령 뒤 SYSTEM_REBOOT를 확인해줘', ['mtk-1'], 'results')
    const mtkResult = await mtkIdle
    expect(mtkResult.id).not.toBe(qcResult.id)
    expect(mtkResult.messages.at(-1)?.content).toContain('LK2')
    expect(execute.mock.calls.map((call) => call[1].name)).toEqual(expect.arrayContaining([
      'soc_boot_profile_scan', 'console_transcript_scan', 'pass_fail_scan',
    ]))
    expect(execute.mock.calls.every((call) => JSON.stringify(call[2]) === JSON.stringify(['mtk-1']))).toBe(true)
    await expect(service.send(qc.id, '다른 폴더 로그를 섞어줘', ['mtk-1'])).rejects.toThrow('프로젝트 로그 범위')
  })

  it('turns a 4-Corner request into a reversible typed Results Summary proposal', async () => {
    const { service, execute } = await harness([{ content: '온도와 전압 조건을 비교합니다.\n<sct-analysis-view>{"dataBasis":"evaluation","rowAxes":["temperatureCorner"],"columnAxes":["vddCorner"],"aggregation":"fail_rate","visualization":"heatmap","rationale":"4-Corner별 판정 분모를 비교합니다."}</sct-analysis-view>' }])
    const session = await service.create(project.id, undefined, 'four-corner', ['corner-1', 'corner-2'])
    execute.mockClear()
    const idle = waitFor(service, session.id, 'idle')
    await service.send(session.id, '[SCT_ANALYSIS_VIEW_CONTEXT]\n같은 Sample의 4-Corner Grid 불량률을 보여줘', ['corner-1', 'corner-2'], 'analysis_view')
    const result = await idle
    expect(execute.mock.calls.map((call) => call[1].name)).toEqual(expect.arrayContaining([
      'evaluation_grid_scan', 'pass_fail_scan', 'failure_trends_get',
    ]))
    expect(result.analysisViewProposal).toMatchObject({
      dataBasis: 'evaluation', rowAxes: ['temperatureCorner'], columnAxes: ['vddCorner'],
      aggregation: 'fail_rate', visualization: 'heatmap',
    })
    expect(result.messages.at(-1)?.content).not.toContain('sct-analysis-view')
    expect(result.lastContextKind).toBe('analysis_view')
  })

  it('preserves the same request and session when a slow LLM is retried', async () => {
    const { service } = await harness([
      new Error('LLM_REQUEST_TIMEOUT'),
      { content: '재시도 후에도 같은 QC 평가 폴더의 근거로 답했습니다.' },
    ])
    const session = await service.create(project.id, undefined, 'qc-training', ['qc-1'])
    const paused = waitFor(service, session.id, 'paused')
    await service.send(session.id, 'QC Training FAIL 근거를 다시 확인해줘', ['qc-1'], 'results')
    const first = await paused
    expect(first.failure).toContain('사내 LLM 응답이 늦거나')
    expect(first.messages.at(-1)?.content).toContain('로컬에서 계산된 값')

    const idle = waitFor(service, session.id, 'idle')
    await service.retry(session.id)
    const recovered = await idle
    expect(recovered.id).toBe(session.id)
    expect(recovered.evaluationScopeId).toBe('qc-training')
    expect(recovered.lastContextKind).toBe('results')
    expect(recovered.messages.at(-1)?.content).toContain('같은 QC 평가 폴더')
  })
})
