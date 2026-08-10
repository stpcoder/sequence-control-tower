import { describe, expect, it } from 'vitest'
import { EvaluationAgentService } from './evaluation-agent-service'
import type { ProjectSnapshot } from '../shared/contracts'

const project: ProjectSnapshot = { schemaVersion: 2, id: 'p1', name: 'p', revision: 1, archived: false, createdAt: '', updatedAt: '', folders: [], artifacts: [{ sourceId: 's1', rootId: 'r', artifactId: 'a1', relativePath: 'LPDDR_BL16_DQ8_CH0_TEMP85C_VDD1.1_DIAG.log' }], equipmentProfiles: [], templatePins: [], exportPresets: [] }
function setup(actions: string[], selectedProject: ProjectSnapshot = project) {
  let i = 0; const prompts: string[] = []; const windows: number[] = []; const searches: number[] = []; const saved: string[] = []
  const service = new EvaluationAgentService({
    projects: { get: async (id) => id === 'p1' ? selectedProject : null },
    artifacts: { list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }], inspectStages: async () => ({ sources: [{ sourceId: 's1', artifactId: 'a1', stages: [{ stage: 'training', status: 'pass', evidenceCount: 1 }, { stage: 'test', status: 'fail', evidenceCount: 2 }] }] }), search: async (input) => { searches.push(input.maxMatches ?? 0); return { query: input.query, mode: 'literal', caseSensitive: false, matches: [{ artifactId: 'a1', fileName: 'x', lineNumber: 2, columnStart: 1, columnEnd: 4, lineText: 'FAIL token=secret /Users/private/log', lineTruncated: false, before: [], after: [] }], totalMatchCount: 1, truncated: false, files: [] } }, lineWindow: async (input) => { windows.push(input.lineCount ?? 0); return { artifactId: 'a1', startLine: 1, lines: Array.from({ length: input.lineCount ?? 0 }, (_, n) => ({ lineNumber: n + 1, text: n === 23 ? '/absolute/path/key=abc' : `line ${n}`, truncated: false })), hasMoreBefore: false, hasMoreAfter: true } } },
    llm: { complete: async (prompt) => { prompts.push(prompt); return { content: actions[i++] ?? '{"action":"complete"}', model: 'fake' } } }, sessions: { save: async (session) => { saved.push(session.id) } }, id: () => 'session-1'
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
  it('binds search/window to exact authorized artifact and does not leak paths or keys', async () => {
    const { service, prompts, windows, searches } = setup(['{"action":"search","fileId":"s1","query":"FAIL"}', '{"action":"window","fileId":"s1","startLine":1,"lineCount":500}', '{"action":"propose","outcome":"TEST_FAIL","rationale":"failure","evidenceIds":["search-1","window-2"]}'])
    const started = await service.start({ projectId: 'p1', sourceIds: ['s1'] })
    expect(started.status).toBe('running')
    const result = await waitForStatus(service, started.id, 'waiting_confirmation')
    expect(searches).toEqual([6]); expect(windows).toEqual([24])
    expect(prompts.join('\n')).not.toContain('/Users/private'); expect(prompts.join('\n')).not.toContain('key=abc')
    expect(prompts.join('\n')).toContain('test:fail(2)')
  })
  it('redacts credential-like filenames before prompt construction while retaining LPDDR dimensions', async () => {
    const credentialProject: ProjectSnapshot = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'run__token=abc123__api_key=z9__BL16_DQ8_CH0.log' }] }
    const { service, prompts } = setup(['{"action":"complete"}'], credentialProject)
    const started = await service.start({ projectId: 'p1' })
    const result = await waitForStatus(service, started.id, 'completed')
    const prompt = prompts.join('\n')
    expect(prompt).not.toContain('abc123'); expect(prompt).not.toContain('z9')
    expect(result.files[0].metadata).toMatchObject({ bl: '16', dq: '8', channel: '0' })
    expect(result.files[0].name).not.toContain('abc123')
  })
  it('preserves compact LPDDR filename dimensions before provider analysis', async () => {
    const dimensionProject: ProjectSnapshot = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'LPDDR6_SM-8975_SKEW-SS_LOT-LA_DIE03_SMP-Q01_T25_VDD1p295_F9600_TM-HDIAG_PAT-ROW_HAMMER_DQ9_BL16_CH0.log' }] }
    const { service } = setup(['{"action":"complete"}'], dimensionProject)
    const started = await service.start({ projectId: 'p1' })
    const result = await waitForStatus(service, started.id, 'completed')
    expect(result.files[0].metadata).toMatchObject({
      skew: 'SS', lot: 'LA', die: '03', sample: 'Q01', temperatureC: 25,
      vdd: 1.295, frequencyMHz: 9600, testMode: 'HDIAG', pattern: 'ROW_HAMMER', dq: '9', bl: '16', channel: '0',
    })
  })
  it('retains sessions through resume and supplies confirmed memory payloads', async () => {
    const { service, saved } = setup(['{"action":"ask","dimension":"testMode","impact":"high","question":"mode?"}', '{"action":"propose","outcome":"PASS","rationale":"ok"}'])
    const started = await service.start({ projectId: 'p1' })
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
    const started = await service.start({ projectId: 'p1' })
    expect(started.status).toBe('running')
    expect(service.get(started.id)?.context.lastProviderState).toBe('waiting for provider')
    release({ content: '{"action":"complete"}', model: 'slow' })
    await waitForStatus(service, started.id, 'completed')
  })
})
