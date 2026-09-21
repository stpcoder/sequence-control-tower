import type { ProjectExportPreset, ProjectSnapshot } from '../../electron/shared/contracts'

type PresetUpdate = Omit<ProjectExportPreset, 'createdAt' | 'updatedAt'>

/** Prepare all related presets for one atomic project save. */
export function mergeProjectPresets(project: ProjectSnapshot, updates: readonly PresetUpdate[], now = new Date().toISOString()): ProjectExportPreset[] {
  const merged = new Map(project.exportPresets.map((preset) => [preset.id, preset]))
  for (const update of updates) {
    const previous = merged.get(update.id)
    merged.set(update.id, { ...previous, ...update, createdAt: previous?.createdAt ?? now, updatedAt: now })
  }
  return [...merged.values()]
}
