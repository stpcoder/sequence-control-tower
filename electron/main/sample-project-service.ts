import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectLoadResult, ProjectSnapshot } from '../shared/contracts'
import type { ArtifactService } from './artifact-service'
import type { ProjectStore } from './project-store'
import { buildSyntheticQualcommLog, type SyntheticOutcome } from './synthetic-qualcomm-log'

const SAMPLE_MARKER = 'SCT_SAMPLE_EVALUATION_V5'
const REFERENCE_MARKER = 'SCT_SAMPLE_LPDDR5_REFERENCE_V5'
const SAMPLE_FOLDER = 'evaluation-demo-v5'
const LEGACY_SAMPLE_MARKER = /(?:SCT_SAMPLE_LPDDR6_XIAOMI_V[1-3]|SCT_SAMPLE_EVALUATION_V4)\b/
const LEGACY_SAMPLE_FOLDERS = ['lpddr6-xiaomi', 'lpddr6-xiaomi-v2', 'lpddr6-xiaomi-v3', 'evaluation-demo-v4'] as const

function demoFilename(input: {
  timestamp: string; equipmentChannel: number; evaluationNo: number; temperatureC: number; vdd: string
  conditions: string[]; com: number; sample: string; evaluationStep: string; result: string
}): string {
  return [
    input.timestamp, 'UTF02A-2', `Ch${input.equipmentChannel}`, 'SM8975', input.evaluationNo,
    input.temperatureC, input.vdd, 'EVA', 'EN', ...input.conditions, `COM${input.com}`,
    input.sample, input.evaluationStep, input.result,
  ].join('_') + '.log'
}

