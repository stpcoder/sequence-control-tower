import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectLoadResult, ProjectSnapshot } from '../shared/contracts'
import type { ArtifactService } from './artifact-service'
import type { ProjectStore } from './project-store'

const SAMPLE_MARKER = 'SCT_SAMPLE_LPDDR6_XIAOMI_V2'
const REFERENCE_MARKER = 'SCT_SAMPLE_LPDDR5_REFERENCE_V2'
const SAMPLE_FOLDER = 'lpddr6-xiaomi-v2'
const SAMPLE_EVALUATIONS = [
  { key: 'screen', folder: '01-vperi-screening', matches: (name: string) => !/RT2|VDD1p315|TM-RETENTION|TRAINFAIL/i.test(name) },
  { key: 'retest', folder: '02-vperi-retest', matches: (name: string) => /RT2/i.test(name) },
  { key: 'improvement', folder: '03-vdd-improvement', matches: (name: string) => /VDD1p315/i.test(name) },
  { key: 'retention', folder: '04-retention', matches: (name: string) => /TM-RETENTION/i.test(name) },
  { key: 'boot', folder: '05-boot-training', matches: (name: string) => /TRAINFAIL/i.test(name) },
] as const
const stamp = '2026-08-01T09:00:00.000Z'

function bootLines(run: string, condition: string): string[] {
  const vdd = /VDD=([0-9.]+)V/i.exec(condition)?.[1] ?? '1.295'
  const frequency = /FREQ=(\d+)MHz/i.exec(condition)?.[1] ?? '9600'
  const lines = [
    `[00:00:00.001] POWER_ON ${run}`,
    '[00:00:00.114] PBL: boot start',
    '[00:00:00.267] XBL: DDR init',
    `[00:00:00.411] DDR_CONDITION ${condition}`,
    '[00:00:00.790] UEFI: memory training start',
    `[00:00:00.820] UEFI> set_rail VDD ${vdd}`,
    `[00:00:00.821] INFO rail controller applied VDD=${vdd}V rc=0`,
    `[00:00:00.850] UEFI> set_freq ${frequency}`,
    `[00:00:00.851] DEBUG clock request ${frequency}MHz accepted`,
    '[00:00:01.206] UEFI: memory training complete',
    '[00:00:01.409] UEFI: ExitBootServices',
    '[00:00:02.901] OS: Linux boot complete',
    'root@sm8975:/ # hdiag --mode memory --start',
    '[00:00:03.215] HIDAG DIAG START',
    'root@sm8975:/ # stressapptest -M 4096 -s 600',
    '# sleep 20',
    '[00:00:03.418] stressapptest BEGIN'
  ]
  for (let index = 0; index < 7_200; index += 1) {
    const time = `[00:${String(Math.floor(index / 3_600)).padStart(2, '0')}:${String(Math.floor(index / 60) % 60).padStart(2, '0')}.${String(index % 1_000).padStart(3, '0')}]`
    const variants = [
      `${time} DEBUG serial.rx packet=${index} bytes=${32 + (index % 96)} crc=ok`,
      `${time} TRACE scheduler tick=${index} cpu=${index % 8} task=mem_stress`,
      `${time} INFO traffic loop=${index} channel=${index % 4} bank=${index % 8} bankGroup=${index % 4}`,
      `${time} [KERNEL] irq=${index % 64} wake=${index % 5} thermal_zone=${42 + (index % 7)}`,
      `${time} [UI-AUTOMATION] clicked=serial-monitor-${index % 3} focus=${index % 2} frame=${index}`,
      `${time} DEBUG training.telemetry dq=${index % 32} eye=${18 + (index % 11)}ps sample=${index % 128}`,
      `${time} TRACE buffer alloc=${4096 + (index % 512)} free=${8192 - (index % 512)} event=complete`,
    ]
    lines.push(variants[index % variants.length])
  }
  return lines
}

function log(run: string, condition: string, end: string[]): string {
  return `${[...bootLines(run, condition), ...end].join('\n')}\n`
}

