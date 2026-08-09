import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ArtifactService } from './artifact-service'
import { ProjectStore } from './project-store'
import { SampleProjectService } from './sample-project-service'
import { sourceEngineeringContext } from './lpddr-agent-tools'

describe('SampleProjectService', () => {
  it('creates a usable LPDDR6 project with logs, branches and an archived LPDDR5 reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-sample-'))
    const artifacts = new ArtifactService(root); const projects = new ProjectStore(root)
    await Promise.all([artifacts.initialize(), projects.initialize()])
    const result = await new SampleProjectService(root, { artifacts, projects }).create()
    expect(result.project.lpddrDevelopmentContext).toMatchObject({ product: 'LPDDR6', customer: 'Xiaomi', densityGb: 16 })
    expect(result.project.artifacts).toHaveLength(9)
    expect(result.project.evaluationNodes).toHaveLength(4)
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-screen-rt2')).toMatchObject({ retestOf: 'sample-n-screen', attemptNo: 2 })
    expect(result.project.equipmentProfiles[0]).toMatchObject({ profileId: 'qualcomm-default', socModels: ['SM-8975'] })
    const allArtifacts = new Map((await artifacts.list()).map((artifact) => [artifact.id, artifact]))
    const initial = result.project.artifacts.find((item) => item.relativePath.includes('SMP-01_T85_VDD1p295') && item.relativePath.includes('RUN1'))!
    const rt = result.project.artifacts.find((item) => item.relativePath.includes('SMP-01_T85_VDD1p295') && item.relativePath.includes('RT2'))!
    expect(sourceEngineeringContext(initial.relativePath, allArtifacts.get(initial.artifactId)).sequenceSignature).toBe(
      sourceEngineeringContext(rt.relativePath, allArtifacts.get(rt.artifactId)).sequenceSignature,
    )
    expect(result.project.evidenceRecords?.find((item) => item.id === 'sample-e-screen-fail')?.sourceIds).toHaveLength(2)
    const all = await projects.list(true)
    expect(all.some((item) => item.archived && item.lpddrDevelopmentContext?.product === 'LPDDR5')).toBe(true)
  })
})
