import { basename } from 'node:path'
import type {
  ArtifactEvidenceSpec, ArtifactRecord, EngineerBootProfileBindingView, EngineerConsolePromptRuleView, EngineerWorkflowMemoryView, ProjectEquipmentProfile, ProjectEvaluationDimensions, ProjectSnapshot
} from '../shared/contracts'
import { inferEvaluationTrends, type EvaluationDimensions, type EvaluationMemory, type EvaluationPurpose, type EvaluationStatus } from '../../src/domain/evaluation-memory'
import { evaluationRelationLabel, suggestEvaluationRelation } from '../../src/domain/evaluation-relation'
import { stableHash } from '../../src/domain/fingerprint'
import { bootProfile, normalizedEvaluationStem } from '../../src/domain/soc-profile'
import { extractLpddrFilenameDimensions, projectSocContext } from '../../src/domain/lpddr-filename-dimensions'
import { classifyConsoleLine, consolePromptSearchPattern } from '../../src/domain/console-transcript'
import { engineerWorkflowContextCompatibility } from '../../src/domain/engineer-behavior'
import { extractLpddrFailureAddress, extractLpddrGridLineEvent } from '../../src/domain/lpddr-evaluation-baseline'
import type { ArtifactService } from './artifact-service'
import type { NativeAgentStore } from './native-agent-store'
import type { ProjectStore } from './project-store'

export type LpddrAgentToolName =
  | 'project_context_get' | 'project_history_get' | 'evaluation_relation_suggest' | 'similar_case_search'
  | 'search_history_get' | 'engineer_workflow_memory_get' | 'engineer_workflow_apply' | 'filename_dimensions_scan' | 'soc_boot_profile_scan' | 'console_transcript_scan' | 'pass_fail_scan'
  | 'evaluation_grid_scan' | 'log_search' | 'log_read_window' | 'failure_trends_get'

export interface LpddrAgentToolCall { name: LpddrAgentToolName; args?: Record<string, unknown> }
export interface LpddrAgentToolResult {
  name: LpddrAgentToolName
  label: string
  summary: string
  data: unknown
  evidenceSourceIds: string[]
}

export const LPDDR_AGENT_TOOL_DESCRIPTIONS: Record<LpddrAgentToolName, string> = {
  project_context_get: '현재 프로젝트의 제품, 고객, 개발 단계와 사용자가 확정한 분석 목표를 조회합니다.',
  project_history_get: '현재 프로젝트의 불량 이슈, 평가 관계, 평가 결과와 근거 연결을 조회합니다.',
  evaluation_relation_suggest: '현재 평가 폴더의 근거를 기존 불량 이슈와 비교해 RT, 조건 비교, 개선, 검증, Side effect 또는 분류 대기를 제안합니다. 저장하거나 자동 확정하지 않습니다.',
  similar_case_search: '다른 LPDDR5/LPDDR6 프로젝트에서 제목과 가설, 평가 요약이 비슷한 사례를 찾습니다.',
  search_history_get: '엔지니어가 Ctrl-F/정규식으로 확인한 검색어와 일치 개수를 조회합니다.',
  engineer_workflow_memory_get: '엔지니어가 확정한 검색 순서, 있음/없음 조건, 평가 단계와 목적을 조회합니다.',
  engineer_workflow_apply: '확정된 분석 절차의 있음/없음 조건과 실제 로그 발생 순서를 선택 로그에 일괄 적용해 후보 판정을 계산합니다.',
  filename_dimensions_scan: '로그 파일명과 저장된 fingerprint에서 SoC, Boot profile, SKEW, Die, Sample, DRAM 위치, Sequence signature와 명령 후보를 추출합니다.',
  soc_boot_profile_scan: '파일명에서 선택한 Qualcomm/MediaTek profile의 단계 marker를 검사하고 로그가 도달한 부팅 구간을 반환합니다.',
  console_transcript_scan: '콘솔 prompt 뒤의 엔지니어 입력과 장비 출력·상태 marker를 분리하고, 프로젝트에서 확정한 prompt 규칙을 적용합니다.',
  pass_fail_scan: '모든 선택 로그를 한 번씩 읽어 PASS, FAIL, training fail, reboot, halt, fast fail을 결정 규칙으로 분류합니다.',
  evaluation_grid_scan: '전원 인가 또는 명시된 Grid 경계를 기준으로 온도, VDD, 주파수, Test Mode, Sequence 명령과 종료 결과를 묶어 Grid 후보를 계산합니다.',
  log_search: '허용된 프로젝트 로그에서 문자열 또는 정규식을 검색하고 최대 12개 근거 위치를 반환합니다.',
  log_read_window: '검색으로 찾은 한 지점 주변을 최대 24줄만 읽습니다. 전체 로그 읽기는 허용되지 않습니다.',
  failure_trends_get: '선택 로그의 확정 Pass/Fail 분모와 Hdiag FAIL 본문의 Channel, Sub Channel, CS, BK, RK, BG, Row, Col, WR, RD, DQ, BL을 함께 사용해 조건별 실패 집중도와 Fail 주소 분포를 계산합니다.'
}