const DEMO_NAMES = {
  screen1: demoFilename({ timestamp: '26-08-07-14-13-17', equipmentChannel: 8, evaluationNo: 1, temperatureC: 85, vdd: '1.295', conditions: ['SKEW-SS', 'LOT-A1', 'DIE03', 'DEFAULT', '9600MHZ', 'TM-VPERI', 'BASE', 'PAT-WR'], com: 74, sample: 'DHCST-89', evaluationStep: 'C', result: 'Fail' }),
  screen2: demoFilename({ timestamp: '26-08-07-14-23-17', equipmentChannel: 8, evaluationNo: 2, temperatureC: 85, vdd: '1.295', conditions: ['SKEW-SS', 'LOT-A1', 'DIE03', 'DEFAULT', '9600MHZ', 'TM-VPERI', 'BASE', 'PAT-WR'], com: 74, sample: 'CHAE-1', evaluationStep: 'C', result: 'Fail' }),
  roomPass: demoFilename({ timestamp: '26-08-07-15-03-12', equipmentChannel: 8, evaluationNo: 3, temperatureC: 25, vdd: '1.295', conditions: ['SKEW-SS', 'LOT-A1', 'DIE04', 'DEFAULT', '9600MHZ', 'TM-VPERI', 'ROOM', 'PAT-WR'], com: 74, sample: 'DHBCT-4', evaluationStep: 'C', result: 'Pass' }),
  trainingFail: demoFilename({ timestamp: '26-08-08-09-11-04', equipmentChannel: 6, evaluationNo: 1, temperatureC: -20, vdd: '1.275', conditions: ['SKEW-SF', 'LOT-B4', 'DIE07', 'DEFAULT', '8533MHZ', 'TM-BOOT', 'PAT-TRAIN'], com: 62, sample: 'BCT-7', evaluationStep: 'C', result: 'TrainingFail' }),
  improvement1: demoFilename({ timestamp: '26-08-09-10-10-10', equipmentChannel: 8, evaluationNo: 1, temperatureC: 85, vdd: '1.315', conditions: ['SKEW-SS', 'LOT-A1', 'DIE03', 'VPERI-UP', '9600MHZ', 'TM-VPERI', 'IMPROVE', 'PAT-WR'], com: 74, sample: 'DHCST-89', evaluationStep: 'D', result: 'Pass' }),
  improvement2: demoFilename({ timestamp: '26-08-09-10-20-10', equipmentChannel: 8, evaluationNo: 2, temperatureC: 85, vdd: '1.315', conditions: ['SKEW-SS', 'LOT-A1', 'DIE03', 'VPERI-UP', '9600MHZ', 'TM-VPERI', 'IMPROVE', 'PAT-WR'], com: 74, sample: 'CHAE-1', evaluationStep: 'D', result: 'Pass' }),
  retentionHalt: demoFilename({ timestamp: '26-08-10-11-01-31', equipmentChannel: 10, evaluationNo: 1, temperatureC: 105, vdd: '1.295', conditions: ['SKEW-FF', 'LOT-C2', 'DIE09', 'DEFAULT', '9600MHZ', 'TM-RETENTION', 'PAT-MARCH'], com: 81, sample: 'RTN-21', evaluationStep: 'C', result: 'SystemHalt' }),
  retentionPass: demoFilename({ timestamp: '26-08-10-11-21-31', equipmentChannel: 10, evaluationNo: 2, temperatureC: 105, vdd: '1.295', conditions: ['SKEW-FF', 'LOT-C2', 'DIE10', 'DEFAULT', '9600MHZ', 'TM-RETENTION', 'PAT-MARCH'], com: 81, sample: 'RTN-22', evaluationStep: 'C', result: 'Pass' }),
  retest: demoFilename({ timestamp: '26-08-11-08-31-08', equipmentChannel: 8, evaluationNo: 2, temperatureC: 85, vdd: '1.295', conditions: ['SKEW-SS', 'LOT-A1', 'DIE03', 'DEFAULT', '9600MHZ', 'TM-VPERI', 'RT2', 'PAT-WR'], com: 74, sample: 'DHCST-89', evaluationStep: 'C', result: 'Fail' }),
  cornerHH: demoFilename({ timestamp: '26-08-12-09-00-01', equipmentChannel: 8, evaluationNo: 1, temperatureC: 85, vdd: '1.315', conditions: ['SKEW-TT', 'LOT-D7', 'DIE11', 'CORNER-HH', 'HOT', 'HVDD', '9600MHZ', 'TM-4CORNER', 'PAT-WR'], com: 74, sample: 'CHAE-25', evaluationStep: 'F', result: 'Pass' }),
  cornerCH: demoFilename({ timestamp: '26-08-12-09-20-01', equipmentChannel: 8, evaluationNo: 2, temperatureC: -20, vdd: '1.315', conditions: ['SKEW-TT', 'LOT-D7', 'DIE11', 'CORNER-CH', 'COLD', 'HVDD', '9600MHZ', 'TM-4CORNER', 'PAT-WR'], com: 74, sample: 'CHAE-25', evaluationStep: 'F', result: 'Pass' }),
  cornerHL: demoFilename({ timestamp: '26-08-12-09-40-01', equipmentChannel: 8, evaluationNo: 3, temperatureC: 85, vdd: '1.275', conditions: ['SKEW-TT', 'LOT-D7', 'DIE11', 'CORNER-HL', 'HOT', 'LVDD', '9600MHZ', 'TM-4CORNER', 'PAT-WR'], com: 74, sample: 'CHAE-25', evaluationStep: 'F', result: 'Fail' }),
  cornerCL: demoFilename({ timestamp: '26-08-12-10-00-01', equipmentChannel: 8, evaluationNo: 4, temperatureC: -20, vdd: '1.275', conditions: ['SKEW-TT', 'LOT-D7', 'DIE11', 'CORNER-CL', 'COLD', 'LVDD', '9600MHZ', 'TM-4CORNER', 'PAT-WR'], com: 74, sample: 'CHAE-25', evaluationStep: 'F', result: 'HdiagReboot' }),
} as const

const SAMPLE_EVALUATIONS = [
  { key: 'corner', folder: '06-four-corner', matches: (name: string) => /_CORNER-(?:HH|CH|HL|CL)_/i.test(name) },
  { key: 'screen', folder: '01-vperi-screening', matches: (name: string) => !/_RT2_|_1\.315_|_TM-RETENTION_|_TrainingFail\.log$|_CORNER-/i.test(name) },
  { key: 'retest', folder: '02-vperi-retest', matches: (name: string) => /_RT2_/i.test(name) },
  { key: 'improvement', folder: '03-vdd-improvement', matches: (name: string) => /_1\.315_/i.test(name) },
  { key: 'retention', folder: '04-retention', matches: (name: string) => /TM-RETENTION/i.test(name) },
  { key: 'boot', folder: '05-boot-training', matches: (name: string) => /_TrainingFail\.log$/i.test(name) },
] as const
const stamp = '2026-08-01T09:00:00.000Z'

