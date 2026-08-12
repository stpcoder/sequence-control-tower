import { describe, expect, it } from 'vitest'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import { visibleProjectList } from './ProjectControl'

const project = (id: string, description?: string): ProjectSnapshot => ({
  schemaVersion: 2, id, name: 'LPDDR6 Xiaomi', revision: 1, archived: false,
  createdAt: '', updatedAt: '', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [],
  ...(description ? { description } : {}),
})

describe('visibleProjectList', () => {
  it('keeps user projects while hiding only superseded built-in sample versions', () => {
    const projects = visibleProjectList([
      project('user-a'), project('user-b'),
      project('sample-v1', 'SCT_SAMPLE_LPDDR6_XIAOMI_V1 · sample'),
      project('sample-v2', 'SCT_SAMPLE_LPDDR6_XIAOMI_V2 · sample'),
      project('reference-v1', 'SCT_SAMPLE_LPDDR5_REFERENCE_V1 · sample'),
    ])
    expect(projects.map((item) => item.id)).toEqual(['user-a', 'user-b', 'sample-v2', 'reference-v1'])
  })
})
