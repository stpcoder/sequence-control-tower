import { describe, expect, it } from 'vitest'
import { AgentService } from './agent-service'
import type { ArtifactRecord, ProjectSnapshot } from '../shared/contracts'

const project: ProjectSnapshot = {
  schemaVersion: 2, id: 'p1', name: 'test', revision: 7, archived: false, createdAt: '', updatedAt: '', folders: [],
  artifacts: [{ sourceId: 's1', rootId: 'r1', artifactId: 'a1', relativePath: 'QBR-001__TEMP=85C__MODE=DIAG.log' }],
  equipmentProfiles: [], templatePins: [], exportPresets: [], onboardingAnswers: { evaluationTarget: 'result' }
}
const artifact: ArtifactRecord = { id: 'a1', sha256: 'a'.repeat(64), size: 100, extension: '.log', originalNames: ['QBR-001__TEMP=85C__MODE=DIAG.log'], importedAt: '', lastSeenAt: '', importCount: 1 }

function setup(actions: string[], lineCount = 1) {
  let calls = 0
  const llm = { complete: async (prompt: string) => { calls += 1; expect(prompt.length).toBeLessThanOrEqual(8000); return { content: actions[Math.min(calls - 1, actions.length - 1)], model: 'test' } } }
  const service = new AgentService({
    projects: { get: async () => project }, artifacts: {
      list: async () => [artifact],
      search: async () => ({ query: 'x', mode: 'literal', caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }),
      lineWindow: async () => ({ artifactId: 'a1', startLine: 1, lines: Array.from({ length: lineCount }, (_, i) => ({ lineNumber: i + 1, text: `line-${i + 1}`, truncated: false })), hasMoreBefore: false, hasMoreAfter: false })
    },
    evaluations: { saveDecision: async (input: never) => ({ snapshot: {} as never, decision: input as never }), approveMetadata: async (input: never) => ({ snapshot: {} as never, metadataApproval: input as never }), saveRecipe: async (input: never) => ({ snapshot: {} as never, recipe: input as never }) },
    llm
  })
  return { service, getCalls: () => calls }
}
async function until(service: AgentService, id: string, state: string): Promise<ReturnType<AgentService['get']>> {
  for (let i = 0; i < 100; i += 1) { const run = service.get(id); if (run?.state === state || run?.status === 'failed') return run; await new Promise((resolve) => setTimeout(resolve, 1)) }
  return service.get(id)
}

describe('AgentService', () => {
  it('uses onboarding and basename metadata, then stops at explicit human confirm', async () => {
    const { service } = setup(['{"action":"summary"}'])
    const started = await service.start({ projectId: 'p1' })
    const run = await until(service, started.id, 'HUMAN_CONFIRM')
    expect(run?.state).toBe('HUMAN_CONFIRM')
    expect(run?.candidate?.result).toBe('UNKNOWN')
  })

  it('rejects repeated overlapping windows and fails closed with UNKNOWN', async () => {
    const { service } = setup([
      '{"action":"lineWindow","input":{"sourceId":"s1","startLine":1,"lineCount":20,"observationId":"w1"}}',
      '{"action":"lineWindow","input":{"sourceId":"s1","startLine":10,"lineCount":20,"observationId":"w2"}}'
    ])
    const started = await service.start({ projectId: 'p1' })
    const run = await until(service, started.id, 'FAILED')
    expect(run?.status).toBe('failed'); expect(run?.candidate?.result).toBe('UNKNOWN'); expect(run?.needsReview).toBe(true)
  })

  it('does not put a 6500-line response into the LLM transport prompt', async () => {
    const { service, getCalls } = setup([
      '{"action":"lineWindow","input":{"sourceId":"s1","startLine":1,"lineCount":20,"observationId":"w1"}}',
      '{"action":"candidate","candidate":{"kind":"result","result":"PASS","status":"candidate","observationIds":["w1"]}}'
    ], 6500)
    const started = await service.start({ projectId: 'p1' })
    const run = await until(service, started.id, 'HUMAN_CONFIRM')
    expect(getCalls()).toBe(2); expect(run?.state).toBe('HUMAN_CONFIRM')
  })

  it('cancels a slow completion and ignores stale completion', async () => {
    let resolve!: (value: { content: string; model: string }) => void
    const { service } = setup(['{"action":"summary"}'])
    const slow = new AgentService({
      projects: { get: async () => project }, artifacts: { list: async () => [artifact], search: async () => ({ query: '', mode: 'literal', caseSensitive: false, matches: [], totalMatchCount: 0, truncated: false, files: [] }), lineWindow: async () => ({ artifactId: 'a1', startLine: 1, lines: [], hasMoreBefore: false, hasMoreAfter: false }) },
      evaluations: { saveDecision: async (input: never) => ({ snapshot: {} as never, decision: input as never }), approveMetadata: async (input: never) => ({ snapshot: {} as never, metadataApproval: input as never }), saveRecipe: async (input: never) => ({ snapshot: {} as never, recipe: input as never }) },
      llm: { complete: async () => new Promise((r) => { resolve = r }) }
    })
    void service
    const started = await slow.start({ projectId: 'p1' }); await new Promise((r) => setTimeout(r, 2)); await slow.cancel({ runId: started.id }); resolve({ content: '{"action":"summary"}', model: 'test' }); await new Promise((r) => setTimeout(r, 2))
    expect(slow.get(started.id)?.state).toBe('CANCELLED')
  })
})
