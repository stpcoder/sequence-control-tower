import { inspectionSummary, type InspectionStates } from '../state/inspectionStatus'

export function InspectionNotice({ label, states, records, onRetry }: { label: string; states?: InspectionStates; records: readonly { id: string; fileName?: string }[]; onRetry?: () => void }) {
  const { pending, errors, incomplete } = inspectionSummary(states, records)
  if (!incomplete) return null
  return <div className="inspection-notice" role={errors.length ? 'alert' : 'status'}>
    <span>{label} · {pending ? `${pending}개 검사 중` : `${errors.length}개 검사 실패`}</span>
    {errors.length ? <><details><summary>실패한 로그</summary><ul>{errors.map((record) => <li key={record.id}>{records.find((item) => item.id === record.id)?.fileName ?? record.id} · {states?.[record.id]?.message}</li>)}</ul></details><button type="button" onClick={onRetry}>다시 검사</button></> : null}
    <small>검사가 끝난 뒤 내보낼 수 있습니다.</small>
  </div>
}