function log(run: string, condition: string, end: string[]): string {
  const joined = end.join('\n')
  const outcome: SyntheticOutcome = /TRAINING_FAIL/i.test(joined) ? 'TRAINING_FAIL'
    : /(?:WATCHDOG|REBOOT_REASON)/i.test(joined) ? 'SYSTEM_REBOOT'
      : /(?:SYSTEM_HALT|CPU_HALT)/i.test(joined) ? 'SYSTEM_HALT'
        : /@FAIL/i.test(joined) ? 'TEST_FAIL' : 'PASS'
  return buildSyntheticQualcommLog({ run, condition, outcome, terminalLines: end, lineCount: 7_600 })
}

const SAMPLE_LOGS: Record<string, string> = {
  [DEMO_NAMES.screen1]: log('VPERI_SCREEN_01', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.009] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002A COL=0x014 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.010] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002B COL=0x018 WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.011] FAST_FAIL threshold reached DQ9 count=128', '[00:00:10.012] @FAIL', '[00:00:10.013] TEST COMPLETE'
  ]),
  [DEMO_NAMES.screen2]: log('VPERI_SCREEN_02', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.019] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=4 ROW=0x0031 COL=0x020 WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.020] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=4 ROW=0x0031 COL=0x024 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.021] @FAIL', '[00:00:10.022] TEST COMPLETE'
  ]),
  [DEMO_NAMES.roomPass]: log('VPERI_BASELINE_03', 'TEMP=25C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.030] stressapptest PASS', '[00:00:10.031] @PASS', '[00:00:10.032] TEST COMPLETE'
  ]),
  [DEMO_NAMES.trainingFail]: log('BOOT_MARGIN_11', 'TEMP=-20C VDD=1.275V FREQ=8533MHz TM=BOOT PATTERN=TRAIN DQ=20 BL=32 CH=1', [
    '[00:00:10.040] TRAINING_FAIL CH=1 SUBCH=0 CS=0 RK=0 BG=0 BK=1 DQ=20 BL=32 write leveling timeout',
    '[00:00:10.041] @FAIL', '[00:00:10.042] SYSTEM REBOOT reason=training watchdog'
  ]),
  [DEMO_NAMES.improvement1]: log('VPERI_MARGIN_UP_01', 'TEMP=85C VDD=1.315V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.050] stressapptest PASS', '[00:00:10.051] @PASS', '[00:00:10.052] TEST COMPLETE'
  ]),
  [DEMO_NAMES.improvement2]: log('VPERI_MARGIN_UP_02', 'TEMP=85C VDD=1.315V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.060] stressapptest PASS', '[00:00:10.061] @PASS', '[00:00:10.062] TEST COMPLETE'
  ]),
  [DEMO_NAMES.retentionHalt]: log('RETENTION_18', 'TEMP=105C VDD=1.295V FREQ=9600MHz TM=RETENTION PATTERN=MARCH DQ=4 BL=16 CH=2 SUBCH=1 RANK=0 BG=2 BANK=4', [
    '[00:00:10.069] HIDAG ERROR CH=2 SUBCH=1 CS=0 RK=0 BG=2 BK=4 ROW=0x08F0 COL=0x03C WR=0x00 RD=0x10 DQ=4 BL=16 timeout',
    '[00:00:10.070] HIDAG ERROR CH=2 SUBCH=1 CS=0 RK=0 BG=2 BK=4 ROW=0x08F1 COL=0x040 WR=0xFF RD=0xEF DQ=4 BL=16 timeout',
    '[00:00:10.071] CPU_HALT fatal exception'
  ]),
  [DEMO_NAMES.retentionPass]: log('RETENTION_19', 'TEMP=105C VDD=1.295V FREQ=9600MHz TM=RETENTION PATTERN=MARCH DQ=4 BL=16 CH=2 SUBCH=1 RANK=0 BG=2 BANK=4', [
    '[00:00:10.080] stressapptest PASS', '[00:00:10.081] @PASS', '[00:00:10.082] SEQUENCE END'
  ]),
  [DEMO_NAMES.retest]: log('VPERI_SCREEN_01_RT2', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.089] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002A COL=0x014 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.090] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002C COL=0x01C WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.091] @FAIL', '[00:00:10.092] TEST COMPLETE'
  ]),
  [DEMO_NAMES.cornerHH]: log('FOUR_CORNER_HH', 'TEMP=85C VDD=1.315V FREQ=9600MHz CORNER=HH TM=4CORNER PATTERN=WR CH=0', [
    '[00:00:10.100] FOUR_CORNER HH HOT HVDD', '[00:00:10.101] stressapptest PASS', '[00:00:10.102] @PASS', '[00:00:10.103] TEST COMPLETE'
  ]),
  [DEMO_NAMES.cornerCH]: log('FOUR_CORNER_CH', 'TEMP=-20C VDD=1.315V FREQ=9600MHz CORNER=CH TM=4CORNER PATTERN=WR CH=0', [
    '[00:00:10.110] FOUR_CORNER CH COLD HVDD', '[00:00:10.111] stressapptest PASS', '[00:00:10.112] @PASS', '[00:00:10.113] TEST COMPLETE'
  ]),
  [DEMO_NAMES.cornerHL]: log('FOUR_CORNER_HL', 'TEMP=85C VDD=1.275V FREQ=9600MHz CORNER=HL TM=4CORNER PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=1', [
    '[00:00:10.120] FOUR_CORNER HL HOT LVDD',
    '[00:00:10.121] HIDAG @FAIL CH=0 SUBCH=1 CS=0 RK=0 BG=1 BK=2 ROW=0x0041 COL=0x028 WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.122] @FAIL', '[00:00:10.123] TEST COMPLETE'
  ]),
  [DEMO_NAMES.cornerCL]: log('FOUR_CORNER_CL', 'TEMP=-20C VDD=1.275V FREQ=9600MHz CORNER=CL TM=4CORNER PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=1', [
    '[00:00:10.130] FOUR_CORNER CL COLD LVDD',
    '[00:00:10.131] HIDAG @FAIL CH=0 SUBCH=1 CS=0 RK=0 BG=1 BK=2 ROW=0x0042 COL=0x02C WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.132] WATCHDOG bite detected', '[00:00:10.133] REBOOT_REASON=hdiag-timeout', '[00:00:10.134] POWER_ON recovery'
  ]),
}

