import { basename } from 'node:path'
import type {
  ArtifactEvidenceSpec, ProjectEvaluationDimensions, ProjectSnapshot
} from '../shared/contracts'
import { inferEvaluationTrends, type EvaluationMemory } from '../../src/domain/evaluation-memory'
import type { ArtifactService } from './artifact-service'
import type { NativeAgentStore } from './native-agent-store'
import type { ProjectStore } from './project-store'

export type LpddrAgentToolName =
  | 'project_context_get' | 'project_history_get' | 'similar_case_search'
  | 'search_history_get' | 'filename_dimensions_scan' | 'pass_fail_scan'
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
  filename_dimensions_scan: '로그 파일명에서 자재, Sample, Lot, 온도, VDD, 주파수, TM, DQ, BL 후보를 추출합니다.',
  pass_fail_scan: '모든 선택 로그를 한 번씩 읽어 PASS, FAIL, training fail, reboot, halt, fast fail을 결정 규칙으로 분류합니다.',
  log_search: '허용된 프로젝트 로그에서 문자열 또는 정규식을 검색하고 최대 12개 근거 위치를 반환합니다.',
  log_read_window: '검색으로 찾은 한 지점 주변을 최대 24줄만 읽습니다. 전체 로그 읽기는 허용되지 않습니다.',
  failure_trends_get: '선택 로그의 확정 Pass/Fail 분모와 저장된 평가 근거를 함께 사용해 DQ, BL, channel, pattern, 온도, VDD별 실패 집중도를 계산합니다.'
}

const safe = (value: unknown, max = 500): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : ''
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const capture = (name: string, expression: RegExp): string | undefined => expression.exec(name)?.[1]
const decimal = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value.replace(/[pP]/g, '.'))
  return Number.isFinite(parsed) ? parsed : undefined
}

