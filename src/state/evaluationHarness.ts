import type {
  EngineerWorkflowMemoryView,
  JsonValue,
  ProjectExportPreset,
} from '../../electron/shared/contracts'
import type { ResultLabel } from '../domain/workbench'
import {
  DEFAULT_EXPORT_COLUMNS,
  normalizeExportColumns,
  type LogRecordExportColumn,
} from './logRecords'
import {
  DEFAULT_PATTERN_LAYOUT,
  normalizePatternLayout,
  type PatternLayout,
} from './patternLayout'

export const EVALUATION_HARNESS_PRESET_ID = 'sequence-control-tower.evaluation-harnesses.v1'
export const EVALUATION_HARNESS_PRESET_NAME = '행동 기반 평가 하네스'

export interface EvaluationHarnessCheck {
  query: string
  mode: 'literal' | 'regex'
  caseSensitive: boolean
  expected: 'present' | 'absent'
  stage: string
  order: number
}

export interface EvaluationHarnessRule {
  id: string
  name: string
  purpose: string
  when: {
    dimensions: Record<string, string | number>
  }
  look: EvaluationHarnessCheck[]
  judge: {
    result: ResultLabel
    policy: 'ordered-all'
    exception: 'send-to-review'
  }
  usage: {
    confirmedCount: number
    appliedCount: number
    correctedCount: number
  }
  createdAt: string
  updatedAt: string
}

/** One connected folder is one evaluation harness. It may contain many
 * independent PASS/FAIL/Reboot rules; output preferences belong to the folder
 * once instead of being duplicated in every rule. */
export interface EvaluationHarness {
  id: string
  name: string
  source: 'engineer-behavior' | 'public-synthetic-replay'
  evaluationScopeId?: string
  rules: EvaluationHarnessRule[]
  output: {
    layout: PatternLayout
    columns: LogRecordExportColumn[]
    format: 'csv' | 'tsv'
  }
  createdAt: string
  updatedAt: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cleanText(value: unknown, fallback: string, max = 240): string {
  if (typeof value !== 'string') return fallback
  const next = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  return next || fallback
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function dimensions(value: unknown): Record<string, string | number> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) => {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) return []
    if (typeof item === 'string') return [[key, cleanText(item, '', 120)]]
    if (typeof item === 'number' && Number.isFinite(item)) return [[key, item]]
    return []
  }).filter(([, item]) => item !== ''))
}

function checks(value: unknown): EvaluationHarnessCheck[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const source = record(item)
    const query = cleanText(source.query, '', 500)
    if (!query) return []
    return [{
      query,
      mode: source.mode === 'regex' ? 'regex' as const : 'literal' as const,
      caseSensitive: source.caseSensitive === true,
      expected: source.expected === 'absent' ? 'absent' as const : 'present' as const,
      stage: cleanText(source.stage, 'unknown', 80),
      order: typeof source.order === 'number' && source.order > 0 ? Math.floor(source.order) : index + 1,
    }]
  }).sort((a, b) => a.order - b.order).slice(0, 20).map((item, index) => ({ ...item, order: index + 1 }))
}

const RESULT_LABELS = new Set<ResultLabel>([
  'PASS', 'DIAG_FAIL', 'TEST_FAIL', 'TRAINING_FAIL', 'SYSTEM_HALT',
  'SYSTEM_REBOOT', 'INCOMPLETE', 'UNKNOWN', 'EXCLUDED',
])