const SAMPLE_LOGS: Record<string, string> = {
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE03_SMP-01_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_SCH0_RK0_BG1_BANK2_FAIL_RUN1.log': log('VPERI_SCREEN_01', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.009] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002A COL=0x014 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.010] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002B COL=0x018 WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.011] FAST_FAIL threshold reached DQ9 count=128', '[00:00:10.012] @FAIL', '[00:00:10.013] TEST COMPLETE'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE03_SMP-02_T85_VDD1p295_F9600_TM-VPERI_PAT-WR-DQ9_BL16_CH0_SCH0_RK0_BG1_BANK2_FAIL_RUN1.log': log('VPERI_SCREEN_02', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.019] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=4 ROW=0x0031 COL=0x020 WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.020] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=4 ROW=0x0031 COL=0x024 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.021] @FAIL', '[00:00:10.022] TEST COMPLETE'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE04_SMP-03_T25_VDD1p295_F9600_TM-VPERI_PAT-WR_DQ9_BL16_CH0_PASS_RUN1.log': log('VPERI_BASELINE_03', 'TEMP=25C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.030] stressapptest PASS', '[00:00:10.031] @PASS', '[00:00:10.032] TEST COMPLETE'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SF_LOT-B4_MAT-WAF27_DIE07_SMP-11_T-20_VDD1p275_F8533_TM-BOOT_PAT-TRAIN_DQ20_BL32_CH1_TRAINFAIL_RUN1.log': log('BOOT_MARGIN_11', 'TEMP=-20C VDD=1.275V FREQ=8533MHz TM=BOOT PATTERN=TRAIN DQ=20 BL=32 CH=1', [
    '[00:00:10.040] TRAINING_FAIL CH=1 SUBCH=0 CS=0 RK=0 BG=0 BK=1 DQ=20 BL=32 write leveling timeout',
    '[00:00:10.041] @FAIL', '[00:00:10.042] SYSTEM REBOOT reason=training watchdog'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE03_SMP-01_T85_VDD1p315_F9600_TM-VPERI_PAT-WR_DQ9_BL16_CH0_PASS_RUN1.log': log('VPERI_MARGIN_UP_01', 'TEMP=85C VDD=1.315V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.050] stressapptest PASS', '[00:00:10.051] @PASS', '[00:00:10.052] TEST COMPLETE'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE03_SMP-02_T85_VDD1p315_F9600_TM-VPERI_PAT-WR_DQ9_BL16_CH0_PASS_RUN1.log': log('VPERI_MARGIN_UP_02', 'TEMP=85C VDD=1.315V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0', [
    '[00:00:10.060] stressapptest PASS', '[00:00:10.061] @PASS', '[00:00:10.062] TEST COMPLETE'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-FF_LOT-C2_MAT-WAF31_DIE09_SMP-18_T105_VDD1p295_F9600_TM-RETENTION_PAT-MARCH_DQ4_BL16_CH2_SCH1_RK0_BG2_BANK4_HALT_RUN1.log': log('RETENTION_18', 'TEMP=105C VDD=1.295V FREQ=9600MHz TM=RETENTION PATTERN=MARCH DQ=4 BL=16 CH=2 SUBCH=1 RANK=0 BG=2 BANK=4', [
    '[00:00:10.069] HIDAG ERROR CH=2 SUBCH=1 CS=0 RK=0 BG=2 BK=4 ROW=0x08F0 COL=0x03C WR=0x00 RD=0x10 DQ=4 BL=16 timeout',
    '[00:00:10.070] HIDAG ERROR CH=2 SUBCH=1 CS=0 RK=0 BG=2 BK=4 ROW=0x08F1 COL=0x040 WR=0xFF RD=0xEF DQ=4 BL=16 timeout',
    '[00:00:10.071] CPU_HALT fatal exception'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-FF_LOT-C2_MAT-WAF31_DIE10_SMP-19_T105_VDD1p295_F9600_TM-RETENTION_PAT-MARCH_DQ4_BL16_CH2_SCH1_RK0_BG2_BANK4_PASS_RUN1.log': log('RETENTION_19', 'TEMP=105C VDD=1.295V FREQ=9600MHz TM=RETENTION PATTERN=MARCH DQ=4 BL=16 CH=2 SUBCH=1 RANK=0 BG=2 BANK=4', [
    '[00:00:10.080] stressapptest PASS', '[00:00:10.081] @PASS', '[00:00:10.082] SEQUENCE END'
  ]),
  'LPDDR6_XIAOMI_16Gb_SM-8975_SKEW-SS_LOT-A1_MAT-WAF12_DIE03_SMP-01_T85_VDD1p295_F9600_TM-VPERI_PAT-WR_DQ9_BL16_CH0_SCH0_RK0_BG1_BANK2_RT2_FAIL.log': log('VPERI_SCREEN_01_RT2', 'TEMP=85C VDD=1.295V FREQ=9600MHz TM=VPERI PATTERN=WR DQ=9 BL=16 CH=0 SUBCH=0 RANK=0 BG=1 BANK=2', [
    '[00:00:10.089] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002A COL=0x014 WR=0x55 RD=0x15 DQ=9 BL=16',
    '[00:00:10.090] HIDAG @FAIL CH=0 SUBCH=0 CS=0 RK=0 BG=1 BK=3 ROW=0x002C COL=0x01C WR=0xAA RD=0xA8 DQ=9 BL=16',
    '[00:00:10.091] @FAIL', '[00:00:10.092] TEST COMPLETE'
  ])
}