export function extractLpddrFilenameDimensions(fileName: string): ProjectEvaluationDimensions {
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
    sample: capture(name, /(?:^|[_\-.])(?:SAMPLE|SMP)(?:=|_|-)?([A-Z0-9-]+)/i),
    bl: capture(name, /(?:^|[_\-.])BL(?:=|_|-)?(\d+)/i),
    dq: capture(name, /(?:^|[_\-.])DQ(?:=|_|-)?(\d+)/i),
    channel: capture(name, /(?:^|[_\-.])(?:CH|CHANNEL)(?:=|_|-)?(\d+)/i),
    bank: capture(name, /(?:^|[_\-.])BANK(?:=|_|-)?(\d+)/i),
    bankGroup: capture(name, /(?:^|[_\-.])(?:BG|BANKGROUP)(?:=|_|-)?(\d+)/i),
    pattern,
    frequencyMHz: decimal(frequency), temperatureC: decimal(temperature), vdd: decimal(vdd),
    skewPs: decimal(capture(name, /(?:^|[_\-.])SKEW(?:=|_|-)?(-?\d+(?:[p.]\d+)?)(?:PS)?/i)),
    testMode: capture(name, /(?:^|[_\-.])(?:TM|MODE)(?:=|_|-)?([A-Z0-9-]+)/i)
  }
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
    agentStore: Pick<NativeAgentStore, 'searchHistory'>
  }) {}

  async execute(projectId: string, call: LpddrAgentToolCall, allowedSourceIds?: string[]): Promise<LpddrAgentToolResult> {
    const project = await this.project(projectId)
    const allowed = this.sources(project, allowedSourceIds)
    switch (call.name) {
      case 'project_context_get': return this.context(project)
      case 'project_history_get': return this.history(project)
      case 'similar_case_search': return this.similar(project, safe(call.args?.query, 240))
      case 'search_history_get': return this.searchHistory(project)
      case 'filename_dimensions_scan': return this.filenames(project, allowed)
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
      hypotheses: (project.failureHypotheses ?? []).slice(-50), nodes: (project.evaluationNodes ?? []).slice(-100),
      evidence: (project.evidenceRecords ?? []).slice(-200).map((item) => ({ ...item, note: safe(item.note, 500) }))
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
    const data = candidates.map(({ item, score }) => ({ projectId: item.id, project: item.name, product: item.lpddrDevelopmentContext?.product, score, hypotheses: (item.failureHypotheses ?? []).slice(-5).map((value) => value.title), evaluations: (item.evaluationNodes ?? []).slice(-8).map((value) => ({ name: value.name, status: value.status, dimensions: value.dimensions })) }))
    return { name: 'similar_case_search', label: '유사 사례', summary: data.length ? `과거 프로젝트 ${data.length}개에서 유사 사례 발견` : '저장된 과거 프로젝트에서 유사 사례 없음', data, evidenceSourceIds: [] }
  }

  private async searchHistory(project: ProjectSnapshot): Promise<LpddrAgentToolResult> {
    const data = await this.deps.agentStore.searchHistory(project.id, 40)
    return { name: 'search_history_get', label: '검색 기록', summary: `최근 Ctrl-F/정규식 확인 ${data.length}건`, data, evidenceSourceIds: [...new Set(data.flatMap((item) => item.sourceIds))] }
  }

  private filenames(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): LpddrAgentToolResult {
    const rows = sources.map((source) => ({ sourceId: source.sourceId, fileName: safe(basename(source.relativePath), 240), dimensions: extractLpddrFilenameDimensions(source.relativePath) }))
    const detected = rows.filter((row) => Object.values(row.dimensions).some((value) => value !== undefined)).length
    return { name: 'filename_dimensions_scan', label: '파일명 조건 추출', summary: `${rows.length}개 중 ${detected}개에서 조건 후보 추출`, data: { project: project.name, rows }, evidenceSourceIds: rows.map((row) => row.sourceId) }
  }

  private async statuses(sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    if (!sources.length) return { name: 'pass_fail_scan', label: 'Pass/Fail 규칙 검사', summary: '검사할 로그 없음', data: { rows: [] }, evidenceSourceIds: [] }
    const inspected = await this.deps.artifacts.inspectEvidence({
      sources: sources.map((source) => ({ sourceId: source.sourceId, artifactId: source.artifactId, rootId: source.artifactRootId ?? source.rootId, relativePath: source.relativePath })),
      specs: STATUS_SPECS
    })
    const rows = inspected.sources.map((source) => {
      const counts = Object.fromEntries(source.evidence.map((item) => [item.specId, item.occurrenceCount ?? 0]))
      return { sourceId: source.sourceId, fileName: safe(source.fileName, 240), counts, ...classifyStatus(counts) }
    })
    const totals = rows.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: (all[row.status] ?? 0) + 1 }), {})
    return { name: 'pass_fail_scan', label: 'Pass/Fail 규칙 검사', summary: Object.entries(totals).map(([key, value]) => `${key} ${value}`).join(' · '), data: { rules: STATUS_SPECS.map((item) => item.id), rows, totals }, evidenceSourceIds: rows.map((row) => row.sourceId) }
  }

  private async search(sources: ProjectSnapshot['artifacts'], args: Record<string, unknown> | undefined): Promise<LpddrAgentToolResult> {
    const query = safe(args?.query, 500)
    if (!query) throw new Error('검색어가 필요합니다.')
    const requested = Array.isArray(args?.sourceIds) ? args.sourceIds.map((item) => safe(item, 160)) : []
    const selected = requested.length ? sources.filter((item) => requested.includes(item.sourceId)) : sources
    const mode = args?.mode === 'regex' ? 'regex' : 'literal'
    const result = await this.deps.artifacts.search({ artifactIds: [...new Set(selected.map((item) => item.artifactId))], query, mode, caseSensitive: args?.caseSensitive === true, maxMatches: 12, contextLines: 0 })
    const artifactSources = new Map(selected.map((item) => [item.artifactId, item.sourceId]))
    const matches = result.matches.map((item) => ({ sourceId: artifactSources.get(item.artifactId), line: item.lineNumber, text: safe(item.lineText, 500) }))
    return { name: 'log_search', label: '로그 검색', summary: `${mode === 'regex' ? '정규식' : '문자열'} “${query.slice(0, 60)}” ${result.totalMatchCount}건`, data: { query, mode, totalMatchCount: result.totalMatchCount, truncated: result.truncated, matches }, evidenceSourceIds: [...new Set(matches.flatMap((item) => item.sourceId ? [item.sourceId] : []))] }
  }

  private async window(sources: ProjectSnapshot['artifacts'], args: Record<string, unknown> | undefined): Promise<LpddrAgentToolResult> {
    const sourceId = safe(args?.sourceId, 160)
    const source = sources.find((item) => item.sourceId === sourceId)
    if (!source) throw new Error('프로젝트에 속한 로그를 선택해 주세요.')
    const startLine = Math.max(1, Math.trunc(finite(args?.startLine) ?? 1))
    const lineCount = Math.min(24, Math.max(1, Math.trunc(finite(args?.lineCount) ?? 16)))
    const result = await this.deps.artifacts.lineWindow({ artifactId: source.artifactId, startLine, lineCount })
    const lines = result.lines.map((line) => ({ line: line.lineNumber, text: safe(line.text, 500) }))
    return { name: 'log_read_window', label: '근거 주변 읽기', summary: `${basename(source.relativePath)} ${startLine}행부터 ${lines.length}줄`, data: { sourceId, lines, hasMoreBefore: result.hasMoreBefore, hasMoreAfter: result.hasMoreAfter }, evidenceSourceIds: [sourceId] }
  }

  private async trends(project: ProjectSnapshot, sources: ProjectSnapshot['artifacts']): Promise<LpddrAgentToolResult> {
    const filenameRows = sources.map((source) => ({
      sourceId: source.sourceId,
      dimensions: extractLpddrFilenameDimensions(source.relativePath)
    }))
    const statusResult = await this.statuses(sources)
    const statusRows = (statusResult.data as { rows?: Array<{ sourceId: string; status: string }> }).rows ?? []
    const statusBySource = new Map(statusRows.map((row) => [row.sourceId, row.status]))
    const failureStatuses = new Set(['FAST_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT', 'SYSTEM_REBOOT'])
    const definitiveStatuses = new Set(['PASS', ...failureStatuses])
    const dimensions: Array<keyof ProjectEvaluationDimensions> = [
      'temperatureC', 'vdd', 'dq', 'bl', 'channel', 'bank', 'bankGroup', 'pattern',
      'frequencyMHz', 'skewPs', 'testMode', 'material', 'sku', 'lot', 'sample'
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
        const bucket = buckets.get(key) ?? { dimension, value, total: 0, failures: 0, sourceIds: [] }
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
    const saved = inferEvaluationTrends(memory).slice(0, 20)
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
