import { describe, expect, it } from 'vitest'
import { projectLogRecords } from '../../src/state/logRecords'

describe('log records metadata fallback', () => {
  it('keeps grid missing when only sample appears in content', () => {
    const [record] = projectLogRecords([{
      id: 'sample-only',
      name: 'capture.log',
      relativePath: 'capture.log',
      text: 'sample: SMP-001\nresult: PASS',
    }])

    expect(record.sample).toEqual({ value: 'SMP-001', state: 'candidate' })
    expect(record.grid).toEqual({ value: null, state: 'missing' })
  })
})