export class SampleProjectService {
  constructor(private readonly dataRoot: string, private readonly deps: {
    artifacts: Pick<ArtifactService, 'importFolder'>
    projects: Pick<ProjectStore, 'create' | 'list' | 'get' | 'save' | 'archive' | 'attachFolder' | 'detachFolder' | 'connectArtifacts' | 'validateFolders'>
  }) {}

  async create(): Promise<ProjectLoadResult> {
    const sampleRoot = join(this.dataRoot, 'samples', SAMPLE_FOLDER)
    await mkdir(sampleRoot, { recursive: true })
    await Promise.all(SAMPLE_EVALUATIONS.map(({ folder }) => mkdir(join(sampleRoot, folder), { recursive: true })))
    await Promise.all(Object.entries(SAMPLE_LOGS).map(([name, content]) => {
      const evaluation = SAMPLE_EVALUATIONS.find((item) => item.matches(name)) ?? SAMPLE_EVALUATIONS[0]
      return writeFile(join(sampleRoot, evaluation.folder, name), content, { encoding: 'utf8', mode: 0o600 })
    }))
    let project = (await this.deps.projects.list(true)).find((item) => item.description?.includes(SAMPLE_MARKER))
    if (!project) project = await this.deps.projects.create({ name: 'LPDDR6 Xiaomi 16Gb VPERI 개발', description: `${SAMPLE_MARKER} · Agent Native 기능 확인용 샘플`, onboardingAnswers: { evaluationTarget: 'VPERI 불량 검출 조건과 개선 전압 확인', importantMetadata: 'material, sample, lot, DQ, BL, channel, pattern, temperature, VDD, frequency, test mode', reuseRules: '@FAIL/training/reboot/halt 우선 판정; @PASS 확정' } })
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
    const ids = (fragment: string): string[] => connected.artifacts.filter((item) => item.relativePath.includes(fragment)).map((item) => item.sourceId)
    const idsWhere = (match: (name: string) => boolean): string[] => connected.artifacts.filter((item) => match(item.relativePath)).map((item) => item.sourceId)
    connected = await this.deps.projects.save({
      projectId: connected.id, expectedRevision: connected.revision,
      equipmentProfiles: [{ alias: 'SM-8975', profileId: 'qualcomm-default', vendor: 'qualcomm', socModels: ['SM-8975'], filenameAliases: ['SM8975', 'SM-8975'], updatedAt: stamp }],
      lpddrDevelopmentContext: { product: 'LPDDR6', skew: 'SS', customer: 'Xiaomi', targetDevice: 'Mobile flagship', densityGb: 16, nominalVoltage: 1.295, program: 'VPERI 개선', phase: 'Development' },
      failureHypotheses: [
        { id: 'sample-h-vperi-dq9', title: '고온 VPERI DQ9 집중', description: '85°C, VDD 1.295V에서 DQ9 fail이 반복됨. VPERI 동일 기인은 엔지니어 확인 전 가설.', origin: 'ai-proposed', evaluationNodeIds: ['sample-n-screen', 'sample-n-screen-rt2', 'sample-n-vdd-up'] },
        { id: 'sample-h-retention', title: '105°C retention DQ4', description: '동일 조건 2개 중 1개 halt. 추가 반복 필요.', origin: 'engineer-confirmed', evaluationNodeIds: ['sample-n-retention'] }
      ],
      evaluationNodes: [
        { id: 'sample-n-screen', hypothesisId: 'sample-h-vperi-dq9', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'baseline', relationConfidence: 1, relationReason: '초기 VPERI DQ9 불량 평가', evaluationScopeId: roots.get('screen')!.rootId, name: 'VPERI 불량 가속 조건 확인', purpose: 'screening', dimensions: { skew: 'SS', lot: 'A1', material: 'WAF12', die: '03', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', dq: 9, bl: 16, channel: 0, subChannel: 0, rank: 0, bankGroup: 1, bank: 2, pattern: 'WR', frequencyMHz: 9600, temperatureC: 85, vdd: 1.295, testMode: 'VPERI' }, interpretation: '85°C·VDD 1.295V의 WR 평가에서 DQ9 실패가 2/2로 확인됐습니다. 검출 조건으로는 유효하지만 동일 기인 확정에는 비교 조건이 더 필요합니다.', authorship: 'agent', reviewState: 'confirmed', sequenceSignature: 'sample-vperi-screen', attemptNo: 1, status: 'fail' },
        { id: 'sample-n-screen-rt2', hypothesisId: 'sample-h-vperi-dq9', parentId: 'sample-n-screen', retestOf: 'sample-n-screen', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'retest', relationConfidence: 1, relationReason: '같은 Sample·Sequence·조건의 재평가', evaluationScopeId: roots.get('retest')!.rootId, name: 'SMP-01 동일 조건 RT2', purpose: 'reproduction', dimensions: { sample: '01' }, interpretation: '같은 Sample과 Sequence로 재평가했지만 다시 실패했습니다. 단발성 오류보다는 반복 가능한 불량 가능성이 높습니다.', authorship: 'engineer', reviewState: 'confirmed', sequenceSignature: 'sample-vperi-screen', attemptNo: 2, status: 'fail' },
        { id: 'sample-n-vdd-up', hypothesisId: 'sample-h-vperi-dq9', parentId: 'sample-n-screen-rt2', branchId: 'issue:sample-h-vperi-dq9:main', relation: 'improvement', relationConfidence: 1, relationReason: '동일 불량의 VDD 개선 조건 비교', evaluationScopeId: roots.get('improvement')!.rootId, name: 'VDD 1.315V 개선 확인', purpose: 'improvement', dimensions: { skew: 'SS', lot: 'A1', material: 'WAF12', die: '03', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', dq: 9, bl: 16, channel: 0, subChannel: 0, rank: 0, bankGroup: 1, bank: 2, pattern: 'WR', frequencyMHz: 9600, temperatureC: 85, vdd: 1.315, testMode: 'VPERI' }, interpretation: 'VDD를 1.315V로 높인 조건에서는 2/2 PASS로 바뀌었습니다. 개선 경향은 보이지만 전압 효과를 확정하려면 중간 전압과 반복 평가가 필요합니다.', authorship: 'agent', reviewState: 'confirmed', status: 'pass' },
        { id: 'sample-n-retention', hypothesisId: 'sample-h-retention', branchId: 'issue:sample-h-retention:main', relation: 'baseline', relationConfidence: .78, relationReason: 'VPERI와 Fail signature가 달라 별도 Retention 이슈로 분류', evaluationScopeId: roots.get('retention')!.rootId, name: '고온 retention 재현', purpose: 'characterization', dimensions: { skew: 'SS', lot: 'C2', material: 'WAF31', socVendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', dq: 4, bl: 16, channel: 2, subChannel: 1, rank: 0, bankGroup: 2, bank: 4, pattern: 'MARCH', frequencyMHz: 9600, temperatureC: 105, vdd: 1.295, testMode: 'RETENTION' }, interpretation: '105°C retention에서 2회 중 1회 halt와 DQ4 marker가 확인됐습니다. 분모가 작아 추가 반복 전에는 경향으로만 유지합니다.', authorship: 'agent', reviewState: 'proposed', status: 'inconclusive' }
      ],
      evidenceRecords: [
        { id: 'sample-e-screen-fail', evaluationNodeId: 'sample-n-screen', occurredAt: stamp, status: 'fail', result: '2/2 FAIL at DQ9', sourceIds: idsWhere((name) => name.includes('T85_VDD1p295_F9600_TM-VPERI') && !name.includes('RT2')), note: '결정 규칙 @FAIL; 85°C 최초 평가 분모 2, 실패 2', origin: 'engineer-confirmed' },
        { id: 'sample-e-screen-rt2', evaluationNodeId: 'sample-n-screen-rt2', occurredAt: stamp, status: 'fail', result: 'RT2 FAIL', sourceIds: ids('RT2_FAIL'), note: '동일 Sample·Sequence의 이전 FAIL 평가에 연결', origin: 'engineer-confirmed' },
        { id: 'sample-e-vdd-pass', evaluationNodeId: 'sample-n-vdd-up', occurredAt: stamp, status: 'pass', result: '2/2 PASS at VDD 1.315V', sourceIds: ids('VDD1p315'), note: '전압 상향 조건 분모 2, PASS 2. 개선 인과는 추가 반복 필요.', origin: 'engineer-confirmed' },
        { id: 'sample-e-retention-fail', evaluationNodeId: 'sample-n-retention', occurredAt: stamp, status: 'fail', result: '1 HALT / 2 runs', sourceIds: ids('TM-RETENTION'), note: '105°C retention에서 halt 1건; DQ4 marker', origin: 'engineer-confirmed' }
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
      evaluationNodes: [{ id: 'ref-n-vperi', hypothesisId: 'ref-h-vperi', branchId: 'closed-vperi', name: 'LPDDR5 VPERI DQ9 screening', purpose: 'screening', dimensions: { skew: 'TT', material: 'REF-WAF8', dq: 9, pattern: 'WR', temperatureC: 85, vdd: 1.1, testMode: 'VPERI' }, status: 'fail' }],
      evidenceRecords: []
    })
    await this.deps.projects.archive({ projectId: reference.id, expectedRevision: reference.revision })
  }
}
