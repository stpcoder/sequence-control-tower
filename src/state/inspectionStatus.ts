export type InspectionStatus = { status: 'loading' | 'ready' | 'error'; message?: string }
export type InspectionStates = Record<string, InspectionStatus>

export function completedInspectionStates(fileIds: ReadonlyMap<string, string>, sources: readonly { sourceId: string; error?: string }[]): InspectionStates {
  const byId = new Map(sources.map((source) => [source.sourceId, source]))
  return Object.fromEntries([...fileIds].map(([sourceId, fileId]) => {
    const source = byId.get(sourceId)
    return [fileId, !source || source.error
      ? { status: 'error', message: source?.error || '검사 응답에 이 로그가 없습니다.' }
      : { status: 'ready' }]
  }))
}

export function inspectionSummary(states: InspectionStates | undefined, records: readonly { id: string }[]) {
  const pending = records.filter((record) => states?.[record.id]?.status === 'loading').length
  const errors = records.filter((record) => states?.[record.id]?.status === 'error')
  return { pending, errors, incomplete: pending > 0 || errors.length > 0 }
}
