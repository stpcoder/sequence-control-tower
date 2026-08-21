import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ArtifactService } from './artifact-service'
import { ProjectStore } from './project-store'
import { SampleProjectService } from './sample-project-service'
import { sourceEngineeringContext } from './lpddr-agent-tools'
import {
  extractLpddrFilenameDimensions,
  extractLpddrFilenameOutcome,
  parsePositionalLabFilename,
} from '../../src/domain/lpddr-filename-dimensions'

describe('SampleProjectService', () => {
  it('creates a usable LPDDR6 project with logs, branches and an archived LPDDR5 reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-sample-'))
    const artifacts = new ArtifactService(root); const projects = new ProjectStore(root)
    await Promise.all([artifacts.initialize(), projects.initialize()])
    const result = await new SampleProjectService(root, { artifacts, projects }).create()
    expect(result.project.lpddrDevelopmentContext).toMatchObject({ product: 'LPDDR6', customer: 'Xiaomi', densityGb: 16 })
    expect(result.project.artifacts).toHaveLength(9)
    expect(result.project.folders.map((item) => item.displayLabel).sort()).toEqual([
      '01-vperi-screening', '02-vperi-retest', '03-vdd-improvement', '04-retention', '05-boot-training',
    ])
    expect(result.project.evaluationNodes).toHaveLength(4)
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-screen-rt2')).toMatchObject({ retestOf: 'sample-n-screen', attemptNo: 2, relation: 'retest' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-vdd-up')).toMatchObject({ parentId: 'sample-n-screen-rt2', purpose: 'improvement', relation: 'improvement' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-retention')).toMatchObject({ hypothesisId: 'sample-h-retention', branchId: 'issue:sample-h-retention:main', relation: 'baseline', status: 'inconclusive' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-retention')?.parentId).toBeUndefined()
    expect(new Set(result.project.evaluationNodes?.map((item) => item.branchId))).toEqual(new Set(['issue:sample-h-vperi-dq9:main', 'issue:sample-h-retention:main']))
    expect(new Set(result.project.evaluationNodes?.map((item) => item.evaluationScopeId)).size).toBe(4)
    expect(result.project.equipmentProfiles[0]).toMatchObject({ profileId: 'qualcomm-default', socModels: ['SM-8975'] })
    const allArtifacts = new Map((await artifacts.list()).map((artifact) => [artifact.id, artifact]))
    expect(result.project.artifacts.every((item) => Boolean(parsePositionalLabFilename(item.relativePath)))).toBe(true)
    const initial = result.project.artifacts.find((item) => item.relativePath.includes('_DHCST-89_C_Fail.log') && item.relativePath.includes('_BASE_'))!
    const rt = result.project.artifacts.find((item) => item.relativePath.includes('_DHCST-89_C_Fail.log') && item.relativePath.includes('_RT2_'))!
    expect(initial).toBeDefined()
    expect(rt).toBeDefined()
    expect(parsePositionalLabFilename(initial.relativePath)).toMatchObject({
      equipmentChannel: '8', gridId: '1', temperatureC: 85, vdd: 1.295,
      eccMode: 'EN', material: 'DHCST-89', evaluationStep: 'C', frequencyMHz: 9600,
      outcome: 'TEST_FAIL',
    })
    expect(extractLpddrFilenameDimensions(initial.relativePath)).toMatchObject({
      sample: 'DHCST-89', material: 'DHCST-89', skew: 'SS', lot: 'A1', die: '03',
      socVendor: 'qualcomm', socModel: 'SM-8975', equipmentChannel: '8', gridId: '1',
      temperatureC: 85, vdd: 1.295, frequencyMHz: 9600, testMode: 'VPERI', pattern: 'WR',
      evaluationStep: 'C', eccMode: 'EN',
    })
    expect(extractLpddrFilenameDimensions(initial.relativePath).channel).toBeUndefined()
    expect(extractLpddrFilenameOutcome(initial.relativePath)).toBe('TEST_FAIL')
    expect(sourceEngineeringContext(initial.relativePath, allArtifacts.get(initial.artifactId)).sequenceSignature).toBe(
      sourceEngineeringContext(rt.relativePath, allArtifacts.get(rt.artifactId)).sequenceSignature,
    )
    const initialArtifact = allArtifacts.get(initial.artifactId)!
    expect(initialArtifact.fingerprint).toMatchObject({
      lineCount: expect.any(Number), commandCount: 4,
      console: { inputCount: 4, ambiguousCount: 1, promptKinds: expect.arrayContaining(['uefi', 'os-root', 'bare-root']) },
    })
    expect(initialArtifact.fingerprint!.lineCount).toBeGreaterThan(7_000)
    expect(initialArtifact.fingerprint!.commandSignatures).toEqual(expect.arrayContaining([
      'voltage-control:set_rail', 'shell:set_freq', 'diagnostic:hdiag', 'shell:stressapptest',
    ]))
    expect(result.project.evidenceRecords?.find((item) => item.id === 'sample-e-screen-fail')?.sourceIds).toHaveLength(2)
    const all = await projects.list(true)
    expect(all.some((item) => item.archived && item.lpddrDevelopmentContext?.product === 'LPDDR5')).toBe(true)
  })
})
