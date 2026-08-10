import { describe, expect, it } from 'vitest'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import {
  buildProjectClonePlan,
  buildProjectOnboardingAnswers,
  isProjectInitStepValid,
  projectListSecondary,
  serializeOnboardingItems,
  type ProjectInitDraft
} from '../../src/components/ProjectControl'

const draft = (overrides: Partial<ProjectInitDraft> = {}): ProjectInitDraft => ({ name: '', purpose: '', items: [], custom: '', reuseProjectId: '', ...overrides })

describe('ProjectControl initialization helpers', () => {
  it('serializes selected common items and optional custom text into an onboarding string', () => {
    expect(serializeOnboardingItems(['Sample', '온도'], 'boot reason')).toBe('Sample · 온도 · boot reason')
    expect(serializeOnboardingItems([], '  ')).toBe('')
  })

  it('maps project purpose to evaluationTarget and extraction decisions to importantMetadata', () => {
    expect(buildProjectOnboardingAnswers(draft({
      name: 'Bring-up',
      purpose: 'Evaluate reboot safety',
      items: ['Mode', 'PASS/FAIL'],
      custom: 'stop reason'
    }))).toEqual({
      evaluationTarget: 'Evaluate reboot safety',
      importantMetadata: 'Mode · PASS/FAIL · stop reason',
      reuseRules: '새로 시작'
    })
  })

  it('validates one progressive step at a time', () => {
    expect(isProjectInitStepValid(1, draft())).toBe(false)
    expect(isProjectInitStepValid(1, draft({ name: 'Bring-up' }))).toBe(true)
    expect(isProjectInitStepValid(2, draft({ name: 'Bring-up' }))).toBe(false)
    expect(isProjectInitStepValid(2, draft({ name: 'Bring-up', items: ['Mode'] }))).toBe(true)
    expect(isProjectInitStepValid(2, draft({ name: 'Bring-up', custom: '정지 원인' }))).toBe(true)
    expect(isProjectInitStepValid(3, draft({ name: 'Bring-up', items: ['Mode'] }))).toBe(true)
  })

  it('builds a clone plan from settings only', () => {
    const source = {
      id: 'source', name: 'Source', revision: 4, archived: false, createdAt: '2026-01-01', updatedAt: '2026-01-02', schemaVersion: 2,
      folders: [{ rootId: 'root', displayLabel: 'logs', status: 'available', connectedAt: '2026-01-01' }],
      artifacts: [{ sourceId: 'source-ref', rootId: 'root', artifactId: 'artifact', relativePath: 'boot.log' }],
      onboardingAnswers: { evaluationTarget: 'Evaluate reboot safety', importantMetadata: 'Mode · stop reason' },
      equipmentProfiles: [{ alias: 'lab', profileId: 'p1', updatedAt: '2026-01-01' }],
      templatePins: [{ templateId: 't1', revision: 2, pinnedAt: '2026-01-01' }],
      exportPresets: [{ id: 'preset', name: 'CSV', format: 'csv', options: { evidence: true }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
    } satisfies ProjectSnapshot
    const plan = buildProjectClonePlan(source)
    expect(plan).toEqual({ onboardingAnswers: { evaluationTarget: 'Evaluate reboot safety', importantMetadata: 'Mode · stop reason' }, equipmentProfiles: source.equipmentProfiles, templatePins: source.templatePins, exportPresets: source.exportPresets })
    expect(plan).not.toHaveProperty('folders')
    expect(plan).not.toHaveProperty('artifacts')
    expect(plan).not.toHaveProperty('results')
    expect(plan.exportPresets).not.toBe(source.exportPresets)
    expect(plan.exportPresets?.[0]?.options).not.toBe(source.exportPresets[0].options)
    expect(projectListSecondary(source)).toBe('Evaluate reboot safety · 로그 1 · 폴더 1')
  })
})