function normalizeHarnessRule(value: unknown, fallbackId = ''): EvaluationHarnessRule | null {
  const source = record(value)
  const id = cleanText(source.id, fallbackId, 180)
  const look = checks(source.look)
  if (!id || !look.length) return null
  const when = record(source.when)
  const judge = record(source.judge)
  const usage = record(source.usage)
  const result = typeof judge.result === 'string' && RESULT_LABELS.has(judge.result as ResultLabel)
    ? judge.result as ResultLabel
    : 'UNKNOWN'
  return {
    id,
    name: cleanText(source.name, '분석 규칙'),
    purpose: cleanText(source.purpose, `${result} 판정`),
    when: { dimensions: dimensions(when.dimensions) },
    look,
    judge: { result, policy: 'ordered-all', exception: 'send-to-review' },
    usage: {
      confirmedCount: count(usage.confirmedCount),
      appliedCount: count(usage.appliedCount),
      correctedCount: count(usage.correctedCount),
    },
    createdAt: cleanText(source.createdAt, new Date(0).toISOString(), 80),
    updatedAt: cleanText(source.updatedAt, new Date(0).toISOString(), 80),
  }
}

export function normalizeEvaluationHarness(value: unknown): EvaluationHarness | null {
  const source = record(value)
  const when = record(source.when)
  const output = record(source.output)
  const evaluationScopeId = cleanText(source.evaluationScopeId ?? when.evaluationScopeId, '', 180)
  const id = cleanText(source.id, evaluationScopeId ? `scope:${evaluationScopeId}` : '', 180)
  if (!id) return null
  const storedRules = Array.isArray(source.rules)
    ? source.rules.flatMap((item, index) => {
      const rule = normalizeHarnessRule(item, `rule:${index + 1}`)
      return rule ? [rule] : []
    })
    : []
  // v1 stored one workflow as the whole harness. Read it as one rule so old
  // projects migrate without losing an engineer-confirmed search sequence.
  const legacyRule = storedRules.length ? null : normalizeHarnessRule({
    id: source.id,
    name: source.name,
    purpose: source.purpose,
    when: { dimensions: when.dimensions },
    look: source.look,
    judge: source.judge,
    usage: source.usage,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  })
  const rules = legacyRule ? [legacyRule] : storedRules
  if (!rules.length) return null
  return {
    id,
    name: cleanText(source.name, '현재 폴더 분석 기준'),
    source: source.source === 'public-synthetic-replay' ? 'public-synthetic-replay' : 'engineer-behavior',
    ...(evaluationScopeId ? { evaluationScopeId } : {}),
    rules,
    output: {
      layout: normalizePatternLayout(output.layout),
      columns: normalizeExportColumns(Array.isArray(output.columns) ? output.columns.filter((item): item is LogRecordExportColumn => typeof item === 'string') : []).length
        ? normalizeExportColumns((output.columns as string[]).filter((item): item is LogRecordExportColumn => typeof item === 'string') as LogRecordExportColumn[])
        : [...DEFAULT_EXPORT_COLUMNS],
      format: output.format === 'tsv' ? 'tsv' : 'csv',
    },
    createdAt: cleanText(source.createdAt, new Date(0).toISOString(), 80),
    updatedAt: cleanText(source.updatedAt, new Date(0).toISOString(), 80),
  }
}

function mergeHarness(left: EvaluationHarness, right: EvaluationHarness): EvaluationHarness {
  const newest = left.updatedAt >= right.updatedAt ? left : right
  const rules = new Map<string, EvaluationHarnessRule>()
  for (const rule of [...left.rules, ...right.rules]) {
    const previous = rules.get(rule.id)
    if (!previous || rule.updatedAt >= previous.updatedAt) rules.set(rule.id, rule)
  }
  return {
    ...newest,
    id: left.evaluationScopeId ? `scope:${left.evaluationScopeId}` : newest.id,
    name: '현재 폴더 분석 기준',
    rules: [...rules.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createdAt: left.createdAt <= right.createdAt ? left.createdAt : right.createdAt,
    updatedAt: left.updatedAt >= right.updatedAt ? left.updatedAt : right.updatedAt,
  }
}

export function evaluationHarnessesFromPreset(preset: ProjectExportPreset | undefined): EvaluationHarness[] {
  const source = record(preset?.options)
  const normalized = Array.isArray(source.harnesses)
    ? source.harnesses.flatMap((item) => {
      const harness = normalizeEvaluationHarness(item)
      return harness ? [harness] : []
    })
    : []
  return [...normalized.reduce((groups, harness) => {
    const key = harness.evaluationScopeId ? `scope:${harness.evaluationScopeId}` : harness.id
    const previous = groups.get(key)
    groups.set(key, previous ? mergeHarness(previous, harness) : harness)
    return groups
  }, new Map<string, EvaluationHarness>()).values()]
}

export function evaluationHarnessPreset(
  harnesses: readonly EvaluationHarness[],
  existing?: ProjectExportPreset,
): Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'> & { id?: string } {
  return {
    id: EVALUATION_HARNESS_PRESET_ID,
    name: EVALUATION_HARNESS_PRESET_NAME,
    format: 'json',
    options: {
      version: 2,
      harnesses: harnesses.map((item) => item as unknown as JsonValue),
    },
    ...(existing?.archived ? { archived: false } : {}),
  }
}

