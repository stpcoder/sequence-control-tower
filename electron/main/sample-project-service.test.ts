import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ArtifactService } from './artifact-service'
import { ProjectStore } from './project-store'
import { SampleProjectService } from './sample-project-service'

describe('SampleProjectService', () => {
  it('creates a usable LPDDR6 project with logs, branches and an archived LPDDR5 reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-sample-'))
    const artifacts = new ArtifactService(root); const projects = new ProjectStore(root)
    await Promise.all([artifacts.initialize(), projects.initialize()])
    const result = await new SampleProjectService(root, { artifacts, projects }).create()
    expect(result.project.lpddrDevelopmentContext).toMatchObject({ product: 'LPDDR6', customer: 'Xiaomi', densityGb: 16 })
    expect(result.project.artifacts).toHaveLength(8)
    expect(result.project.evaluationNodes).toHaveLength(3)
    expect(result.project.evidenceRecords?.find((item) => item.id === 'sample-e-screen-fail')?.sourceIds).toHaveLength(2)
    const all = await projects.list(true)
    expect(all.some((item) => item.archived && item.lpddrDevelopmentContext?.product === 'LPDDR5')).toBe(true)
  })
})
