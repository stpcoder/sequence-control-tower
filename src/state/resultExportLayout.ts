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

export function resultExportLayoutFromPreset(preset: ProjectExportPreset | undefined): ResultExportLayout {
  return normalizeResultExportLayout(preset?.options)
}

export function resultExportLayoutPreset(
  layout: ResultExportLayout,
  existing?: ProjectExportPreset,
): Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'> & { id?: string } {
  return {
    id: RESULT_EXPORT_PRESET_ID,
    name: RESULT_EXPORT_PRESET_NAME,
    format: 'csv',
    options: normalizeResultExportLayout(layout) as unknown as Record<string, JsonValue>,
    ...(existing?.archived ? { archived: false } : {}),
  }
}
