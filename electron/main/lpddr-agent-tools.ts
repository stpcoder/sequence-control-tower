import { basename } from 'node:path'
import type {
  ArtifactEvidenceSpec, ArtifactRecord, EngineerBootProfileBindingView, EngineerConsolePromptRuleView, ProjectEquipmentProfile, ProjectEvaluationDimensions, ProjectSnapshot
} from '../shared/contracts'
import { inferEvaluationTrends, type EvaluationMemory } from '../../src/domain/evaluation-memory'
import { stableHash } from '../../src/domain/fingerprint'
import { bootProfile, detectSocFilenameContext, normalizedEvaluationStem, type SocFilenameContext } from '../../src/domain/soc-profile'
import { classifyConsoleLine, consolePromptSearchPattern } from '../../src/domain/console-transcript'
import type { ArtifactService } from './artifact-service'
import type { NativeAgentStore } from './native-agent-store'
import type { ProjectStore } from './project-store'

export type LpddrAgentToolName =
  | 'project_context_get' | 'project_history_get' | 'similar_case_search'
  | 'search_history_get' | 'engineer_workflow_memory_get' | 'engineer_workflow_apply' | 'filename_dimensions_scan' | 'soc_boot_profile_scan' | 'console_transcript_scan' | 'pass_fail_scan'
  | 'log_search' | 'log_read_window' | 'failure_trends_get'

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
  project_history_get: '현재 프로젝트의 불량 가설, 평가 브랜치, 평가 결과와 근거 연결을 조회합니다.',
  similar_case_search: '다른 LPDDR5/LPDDR6 프로젝트에서 제목과 가설, 평가 요약이 비슷한 사례를 찾습니다.',
  search_history_get: '엔지니어가 Ctrl-F/정규식으로 확인한 검색어와 일치 개수를 조회합니다.',
  engineer_workflow_memory_get: '엔지니어가 확정한 검색 순서, 있음/없음 조건, 평가 단계와 목적을 조회합니다.',
  engineer_workflow_apply: '확정된 분석 절차의 있음/없음 조건과 실제 로그 발생 순서를 선택 로그에 일괄 적용해 후보 판정을 계산합니다.',
  filename_dimensions_scan: '로그 파일명과 저장된 fingerprint에서 SoC, Boot profile, SKU, SKEW, Die, Sample, 조건, Sequence signature와 명령 후보를 추출합니다.',
  soc_boot_profile_scan: '파일명에서 선택한 Qualcomm/MediaTek profile의 단계 marker를 검사하고 로그가 도달한 부팅 구간을 반환합니다.',
  console_transcript_scan: '콘솔 prompt 뒤의 엔지니어 입력과 장비 출력·상태 marker를 분리하고, 프로젝트에서 확정한 prompt 규칙을 적용합니다.',
  pass_fail_scan: '모든 선택 로그를 한 번씩 읽어 PASS, FAIL, training fail, reboot, halt, fast fail을 결정 규칙으로 분류합니다.',
  log_search: '허용된 프로젝트 로그에서 문자열 또는 정규식을 검색하고 최대 12개 근거 위치를 반환합니다.',
  log_read_window: '검색으로 찾은 한 지점 주변을 최대 24줄만 읽습니다. 전체 로그 읽기는 허용되지 않습니다.',
  failure_trends_get: '선택 로그의 확정 Pass/Fail 분모와 저장된 평가 근거를 함께 사용해 SKU, SKEW, Die, Sample, 명령, DQ, BL, channel, pattern, 온도, VDD별 실패 집중도를 계산합니다.'
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
const agentDimensionName = (dimension: string) => dimension === 'sku' ? 'SKU' : dimension === 'skewPs' ? 'SKEW' : dimension
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bootAliasPattern = (alias: string): string => {
  const body = regexEscape(alias).replace(/ +/g, '[ _-]*')
  return `(?:^|[^A-Z0-9])${body}(?:[^A-Z0-9]|$)`
}
const capture = (name: string, expression: RegExp): string | undefined => expression.exec(name)?.[1]
const decimal = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value.replace(/[pP]/g, '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function projectSocContext(fileName: string, profiles: readonly ProjectEquipmentProfile[] = []): SocFilenameContext {
  const detected = detectSocFilenameContext(fileName)
  if (detected.vendor !== 'unknown') return detected
  const lower = basename(fileName).toLowerCase()
  const matched = profiles.find((profile) => [profile.alias, ...(profile.filenameAliases ?? []), ...(profile.socModels ?? [])]
    .some((alias) => alias.length >= 2 && lower.includes(alias.toLowerCase())))
  if (!matched || (matched.vendor !== 'qualcomm' && matched.vendor !== 'mediatek')) return detected
  return { vendor: matched.vendor, socModel: matched.socModels?.[0], bootProfileId: matched.profileId as 'qualcomm-default' | 'mediatek-default', confidence: 0.95, evidence: matched.alias, explicitRetest: detected.explicitRetest, ...(detected.attemptNo ? { attemptNo: detected.attemptNo } : {}) }
}

