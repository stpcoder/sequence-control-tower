import type { RunStatus } from '../data/demo'

const labels: Record<RunStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  review: 'Review',
  running: 'Running',
  ready: 'Ready',
  offline: 'Offline',
}

export function StatusDot({ status, label }: { status: RunStatus; label?: string }) {
  return (
    <span className={`status-dot status-${status}`}>
      <i aria-hidden="true" />
      {label ?? labels[status]}
    </span>
  )
}
