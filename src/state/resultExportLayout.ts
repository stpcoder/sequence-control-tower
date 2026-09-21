import type { JsonValue, ProjectExportPreset } from '../../electron/shared/contracts'
import { DEFAULT_EXPORT_COLUMNS, normalizeExportColumns, type LogRecordExportColumn } from './logRecords'

export const RESULT_EXPORT_PRESET_ID = 'sequence-control-tower.results-export.v1'
export const RESULT_EXPORT_PRESET_NAME = '결과 내보내기 열'

export interface ResultExportLayout { columns: LogRecordExportColumn[] }

export function normalizeResultExportLayout(value: unknown): ResultExportLayout {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const columns = Array.isArray(source.columns)
    ? normalizeExportColumns(source.columns.filter((item): item is LogRecordExportColumn => typeof item === 'string') as LogRecordExportColumn[])
    : []
  return { columns: columns.length ? columns : [...DEFAULT_EXPORT_COLUMNS] }
}

function scopedResultLayouts(preset: ProjectExportPreset | undefined): Record<string, unknown> {
  const options = preset?.options as Record<string, unknown> | undefined
  const layouts = options?.layoutsByEvaluation
  return layouts && typeof layouts === 'object' && !Array.isArray(layouts) ? layouts as Record<string, unknown> : {}
}

export function resultExportLayoutFromPreset(preset: ProjectExportPreset | undefined, evaluationScopeId?: string): ResultExportLayout {
  const scoped = evaluationScopeId ? scopedResultLayouts(preset)[evaluationScopeId] : undefined
  if (scoped) return normalizeResultExportLayout(scoped)
  const options = preset?.options as Record<string, unknown> | undefined
  return normalizeResultExportLayout(options?.defaultLayout ?? options)
}

export function resultExportLayoutPreset(
  layout: ResultExportLayout,
  existing?: ProjectExportPreset,
  evaluationScopeId?: string,
): Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'> & { id?: string } {
  const normalized = normalizeResultExportLayout(layout)
  const options = evaluationScopeId
    ? {
        version: 2,
        defaultLayout: resultExportLayoutFromPreset(existing),
        layoutsByEvaluation: { ...scopedResultLayouts(existing), [evaluationScopeId]: normalized },
      }
    : normalized
  return {
    id: RESULT_EXPORT_PRESET_ID,
    name: RESULT_EXPORT_PRESET_NAME,
    format: 'csv',
    options: options as unknown as Record<string, JsonValue>,
    ...(existing?.archived ? { archived: false } : {}),
  }
}