export function extractLpddrFilenameDimensions(fileName: string, profiles: readonly ProjectEquipmentProfile[] = []): ProjectEvaluationDimensions {
  const name = safe(basename(fileName), 240)
  const temperature = capture(name, /(?:^|[_\-.])(?:TEMP|T)(?:=|_)?(-?\d{1,3})(?:C)?(?:[_\-.]|$)/i)
  const vdd = capture(name, /(?:^|[_\-.])VDD(?:=|_|-)?(\d+(?:[p.]\d+)?)(?:V)?(?:[_\-.]|$)/i)
  const frequency = capture(name, /(?:^|[_\-.])(?:FREQ|F)(?:=|_|-)?(\d{3,5})(?:MHZ|MT)?(?:[_\-.]|$)/i)
    ?? capture(name, /(?:^|[_\-.])(\d{3,5})MT(?:[_\-.]|$)/i)
  const pattern = capture(name, /(?:^|[_\-.])(?:PATTERN|PAT)(?:=|_|-)?([A-Z0-9-]+)/i)?.replace(/-(?:DQ|BL|CH|CHANNEL|BANK|BG|FREQ|TEMP|VDD|SKEW|TM|MODE|PASS|FAIL|HALT|TRAIN).*$/i, '')
  return {
    sku: capture(name, /(?:^|[_\-.])SKU(?:=|_|-)?([A-Z0-9-]+)/i),
    lot: capture(name, /(?:^|[_\-.])LOT(?:=|_|-)?([A-Z0-9-]+)/i),
    material: capture(name, /(?:^|[_\-.])(?:MAT|MATERIAL)(?:=|_|-)?([A-Z0-9-]+)/i),
    die: capture(name, /(?:^|[_\-.])DIE(?:=|_|-)?([A-Z0-9-]+)/i),
    sample: capture(name, /(?:^|[_\-.])(?:SAMPLE|SMP)(?:=|_|-)?([A-Z0-9-]+)/i),
    bl: capture(name, /(?:^|[_\-.])BL(?:=|_|-)?(\d+)/i),
    dq: capture(name, /(?:^|[_\-.])DQ(?:=|_|-)?(\d+)/i),
    channel: capture(name, /(?:^|[_\-.])(?:CH|CHANNEL)(?:=|_|-)?(\d+)/i),
    bank: capture(name, /(?:^|[_\-.])BANK(?:=|_|-)?(\d+)/i),
    bankGroup: capture(name, /(?:^|[_\-.])(?:BG|BANKGROUP)(?:=|_|-)?(\d+)/i),
    pattern,
    frequencyMHz: decimal(frequency), temperatureC: decimal(temperature), vdd: decimal(vdd),
    skewPs: decimal(capture(name, /(?:^|[_\-.])SKEW(?:=|_|-)?(-?\d+(?:[p.]\d+)?)(?:PS)?/i)),
    testMode: capture(name, /(?:^|[_\-.])(?:TM|MODE)(?:=|_|-)?([A-Z0-9-]+)/i),
    ...(() => {
      const soc = projectSocContext(name, profiles)
      return soc.vendor === 'unknown' ? {} : { socVendor: soc.vendor, socModel: soc.socModel, bootProfileId: soc.bootProfileId }
    })(),
  }
}

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