export class SampleProjectService {
  constructor(private readonly dataRoot: string, private readonly deps: {
    artifacts: Pick<ArtifactService, 'importFolder'>
    projects: Pick<ProjectStore, 'create' | 'list' | 'get' | 'save' | 'archive' | 'attachFolder' | 'detachFolder' | 'connectArtifacts' | 'validateFolders'>
  }) {}

  async migrateLegacySamples(): Promise<boolean> {
    const legacy = (await this.deps.projects.list(true)).filter((project) =>
      !project.archived && LEGACY_SAMPLE_MARKER.test(project.description ?? ''))
    if (!legacy.length) return false
    await this.create()
    for (const project of legacy) {
      const current = await this.deps.projects.get(project.id)
      if (current && !current.archived) {
        await this.deps.projects.archive({ projectId: current.id, expectedRevision: current.revision })
      }
    }
    await Promise.all(LEGACY_SAMPLE_FOLDERS.map((folder) =>
      rm(join(this.dataRoot, 'samples', folder), { recursive: true, force: true })))
    return true
  }

  async create(): Promise<ProjectLoadResult> {
    const sampleRoot = join(this.dataRoot, 'samples', SAMPLE_FOLDER)
    await mkdir(sampleRoot, { recursive: true })
    await Promise.all(SAMPLE_EVALUATIONS.map(({ folder }) => mkdir(join(sampleRoot, folder), { recursive: true })))
    await Promise.all(Object.entries(SAMPLE_LOGS).map(([name, content]) => {
      const evaluation = SAMPLE_EVALUATIONS.find((item) => item.matches(name)) ?? SAMPLE_EVALUATIONS[0]
      return writeFile(join(sampleRoot, evaluation.folder, name), content, { encoding: 'utf8', mode: 0o600 })
    }))
    let project = (await this.deps.projects.list(true)).find((item) => item.description?.includes(SAMPLE_MARKER))
    if (!project) project = await this.deps.projects.create({ name: 'LPDDR6 Xiaomi 16Gb 평가 샘플', description: `${SAMPLE_MARKER} · Agent Native 기능 확인용 샘플`, onboardingAnswers: { evaluationTarget: 'VPERI 불량 검출·개선과 4-Corner 조건 비교', importantMetadata: 'sample, skew, lot, die, DQ, BL, channel, pattern, temperature, VDD, corner, frequency, test mode, evaluation step', reuseRules: '@FAIL/training/reboot/halt 우선 판정; @PASS 확정' } })
    const legacyRoot = project.folders.find((item) => item.displayLabel === SAMPLE_FOLDER)
    if (legacyRoot) project = await this.deps.projects.detachFolder(project.id, project.revision, legacyRoot.rootId)
    for (const evaluation of SAMPLE_EVALUATIONS) {
      if (!project.folders.some((item) => item.displayLabel === evaluation.folder)) project = await this.deps.projects.attachFolder(project.id, project.revision, join(sampleRoot, evaluation.folder))
    }
    const imports = await Promise.all(SAMPLE_EVALUATIONS.map(async (evaluation) => ({ evaluation, result: await this.deps.artifacts.importFolder(join(sampleRoot, evaluation.folder), { extensions: ['log'], maxFiles: 100 }) })))
    const imported = {
      artifacts: imports.flatMap((item) => item.result.artifacts),
      failures: imports.flatMap((item) => item.result.failures),
      skippedCount: imports.reduce((sum, item) => sum + item.result.skippedCount, 0),
    }
    const current = await this.deps.projects.get(project.id)
    if (!current) throw new Error('샘플 프로젝트를 만들지 못했습니다.')
    const roots = new Map(SAMPLE_EVALUATIONS.map((evaluation) => [evaluation.key, current.folders.find((item) => item.displayLabel === evaluation.folder)] as const))
    if ([...roots.values()].some((root) => !root)) throw new Error('샘플 평가 폴더를 연결하지 못했습니다.')
    const sources = imports.flatMap(({ evaluation, result }) => {
      const root = roots.get(evaluation.key)!
      return result.artifacts.flatMap((artifact) => (artifact.sources ?? []).filter((source) => source.folderLabel === evaluation.folder).map((source) => ({
        sourceId: createHash('sha256').update(`${current.id}\0${root.rootId}\0${source.relativePath}`).digest('hex').slice(0, 40),
        rootId: root.rootId, artifactRootId: source.rootId, artifactId: artifact.id, relativePath: source.relativePath
      })))
    })
    let connected = sources.length ? await this.deps.projects.connectArtifacts({ projectId: current.id, expectedRevision: current.revision, artifacts: sources }) : current
    const idsWhere = (match: (name: string) => boolean): string[] => connected.artifacts.filter((item) => match(item.relativePath)).map((item) => item.sourceId)
    const idsFor = (...names: string[]): string[] => idsWhere((path) => names.some((name) => path.endsWith(name)))
    connected = await this.deps.projects.save({
      projectId: connected.id, expectedRevision: connected.revision,
      equipmentProfiles: [{ alias: 'SM-8975', profileId: 'qualcomm-default', vendor: 'qualcomm', socModels: ['SM-8975'], filenameAliases: ['SM8975', 'SM-8975'], updatedAt: stamp }],
      lpddrDevelopmentContext: { product: 'LPDDR6', skew: 'SS', customer: 'Xiaomi', targetDevice: 'Mobile flagship', densityGb: 16, nominalVoltage: 1.295, program: 'VPERI 개선', phase: 'Development' },
      failureHypotheses: [
        { id: 'sample-h-vperi-dq9', title: '고온 VPERI DQ9 집중', description: '85°C, VDD 1.295V에서 DQ9 fail이 반복됨. VPERI 동일 기인은 엔지니어 확인 전 가설.', origin: 'ai-proposed', evaluationNodeIds: ['sample-n-screen', 'sample-n-screen-rt2', 'sample-n-vdd-up', 'sample-n-four-corner'] },
        { id: 'sample-h-retention', title: '105°C retention DQ4', description: '동일 조건 2개 중 1개 halt. 추가 반복 필요.', origin: 'engineer-confirmed', evaluationNodeIds: ['sample-n-retention'] }
      ],
      evaluationNodes: [
        { id: 'sample-n-screen', hypothesisId: 'sample-h-vperi-dq9', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'baseline', relationConfidence: 1, relationReason: '초기 VPERI DQ9 불량 평가', evaluationScopeId: roots.get('screen')!.rootId, name: 'VPERI 불량 가속 조건 확인', purpose: 'screening', dimensions: { skew: 'SS', lot: 'A1', die: '03', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', equipmentChannel: '8', eccMode: 'EN', evaluationStep: 'C', dq: 9, bl: 16, channel: 0, subChannel: 0, rank: 0, bankGroup: 1, bank: 2, pattern: 'WR', frequencyMHz: 9600, temperatureC: 85, vdd: 1.295, testMode: 'VPERI' }, interpretation: '85°C·VDD 1.295V의 WR 평가에서 DQ9 실패가 2/2로 확인됐습니다. 검출 조건으로는 유효하지만 동일 기인 확정에는 비교 조건이 더 필요합니다.', authorship: 'agent', reviewState: 'confirmed', sequenceSignature: 'sample-vperi-screen', attemptNo: 1, status: 'fail' },
        { id: 'sample-n-screen-rt2', hypothesisId: 'sample-h-vperi-dq9', parentId: 'sample-n-screen', retestOf: 'sample-n-screen', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'retest', relationConfidence: 1, relationReason: '같은 Sample·Sequence·조건의 재평가', evaluationScopeId: roots.get('retest')!.rootId, name: 'DHCST-89 동일 조건 RT2', purpose: 'reproduction', dimensions: { sample: 'DHCST-89', equipmentChannel: '8', eccMode: 'EN', evaluationStep: 'C' }, interpretation: '같은 Sample과 Sequence로 재평가했지만 다시 실패했습니다. 단발성 오류보다는 반복 가능한 불량 가능성이 높습니다.', authorship: 'engineer', reviewState: 'confirmed', sequenceSignature: 'sample-vperi-screen', attemptNo: 2, status: 'fail' },
        { id: 'sample-n-vdd-up', hypothesisId: 'sample-h-vperi-dq9', parentId: 'sample-n-screen-rt2', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'improvement', relationConfidence: 1, relationReason: '동일 불량의 VDD 개선 조건 비교', evaluationScopeId: roots.get('improvement')!.rootId, name: 'VDD 1.315V 개선 확인', purpose: 'improvement', dimensions: { skew: 'SS', lot: 'A1', die: '03', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', equipmentChannel: '8', eccMode: 'EN', evaluationStep: 'D', dq: 9, bl: 16, channel: 0, subChannel: 0, rank: 0, bankGroup: 1, bank: 2, pattern: 'WR', frequencyMHz: 9600, temperatureC: 85, vdd: 1.315, testMode: 'VPERI' }, interpretation: 'VDD를 1.315V로 높인 조건에서는 2/2 PASS로 바뀌었습니다. 개선 경향은 보이지만 전압 효과를 확정하려면 중간 전압과 반복 평가가 필요합니다.', authorship: 'agent', reviewState: 'confirmed', status: 'pass' },
        { id: 'sample-n-four-corner', hypothesisId: 'sample-h-vperi-dq9', parentId: 'sample-n-screen', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'condition-comparison', relationConfidence: 1, relationReason: '같은 Sample과 Sequence에서 온도·VDD 4-Corner 비교', evaluationScopeId: roots.get('corner')!.rootId, name: '온도·VDD 4-Corner 평가', purpose: 'characterization', dimensions: { skew: 'TT', lot: 'D7', die: '11', sample: 'CHAE-25', material: 'CHAE-25', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', equipmentChannel: '8', eccMode: 'EN', evaluationStep: 'F', pattern: 'WR', frequencyMHz: 9600, conditionCorner: 'HH/CH/HL/CL', testMode: '4CORNER' }, interpretation: '동일 자재 CHAE-25에서 HH·CH는 PASS, HL은 FAIL, CL은 Hdiag reboot가 발생했습니다. LVDD에서 불량이 나타나며 Cold+LVDD 조건에서 증상이 가장 심합니다.', authorship: 'agent', reviewState: 'confirmed', status: 'fail' },
        { id: 'sample-n-retention', hypothesisId: 'sample-h-retention', branchId: 'issue:sample-h-retention:main', relation: 'baseline', relationConfidence: .78, relationReason: 'VPERI와 Fail signature가 달라 별도 Retention 이슈로 분류', evaluationScopeId: roots.get('retention')!.rootId, name: '고온 retention 재현', purpose: 'characterization', dimensions: { skew: 'FF', lot: 'C2', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', equipmentChannel: '10', eccMode: 'EN', evaluationStep: 'C', dq: 4, bl: 16, channel: 2, subChannel: 1, rank: 0, bankGroup: 2, bank: 4, pattern: 'MARCH', frequencyMHz: 9600, temperatureC: 105, vdd: 1.295, testMode: 'RETENTION' }, interpretation: '105°C retention에서 2회 중 1회 halt와 DQ4 marker가 확인됐습니다. 분모가 작아 추가 반복 전에는 경향으로만 유지합니다.', authorship: 'agent', reviewState: 'proposed', status: 'inconclusive' }
      ],
      evidenceRecords: [
        { id: 'sample-e-screen-fail', evaluationNodeId: 'sample-n-screen', occurredAt: stamp, status: 'fail', result: '2/2 FAIL at DQ9', sourceIds: idsFor(DEMO_NAMES.screen1, DEMO_NAMES.screen2), note: '결정 규칙 @FAIL; 85°C 최초 평가 분모 2, 실패 2', origin: 'engineer-confirmed' },
        { id: 'sample-e-screen-rt2', evaluationNodeId: 'sample-n-screen-rt2', occurredAt: stamp, status: 'fail', result: 'RT2 FAIL', sourceIds: idsFor(DEMO_NAMES.retest), note: '동일 Sample·Sequence의 이전 FAIL 평가에 연결', origin: 'engineer-confirmed' },
        { id: 'sample-e-vdd-pass', evaluationNodeId: 'sample-n-vdd-up', occurredAt: stamp, status: 'pass', result: '2/2 PASS at VDD 1.315V', sourceIds: idsFor(DEMO_NAMES.improvement1, DEMO_NAMES.improvement2), note: '전압 상향 조건 분모 2, PASS 2. 개선 인과는 추가 반복 필요.', origin: 'engineer-confirmed' },
        { id: 'sample-e-four-corner', evaluationNodeId: 'sample-n-four-corner', occurredAt: stamp, status: 'fail', result: 'HH PASS · CH PASS · HL FAIL · CL REBOOT', sourceIds: idsFor(DEMO_NAMES.cornerHH, DEMO_NAMES.cornerCH, DEMO_NAMES.cornerHL, DEMO_NAMES.cornerCL), note: '같은 CHAE-25 자재의 온도·VDD 조합 비교. LVDD에서 불량, Cold+LVDD에서 reboot.', origin: 'engineer-confirmed' },
        { id: 'sample-e-retention-fail', evaluationNodeId: 'sample-n-retention', occurredAt: stamp, status: 'fail', result: '1 HALT / 2 runs', sourceIds: idsFor(DEMO_NAMES.retentionHalt, DEMO_NAMES.retentionPass), note: '105°C retention에서 halt 1건; DQ4 marker', origin: 'engineer-confirmed' }
      ]
    })
    await this.ensureLpddr5Reference()
    return { project: connected, artifacts: imported.artifacts, failures: imported.failures, skippedCount: imported.skippedCount }
  }

  private async ensureLpddr5Reference(): Promise<void> {
    if ((await this.deps.projects.list(true)).some((item) => item.description?.includes(REFERENCE_MARKER))) return
    let reference = await this.deps.projects.create({ name: 'LPDDR5 VPERI DQ9 과거 사례', description: `${REFERENCE_MARKER} · 샘플 프로젝트의 유사 사례 검색용` })
    reference = await this.deps.projects.save({
      projectId: reference.id, expectedRevision: reference.revision,
      lpddrDevelopmentContext: { product: 'LPDDR5', skew: 'TT', customer: 'Xiaomi', program: 'VPERI screening', phase: 'Closed' },
      failureHypotheses: [{ id: 'ref-h-vperi', title: '고온 VPERI DQ9 반복 불량', description: '85°C VPERI write pattern에서 DQ9 집중. 전압 상향 후 개선은 제한적이어서 pattern 변경을 후속 평가함.', origin: 'engineer-confirmed', evaluationNodeIds: ['ref-n-vperi'] }],
      evaluationNodes: [{ id: 'ref-n-vperi', hypothesisId: 'ref-h-vperi', branchId: 'closed-vperi', name: 'LPDDR5 VPERI DQ9 screening', purpose: 'screening', dimensions: { skew: 'TT', sample: 'REF-DHCST-08', dq: 9, pattern: 'WR', temperatureC: 85, vdd: 1.1, testMode: 'VPERI' }, status: 'fail' }],
      evidenceRecords: []
    })
    await this.deps.projects.archive({ projectId: reference.id, expectedRevision: reference.revision })
  }
}