export function harnessFromEngineerWorkflow(
  memory: EngineerWorkflowMemoryView,
  existing?: EvaluationHarness,
): EvaluationHarness {
  const rule = normalizeHarnessRule({
    id: `workflow:${memory.id}`,
    name: memory.name,
    purpose: memory.purpose,
    when: { dimensions: memory.dimensions ?? {} },
    look: memory.checks,
    judge: { result: memory.result },
    usage: {
      confirmedCount: memory.confirmedCount,
      appliedCount: memory.appliedCount,
      correctedCount: existing?.rules.find((item) => item.id === `workflow:${memory.id}`)?.usage.correctedCount ?? 0,
    },
    createdAt: existing?.rules.find((item) => item.id === `workflow:${memory.id}`)?.createdAt ?? memory.createdAt,
    updatedAt: memory.updatedAt,
  })!
  return normalizeEvaluationHarness({
    id: memory.evaluationScopeId ? `scope:${memory.evaluationScopeId}` : `workflow:${memory.id}`,
    name: '현재 폴더 분석 기준',
    source: 'engineer-behavior',
    evaluationScopeId: memory.evaluationScopeId,
    rules: [...(existing?.rules.filter((item) => item.id !== rule.id) ?? []), rule],
    output: existing?.output ?? { layout: DEFAULT_PATTERN_LAYOUT, columns: DEFAULT_EXPORT_COLUMNS, format: 'csv' },
    createdAt: existing?.createdAt ?? memory.createdAt,
    updatedAt: memory.updatedAt,
  })!
}

export function upsertEvaluationHarness(
  harnesses: readonly EvaluationHarness[],
  next: EvaluationHarness,
): EvaluationHarness[] {
  return [...harnesses.filter((item) => item.id !== next.id
    && (!next.evaluationScopeId || item.evaluationScopeId !== next.evaluationScopeId)), next]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 50)
}

export function evaluationHarnessForScope(
  harnesses: readonly EvaluationHarness[],
  evaluationScopeId?: string,
): EvaluationHarness | undefined {
  if (!evaluationScopeId) return undefined
  return harnesses.find((item) => item.evaluationScopeId === evaluationScopeId)
}

export function evaluationHarnessWithLayout(harness: EvaluationHarness, layout: PatternLayout, stamp = new Date().toISOString()): EvaluationHarness {
  return { ...harness, output: { ...harness.output, layout: normalizePatternLayout(layout) }, updatedAt: stamp }
}

export function evaluationHarnessWithColumns(
  harness: EvaluationHarness,
  columns: readonly LogRecordExportColumn[],
  stamp = new Date().toISOString(),
): EvaluationHarness {
  const normalized = normalizeExportColumns(columns)
  return {
    ...harness,
    output: { ...harness.output, columns: normalized.length ? normalized : [...DEFAULT_EXPORT_COLUMNS] },
    updatedAt: stamp,
  }
}