const STATUS_SPECS: ArtifactEvidenceSpec[] = [
  { id: 'at-pass', query: '@PASS', mode: 'literal' },
  { id: 'at-fail', query: '@FAIL', mode: 'literal' },
  { id: 'stress-pass', query: 'stressapp(?:test)?[^\n]{0,80}\bPASS\b', mode: 'regex', caseSensitive: false },
  { id: 'diag-start', query: '(?:HIDAG|HI_DIAG|DIAG(?:NOSTIC)?)[^\n]{0,80}(?:START|BEGIN|RUN)', mode: 'regex', caseSensitive: false },
  { id: 'training-fail', query: '(?:TRAINING|TRAIN)[ _:-]*FAIL', mode: 'regex', caseSensitive: false },
  { id: 'reboot', query: '(?:SYSTEM[ _-]*REBOOT|WATCHDOG|REBOOT_REASON|WARM RESET)', mode: 'regex', caseSensitive: false },
  { id: 'halt', query: '(?:SYSTEM[ _-]*HALT|CPU[ _-]*HALT|FATAL EXCEPTION|KERNEL PANIC)', mode: 'regex', caseSensitive: false },
  { id: 'fast-fail', query: '(?:FAST[ _-]*FAIL|FAIL[ _-]*FAST|EARLY[ _-]*EXIT)', mode: 'regex', caseSensitive: false },
  { id: 'normal-end', query: '(?:TEST|SEQUENCE|RUN)[ _:-]*(?:COMPLETE|END|DONE)', mode: 'regex', caseSensitive: false }
]

