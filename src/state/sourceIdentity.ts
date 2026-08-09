import type { ProjectArtifactSourceRef, EvaluationSourceInput } from '../../electron/shared/contracts'
import type { WorkbenchFile } from '../views/WorkbenchView'

export function normalizeSourcePath(value: string): string {
  const segments: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

export function sourceKeyFor(rootId: string, relativePath: string): string {
  return `root:${rootId}\u001f${normalizeSourcePath(relativePath)}`
}

export function matchesProjectSource(file: Pick<WorkbenchFile, 'artifactId' | 'rootId' | 'relativePath' | 'sourceKey'>, source: Pick<ProjectArtifactSourceRef, 'artifactId' | 'rootId' | 'artifactRootId' | 'relativePath'>): boolean {
  return file.artifactId === source.artifactId
    && file.rootId === (source.artifactRootId ?? source.rootId)
    && normalizeSourcePath(file.relativePath ?? '') === normalizeSourcePath(source.relativePath)
}

export function matchesPersistedSource(file: Pick<WorkbenchFile, 'id' | 'artifactId' | 'rootId' | 'relativePath' | 'sourceKey'>, source: Pick<EvaluationSourceInput, 'sourceId' | 'artifactId'> & { sourceKey?: string }, projectSources: readonly ProjectArtifactSourceRef[] = []): boolean {
  if (file.artifactId !== source.artifactId) return false
  const projectSource = projectSources.find((candidate) => candidate.sourceId === source.sourceId)
  if (projectSource) return matchesProjectSource(file, projectSource)
  if (source.sourceKey && file.sourceKey && source.sourceKey === file.sourceKey) return true
  return source.sourceId === file.id
}

export function resolveProjectSource(project: { artifacts: readonly ProjectArtifactSourceRef[] }, file: Pick<WorkbenchFile, 'artifactId' | 'rootId' | 'relativePath' | 'sourceKey'>): ProjectArtifactSourceRef | null {
  if (!file.artifactId) return null
  const candidates = project.artifacts.filter((source) => source.artifactId === file.artifactId)
  const exact = candidates.filter((source) => matchesProjectSource(file, source))
  if (exact.length === 1) return exact[0]
  return !file.rootId && !file.relativePath && candidates.length === 1 ? candidates[0] : null
}