const safe = (value: unknown, max = 500): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''
const promptSafe = (value: unknown, max = 500): string => safe(value, max).replace(
  /((?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*)([^\s,;]+)/gi,
  '$1[REDACTED]',
)
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const agentDimensionView = (dimensions: ProjectEvaluationDimensions | undefined) => ({ ...dimensions })
const AGENT_DIMENSION_LABELS: Record<string, string> = {
  skew: 'SKEW', timingSkewPs: 'Timing SKEW (ps)', temperatureC: '온도', frequencyMHz: '주파수',
  testMode: 'Mode', material: '자재 (Sample)', sample: '자재 (Sample)', die: 'Die', lot: 'Lot', socModel: 'SoC', bootProfileId: 'Boot profile',
  equipmentChannel: '실장기 채널', eccMode: 'ECC', customCondition: '사용자 조건', evaluationStep: '평가 Step',
  channel: 'Channel', subChannel: 'Sub Channel', chipSelect: 'CS', rank: 'Rank', bankGroup: 'Bank Group', bank: 'Bank', row: 'Row', column: 'Column',
  dq: 'DQ', bl: 'BL', pattern: 'Pattern', writeData: 'WR', readData: 'RD', gridId: 'Grid', temperatureCorner: '온도 조건', vdd: 'VDD', vddCorner: 'VDD 조건', conditionCorner: '4-Corner',
}
const agentDimensionName = (dimension: string) => AGENT_DIMENSION_LABELS[dimension] ?? dimension
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bootAliasPattern = (alias: string): string => {
  const body = regexEscape(alias).replace(/ +/g, '[ _-]*')
  return `(?:^|[^A-Z0-9])${body}(?:[^A-Z0-9]|$)`
}
export { extractLpddrFilenameDimensions } from '../../src/domain/lpddr-filename-dimensions'

export interface LpddrSourceEngineeringContext {
  dimensions: ProjectEvaluationDimensions
  sequenceSignature: string
  commandSignatures: string[]
  explicitRetest: boolean
  filenameAttemptNo?: number
}

export function sourceEngineeringContext(fileName: string, artifact?: ArtifactRecord, profiles: readonly ProjectEquipmentProfile[] = []): LpddrSourceEngineeringContext {
  const soc = projectSocContext(fileName, profiles)
  const parsedSignature = artifact?.fingerprint?.commandCount ? artifact.fingerprint.structuralHash : undefined
  const fallback = normalizedEvaluationStem(fileName)
  return {
    dimensions: extractLpddrFilenameDimensions(fileName, profiles),
    sequenceSignature: parsedSignature ? `seq:${parsedSignature}` : `name:${stableHash(fallback)}`,
    commandSignatures: [...new Set(artifact?.fingerprint?.commandSignatures ?? [])].slice(0, 40),
    explicitRetest: soc.explicitRetest,
    ...(soc.attemptNo ? { filenameAttemptNo: soc.attemptNo } : {}),
  }
}

function sourceContextWithBinding(fileName: string, artifact: ArtifactRecord | undefined, profiles: readonly ProjectEquipmentProfile[], binding?: EngineerBootProfileBindingView): LpddrSourceEngineeringContext {
  const context = sourceEngineeringContext(fileName, artifact, profiles)
  if (context.dimensions.socVendor || !binding) return context
  return { ...context, dimensions: { ...context.dimensions, socVendor: binding.vendor, bootProfileId: binding.profileId } }
}

/** A confirmed procedure from another folder is reusable only as a candidate.
 * Require at least one stable test-context match and reject known boot/test
 * conflicts; sweep variables such as VDD/temperature/frequency do not block it. */
export function engineerWorkflowCompatibility(
  workflow: Pick<EngineerWorkflowMemoryView, 'dimensions'>,
  dimensions: Partial<ProjectEvaluationDimensions>,
): number | null {
  return engineerWorkflowContextCompatibility(workflow, dimensions)
}

export const LPDDR_STATUS_SPECS: ArtifactEvidenceSpec[] = [
  { id: 'at-pass', query: '@PASS', mode: 'literal' },
  { id: 'at-fail', query: '@FAIL', mode: 'literal' },
  { id: 'stress-pass', query: 'stressapp(?:test)?[^\n]{0,80}\bPASS\b', mode: 'regex', caseSensitive: false },
  { id: 'diag-start', query: '(?:HIDAG|HI_DIAG|DIAG(?:NOSTIC)?)[^\n]{0,80}(?:START|BEGIN|RUN)', mode: 'regex', caseSensitive: false },
  { id: 'training-fail', query: '(?:TRAINING|TRAIN)[ _:-]*FAIL', mode: 'regex', caseSensitive: false },
  // An operator-issued UEFI reset is a sequence command, not a failure. Only
  // explicit watchdog/reboot-result evidence is classified as SYSTEM_REBOOT.
  { id: 'reboot', query: '(?:SYSTEM[ _-]*REBOOT|WATCHDOG|REBOOT_REASON)', mode: 'regex', caseSensitive: false },
  { id: 'halt', query: '(?:SYSTEM[ _-]*HALT|CPU[ _-]*HALT|FATAL EXCEPTION|KERNEL PANIC)', mode: 'regex', caseSensitive: false },
  { id: 'fast-fail', query: '(?:FAST[ _-]*FAIL|FAIL[ _-]*FAST|EARLY[ _-]*EXIT)', mode: 'regex', caseSensitive: false },
  { id: 'normal-end', query: '(?:TEST|SEQUENCE|RUN)[ _:-]*(?:COMPLETE|END|DONE)', mode: 'regex', caseSensitive: false }
]

export function classifyLpddrStatus(counts: Record<string, number>): { status: string; confidence: number; reason: string; fastFail?: boolean } {
  if (counts['training-fail'] > 0) return { status: 'TRAINING_FAIL', confidence: 0.99, reason: 'training fail marker 검출' }
  if (counts['at-fail'] > 0) return { status: 'TEST_FAIL', confidence: 0.99, reason: counts['fast-fail'] > 0 ? '@FAIL 및 fast fail marker 검출' : '@FAIL marker 검출', ...(counts['fast-fail'] > 0 ? { fastFail: true } : {}) }
  if (counts.reboot > 0) return { status: 'SYSTEM_REBOOT', confidence: 0.97, reason: 'reboot/watchdog marker 검출' }
  if (counts.halt > 0) return { status: 'SYSTEM_HALT', confidence: 0.97, reason: 'halt/fatal marker 검출' }
  if (counts['at-pass'] > 0) return { status: 'PASS', confidence: 0.99, reason: '@PASS marker 검출' }
  if (counts['diag-start'] > 0 && counts['at-pass'] === 0 && counts['at-fail'] === 0) {
    return { status: 'SYSTEM_HALT', confidence: 0.88, reason: 'diag 시작 후 종료 판정 marker 없음' }
  }
  if (counts['stress-pass'] > 0 && counts['normal-end'] > 0) return { status: 'PASS', confidence: 0.85, reason: 'stress PASS와 정상 종료 marker 검출' }
  return { status: 'INCOMPLETE', confidence: 0.55, reason: '확정 가능한 종료 marker 부족' }
}

export class LpddrAgentToolService {
  constructor(private readonly deps: {
    artifacts: Pick<ArtifactService, 'list' | 'search' | 'lineWindow' | 'inspectEvidence'>
    projects: Pick<ProjectStore, 'get' | 'list'>
    agentStore: Pick<NativeAgentStore, 'searchHistory' | 'workflowMemories' | 'conversationHistory' | 'attemptHistory' | 'commandKnowledge' | 'profileBindings' | 'consolePromptRules'>
  }) {}

  async execute(projectId: string, call: LpddrAgentToolCall, allowedSourceIds?: string[]): Promise<LpddrAgentToolResult> {
    const project = await this.project(projectId)
    const allowed = this.sources(project, allowedSourceIds)
    switch (call.name) {
      case 'project_context_get': return this.context(project, allowed)
      case 'project_history_get': return this.history(project, allowed)
      case 'evaluation_relation_suggest': return this.relationSuggestion(project, allowed, call.args)
      case 'similar_case_search': return this.similar(project, safe(call.args?.query, 240))
      case 'search_history_get': return this.searchHistory(project, allowed)
      case 'engineer_workflow_memory_get': return this.workflowMemory(project, allowed)
      case 'engineer_workflow_apply': return this.applyWorkflow(project, allowed, call.args)
      case 'filename_dimensions_scan': return this.filenames(project, allowed)
      case 'soc_boot_profile_scan': return this.bootProfiles(project, allowed)
      case 'console_transcript_scan': return this.consoleTranscript(project, allowed)
      case 'pass_fail_scan': return this.statuses(allowed)
      case 'evaluation_grid_scan': return this.gridSequence(allowed)
      case 'log_search': return this.search(allowed, call.args)
      case 'log_read_window': return this.window(allowed, call.args)
      case 'failure_trends_get': return this.trends(project, allowed)
      default: throw new Error('허용되지 않은 에이전트 도구입니다.')
    }
  }

  private async project(projectId: string): Promise<ProjectSnapshot> {
    const project = await this.deps.projects.get(safe(projectId, 160))
    if (!project) throw new Error('프로젝트를 찾을 수 없습니다.')
    return project
  }

  private sources(project: ProjectSnapshot, requested?: string[]): ProjectSnapshot['artifacts'] {
    const wanted = requested?.length ? new Set(requested.map((item) => safe(item, 160))) : null
    const sources = project.artifacts.filter((source) => !wanted || wanted.has(source.sourceId)).slice(0, 100)
    if (wanted && sources.length !== wanted.size) throw new Error('프로젝트에 속하지 않은 로그가 포함되어 있습니다.')
    return sources
  }

  private context(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): LpddrAgentToolResult {
    const savedLayouts = project.exportPresets.filter((item) => !item.archived).slice(-10).map((item) => {
      if (item.id === 'sequence-control-tower.results-export.v1') {
        return { id: item.id, name: item.name, format: item.format, columns: Array.isArray(item.options.columns) ? item.options.columns.slice(0, 32) : [] }
      }
      if (item.id === 'sequence-control-tower.patterns-layout.v1') {
        return {
          id: item.id, name: item.name, format: item.format,
          rowAxes: Array.isArray(item.options.rowAxes) ? item.options.rowAxes.slice(0, 3) : [],
          columnAxes: Array.isArray(item.options.columnAxes) ? item.options.columnAxes.slice(0, 3) : [],
          aggregation: item.options.aggregation,
          visualization: item.options.visualization,
          dataBasis: item.options.dataBasis,
        }
      }
      return { id: item.id, name: item.name, format: item.format }
    })
    const evaluationScopeIds = [...new Set(sources.map((source) => source.rootId))]
    const folderLabels = new Map(project.folders.map((folder) => [folder.rootId, promptSafe(folder.displayLabel, 160)]))
    const scopedNodes = (project.evaluationNodes ?? []).filter((node) => node.evaluationScopeId && evaluationScopeIds.includes(node.evaluationScopeId))
    const latestScopedNode = [...scopedNodes].reverse()[0]
    const currentNode = [...scopedNodes].reverse().find((node) => node.reviewState === 'confirmed')
    const onboarding = currentNode
      ? project.onboardingAnswers
      : project.onboardingAnswers ? {
          importantMetadata: project.onboardingAnswers.importantMetadata,
          reuseRules: project.onboardingAnswers.reuseRules,
        } : undefined
    const data = {
      name: project.name, description: project.description, ...project.lpddrDevelopmentContext, onboarding,
      contextScope: 'project',
      currentEvaluation: {
        folders: evaluationScopeIds.map((scopeId) => folderLabels.get(scopeId) ?? '연결 폴더'), logCount: sources.length, confirmed: Boolean(currentNode),
        ...(currentNode ? { name: currentNode.name, purpose: currentNode.purpose, interpretation: currentNode.interpretation } : {}),
        ...(!currentNode && latestScopedNode ? {
          proposal: { name: latestScopedNode.name, purpose: latestScopedNode.purpose, interpretation: latestScopedNode.interpretation },
        } : {}),
      },
      savedLayouts,
    }
    return { name: 'project_context_get', label: '프로젝트 조건', summary: `${project.name} · 선택 폴더 로그 ${sources.length}개 · 저장된 평가 ${project.evaluationNodes?.length ?? 0}건`, data, evidenceSourceIds: [] }
  }

  private history(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): LpddrAgentToolResult {
    const allowed = new Set(sources.map((source) => source.sourceId))
    const currentScopeIds = new Set(sources.map((source) => source.rootId))
    // Project history is structured memory, not raw-log access. Return every
    // bounded evaluation so the Agent can connect reproduction, screening and
    // improvement folders, while omitting other folders' source identifiers.
    const nodes = (project.evaluationNodes ?? []).slice(-100)
    const folderLabels = new Map(project.folders.map((folder) => [folder.rootId, promptSafe(folder.displayLabel, 160)]))
    const linkedNodes = nodes.filter((item) => Boolean(item.evaluationScopeId && folderLabels.has(item.evaluationScopeId)))
    const unlinkedNodes = nodes.filter((item) => !item.evaluationScopeId || !folderLabels.has(item.evaluationScopeId))
    const nodeIds = new Set(linkedNodes.map((item) => item.id))
    const evidence = (project.evidenceRecords ?? []).filter((item) => nodeIds.has(item.evaluationNodeId)).slice(-200)
    const hypothesisIds = new Set(linkedNodes.map((item) => item.hypothesisId))
    const hypothesisNames = new Map((project.failureHypotheses ?? []).map((item) => [item.id, promptSafe(item.title, 240)]))
    const nodeNames = new Map(linkedNodes.map((item) => [item.id, promptSafe(item.name, 240)]))
    const folderName = (scopeId?: string): string => scopeId ? folderLabels.get(scopeId) ?? '연결 폴더' : '폴더 미지정'
    const data = {
      lineageRule: '같은 issue의 평가만 한 흐름입니다. relation은 평가를 이어간 이유이며 previousEvaluation은 직접 연결입니다. 배열 순서는 시간 흐름이 아닙니다.',
      currentFolders: [...currentScopeIds].map(folderName),
      hypotheses: (project.failureHypotheses ?? []).filter((item) => hypothesisIds.has(item.id)).slice(-50)
        .map((item) => ({
          title: promptSafe(item.title, 240), description: promptSafe(item.description, 1_000), origin: item.origin,
          evaluationCount: item.evaluationNodeIds?.filter((nodeId) => nodeIds.has(nodeId)).length ?? 0,
        })),
      nodes: linkedNodes.map((item) => ({
        folder: folderName(item.evaluationScopeId), name: promptSafe(item.name, 240),
        issue: item.hypothesisId ? hypothesisNames.get(item.hypothesisId) : undefined,
        relation: item.relation, relationReason: promptSafe(item.relationReason, 500),
        purpose: item.purpose, status: item.status, interpretation: promptSafe(item.interpretation, 1_000),
        dimensions: agentDimensionView(item.dimensions), authorship: item.authorship, reviewState: item.reviewState,
        attemptNo: item.attemptNo, retest: Boolean(item.retestOf),
        ...(item.parentId && nodeNames.has(item.parentId) ? { previousEvaluation: nodeNames.get(item.parentId) } : {}),
        current: Boolean(item.evaluationScopeId && currentScopeIds.has(item.evaluationScopeId)),
      })),
      unlinkedEvaluations: unlinkedNodes.map((item) => ({
        name: promptSafe(item.name, 240), purpose: item.purpose, status: item.status,
        reviewState: item.reviewState, action: '폴더 연결 필요',
      })),
      evidence: evidence.map((item) => ({
        evaluation: nodeNames.get(item.evaluationNodeId) ?? '연결 평가', occurredAt: item.occurredAt,
        status: item.status, result: promptSafe(item.result, 120), dimensions: agentDimensionView(item.dimensions),
        note: promptSafe(item.note, 500), origin: item.origin, sourceCount: item.sourceIds.length,
        current: item.sourceIds.some((sourceId) => allowed.has(sourceId)),
      }))
    }
    const currentNodes = data.nodes.filter((item) => item.current).length
    const linkedLogCount = new Set(evidence.flatMap((item) => item.sourceIds)).size
    return {
      name: 'project_history_get', label: '평가 이력',
      summary: `저장된 평가 ${data.nodes.length}건 · 선택 폴더 기록 ${currentNodes}건 · 연결 로그 ${linkedLogCount}개${data.unlinkedEvaluations.length ? ` · 폴더 연결 필요 ${data.unlinkedEvaluations.length}건` : ''}`,
      data,
      evidenceSourceIds: [...new Set(evidence.filter((item) => item.sourceIds.some((sourceId) => allowed.has(sourceId))).flatMap((item) => item.sourceIds.filter((sourceId) => allowed.has(sourceId))))],
    }
  }

  private async relationSuggestion(
    project: ProjectSnapshot,
    sources: ProjectSnapshot['artifacts'],
    args: Record<string, unknown> | undefined,
  ): Promise<LpddrAgentToolResult> {
    if (!sources.length) return { name: 'evaluation_relation_suggest', label: '평가 관계 제안', summary: '비교할 평가 폴더 로그 없음', data: { classification: 'pending' }, evidenceSourceIds: [] }
    const scopeIds = [...new Set(sources.map((source) => source.rootId))]
    if (scopeIds.length !== 1) throw new Error('평가 관계는 한 폴더 범위에서만 제안할 수 있습니다.')
    const scopeId = scopeIds[0]
    const folderLabel = promptSafe(project.folders.find((folder) => folder.rootId === scopeId)?.displayLabel, 160) || '현재 평가'
    const purposes = new Set<EvaluationPurpose>(['screening', 'improvement', 'reproduction', 'characterization', 'verification', 'stage-verification'])
    const requestedPurpose = safe(args?.purpose, 80) as EvaluationPurpose
    const inferredPurpose: EvaluationPurpose | undefined = /(?:retest|\brt\d*\b|재현|repeat)/i.test(folderLabel) ? 'reproduction'
      : /(?:improv|개선|완화)/i.test(folderLabel) ? 'improvement'
        : /(?:verif|안정성|효과\s*검증)/i.test(folderLabel) ? 'verification'
          : /(?:screen|검출|가속)/i.test(folderLabel) ? 'screening'
            : /(?:boot|training|부팅|uefi|post.?pbl|lk2?)/i.test(folderLabel) ? 'stage-verification'
              : /(?:trend|character|경향|split|갈라치기)/i.test(folderLabel) ? 'characterization' : undefined
    const purpose = purposes.has(requestedPurpose) ? requestedPurpose : inferredPurpose

    const [artifacts, bindings, trendResult] = await Promise.all([
      this.deps.artifacts.list(),
      this.deps.agentStore.profileBindings(project.id),
      this.trends(project, sources),
    ])
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const contexts = sources.map((source) => sourceContextWithBinding(
      source.relativePath, artifactById.get(source.artifactId), project.equipmentProfiles,
      bindings.find((item) => item.sourceIds.includes(source.sourceId)),
    ))
    const dimensions: EvaluationDimensions = {}
    const dimensionKeys = Object.keys(AGENT_DIMENSION_LABELS) as Array<keyof EvaluationDimensions>
    dimensionKeys.forEach((key) => {
      const values = [...new Set(contexts.flatMap((context) => context.dimensions[key] === undefined ? [] : [context.dimensions[key]]))]
      if (values.length === 1) Object.assign(dimensions, { [key]: values[0] })
    })
    const trendData = trendResult.data as {
      numerator?: number; denominator?: number
      failAddress?: { distribution?: Array<{ dimension?: string; value?: string; eventShare?: number; sourceCount?: number }> }
    }
    const dimensionKeyByLabel = new Map(Object.entries(AGENT_DIMENSION_LABELS).map(([key, label]) => [label, key as keyof EvaluationDimensions]))
    for (const item of trendData.failAddress?.distribution ?? []) {
      const key = item.dimension ? dimensionKeyByLabel.get(item.dimension) : undefined
      if (!key || (item.eventShare ?? 0) < .5 || (item.sourceCount ?? 0) < 1 || dimensions[key] !== undefined) continue
      Object.assign(dimensions, { [key]: item.value })
    }
    const deterministicStatus: EvaluationStatus | undefined = trendData.denominator
      ? trendData.numerator === 0 ? 'pass' : trendData.numerator === trendData.denominator ? 'fail' : 'inconclusive'
      : undefined
    const requestedStatus = safe(args?.status, 40) as EvaluationStatus
    const status = deterministicStatus ?? (['pass', 'fail', 'inconclusive', 'running'].includes(requestedStatus) ? requestedStatus : undefined)
    const sequenceSignatures = [...new Set(contexts.map((context) => context.sequenceSignature).filter(Boolean))]
    const memory: EvaluationMemory = {
      project: { id: project.id, name: project.name, ...project.lpddrDevelopmentContext },
      hypotheses: (project.failureHypotheses ?? []).map((item) => ({ ...item, projectId: project.id })),
      nodes: (project.evaluationNodes ?? []).map((item) => ({ ...item, projectId: project.id })),
      evidence: (project.evidenceRecords ?? []).map((item) => ({ ...item, projectId: project.id })),
    }
    const suggestion = suggestEvaluationRelation(memory, {
      evaluationScopeId: scopeId,
      name: folderLabel,
      purpose,
      status,
      dimensions,
      ...(sequenceSignatures.length === 1 ? { sequenceSignature: sequenceSignatures[0] } : {}),
      ...(safe(args?.interpretation, 800) ? { interpretation: safe(args?.interpretation, 800) } : {}),
    })
    const previous = suggestion.candidateNodeId
      ? memory.nodes.find((node) => node.id === suggestion.candidateNodeId)?.name
      : undefined
    const result = {
      classification: suggestion.classification,
      relation: suggestion.relation,
      issue: suggestion.candidateTitle,
      previousEvaluation: previous,
      suggestedIssueTitle: suggestion.suggestedIssueTitle,
      confidence: suggestion.confidence,
      reason: suggestion.reason,
      currentEvaluation: { folder: folderLabel, purpose, status, dimensions },
      confirmationRequired: true,
    }
    const summary = suggestion.classification === 'update-existing'
      ? `${folderLabel}의 기존 평가 기록 업데이트`
      : suggestion.classification === 'existing-issue'
        ? `${suggestion.candidateTitle ?? '기존 불량'} · ${evaluationRelationLabel(suggestion.relation)}`
        : suggestion.classification === 'new-issue'
          ? `새 불량 이슈 후보 · ${suggestion.suggestedIssueTitle}`
          : `분류 대기 · ${suggestion.candidateTitle ?? '연결 후보 미확인'}`
    return { name: 'evaluation_relation_suggest', label: '평가 관계 제안', summary, data: result, evidenceSourceIds: sources.map((source) => source.sourceId) }
  }

  private async similar(project: ProjectSnapshot, query: string): Promise<LpddrAgentToolResult> {
    const tokens = `${query} ${project.name} ${project.lpddrDevelopmentContext?.product ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2)
    const candidates = (await this.deps.projects.list(true)).filter((item) => item.id !== project.id).map((item) => {
      const text = [item.name, item.description, item.lpddrDevelopmentContext?.product, item.lpddrDevelopmentContext?.customer,
        ...(item.failureHypotheses ?? []).map((value) => value.title), ...(item.evaluationNodes ?? []).map((value) => value.name),
        ...(item.evidenceRecords ?? []).map((value) => `${value.result ?? ''} ${value.note ?? ''}`)].join(' ').toLowerCase()
      const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0)
      return { item, score }
    }).filter((value) => value.score > 0).sort((a, b) => b.score - a.score).slice(0, 5)
    const data = candidates.map(({ item, score }) => ({ projectId: item.id, project: item.name, product: item.lpddrDevelopmentContext?.product, score, hypotheses: (item.failureHypotheses ?? []).slice(-5).map((value) => value.title), evaluations: (item.evaluationNodes ?? []).slice(-8).map((value) => ({ name: value.name, status: value.status, dimensions: agentDimensionView(value.dimensions) })) }))
    return { name: 'similar_case_search', label: '유사 사례', summary: data.length ? `과거 프로젝트 ${data.length}개에서 유사 사례 발견` : '저장된 과거 프로젝트에서 유사 사례 없음', data, evidenceSourceIds: [] }
  }

  private async searchHistory(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const allowed = new Set(sources.map((source) => source.sourceId))
    const data = (await this.deps.agentStore.searchHistory(project.id, 100)).filter((item) => item.sourceIds.some((sourceId) => allowed.has(sourceId))).slice(0, 40)
    return { name: 'search_history_get', label: '검색 기록', summary: `최근 Ctrl-F/정규식 확인 ${data.length}건`, data, evidenceSourceIds: [...new Set(data.flatMap((item) => item.sourceIds))] }
  }

  private async workflowMemory(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const allowed = new Set(sources.map((source) => source.sourceId))
    const scopeIds = new Set(sources.map((source) => source.rootId))
    const [allWorkflows, allSearches, allConversation, allAttempts, commandKnowledge, profileBindings, consolePromptRules] = await Promise.all([
      this.deps.agentStore.workflowMemories(project.id, 50),
      this.deps.agentStore.searchHistory(project.id, 100),
      this.deps.agentStore.conversationHistory(project.id, 50),
      this.deps.agentStore.attemptHistory(project.id, 500),
      this.deps.agentStore.commandKnowledge(project.id, 100),
      this.deps.agentStore.profileBindings(project.id),
      this.deps.agentStore.consolePromptRules(project.id),
    ])
    const workflows = allWorkflows.filter((item) => item.evaluationScopeId ? scopeIds.has(item.evaluationScopeId) : item.sourceIds.some((sourceId) => allowed.has(sourceId)))
    const currentDimensions = sources.map((source) => {
      const binding = profileBindings.find((item) => item.sourceIds.includes(source.sourceId))
      return sourceContextWithBinding(source.relativePath, undefined, project.equipmentProfiles, binding).dimensions
    })
    const reusableCandidates = allWorkflows
      .filter((item) => !workflows.some((current) => current.id === item.id))
      .map((item) => {
        const scores = currentDimensions.map((dimensions) => engineerWorkflowCompatibility(item, dimensions))
        const compatibleScores = scores.filter((score): score is number => score !== null)
        return {
          item,
          compatibility: compatibleScores.length ? 'candidate' as const : 'incompatible' as const,
          matchedContextCount: compatibleScores.length ? Math.max(...compatibleScores) : 0,
        }
      })
      .sort((left, right) => Number(right.compatibility === 'candidate') - Number(left.compatibility === 'candidate')
        || right.matchedContextCount - left.matchedContextCount
        || right.item.updatedAt.localeCompare(left.item.updatedAt))
      .slice(0, 8)
    const recentSearches = allSearches.filter((item) => item.sourceIds.some((sourceId) => allowed.has(sourceId))).slice(0, 20)
    const conversation = allConversation.filter((item) => item.evaluationScopeId ? scopeIds.has(item.evaluationScopeId) : item.evidenceSourceIds?.some((sourceId) => allowed.has(sourceId))).slice(-20)
    const attempts = allAttempts.filter((item) => allowed.has(item.sourceId)).slice(0, 100)
    const data = {
      confirmed: workflows.map((item) => ({
        ...item,
        name: promptSafe(item.name, 160),
        purpose: promptSafe(item.purpose, 160),
        checks: item.checks.map((check) => ({ ...check, query: promptSafe(check.query) })),
      })),
      otherEvaluationCandidates: reusableCandidates.map(({ item, compatibility, matchedContextCount }) => ({
        name: promptSafe(item.name, 160), purpose: promptSafe(item.purpose, 160),
        result: item.result, stages: item.stages, dimensions: agentDimensionView(item.dimensions),
        checks: item.checks.map((check) => ({
          query: promptSafe(check.query), mode: check.mode, caseSensitive: check.caseSensitive,
          expected: check.expected, stage: check.stage, order: check.order,
        })),
        compatibility, matchedContextCount,
        note: compatibility === 'candidate'
          ? '현재 폴더에 자동 확정하지 않는 재사용 후보'
          : '현재 폴더의 안정 조건과 달라 직접 적용하지 않는 비교용 절차',
      })),
      recentSearches: recentSearches.map((item) => ({
        query: promptSafe(item.query), mode: item.mode, caseSensitive: item.caseSensitive,
        activeMatchCount: item.activeMatchCount, matchCount: item.matchCount, occurredAt: item.occurredAt,
      })),
      conversation: conversation.map((item) => ({ ...item, content: promptSafe(item.content, 4_000) })),
      attempts,
      commandKnowledge,
      profileBindings,
      consolePromptRules,
    }
    const applied = workflows.reduce((sum, item) => sum + item.appliedCount, 0)
    return {
      name: 'engineer_workflow_memory_get', label: '분석 절차 기억',
      summary: `현재 폴더 확정 절차 ${workflows.length}개 · 다른 평가 절차 ${reusableCandidates.length}개 · RT ${attempts.filter((item) => item.relation === 'retest').length}건 · 명령 지식 ${commandKnowledge.length}개 · 콘솔 형식 ${consolePromptRules.length}개`,
      data, evidenceSourceIds: [...new Set([
        ...workflows.flatMap((item) => item.sourceIds),
        ...conversation.flatMap((item) => item.evidenceSourceIds ?? []),
      ])],
    }
  }

  private async applyWorkflow(
    project: ProjectSnapshot,
    sources: ProjectSnapshot['artifacts'],
    args: Record<string, unknown> | undefined,
  ): Promise<LpddrAgentToolResult> {
    const requestedId = safe(args?.workflowId, 160)
    const [storedMemories, bindings] = await Promise.all([this.deps.agentStore.workflowMemories(project.id, 50), this.deps.agentStore.profileBindings(project.id)])
    const scopeIds = new Set(sources.map((source) => source.rootId))
    const sourceIds = new Set(sources.map((source) => source.sourceId))
    const detectedBySource = new Map(sources.map((source) => {
      const binding = bindings.find((item) => item.sourceIds.includes(source.sourceId))
      return [source.sourceId, sourceContextWithBinding(source.relativePath, undefined, project.equipmentProfiles, binding).dimensions] as const
    }))
    const sameScope = storedMemories
      .filter((item) => item.evaluationScopeId ? scopeIds.has(item.evaluationScopeId) : item.sourceIds.some((sourceId) => sourceIds.has(sourceId)))
    const crossScope = storedMemories
      .filter((item) => !sameScope.some((current) => current.id === item.id))
      .map((memory) => ({
        memory,
        score: Math.max(...[...detectedBySource.values()].map((dimensions) => engineerWorkflowCompatibility(memory, dimensions) ?? 0)),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .map((item) => item.memory)
    const memories = (sameScope.length ? sameScope : crossScope)
      .filter((item) => !requestedId || item.id === requestedId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, requestedId ? 1 : 3)
    if (!memories.length || !sources.length) return {
      name: 'engineer_workflow_apply', label: '분석 절차 적용',
      summary: memories.length ? '적용할 로그 없음' : '확정된 분석 절차 없음',
      data: { rows: [] }, evidenceSourceIds: [],
    }
    const dimensionKeys: Array<keyof ProjectEvaluationDimensions> = [
      'testMode', 'gridId', 'temperatureCorner', 'temperatureC', 'vddCorner', 'vdd', 'conditionCorner', 'frequencyMHz', 'die', 'skew', 'lot', 'sample', 'socModel', 'bootProfileId', 'equipmentChannel', 'eccMode', 'customCondition', 'evaluationStep',
      'dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bank', 'bankGroup', 'row', 'column', 'writeData', 'readData', 'pattern', 'timingSkewPs',
    ]
    const selectedBySource = new Map(sources.flatMap((source) => {
      const detected = detectedBySource.get(source.sourceId) ?? {}
      const ranked = memories.flatMap((memory) => {
        const isSameScope = memory.evaluationScopeId ? scopeIds.has(memory.evaluationScopeId) : memory.sourceIds.some((sourceId) => sourceIds.has(sourceId))
        if (!isSameScope && engineerWorkflowCompatibility(memory, detected) === null) return []
        return [{
        memory,
        score: dimensionKeys.filter((key) => detected[key] !== undefined && memory.dimensions?.[key] !== undefined
          && String(detected[key]) === String(memory.dimensions?.[key])).length,
        }]
      }).sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      return ranked[0] ? [[source.sourceId, ranked[0].memory] as const] : []
    }))
    const specIds = new Map<string, { memoryId: string; checkIndex: number }>()
    const specs: ArtifactEvidenceSpec[] = memories.flatMap((memory, memoryIndex) => memory.checks.slice(0, 20).map((check, checkIndex) => {
      const id = `workflow-${memoryIndex}-${checkIndex}`
      specIds.set(id, { memoryId: memory.id, checkIndex })
      return { id, query: check.query, mode: check.mode, caseSensitive: check.caseSensitive }
    }))
    const inspected = await this.deps.artifacts.inspectEvidence({
      sources: sources.map((source) => ({
        sourceId: source.sourceId, artifactId: source.artifactId,
        rootId: source.artifactRootId ?? source.rootId, relativePath: source.relativePath,
      })),
      specs,
    })
    const rows = inspected.sources.flatMap((source) => {
      const memory = selectedBySource.get(source.sourceId)
      if (!memory) return []
      const checks = memory.checks.map((check, checkIndex) => {
        const specId = [...specIds].find(([, value]) => value.memoryId === memory.id && value.checkIndex === checkIndex)?.[0]
        const evidence = source.evidence.find((item) => item.specId === specId)
        const count = evidence?.occurrenceCount ?? 0
        return { query: promptSafe(check.query), expected: check.expected, count, firstLine: evidence?.firstOccurrence?.lineNumber }
      })
      const expectationsMet = checks.every((check) => check.expected === 'present' ? check.count > 0 : check.count === 0)
      const presentLines = checks.filter((check) => check.expected === 'present').map((check) => check.firstLine)
      const orderMet = presentLines.every((line, index) => index === 0 || (line !== undefined && presentLines[index - 1] !== undefined && line > presentLines[index - 1]!))
      const scopeMatch = memory.evaluationScopeId ? scopeIds.has(memory.evaluationScopeId) : memory.sourceIds.some((sourceId) => sourceIds.has(sourceId))
      return [{
        sourceId: source.sourceId, workflowId: memory.id, purpose: promptSafe(memory.purpose, 160),
        stages: memory.stages, candidateResult: memory.result, matched: expectationsMet && orderMet,
        expectationsMet, orderMet, scopeMatch, checks,
      }]
    })
    const matched = rows.filter((row) => row.matched).length
    const transferred = rows.some((row) => !row.scopeMatch)
    return {
      name: 'engineer_workflow_apply', label: '분석 절차 적용',
      summary: transferred
        ? `유사 평가의 확정 절차 후보를 적용해 ${rows.length}개 중 ${matched}개가 조건과 순서에 일치`
        : `${rows.length}개 중 ${matched}개가 확정 절차의 조건과 순서에 일치`,
      data: { rows }, evidenceSourceIds: rows.map((row) => row.sourceId),
    }
  }

  private async filenames(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const [workflows, artifacts, bindings] = await Promise.all([this.deps.agentStore.workflowMemories(project.id, 50), this.deps.artifacts.list(), this.deps.agentStore.profileBindings(project.id)])
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const dimensions: Array<keyof ProjectEvaluationDimensions> = [
      'testMode', 'gridId', 'temperatureCorner', 'temperatureC', 'vddCorner', 'vdd', 'conditionCorner', 'frequencyMHz', 'die', 'skew', 'lot', 'sample', 'socModel', 'bootProfileId', 'equipmentChannel', 'eccMode', 'customCondition', 'evaluationStep',
      'dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bank', 'bankGroup', 'row', 'column', 'writeData', 'readData', 'pattern', 'timingSkewPs',
    ]
    const rows = sources.map((source) => {
      const binding = bindings.find((item) => item.sourceIds.includes(source.sourceId))
      const context = sourceContextWithBinding(source.relativePath, artifactById.get(source.artifactId), project.equipmentProfiles, binding)
      const detected = context.dimensions
      const workflowHints = workflows.flatMap((memory) => {
        const matched = dimensions.filter((dimension) => detected[dimension] !== undefined
          && memory.dimensions?.[dimension] !== undefined
          && String(detected[dimension]) === String(memory.dimensions?.[dimension]))
        return matched.length ? [{ workflowId: memory.id, purpose: promptSafe(memory.purpose, 160), stages: memory.stages, matchedDimensions: matched }] : []
      }).sort((a, b) => b.matchedDimensions.length - a.matchedDimensions.length).slice(0, 3)
      return { sourceId: source.sourceId, fileName: promptSafe(basename(source.relativePath), 240), dimensions: agentDimensionView(detected), sequenceSignature: context.sequenceSignature, commandSignatures: context.commandSignatures, explicitRetest: context.explicitRetest, filenameAttemptNo: context.filenameAttemptNo, workflowHints }
    })
    const detected = rows.filter((row) => Object.values(row.dimensions).some((value) => value !== undefined)).length
    return { name: 'filename_dimensions_scan', label: '파일명 조건 추출', summary: `${rows.length}개 중 ${detected}개에서 조건 후보 추출`, data: { project: project.name, rows }, evidenceSourceIds: rows.map((row) => row.sourceId) }
  }

  private async bootProfiles(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const bindings = await this.deps.agentStore.profileBindings(project.id)
    const contexts = sources.map((source) => {
      const detected = projectSocContext(source.relativePath, project.equipmentProfiles)
      const binding = bindings.find((item) => item.sourceIds.includes(source.sourceId))
      const soc = detected.vendor !== 'unknown' || !binding ? detected : { ...detected, vendor: binding.vendor, bootProfileId: binding.profileId as 'qualcomm-default' | 'mediatek-default', confidence: 1, evidence: 'engineer-confirmed project binding' }
      return { source, soc }
    })
    const specs: ArtifactEvidenceSpec[] = []
    const specProfiles = new Map<string, { profileId: string; stageId: string; order: number }>()
    for (const profileId of [...new Set(contexts.flatMap((item) => item.soc.bootProfileId ? [item.soc.bootProfileId] : []))]) {
      const profile = bootProfile(profileId)
      profile?.stages.forEach((stage, order) => {
        const id = `boot-${profile.id}-${stage.id}`
        specs.push({ id, query: stage.aliases.map(bootAliasPattern).join('|'), mode: 'regex', caseSensitive: false })
        specProfiles.set(id, { profileId: profile.id, stageId: stage.id, order })
      })
    }
    const inspected = specs.length ? await this.deps.artifacts.inspectEvidence({
      sources: sources.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, rootId: source.artifactRootId ?? source.rootId, relativePath: source.relativePath })), specs,
    }) : { sources: [] }
    const evidenceBySource = new Map(inspected.sources.map((source) => [source.sourceId, source.evidence]))
    const rows = contexts.map(({ source, soc }) => {
      const profile = bootProfile(soc.bootProfileId)
      const found = (evidenceBySource.get(source.sourceId) ?? []).flatMap((item) => {
        const meta = specProfiles.get(item.specId)
        return meta && meta.profileId === profile?.id && (item.occurrenceCount ?? 0) > 0
          ? [{ stage: meta.stageId, order: meta.order, count: item.occurrenceCount ?? 0, firstLine: item.firstOccurrence?.lineNumber }]
          : []
      }).sort((a, b) => a.order - b.order)
      return { sourceId: source.sourceId, vendor: soc.vendor, socModel: soc.socModel, bootProfileId: soc.bootProfileId, confidence: soc.confidence, stages: found, lastStage: found.at(-1)?.stage, explicitRetest: soc.explicitRetest }
    })
    const identified = rows.filter((row) => row.bootProfileId).length
    return { name: 'soc_boot_profile_scan', label: 'SoC · 부팅 구간', summary: `${rows.length}개 중 SoC profile ${identified}개 식별`, data: { rows }, evidenceSourceIds: rows.filter((row) => row.stages.length).map((row) => row.sourceId) }
  }

  private async statuses(sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    if (!sources.length) return { name: 'pass_fail_scan', label: 'Pass/Fail 규칙 검사', summary: '검사할 로그 없음', data: { rows: [] }, evidenceSourceIds: [] }
    const inspected = await this.deps.artifacts.inspectEvidence({
      sources: sources.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, rootId: source.artifactRootId ?? source.rootId, relativePath: source.relativePath })),
      specs: LPDDR_STATUS_SPECS
    })
    const rows = inspected.sources.map((source) => {
      const counts = Object.fromEntries(source.evidence.map((item) => [item.specId, item.occurrenceCount ?? 0]))
      return { sourceId: source.sourceId, fileName: promptSafe(source.fileName, 240), counts, ...classifyLpddrStatus(counts) }
    })
    const totals = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {})
    return { name: 'pass_fail_scan', label: 'Pass/Fail 규칙 검사', summary: Object.entries(totals).map(([key, value]) => `${key} ${value}`).join(' · '), data: { rules: LPDDR_STATUS_SPECS.map((item) => item.id), rows, totals }, evidenceSourceIds: rows.map((row) => row.sourceId) }
  }

  private async gridSequence(sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    if (!sources.length) return { name: 'evaluation_grid_scan', label: 'Grid · Sequence', summary: '확인할 로그 없음', data: { rows: [] }, evidenceSourceIds: [] }
    const result = await this.deps.artifacts.search({
      artifactIds: [...new Set(sources.map((source) => source.artifactId))],
      query: '(?:GRID(?:[_ ]?(?:START|BEGIN|END|ID|NO))?|POWER[ _-]?ON|PWR[ _-]?ON|setddrclk|clk\\.sh|dtvs|erase[ _]+ddr|(?:TEMP(?:ERATURE)?|VDD|TM|TEST[ _-]?MODE|MODE|FREQ(?:UENCY)?)[ =:_-]+|HIDAG|HDIAG|@PASS|@FAIL|TRAINING[ _:-]*FAIL|WATCHDOG|REBOOT_REASON|SYSTEM[ _-]*(?:HALT|REBOOT))',
      mode: 'regex', caseSensitive: false, maxMatches: 2_000, contextLines: 0,
    })
    const sourceIdsByArtifact = new Map<string, string[]>()
    sources.forEach((source) => sourceIdsByArtifact.set(source.artifactId, [...(sourceIdsByArtifact.get(source.artifactId) ?? []), source.sourceId]))
    const eventsBySource = new Map<string, Array<{ line: number; event: NonNullable<ReturnType<typeof extractLpddrGridLineEvent>> }>>()
    for (const match of result.matches) {
      const event = extractLpddrGridLineEvent(match.lineText)
      if (!event) continue
      for (const sourceId of sourceIdsByArtifact.get(match.artifactId) ?? []) {
        const events = eventsBySource.get(sourceId) ?? []
        events.push({ line: match.lineNumber, event })
        eventsBySource.set(sourceId, events)
      }
    }
    const rows = sources.map((source) => {
      const events = (eventsBySource.get(source.sourceId) ?? []).sort((left, right) => left.line - right.line)
      const grids: Array<{
        index: number; boundary: 'grid' | 'power-on' | 'implicit'; startLine: number; endLine: number
        conditions: Record<string, string | number>; commands: string[]; results: string[]
      }> = []
      let current: typeof grids[number] | undefined
      const open = (line: number, boundary: typeof grids[number]['boundary']) => {
        if (current) grids.push(current)
        current = { index: grids.length + 1, boundary, startLine: line, endLine: line, conditions: {}, commands: [], results: [] }
      }
      events.forEach(({ line, event }) => {
        if (event.boundary) open(line, event.boundaryKind ?? 'grid')
        if (!current) open(line, 'implicit')
        current!.endLine = line
        Object.entries(event.conditions).forEach(([key, value]) => { if (value !== undefined) current!.conditions[key] = value })
        if (event.command && !current!.commands.includes(event.command)) current!.commands.push(promptSafe(event.command, 240))
        if (event.result && !current!.results.includes(event.result)) current!.results.push(event.result)
      })
      if (current) grids.push(current)
      if (!grids.length) grids.push({ index: 1, boundary: 'implicit', startLine: 1, endLine: 1, conditions: {}, commands: [], results: [] })
      return {
        sourceId: source.sourceId,
        gridCount: grids.length,
        explicitBoundary: grids.some((grid) => grid.boundary !== 'implicit'),
        grids: grids.slice(0, 40).map((grid) => ({ ...grid, commands: grid.commands.slice(0, 20) })),
      }
    })
    const gridCount = rows.reduce((sum, row) => sum + row.gridCount, 0)
    const explicit = rows.filter((row) => row.explicitBoundary).length
    const conditionCount = rows.reduce((sum, row) => sum + row.grids.filter((grid) => Object.keys(grid.conditions).length > 0).length, 0)
    return {
      name: 'evaluation_grid_scan', label: 'Grid · Sequence',
      summary: `Grid 후보 ${gridCount}개 · 경계 확인 로그 ${explicit}/${rows.length} · 조건 확인 ${conditionCount}개${result.truncated ? ' · 일부 marker만 표시' : ''}`,
      data: {
        rows,
        unitRule: '명시된 Grid/Power-on 경계가 없으면 로그 파일 전체를 Grid 후보 1개로만 둡니다. 확정 Grid 수가 아닙니다.',
        truncated: result.truncated,
      },
      evidenceSourceIds: rows.filter((row) => row.grids.some((grid) => grid.results.length || grid.commands.length || Object.keys(grid.conditions).length)).map((row) => row.sourceId),
    }
  }

  private async consoleTranscript(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    if (!sources.length) return { name: 'console_transcript_scan', label: '콘솔 입력 구분', summary: '검사할 로그 없음', data: { commands: [], ambiguous: [] }, evidenceSourceIds: [] }
    const [rules, searches, artifacts] = await Promise.all([
      this.deps.agentStore.consolePromptRules(project.id),
      this.deps.agentStore.searchHistory(project.id, 80),
      this.deps.artifacts.list(),
    ])
    const decisions = rules.map((rule) => ({ promptSignature: rule.promptSignature, role: rule.role }))
    const sourceByArtifact = new Map(sources.map((source) => [source.artifactId, source]))
    const fingerprintByArtifact = new Map(artifacts.map((artifact) => [artifact.id, artifact.fingerprint]))
    const found = await this.deps.artifacts.search({
      artifactIds: [...new Set(sources.map((source) => source.artifactId))],
      query: consolePromptSearchPattern(), mode: 'regex', caseSensitive: false, maxMatches: 240, contextLines: 0,
    })
    const rows = found.matches.flatMap((match) => {
      const source = sourceByArtifact.get(match.artifactId)
      if (!source) return []
      const classified = classifyConsoleLine(match.lineText, decisions)
      if (!classified.prompt || (classified.role !== 'input' && classified.role !== 'ambiguous')) return []
      // A confirmed bare `#` shell prompt must not turn fixture/capture
      // metadata comments into operator commands. Real commands such as
      // `# sleep 20` still pass this narrow header guard.
      if (classified.prompt.promptKind === 'bare-root'
        && /^(?:SYNTHETIC(?:_[A-Z0-9]+)+|META(?:DATA)?\b|CORPUS\b|FIXTURE\b)/i.test(classified.prompt.command)) return []
      const searchedByEngineer = searches.some((event) => event.sourceIds.includes(source.sourceId)
        && (classified.prompt!.command.toLowerCase().includes(event.query.toLowerCase()) || event.query.toLowerCase().includes(classified.prompt!.command.toLowerCase())))
      return [{
        sourceId: source.sourceId, lineNumber: match.lineNumber, role: classified.role,
        promptKind: classified.prompt.promptKind, promptSignature: classified.prompt.promptSignature,
        command: promptSafe(classified.prompt.command, 500), confidence: classified.prompt.confidence, searchedByEngineer,
      }]
    })
    const commands = rows.filter((row) => row.role === 'input').slice(0, 80)
    const ambiguous = rows.filter((row) => row.role === 'ambiguous')
      .filter((row, index, all) => all.findIndex((item) => item.promptSignature === row.promptSignature) === index)
      .slice(0, 8)
    const persisted = sources.map((source) => fingerprintByArtifact.get(source.artifactId)?.console).filter(Boolean)
    const inputCount = persisted.reduce((sum, item) => sum + (item?.inputCount ?? 0), 0)
    const statusCount = persisted.reduce((sum, item) => sum + Object.values(item?.statusCounts ?? {}).reduce((all, count) => all + count, 0), 0)
    const reportedInputCount = found.truncated ? Math.max(commands.length, inputCount) : commands.length
    const summary = `입력 명령 ${reportedInputCount}개 · 상태 신호 ${statusCount}개${ambiguous.length ? ` · 형식 확인 ${ambiguous.length}개` : ''}`
    return {
      name: 'console_transcript_scan', label: '콘솔 입력 구분', summary,
      data: { commands, ambiguous, rules: rules.map((rule: EngineerConsolePromptRuleView) => ({ promptSignature: rule.promptSignature, promptKind: rule.promptKind, role: rule.role, confirmedCount: rule.confirmedCount })) },
      evidenceSourceIds: [...new Set(rows.map((row) => row.sourceId))],
    }
  }

  private async search(sources: ProjectSnapshot['artifacts'], args: Record<string, unknown> | undefined): Promise<LpddrAgentToolResult> {
    const query = safe(args?.query, 500)
    if (!query) throw new Error('검색어가 필요합니다.')
    const requested = Array.isArray(args?.sourceIds) ? args.sourceIds.map((item) => safe(item, 160)) : []
    const selected = requested.length ? sources.filter((item) => requested.includes(item.sourceId)) : sources
    const mode = args?.mode === 'regex' ? 'regex' : 'literal'
    const result = await this.deps.artifacts.search({ artifactIds: [...new Set(selected.map((item) => item.artifactId))], query, mode, caseSensitive: args?.caseSensitive === true, maxMatches: 12, contextLines: 0 })
    const artifactSources = new Map(selected.map((item) => [item.artifactId, item.sourceId]))
    const matches = result.matches.map((item) => ({ sourceId: artifactSources.get(item.artifactId), line: item.lineNumber, text: promptSafe(item.lineText, 500) }))
    return { name: 'log_search', label: '로그 검색', summary: `${mode === 'regex' ? '정규식' : '문자열'} “${promptSafe(query, 60)}” ${result.totalMatchCount}건`, data: { query: promptSafe(query), mode, totalMatchCount: result.totalMatchCount, truncated: result.truncated, matches }, evidenceSourceIds: [...new Set(matches.flatMap((item) => item.sourceId ? [item.sourceId] : []))] }
  }

  private async window(sources: ProjectSnapshot['artifacts'], args: Record<string, unknown> | undefined): Promise<LpddrAgentToolResult> {
    const sourceId = safe(args?.sourceId, 160)
    const source = sources.find((item) => item.sourceId === sourceId)
    if (!source) throw new Error('프로젝트에 속한 로그를 선택해 주세요.')
    const startLine = Math.max(1, Math.trunc(finite(args?.startLine) ?? 1))
    const lineCount = Math.min(24, Math.max(1, Math.trunc(finite(args?.lineCount) ?? 16)))
    const result = await this.deps.artifacts.lineWindow({ artifactId: source.artifactId, startLine, lineCount })
    const lines = result.lines.map((line) => ({ line: line.lineNumber, text: promptSafe(line.text, 500) }))
    return { name: 'log_read_window', label: '근거 주변 읽기', summary: `${basename(source.relativePath)} ${startLine}행부터 ${lines.length}줄`, data: { sourceId, lines, hasMoreBefore: result.hasMoreBefore, hasMoreAfter: result.hasMoreAfter }, evidenceSourceIds: [sourceId] }
  }

  private async trends(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const [artifacts, bindings] = await Promise.all([this.deps.artifacts.list(), this.deps.agentStore.profileBindings(project.id)])
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const filenameRows = sources.map((source) => ({
      sourceId: source.sourceId,
      ...sourceContextWithBinding(source.relativePath, artifactById.get(source.artifactId), project.equipmentProfiles, bindings.find((item) => item.sourceIds.includes(source.sourceId))),
    }))
    const statusResult = await this.statuses(sources)
    const statusRows = (statusResult.data as { rows?: Array<{ sourceId: string; status: string }> }).rows ?? []
    const statusBySource = new Map(statusRows.map((row) => [row.sourceId, row.status]))
    const failureStatuses = new Set(['TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
    const definitiveStatuses = new Set(['PASS', ...failureStatuses])
    const dimensions: Array<keyof ProjectEvaluationDimensions> = [
      'temperatureCorner', 'temperatureC', 'vddCorner', 'vdd', 'conditionCorner', 'gridId', 'dq', 'bl', 'channel', 'subChannel', 'chipSelect', 'rank', 'bank', 'bankGroup', 'row', 'column', 'writeData', 'readData', 'pattern',
      'frequencyMHz', 'timingSkewPs', 'testMode', 'die', 'skew', 'lot', 'sample', 'socModel', 'bootProfileId', 'equipmentChannel', 'eccMode', 'customCondition', 'evaluationStep'
    ]
    const buckets = new Map<string, { dimension: string; value: string; total: number; failures: number; sourceIds: string[] }>()
    filenameRows.forEach((row) => {
      const status = statusBySource.get(row.sourceId)
      if (!status || !definitiveStatuses.has(status)) return
      dimensions.forEach((dimension) => {
        const raw = row.dimensions[dimension]
        if (raw === undefined || raw === '') return
        const value = String(raw)
        const key = `${dimension}:${value}`
        const bucket = buckets.get(key) ?? { dimension: agentDimensionName(dimension), value, total: 0, failures: 0, sourceIds: [] }
        bucket.total += 1
        if (failureStatuses.has(status)) bucket.failures += 1
        bucket.sourceIds.push(row.sourceId)
        buckets.set(key, bucket)
      })
      row.commandSignatures.forEach((command) => {
        const key = `command:${command}`
        const bucket = buckets.get(key) ?? { dimension: 'command', value: command, total: 0, failures: 0, sourceIds: [] }
        bucket.total += 1
        if (failureStatuses.has(status)) bucket.failures += 1
        bucket.sourceIds.push(row.sourceId)
        buckets.set(key, bucket)
      })
    })
    const definitiveRows = statusRows.filter((row) => definitiveStatuses.has(row.status))
    const globalFailures = definitiveRows.filter((row) => failureStatuses.has(row.status)).length
    const globalFailureRate = definitiveRows.length ? globalFailures / definitiveRows.length : 0
    const live = [...buckets.values()].map((item) => ({
      ...item,
      failureRate: item.total ? item.failures / item.total : 0,
      lift: item.total ? item.failures / item.total - globalFailureRate : 0,
      sourceIds: [...new Set(item.sourceIds)]
    })).sort((a, b) => b.lift - a.lift || b.failures - a.failures || b.total - a.total || a.dimension.localeCompare(b.dimension))

    const sampleBySkew = new Map<string, { skew: string; sampleIds: Set<string>; evaluations: number; pass: number; fail: number; unknown: number }>()
    filenameRows.forEach((row) => {
      const skew = String(row.dimensions.skew ?? '미확인')
      const bucket = sampleBySkew.get(skew) ?? { skew, sampleIds: new Set<string>(), evaluations: 0, pass: 0, fail: 0, unknown: 0 }
      if (row.dimensions.sample !== undefined) bucket.sampleIds.add(String(row.dimensions.sample))
      bucket.evaluations += 1
      const status = statusBySource.get(row.sourceId)
      if (status === 'PASS') bucket.pass += 1
      else if (status && failureStatuses.has(status)) bucket.fail += 1
      else bucket.unknown += 1
      sampleBySkew.set(skew, bucket)
    })
    const coverage = [...sampleBySkew.values()].map((item) => ({
      skew: item.skew, sampleCount: item.sampleIds.size, logCount: item.evaluations,
      pass: item.pass, fail: item.fail, unknown: item.unknown,
      failureRate: item.pass + item.fail ? item.fail / (item.pass + item.fail) : null,
    }))

    const failedSources = sources.filter((source) => failureStatuses.has(statusBySource.get(source.sourceId) ?? ''))
    const failedSourceIdsByArtifact = new Map<string, string[]>()
    failedSources.forEach((source) => failedSourceIdsByArtifact.set(source.artifactId, [...(failedSourceIdsByArtifact.get(source.artifactId) ?? []), source.sourceId]))
    let failAddressSearch: Awaited<ReturnType<ArtifactService['search']>> | null = null
    if (failedSources.length) {
      try {
        failAddressSearch = await this.deps.artifacts.search({
          artifactIds: [...failedSourceIdsByArtifact.keys()],
          // Long training traces also contain CH/DQ fields. Requiring an
          // error marker on the same line prevents those healthy rows from
          // exhausting maxMatches before the terminal fail address.
          query: '(?=.*(?:@FAIL|FAIL(?:URE)?|ERR(?:OR)?|MISCOMPARE|MISMATCH|\\bEDAC\\b.*\\b(?:UE|CE)\\b))(?=.*(?:CH(?:ANNEL)?|SUB(?:CH|CHANNEL)|SUB[ _]?CHANNEL|CS|CHIP[ _]?SELECT|BK|BANK|RK|RANK|BG|BANK[ _]?GROUP|ROW|COL(?:UMN)?|WR|WRITE|RD|READ|DQ|BL)\\s*[=:]).+',
          mode: 'regex', caseSensitive: false, maxMatches: 2_000, contextLines: 0,
        })
      } catch { /* Condition rates remain available when optional fail-address scanning fails. */ }
    }
    const failAddressEvents: Array<{ sourceId: string; line: number; fields: NonNullable<ReturnType<typeof extractLpddrFailureAddress>> }> = []
    const failAddressEventKeys = new Set<string>()
    for (const match of failAddressSearch?.matches ?? []) {
      if (/^\s*(?:#|META(?:DATA)?\b|CONDITION\b|CONFIG\b)/i.test(match.lineText)) continue
      const fields = extractLpddrFailureAddress(match.lineText)
      if (!fields) continue
      const fieldCount = Object.values(fields).filter(Boolean).length
      if (!/(?:@FAIL|FAIL(?:URE)?|ERR(?:OR)?|MISCOMPARE|MISMATCH|\bEDAC\b.*\b(?:UE|CE)\b)/i.test(match.lineText)
        && !(fieldCount >= 3 && fields.writeData !== undefined && fields.readData !== undefined)) continue
      for (const sourceId of failedSourceIdsByArtifact.get(match.artifactId) ?? []) {
        const key = `${sourceId}:${match.lineNumber}`
        if (failAddressEventKeys.has(key)) continue
        failAddressEventKeys.add(key); failAddressEvents.push({ sourceId, line: match.lineNumber, fields })
      }
    }
    const failAddressBuckets = new Map<string, { dimension: string; value: string; eventCount: number; sourceIds: Set<string> }>()
    failAddressEvents.forEach((event) => Object.entries(event.fields).forEach(([dimension, raw]) => {
      if (raw === undefined) return
      const key = `${dimension}:${raw}`
      const bucket = failAddressBuckets.get(key) ?? { dimension: agentDimensionName(dimension), value: String(raw), eventCount: 0, sourceIds: new Set<string>() }
      bucket.eventCount += 1; bucket.sourceIds.add(event.sourceId); failAddressBuckets.set(key, bucket)
    }))
    const failAddress = [...failAddressBuckets.values()].map((item) => ({
      dimension: item.dimension, value: item.value, eventCount: item.eventCount, sourceCount: item.sourceIds.size,
      eventShare: failAddressEvents.length ? item.eventCount / failAddressEvents.length : 0,
      sourceIds: [...item.sourceIds],
    })).sort((a, b) => b.eventCount - a.eventCount || b.sourceCount - a.sourceCount || a.dimension.localeCompare(b.dimension)).slice(0, 80)

    const memory: EvaluationMemory = {
      project: { id: project.id, name: project.name, ...project.lpddrDevelopmentContext },
      hypotheses: (project.failureHypotheses ?? []).map((item) => ({ ...item, projectId: project.id })),
      nodes: (project.evaluationNodes ?? []).map((item) => ({ ...item, projectId: project.id })),
      evidence: (project.evidenceRecords ?? []).map((item) => ({ ...item, projectId: project.id }))
    }
    const saved = inferEvaluationTrends(memory).slice(0, 20).map((item) => ({ ...item, dimension: agentDimensionName(item.dimension) }))
    const discriminating = live.filter((item) => item.total >= 2 && item.failures > 0 && item.lift > 0)
    const headline = (discriminating.length ? discriminating : live.filter((item) => item.total >= 2 && item.failures > 0)).slice(0, 2)
    const addressHeadline = failAddress[0]
    const conditionSummary = headline.length
      ? headline.map((item) => `${item.dimension} ${item.value} · ${item.failures}/${item.total} FAIL (${(item.failureRate * 100).toFixed(1)}%)`).join(' · ')
      : saved.length
        ? `저장 평가 기준 ${saved.slice(0, 3).map((item) => `${item.dimension} ${item.value} · ${(item.failureRate * 100).toFixed(1)}%`).join(' · ')}`
        : '확정된 Pass/Fail 분모와 평가 근거가 부족함'
    const summary = `${conditionSummary}${addressHeadline ? ` · Fail 주소 ${addressHeadline.dimension} ${addressHeadline.value} ${addressHeadline.eventCount}/${failAddressEvents.length}회 (${addressHeadline.sourceCount}개 로그)` : ''}`
    return {
      name: 'failure_trends_get', label: '조건별 불량 경향', summary,
      data: {
        live, saved, coverage,
        denominator: definitiveRows.length, numerator: globalFailures, globalFailureRate,
        denominatorRule: 'FAIL 로그 / (PASS + FAIL 확정 로그). 미확인 결과 제외.',
        failAddress: { events: failAddressEvents.length, distribution: failAddress, truncated: failAddressSearch?.truncated ?? false },
      },
      evidenceSourceIds: [...new Set([
        ...live.flatMap((item) => item.sourceIds),
        ...failAddress.flatMap((item) => item.sourceIds),
        ...memory.evidence.flatMap((item) => item.sourceIds ?? [])
      ])]
    }
  }
}
