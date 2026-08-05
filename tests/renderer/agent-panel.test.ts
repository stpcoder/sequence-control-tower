import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildAgentDecisionInput, isAgentRunPending, shouldAcceptAgentRun } from '../../src/components/AgentPanel'
import type { AgentRun, EvaluationProjectSnapshot, ProjectSnapshot } from '../../electron/shared/contracts'
import type { WorkbenchFile } from '../../src/views/WorkbenchView'

const project = {
  id: 'project-1', name: '검증 프로젝트', artifacts: [{ sourceId: 'project-source-1', rootId: 'root-1', artifactId: 'artifact-1', relativePath: 'logs/sample.log' }],
} as ProjectSnapshot
const file = { id: 'renderer-row-1', name: 'sample.log', artifactId: 'artifact-1', rootId: 'root-1', relativePath: 'logs\\sample.log', sourceKey: 'root:root-1\\u001flogs/sample.log' } as WorkbenchFile
const snapshot = { revision: 7 } as EvaluationProjectSnapshot

function projectWithArtifacts(artifacts: ProjectSnapshot['artifacts']): ProjectSnapshot {
  return { ...project, artifacts }
}

function run(id: string, projectId = 'project-1'): AgentRun {
  return { id, projectId, status: 'running', stage: 'plan', completionCount: 0, toolCount: 0, searchCount: 0, lineWindowCount: 0, promptChars: 0, startedAt: '', updatedAt: '' }
}

describe('mini agent domain safety', () => {
  it('maps an exact project source and only a known result for confirmation', () => {
    expect(buildAgentDecisionInput(project, file, snapshot, 'PASS')).toMatchObject({
      projectId: 'project-1', expectedRevision: 7, source: { sourceId: 'project-source-1', artifactId: 'artifact-1' }, result: 'PASS',
    })
    expect(buildAgentDecisionInput(null, file, snapshot, 'PASS')).toBeNull()
    expect(buildAgentDecisionInput(project, undefined, snapshot, 'PASS')).toBeNull()
    expect(buildAgentDecisionInput(project, file, snapshot, 'UNKNOWN')).toBeNull()
    expect(buildAgentDecisionInput(project, file, snapshot, 'NOT_A_RESULT' as never)).toBeNull()
  })

  it('falls back to a unique project artifact when row location metadata is absent', () => {
    const selected = { ...file, rootId: undefined, relativePath: undefined }
    expect(buildAgentDecisionInput(project, selected, snapshot, 'PASS')?.source.sourceId).toBe('project-source-1')
  })

  it('fails closed when the same artifact belongs to multiple project sources', () => {
    const duplicated = projectWithArtifacts([
      project.artifacts[0],
      { sourceId: 'project-source-2', rootId: 'root-2', artifactId: 'artifact-1', relativePath: 'other/sample.log' },
    ])
    expect(buildAgentDecisionInput(duplicated, { ...file, rootId: undefined, relativePath: undefined }, snapshot, 'PASS')).toBeNull()
  })

  it('fails closed when the selected artifact is missing from the project', () => {
    expect(buildAgentDecisionInput(projectWithArtifacts([]), file, snapshot, 'PASS')).toBeNull()
  })

  it('only treats active tool or LLM work as pending', () => {
    const candidate = { kind: 'result' as const, result: 'PASS' as const, status: 'candidate' as const, observationIds: [] }
    expect(isAgentRunPending(run('queued'))).toBe(true)
    expect(isAgentRunPending(run('running'))).toBe(true)
    expect(isAgentRunPending({ ...run('complete'), stage: 'complete' })).toBe(false)
    expect(isAgentRunPending({ ...run('human-confirm'), stage: 'complete', state: 'HUMAN_CONFIRM', candidate })).toBe(false)
    expect(isAgentRunPending({ ...run('candidate'), candidate })).toBe(false)
    expect(isAgentRunPending({ ...run('question'), question: { id: 'q1', kind: 'clarification', prompt: '확인해 주세요.' } })).toBe(false)
  })

  it('ignores stale and cross-project run updates', () => {
    expect(shouldAcceptAgentRun(run('active'), 'active', 'project-1')).toBe(true)
    expect(shouldAcceptAgentRun(run('old'), 'active', 'project-1')).toBe(false)
    expect(shouldAcceptAgentRun(run('active', 'project-2'), 'active', 'project-1')).toBe(false)
    expect(shouldAcceptAgentRun(run('active'), null, 'project-1')).toBe(false)
  })

  it('does not contain the removed demo conversation or cache labels', () => {
    const source = readFileSync(new URL('../../src/components/AgentPanel.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('SEQ-1054')
    expect(source).not.toContain('CLK boundary')
    expect(source).not.toContain('cache hit')
    expect(source).toContain('확인하고 저장')
  })
})