function classifyStatus(counts: Record<string, number>): { status: string; confidence: number; reason: string } {
  if (counts['training-fail'] > 0) return { status: 'TRAINING_FAIL', confidence: 0.99, reason: 'training fail marker 검출' }
  if (counts['at-fail'] > 0) return { status: counts['fast-fail'] > 0 ? 'FAST_FAIL' : 'TEST_FAIL', confidence: 0.99, reason: '@FAIL marker 검출' }
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
      case 'project_context_get': return this.context(project)
      case 'project_history_get': return this.history(project)
      case 'similar_case_search': return this.similar(project, safe(call.args?.query, 240))
      case 'search_history_get': return this.searchHistory(project)
      case 'engineer_workflow_memory_get': return this.workflowMemory(project)
      case 'engineer_workflow_apply': return this.applyWorkflow(project, allowed, call.args)
      case 'filename_dimensions_scan': return this.filenames(project, allowed)
      case 'soc_boot_profile_scan': return this.bootProfiles(project, allowed)
      case 'console_transcript_scan': return this.consoleTranscript(project, allowed)
      case 'pass_fail_scan': return this.statuses(allowed)
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

  private context(project: ProjectSnapshot): LpddrAgentToolResult {
    const data = { name: project.name, description: project.description, ...project.lpddrDevelopmentContext, onboarding: project.onboardingAnswers }
    return { name: 'project_context_get', label: '프로젝트 조건', summary: `${project.name} · 로그 ${project.artifacts.length}개 · 평가 ${project.evaluationNodes?.length ?? 0}건`, data, evidenceSourceIds: [] }
  }

  private history(project: ProjectSnapshot): LpddrAgentToolResult {
    const data = {
      hypotheses: (project.failureHypotheses ?? []).slice(-50), nodes: (project.evaluationNodes ?? []).slice(-100).map((item) => ({ ...item, dimensions: agentDimensionView(item.dimensions) })),
      evidence: (project.evidenceRecords ?? []).slice(-200).map((item) => ({ ...item, dimensions: agentDimensionView(item.dimensions), note: safe(item.note, 500) }))
    }
    return { name: 'project_history_get', label: '평가 이력', summary: `가설 ${data.hypotheses.length}개 · 평가 ${data.nodes.length}개 · 근거 ${data.evidence.length}개`, data, evidenceSourceIds: [...new Set(data.evidence.flatMap((item) => item.sourceIds))] }
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

  private async searchHistory(project: ProjectSnapshot): Promise<LpddrAgentToolResult> {
    const data = await this.deps.agentStore.searchHistory(project.id, 40)
    return { name: 'search_history_get', label: '검색 기록', summary: `최근 Ctrl-F/정규식 확인 ${data.length}건`, data, evidenceSourceIds: [...new Set(data.flatMap((item) => item.sourceIds))] }
  }

  private async workflowMemory(project: ProjectSnapshot): Promise<LpddrAgentToolResult> {
    const [workflows, recentSearches, conversation, attempts, commandKnowledge, profileBindings, consolePromptRules] = await Promise.all([
      this.deps.agentStore.workflowMemories(project.id, 50),
      this.deps.agentStore.searchHistory(project.id, 20),
      this.deps.agentStore.conversationHistory(project.id, 20),
      this.deps.agentStore.attemptHistory(project.id, 100),
      this.deps.agentStore.commandKnowledge(project.id, 100),
      this.deps.agentStore.profileBindings(project.id),
      this.deps.agentStore.consolePromptRules(project.id),
    ])
    const data = {
      confirmed: workflows.map((item) => ({
        ...item,
        name: promptSafe(item.name, 160),
        purpose: promptSafe(item.purpose, 160),
        checks: item.checks.map((check) => ({ ...check, query: promptSafe(check.query) })),
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
      summary: `확정 절차 ${workflows.length}개 · RT ${attempts.filter((item) => item.relation === 'retest').length}건 · 명령 지식 ${commandKnowledge.length}개 · 콘솔 형식 ${consolePromptRules.length}개`,
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
    const memories = storedMemories
      .filter((item) => !requestedId || item.id === requestedId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, requestedId ? 1 : 3)
    if (!memories.length || !sources.length) return {
      name: 'engineer_workflow_apply', label: '분석 절차 적용',
      summary: memories.length ? '적용할 로그 없음' : '확정된 분석 절차 없음',
      data: { rows: [] }, evidenceSourceIds: [],
    }
    const dimensionKeys: Array<keyof ProjectEvaluationDimensions> = [
      'testMode', 'temperatureC', 'vdd', 'frequencyMHz', 'material', 'die', 'sku', 'lot', 'sample', 'socModel', 'bootProfileId',
      'dq', 'bl', 'channel', 'bank', 'bankGroup', 'pattern', 'skewPs',
    ]
    const selectedBySource = new Map(sources.map((source) => {
      const binding = bindings.find((item) => item.sourceIds.includes(source.sourceId))
      const detected = sourceContextWithBinding(source.relativePath, undefined, project.equipmentProfiles, binding).dimensions
      const ranked = memories.map((memory) => ({
        memory,
        score: dimensionKeys.filter((key) => detected[key] !== undefined && memory.dimensions?.[key] !== undefined
          && String(detected[key]) === String(memory.dimensions?.[key])).length,
      })).sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      return [source.sourceId, ranked[0].memory] as const
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
    const rows = inspected.sources.map((source) => {
      const memory = selectedBySource.get(source.sourceId)!
      const checks = memory.checks.map((check, checkIndex) => {
        const specId = [...specIds].find(([, value]) => value.memoryId === memory.id && value.checkIndex === checkIndex)?.[0]
        const evidence = source.evidence.find((item) => item.specId === specId)
        const count = evidence?.occurrenceCount ?? 0
        return { query: promptSafe(check.query), expected: check.expected, count, firstLine: evidence?.firstOccurrence?.lineNumber }
      })
      const expectationsMet = checks.every((check) => check.expected === 'present' ? check.count > 0 : check.count === 0)
      const presentLines = checks.filter((check) => check.expected === 'present').map((check) => check.firstLine)
      const orderMet = presentLines.every((line, index) => index === 0 || (line !== undefined && presentLines[index - 1] !== undefined && line > presentLines[index - 1]!))
      return {
        sourceId: source.sourceId, workflowId: memory.id, purpose: promptSafe(memory.purpose, 160),
        stages: memory.stages, candidateResult: memory.result, matched: expectationsMet && orderMet,
        expectationsMet, orderMet, checks,
      }
    })
    const matched = rows.filter((row) => row.matched).length
    return {
      name: 'engineer_workflow_apply', label: '분석 절차 적용',
      summary: `${rows.length}개 중 ${matched}개가 확정 절차의 조건과 순서에 일치`,
      data: { rows }, evidenceSourceIds: rows.map((row) => row.sourceId),
    }
  }

  private async filenames(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const [workflows, artifacts, bindings] = await Promise.all([this.deps.agentStore.workflowMemories(project.id, 50), this.deps.artifacts.list(), this.deps.agentStore.profileBindings(project.id)])
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    const dimensions: Array<keyof ProjectEvaluationDimensions> = [
      'testMode', 'temperatureC', 'vdd', 'frequencyMHz', 'material', 'die', 'sku', 'lot', 'sample', 'socModel', 'bootProfileId',
      'dq', 'bl', 'channel', 'bank', 'bankGroup', 'pattern', 'skewPs',
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
      specs: STATUS_SPECS
    })
    const rows = inspected.sources.map((source) => {
      const counts = Object.fromEntries(source.evidence.map((item) => [item.specId, item.occurrenceCount ?? 0]))
      return { sourceId: source.sourceId, fileName: promptSafe(source.fileName, 240), counts, ...classifyStatus(counts) }
    })
    const totals = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {})
    return { name: 'pass_fail_scan', label: 'Pass/Fail 규칙 검사', summary: Object.entries(totals).map(([key, value]) => `${key} ${value}`).join(' · '), data: { rules: STATUS_SPECS.map((item) => item.id), rows, totals }, evidenceSourceIds: rows.map((row) => row.sourceId) }
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
    const summary = `입력 명령 ${inputCount || commands.length}개 · 상태 신호 ${statusCount}개${ambiguous.length ? ` · 형식 확인 ${ambiguous.length}개` : ''}`
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
    const failureStatuses = new Set(['FAST_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
    const definitiveStatuses = new Set(['PASS', ...failureStatuses])
    const dimensions: Array<keyof ProjectEvaluationDimensions> = [
      'temperatureC', 'vdd', 'dq', 'bl', 'channel', 'bank', 'bankGroup', 'pattern',
      'frequencyMHz', 'skewPs', 'testMode', 'material', 'die', 'sku', 'lot', 'sample', 'socModel', 'bootProfileId'
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
    const live = [...buckets.values()].map((item) => ({
      ...item,
      failureRate: item.total ? item.failures / item.total : 0,
      sourceIds: [...new Set(item.sourceIds)]
    })).sort((a, b) => b.failures - a.failures || b.total - a.total || b.failureRate - a.failureRate || a.dimension.localeCompare(b.dimension))

    const memory: EvaluationMemory = {
      project: { id: project.id, name: project.name, ...project.lpddrDevelopmentContext },
      hypotheses: (project.failureHypotheses ?? []).map((item) => ({ ...item, projectId: project.id })),
      nodes: (project.evaluationNodes ?? []).map((item) => ({ ...item, projectId: project.id })),
      evidence: (project.evidenceRecords ?? []).map((item) => ({ ...item, projectId: project.id }))
    }
    const saved = inferEvaluationTrends(memory).slice(0, 20).map((item) => ({ ...item, dimension: agentDimensionName(item.dimension) }))
    const headline = (live.filter((item) => item.total >= 2).length ? live.filter((item) => item.total >= 2) : live).slice(0, 3)
    const summary = headline.length
      ? headline.map((item) => `${item.dimension} ${item.value} · ${item.failures}/${item.total} fail (${(item.failureRate * 100).toFixed(1)}%)`).join(' · ')
      : saved.length
        ? `저장 평가 기준 ${saved.slice(0, 3).map((item) => `${item.dimension} ${item.value} · ${(item.failureRate * 100).toFixed(1)}%`).join(' · ')}`
        : '확정된 Pass/Fail 분모와 평가 근거가 부족함'
    return {
      name: 'failure_trends_get', label: '조건별 불량 경향', summary,
      data: { live, saved, denominator: statusRows.filter((row) => definitiveStatuses.has(row.status)).length },
      evidenceSourceIds: [...new Set([
        ...live.flatMap((item) => item.sourceIds),
        ...memory.evidence.flatMap((item) => item.sourceIds ?? [])
      ])]
    }
  }
}
