import { describe, expect, it } from 'vitest'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import { buildProjectOnboardingAnswers, isPublicSyntheticDemo, PROJECT_INIT_ITEMS, visibleProjectList } from './ProjectControl'

const project = (id: string, description?: string): ProjectSnapshot => ({
  schemaVersion: 2, id, name: 'LPDDR 합성 평가 데모', revision: 1, archived: false,
  createdAt: '', updatedAt: '', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [], exportPresets: [],
  ...(description ? { description } : {}),
})

describe('visibleProjectList', () => {
  it('marks only the explicitly public synthetic project as share-safe', () => {
    expect(isPublicSyntheticDemo(project('public', 'SCT_PUBLIC_SYNTHETIC_DEMO_V6 · 공개 가능한 합성 데이터'))).toBe(true)
    expect(isPublicSyntheticDemo(project('user'))).toBe(false)
    expect(isPublicSyntheticDemo(project('legacy', 'SCT_SAMPLE_EVALUATION_V5 · sample'))).toBe(false)
  })

  it('keeps user projects while hiding only superseded built-in sample versions', () => {
    const projects = visibleProjectList([
      project('user-a'), project('user-b'),
      project('sample-v1', 'SCT_SAMPLE_LPDDR6_XIAOMI_V1 · sample'),
      project('sample-v2', 'SCT_SAMPLE_LPDDR6_XIAOMI_V2 · sample'),
      project('reference-v1', 'SCT_SAMPLE_LPDDR5_REFERENCE_V1 · sample'),
      project('public-v5', 'SCT_PUBLIC_SYNTHETIC_DEMO_V5 · sample'),
      project('public-v6', 'SCT_PUBLIC_SYNTHETIC_DEMO_V6 · sample'),
    ])
    expect(projects.map((item) => item.id)).toEqual(['user-a', 'user-b', 'sample-v2', 'reference-v1', 'public-v6'])
  })
})

describe('project creation defaults', () => {
  it('always enables the standard log dimensions without a per-project selection', () => {
    const answers = buildProjectOnboardingAnswers({ name: '4-Corner', purpose: 'Cold LVDD 재현', reuseProjectId: '' })
    expect(answers.importantMetadata.split(' · ')).toEqual(PROJECT_INIT_ITEMS)
    expect(answers.importantMetadata).toContain('Sample')
    expect(answers.importantMetadata).toContain('Skew')
    expect(answers.importantMetadata).toContain('VDD')
    expect(answers.importantMetadata).toContain('PASS/FAIL')
  })
})
