import { describe, expect, it } from 'vitest'
import { EvaluationAgentService, type EvaluationAgentStoredSession } from './evaluation-agent-service'
import type { EngineerWorkflowMemoryView, ProjectSnapshot } from '../shared/contracts'

const project: ProjectSnapshot = { schemaVersion: 2, id: 'p1', name: 'p', revision: 1, archived: false, createdAt: '', updatedAt: '', folders: [], artifacts: [{ sourceId: 's1', rootId: 'r', artifactId: 'a1', relativePath: 'LPDDR_BL16_DQ8_CH0_TEMP85C_VDD1.1_DIAG.log' }], equipmentProfiles: [], templatePins: [], exportPresets: [] }
function setup(actions: string[], selectedProject: ProjectSnapshot = project, workflows: EngineerWorkflowMemoryView[] = []) {
  let i = 0; const prompts: string[] = []; const windows: number[] = []; const searches: number[] = []; const saved: string[] = []
  const service = new EvaluationAgentService({
    projects: { get: async (id) => id === 'p1' ? selectedProject : null },
    artifacts: { list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }], inspectStages: async () => ({ sources: [{ sourceId: 's1', artifactId: 'a1', stages: [{ stage: 'training', status: 'pass', evidenceCount: 1 }, { stage: 'test', status: 'fail', evidenceCount: 2 }] }] }), search: async (input) => { searches.push(input.maxMatches ?? 0); return { query: input.query, mode: 'literal', caseSensitive: false, matches: [{ artifactId: 'a1', fileName: 'x', lineNumber: 2, columnStart: 1, columnEnd: 4, lineText: 'FAIL token=secret /Users/private/log', lineTruncated: false, before: [], after: [] }], totalMatchCount: 1, truncated: false, files: [] } }, lineWindow: async (input) => { windows.push(input.lineCount ?? 0); return { artifactId: 'a1', startLine: 1, lines: Array.from({ length: input.lineCount ?? 0 }, (_, n) => ({ lineNumber: n + 1, text: n === 23 ? '/absolute/path/key=abc' : `line ${n}`, truncated: false })), hasMoreBefore: false, hasMoreAfter: true } } },
    llm: { complete: async (prompt) => { prompts.push(prompt); return { content: actions[i++] ?? '{"action":"complete"}', model: 'fake' } } },
    engineerMemory: { workflowMemories: async () => workflows },
    sessions: { save: async (record) => { saved.push(record.session.id) } }, id: () => 'session-1'
  })
  return { service, prompts, windows, searches, saved }
}
async function waitForStatus(service: EvaluationAgentService, sessionId: string, status: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const session = service.get(sessionId)
    if (session?.status === status) return session
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`session did not reach ${status}`)
}
describe('EvaluationAgentService', () => {
  it('rejects cross-project sources before accessing artifacts', async () => { const { service } = setup([]); await expect(service.start({ projectId: 'p1', sourceIds: ['other'] })).rejects.toThrow('not authorized') })
  it('returns a no-cost evaluation-purpose question before provider analysis', async () => {
    const { service, prompts } = setup(['{"action":"propose","outcome":"PASS","rationale":"confirmed"}'])
    const started = await service.start({ projectId: 'p1', sourceIds: ['s1'] })
    expect(started).toMatchObject({ status: 'waiting_question', question: { field: 'evaluationIntent' } })
    expect(prompts).toHaveLength(0)
    const resumed = await service.resume(started.id, { answer: '개선 효과 검증' })
    expect(['running', 'waiting_confirmation']).toContain(resumed.status)
    expect(await waitForStatus(service, started.id, 'waiting_confirmation')).toMatchObject({ proposal: { purpose: 'verification' } })
  })
  it('binds search/window to exact authorized artifact and does not leak paths or keys', async () => {
    const { service, prompts, windows, searches } = setup(['{"action":"search","fileId":"s1","query":"FAIL"}', '{"action":"window","fileId":"s1","startLine":1,"lineCount":500}', '{"action":"propose","outcome":"TEST_FAIL","rationale":"failure","evidenceIds":["search-1","window-2"]}'])
    const started = await service.start({ projectId: 'p1', sourceIds: ['s1'], intent: '불량 검출 가속 조건 확인' })
    expect(started.status).toBe('running')
    const result = await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(searches).toEqual([6]); expect(windows).toEqual([24])
    expect(prompts.join('\n')).not.toContain('/Users/private'); expect(prompts.join('\n')).not.toContain('key=abc')
    expect(prompts.join('\n')).toContain('test:fail(2)')
  })
  it('redacts credential-like filenames before prompt construction while retaining LPDDR dimensions', async () => {
    const credentialProject: ProjectSnapshot = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'run__token=abc123__api_key=z9__BL16_DQ8_CH0.log' }] }
    const { service, prompts } = setup(['{"action":"complete"}'], credentialProject)
    const started = await service.start({ projectId: 'p1', intent: '불량 경향 비교' })
    const result = await waitForStatus(service, started.id, 'waiting_confirmation')
    const prompt = prompts.join('\n')
    expect(prompt).not.toContain('abc123'); expect(prompt).not.toContain('z9')
    expect(result.files[0].metadata).toMatchObject({ bl: '16', dq: '8', channel: '0' })
    expect(result.files[0].name).not.toContain('abc123')
  })
  it('preserves compact LPDDR filename dimensions before provider analysis', async () => {
    const dimensionProject: ProjectSnapshot = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'LPDDR6_SM-8975_SKEW-SS_LOT-LA_DIE03_SMP-Q01_T25_VDD1p295_F9600_TM-HDIAG_PAT-ROW_HAMMER_DQ9_BL16_CH0.log' }] }
    const { service } = setup(['{"action":"complete"}'], dimensionProject)
    const started = await service.start({ projectId: 'p1', intent: '불량 경향 비교' })
    const result = await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(result.files[0].metadata).toMatchObject({
      skew: 'SS', lot: 'LA', die: '03', sample: 'Q01', temperatureC: 25,
      vdd: 1.295, frequencyMHz: 9600, testMode: 'HDIAG', pattern: 'ROW_HAMMER', dq: '9', bl: '16', channel: '0',
    })
  })
  it('classifies every selected log locally before accepting a folder-level LLM result', async () => {
    const mixedProject: ProjectSnapshot = {
      ...project,
      artifacts: [
        { sourceId: 'pass-source', rootId: 'mixed-root', artifactId: 'pass-artifact', relativePath: 'SMP-01_T25_TM-HDIAG_PASS.log' },
        { sourceId: 'halt-source', rootId: 'mixed-root', artifactId: 'halt-artifact', relativePath: 'SMP-02_T105_TM-RETENTION_HALT.log' },
      ],
    }
    const service = new EvaluationAgentService({
      projects: { get: async () => mixedProject },
      artifacts: {
        list: async () => mixedProject.artifacts.map((source) => ({ id: source.artifactId, sha256: source.artifactId, size: 10, extension: '.log', originalNames: [source.relativePath], importedAt: '', lastSeenAt: '', importCount: 1 })),
        inspectStages: async () => ({ sources: mixedProject.artifacts.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, stages: [] })) }),
        inspectEvidence: async (input) => ({ sources: input.sources.map((source) => ({
          sourceId: source.sourceId, artifactId: source.artifactId, fileName: `${source.sourceId}.log`,
          evidence: input.specs.map((spec) => ({
            specId: spec.id,
            occurrenceCount: source.sourceId === 'pass-source' && spec.id === 'at-pass'
              ? 1 : source.sourceId === 'halt-source' && spec.id === 'halt' ? 1 : 0,
          })),
        })) }),
        search: async () => ({ query: '', mode: 'literal', caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }),
        lineWindow: async () => ({ artifactId: '', startLine: 1, lines: [], hasMoreBefore: false, hasMoreAfter: false }),
      },
      llm: { complete: async () => ({ content: '{"action":"propose","outcome":"PASS","rationale":"representative passed"}', model: 'fake' }) },
      id: () => 'mixed-session',
    })
    const started = await service.start({ projectId: 'p1', intent: '불량 경향 비교' })
    const result = await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(result.proposal).toMatchObject({
      outcome: 'UNKNOWN',
      sourceAssessments: [
        { sourceId: 'pass-source', outcome: 'PASS' },
        { sourceId: 'halt-source', outcome: 'SYSTEM_HALT' },
      ],
    })
    expect(result.proposal?.rationale).toContain('PASS 1 · SYSTEM_HALT 1')
  })
  it('supplies bounded confirmed evaluation and Ctrl-F procedure context to the planner', async () => {
    const contextualProject: ProjectSnapshot = {
      ...project,
      failureHypotheses: [{ id: 'h-vperi', title: 'VPERI DQ9 반복 불량', origin: 'engineer-confirmed', evaluationNodeIds: ['n-old', 'n-improve'] }],
      evaluationNodes: [
        { id: 'n-old', hypothesisId: 'h-vperi', evaluationScopeId: 'old-root', name: '이전 VPERI 평가', purpose: 'screening', relation: 'baseline', status: 'fail', dimensions: { testMode: 'VPERI', dq: '9' }, interpretation: 'DQ9에서 실패 집중', reviewState: 'confirmed' },
        { id: 'n-improve', hypothesisId: 'h-vperi', parentId: 'n-old', evaluationScopeId: 'improve-root', name: 'VDD 개선 평가', purpose: 'improvement', relation: 'improvement', status: 'pass', dimensions: { testMode: 'VPERI', dq: '9', vdd: 1.315 }, interpretation: 'VDD 상향 후 PASS', reviewState: 'confirmed' },
      ],
    }
    const workflow: EngineerWorkflowMemoryView = {
      id: 'w-old', projectId: 'p1', evaluationScopeId: 'old-root', name: 'VPERI 판정', purpose: 'VPERI 불량 검출', stages: ['uefi', 'memory-test'],
      checks: [{ query: '@PASS', mode: 'literal', caseSensitive: false, expected: 'present', matchCount: 1, stage: 'memory-test', order: 1 }],
      result: 'PASS', sourceIds: ['old-source'], evidenceLines: [], dimensions: { testMode: 'VPERI' }, confirmedCount: 1, appliedCount: 2, createdAt: '', updatedAt: '',
    }
    const { service, prompts } = setup(['{"action":"complete"}'], contextualProject, [workflow])
    const started = await service.start({ projectId: 'p1', sourceIds: ['s1'], intent: '개선 조건 검증' })
    await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(prompts.join('\n')).toContain('DQ9에서 실패 집중')
    expect(prompts.join('\n')).toContain('VPERI DQ9 반복 불량')
    expect(prompts.join('\n')).toContain('improvement')
    expect(prompts.join('\n')).toContain('이전 VPERI 평가')
    expect(prompts.join('\n')).toContain('@PASS')
    expect(prompts.join('\n')).toContain('confirmedSearchProcedures')
  })
  it('retains sessions through resume and supplies confirmed memory payloads', async () => {
    const { service, saved } = setup(['{"action":"ask","dimension":"testMode","impact":"high","question":"mode?"}', '{"action":"propose","outcome":"PASS","rationale":"ok"}'])
    const started = await service.start({ projectId: 'p1', intent: '메모리 테스트 확인' })
    await waitForStatus(service, started.id, 'waiting_question')
    const resumed = await service.resume(started.id, { answer: 'READ' }); expect(resumed.status).toBe('running')
    const proposed = await waitForStatus(service, started.id, 'waiting_confirmation'); expect(proposed.status).toBe('waiting_confirmation')
    await service.resume(started.id, { confirm: 'accept' }); expect(saved.length).toBeGreaterThanOrEqual(5)
    expect(service.memorySavePayload(started.id, { projectId: 'p1', hypothesisId: 'h', nodeId: 'n', evidenceId: (id) => `e-${id}` })?.node.projectId).toBe('p1')
    expect(() => service.memorySavePayload(started.id, { projectId: 'other-project', hypothesisId: 'h', nodeId: 'n', evidenceId: (id) => `e-${id}` })).toThrow('project scope mismatch')
  })

  it('returns a running session before a slow provider responds', async () => {
    let release!: (value: { content: string; model: string }) => void
    const waiting = new Promise<{ content: string; model: string }>((resolve) => { release = resolve })
    const service = new EvaluationAgentService({
      projects: { get: async () => project },
      artifacts: { list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }], search: async () => ({ query: '', mode: 'literal', caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }), lineWindow: async () => ({ artifactId: 'a1', startLine: 1, lines: [], hasMoreBefore: false, hasMoreAfter: false }) },
      llm: { complete: async () => waiting }, id: () => 'slow-session',
    })
    const started = await service.start({ projectId: 'p1', intent: '메모리 테스트 확인' })
    expect(started.status).toBe('running')
    expect(service.get(started.id)?.context.lastProviderState).toBe('waiting for provider')
    release({ content: '{"action":"complete"}', model: 'slow' })
    await waitForStatus(service, started.id, 'waiting_confirmation')
  })

  it('restores a question session only after re-authorizing its project folder sources', async () => {
    let stored: EvaluationAgentStoredSession | null = null
    const artifacts = {
      list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }],
      search: async () => ({ query: '', mode: 'literal' as const, caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }),
      lineWindow: async () => ({ artifactId: 'a1', startLine: 1, lines: [], hasMoreBefore: false, hasMoreAfter: false }),
    }
    const first = new EvaluationAgentService({
      projects: { get: async () => project }, artifacts,
      llm: { complete: async () => ({ content: '{"action":"ask","dimension":"testMode","impact":"high","question":"mode?"}', model: 'fake' }) },
      sessions: { save: async (record) => { stored = structuredClone(record) } }, id: () => 'restorable',
    })
    await first.start({ projectId: 'p1', sourceIds: ['s1'], intent: '메모리 테스트 확인' })
    await waitForStatus(first, 'restorable', 'waiting_question')
    for (let attempt = 0; attempt < 50 && (stored as EvaluationAgentStoredSession | null)?.session.status !== 'waiting_question'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect((stored as EvaluationAgentStoredSession | null)?.session.status).toBe('waiting_question')
    const reopened = new EvaluationAgentService({
      projects: { get: async () => project }, artifacts,
      llm: { complete: async () => ({ content: '{"action":"propose","outcome":"PASS","rationale":"confirmed"}', model: 'fake' }) },
      sessions: { latest: async () => stored, load: async () => stored },
    })
    const restored = await reopened.restoreLatest('p1', 'r')
    expect(restored).toMatchObject({ id: 'restorable', status: 'waiting_question' })
    await reopened.resume('restorable', { answer: 'HDIAG' })
    expect(await waitForStatus(reopened, 'restorable', 'waiting_confirmation')).toMatchObject({ proposal: { outcome: 'PASS' } })
  })

  it('keeps the project evaluation folder id while using a separate physical artifact root', async () => {
    const splitRoots: ProjectSnapshot = {
      ...project,
      artifacts: [{ ...project.artifacts[0], rootId: 'evaluation-folder', artifactRootId: 'physical-import-root' }],
    }
    let stored: EvaluationAgentStoredSession | null = null
    const inspectedRoots: string[] = []
    const service = new EvaluationAgentService({
      projects: { get: async () => splitRoots },
      artifacts: {
        list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }],
        inspectStages: async (input) => {
          inspectedRoots.push(...input.sources.map((source) => source.rootId ?? ''))
          return { sources: input.sources.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, stages: [] })) }
        },
        search: async () => ({ query: '', mode: 'literal', caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }),
        lineWindow: async () => ({ artifactId: 'a1', startLine: 1, lines: [], hasMoreBefore: false, hasMoreAfter: false }),
      },
      llm: { complete: async () => ({ content: '{"action":"complete"}', model: 'fake' }) },
      sessions: { save: async (record) => { stored = structuredClone(record) } },
      id: () => 'split-root-session',
    })
    const started = await service.start({ projectId: 'p1', sourceIds: ['s1'], intent: '불량 경향 비교' })
    await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(inspectedRoots).toEqual(['physical-import-root'])
    expect((stored as EvaluationAgentStoredSession | null)?.evaluationScopeId).toBe('evaluation-folder')
  })
})
