import { describe, expect, it } from 'vitest'
import { EvaluationAgentService } from './evaluation-agent-service'
import type { ProjectSnapshot } from '../shared/contracts'

const project: ProjectSnapshot = { schemaVersion: 2, id: 'p1', name: 'p', revision: 1, archived: false, createdAt: '', updatedAt: '', folders: [], artifacts: [{ sourceId: 's1', rootId: 'r', artifactId: 'a1', relativePath: 'LPDDR_BL16_DQ8_CH0_TEMP85C_VDD1.1_DIAG.log' }], equipmentProfiles: [], templatePins: [], exportPresets: [] }
function setup(actions: string[], selectedProject: ProjectSnapshot = project) {
  let i = 0; const prompts: string[] = []; const windows: number[] = []; const searches: number[] = []; const saved: string[] = []
  const service = new EvaluationAgentService({
    projects: { get: async (id) => id === 'p1' ? selectedProject : null },
    artifacts: { list: async () => [{ id: 'a1', sha256: 'x', size: 10, extension: '.log', originalNames: ['x'], importedAt: '', lastSeenAt: '', importCount: 1 }], search: async (input) => { searches.push(input.maxMatches ?? 0); return { query: input.query, mode: 'literal', caseSensitive: false, matches: [{ artifactId: 'a1', fileName: 'x', lineNumber: 2, columnStart: 1, columnEnd: 4, lineText: 'FAIL token=secret /Users/private/log', lineTruncated: false, before: [], after: [] }], totalMatchCount: 1, truncated: false, files: [] } }, lineWindow: async (input) => { windows.push(input.lineCount ?? 0); return { artifactId: 'a1', startLine: 1, lines: Array.from({ length: input.lineCount ?? 0 }, (_, n) => ({ lineNumber: n + 1, text: n === 23 ? '/absolute/path/key=abc' : `line ${n}`, truncated: false })), hasMoreBefore: false, hasMoreAfter: true } } },
    llm: { complete: async (prompt) => { prompts.push(prompt); return { content: actions[i++] ?? '{"action":"complete"}', model: 'fake' } } }, sessions: { save: async (session) => { saved.push(session.id) } }, id: () => 'session-1'
  })
  return { service, prompts, windows, searches, saved }
}
describe('EvaluationAgentService', () => {
  it('rejects cross-project sources before accessing artifacts', async () => { const { service } = setup([]); await expect(service.start({ projectId: 'p1', sourceIds: ['other'] })).rejects.toThrow('not authorized') })
  it('binds search/window to exact authorized artifact and does not leak paths or keys', async () => {
    const { service, prompts, windows, searches } = setup(['{"action":"search","fileId":"s1","query":"FAIL"}', '{"action":"window","fileId":"s1","startLine":1,"lineCount":500}', '{"action":"propose","outcome":"FAIL","rationale":"failure","evidenceIds":["search-1","window-2"]}'])
    const result = await service.start({ projectId: 'p1', sourceIds: ['s1'] })
    expect(result.status).toBe('waiting_confirmation'); expect(searches).toEqual([6]); expect(windows).toEqual([24])
    expect(prompts.join('\n')).not.toContain('/Users/private'); expect(prompts.join('\n')).not.toContain('key=abc')
  })
  it('redacts credential-like filenames before prompt construction while retaining LPDDR dimensions', async () => {
    const credentialProject: ProjectSnapshot = { ...project, artifacts: [{ ...project.artifacts[0], relativePath: 'run__token=abc123__api_key=z9__BL16_DQ8_CH0.log' }] }
    const { service, prompts } = setup(['{"action":"complete"}'], credentialProject)
    const result = await service.start({ projectId: 'p1' })
    const prompt = prompts.join('\n')
    expect(prompt).not.toContain('abc123'); expect(prompt).not.toContain('z9')
    expect(result.files[0].metadata).toMatchObject({ bl: '16', dq: '8', channel: '0' })
    expect(result.files[0].name).not.toContain('abc123')
  })
  it('retains sessions through resume and supplies confirmed memory payloads', async () => {
    const { service, saved } = setup(['{"action":"ask","dimension":"testMode","impact":"high","question":"mode?"}', '{"action":"propose","outcome":"PASS","rationale":"ok"}'])
    const started = await service.start({ projectId: 'p1' }); expect(service.get(started.id)?.status).toBe('waiting_question')
    const proposed = await service.resume(started.id, { answer: 'READ' }); expect(proposed.status).toBe('waiting_confirmation')
    await service.resume(started.id, { confirm: 'accept' }); expect(saved.length).toBe(3)
    expect(service.memorySavePayload(started.id, { projectId: 'p1', hypothesisId: 'h', nodeId: 'n', evidenceId: (id) => `e-${id}` })?.node.projectId).toBe('p1')
    expect(() => service.memorySavePayload(started.id, { projectId: 'other-project', hypothesisId: 'h', nodeId: 'n', evidenceId: (id) => `e-${id}` })).toThrow('project scope mismatch')
  })
})
