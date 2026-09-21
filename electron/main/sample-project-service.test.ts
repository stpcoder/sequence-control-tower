import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
    expect(result.project).toMatchObject({ name: 'LPDDR 합성 평가 데모' })
    expect(result.project.description).toContain('공개 가능한 합성 데이터')
    expect(result.project.lpddrDevelopmentContext).toMatchObject({ product: 'LPDDR Demo', customer: 'Demo Customer', densityGb: 16 })
    expect(result.project.artifacts).toHaveLength(13)
    expect(result.project.folders.map((item) => item.displayLabel).sort()).toEqual([
      '01-margin-screening', '02-margin-retest', '03-voltage-improvement', '04-retention', '05-boot-training', '06-four-corner',
    ])
    expect(result.project.evaluationNodes).toHaveLength(5)
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-screen-rt2')).toMatchObject({ retestOf: 'sample-n-screen', attemptNo: 2, relation: 'retest' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-vdd-up')).toMatchObject({ parentId: 'sample-n-screen-rt2', purpose: 'improvement', relation: 'improvement' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-retention')).toMatchObject({ hypothesisId: 'sample-h-retention', branchId: 'issue:sample-h-retention:main', relation: 'baseline', status: 'inconclusive' })
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-retention')?.parentId).toBeUndefined()
    expect(new Set(result.project.evaluationNodes?.map((item) => item.branchId))).toEqual(new Set(['issue:sample-h-margin-dq9:main', 'issue:sample-h-retention:main']))
    expect(result.project.evaluationNodes?.find((item) => item.id === 'sample-n-four-corner')).toMatchObject({
      parentId: 'sample-n-screen', relation: 'condition-comparison', dimensions: { sample: 'DEMO-D01', conditionCorner: 'HH/CH/HL/CL' }, status: 'fail',
    })
    expect(new Set(result.project.evaluationNodes?.map((item) => item.evaluationScopeId)).size).toBe(5)
    expect(result.project.equipmentProfiles[0]).toMatchObject({ profileId: 'qualcomm-default', socModels: ['SM-9999'] })
    const allArtifacts = new Map((await artifacts.list()).map((artifact) => [artifact.id, artifact]))
    expect(new Set([...allArtifacts.values()].filter((artifact) => artifact.sources?.some((source) => source.relativePath.endsWith('.log'))).map((artifact) => artifact.fingerprint?.lineCount))).toEqual(new Set([7_601]))
    expect(result.project.artifacts.every((item) => Boolean(parsePositionalLabFilename(item.relativePath)))).toBe(true)
    expect([...new Set(result.project.artifacts.map((item) => parsePositionalLabFilename(item.relativePath)?.material))]).toEqual(expect.arrayContaining([
      'DEMO-A01', 'DEMO-A02', 'DEMO-A03', 'DEMO-B01', 'DEMO-C01', 'DEMO-C02', 'DEMO-D01',
    ]))
    const initial = result.project.artifacts.find((item) => item.relativePath.includes('_DEMO-A01_C_Fail.log') && item.relativePath.includes('_BASE_'))!
    const rt = result.project.artifacts.find((item) => item.relativePath.includes('_DEMO-A01_C_Fail.log') && item.relativePath.includes('_RT2_'))!
    expect(initial).toBeDefined()
    expect(rt).toBeDefined()
    expect(parsePositionalLabFilename(initial.relativePath)).toMatchObject({
      equipmentChannel: '8', gridId: '1', temperatureC: 85, vdd: 1.295,
      eccMode: 'EN', material: 'DEMO-A01', evaluationStep: 'C', frequencyMHz: 9600,
      outcome: 'TEST_FAIL',
    })
    expect(extractLpddrFilenameDimensions(initial.relativePath)).toMatchObject({
      sample: 'DEMO-A01', material: 'DEMO-A01', skew: 'SS', lot: 'A1', die: '03',
      socVendor: 'qualcomm', socModel: 'SM-9999', equipmentChannel: '8', gridId: '1',
      temperatureC: 85, vdd: 1.295, frequencyMHz: 9600, testMode: 'MARGIN-A', pattern: 'WR',
      evaluationStep: 'C', eccMode: 'EN',
    })
    expect(extractLpddrFilenameDimensions(initial.relativePath).channel).toBeUndefined()
    expect(extractLpddrFilenameOutcome(initial.relativePath)).toBe('TEST_FAIL')
    const corners = result.project.artifacts.filter((item) => /_CORNER-(?:HH|CH|HL|CL)_/.test(item.relativePath))
    expect(corners).toHaveLength(4)
    expect(corners.map((item) => extractLpddrFilenameDimensions(item.relativePath))).toEqual(expect.arrayContaining([
      expect.objectContaining({ conditionCorner: 'HH', temperatureC: 85, vdd: 1.315, sample: 'DEMO-D01' }),
      expect.objectContaining({ conditionCorner: 'CH', temperatureC: -20, vdd: 1.315, sample: 'DEMO-D01' }),
      expect.objectContaining({ conditionCorner: 'HL', temperatureC: 85, vdd: 1.275, sample: 'DEMO-D01' }),
      expect.objectContaining({ conditionCorner: 'CL', temperatureC: -20, vdd: 1.275, sample: 'DEMO-D01' }),
    ]))
    expect(sourceEngineeringContext(initial.relativePath, allArtifacts.get(initial.artifactId)).sequenceSignature).toBe(
      sourceEngineeringContext(rt.relativePath, allArtifacts.get(rt.artifactId)).sequenceSignature,
    )
    const initialArtifact = allArtifacts.get(initial.artifactId)!
    expect(initialArtifact.fingerprint).toMatchObject({
      lineCount: expect.any(Number), commandCount: 9,
      console: { inputCount: 9, ambiguousCount: 0, promptKinds: expect.arrayContaining(['uefi', 'os-root']) },
    })
    expect(initialArtifact.fingerprint!.lineCount).toBeGreaterThan(7_000)
    expect(initialArtifact.fingerprint!.commandSignatures).toEqual(expect.arrayContaining([
      'training-control:erase-ddr', 'test-mode-control:dtvs', 'firmware-control:reset', 'firmware-control:exit',
      'clock-control:setddrclk', 'diagnostic:hdiag', 'shell:stressapptest', 'timing:sleep',
    ]))
    const initialText = await readFile(join(root, 'samples', 'public-synthetic-demo-v6', '01-margin-screening', basename(initial.relativePath)), 'utf8')
    expect(initialText).toContain('# SYNTHETIC_PUBLIC_FLOW_CORPUS: not a vendor capture')
    expect(initialText.trimEnd().split(/\r?\n/)).toHaveLength(7_600)
    const publicSampleSurface = JSON.stringify({
      project: result.project,
      filenames: result.project.artifacts.map((item) => item.relativePath),
    })
    expect(publicSampleSurface).not.toMatch(/xiaomi|sk[ -]?hynix|vperi|dhcst|chae|dhbct|utf02a|sm8975/i)
    const stage = (marker: string) => initialText.indexOf(marker)
    expect(stage('B - 000000 - Power key pressed')).toBeGreaterThan(0)
    expect(stage('UEFI] erase ddr')).toBeGreaterThan(stage('DDR training, Start'))
    expect(stage('UEFI] dtvs 1')).toBeGreaterThan(stage('UEFI] dtvs'))
    expect(stage('UEFI] reset')).toBeGreaterThan(stage('UEFI] dtvs 1'))
    expect(stage('UEFI] exit')).toBeGreaterThan(stage('UEFI] reset'))
    expect(stage('init: init first stage started!')).toBeGreaterThan(stage('UEFI] exit'))
    expect(stage('init: init second stage started!')).toBeGreaterThan(stage('init: init first stage started!'))
    expect(stage('console:/ # hdiag')).toBeGreaterThan(stage('console:/ #'))
    expect(result.project.evidenceRecords?.find((item) => item.id === 'sample-e-screen-fail')?.sourceIds).toHaveLength(2)
    const all = await projects.list(true)
    expect(all.some((item) => item.archived && item.lpddrDevelopmentContext?.product === 'LPDDR5 Demo')).toBe(true)
  })

  it('replaces active legacy generated samples and removes only their generated folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sct-sample-migration-'))
    const artifacts = new ArtifactService(root); const projects = new ProjectStore(root)
    await Promise.all([artifacts.initialize(), projects.initialize()])
    const legacy = await projects.create({ name: 'old sample', description: 'SCT_SAMPLE_LPDDR6_XIAOMI_V2 · generated' })
    for (const folder of ['lpddr6-xiaomi', 'lpddr6-xiaomi-v2']) {
      const path = join(root, 'samples', folder)
      await mkdir(path, { recursive: true }); await writeFile(join(path, 'old.log'), 'old')
    }

    const migrated = await new SampleProjectService(root, { artifacts, projects }).migrateLegacySamples()

    expect(migrated).toBe(true)
    expect((await projects.get(legacy.id))?.archived).toBe(true)
    expect((await projects.list()).some((item) => item.description?.includes('SCT_PUBLIC_SYNTHETIC_DEMO_V6'))).toBe(true)
    await expect(access(join(root, 'samples', 'lpddr6-xiaomi'))).rejects.toThrow()
    await expect(access(join(root, 'samples', 'lpddr6-xiaomi-v2'))).rejects.toThrow()
    await expect(access(join(root, 'samples', 'public-synthetic-demo-v6'))).resolves.toBeUndefined()
  })
})
