import { describe, expect, it } from 'vitest'
import { buildProjectClonePlan } from '../components/ProjectControl'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import {
  DEFAULT_PATTERN_LAYOUT,
  PATTERN_LAYOUT_PRESET_ID,
  PATTERN_LAYOUT_PRESET_NAME,
  normalizePatternLayout,
  patternLayoutPreset,
} from './patternLayout'

describe('pattern layout persistence', () => {
  it('normalizes malformed persisted axes, filters, and aggregation to safe values', () => {
    expect(normalizePatternLayout({
      rowAxes: ['sample', 'sample'], columnAxes: ['not-a-dimension', 'folder'], aggregation: 'invalid',
      resultFilter: 'INVALID', folderFilter: 'bad\nfolder', failOnly: 'yes', unknownMetadataOnly: true,
    })).toEqual({ ...DEFAULT_PATTERN_LAYOUT, rowAxes: ['sample'], columnAxes: ['folder'], unknownMetadataOnly: true })
  })

  it('writes one reserved JSON preset identity with the complete layout', () => {
    const preset = patternLayoutPreset({ ...DEFAULT_PATTERN_LAYOUT, rowAxes: ['mode', 'run'], failOnly: true })
    expect(preset).toMatchObject({ id: PATTERN_LAYOUT_PRESET_ID, name: PATTERN_LAYOUT_PRESET_NAME, format: 'json' })
    expect(preset.options).toMatchObject({ rowAxes: ['mode', 'run'], failOnly: true })
  })

  it('retains DRAM and operating-condition axes', () => {
    expect(normalizePatternLayout({
      rowAxes: ['frequencyMHz', 'vdd', 'pattern', 'mode'], columnAxes: ['dq', 'subChannel'], aggregation: 'fail_rate',
    })).toMatchObject({ rowAxes: ['frequencyMHz', 'vdd', 'pattern'], columnAxes: ['dq', 'subChannel'], aggregation: 'fail_rate' })
  })

  it('persists the combined PASS and FAIL display', () => {
    expect(normalizePatternLayout({ aggregation: 'pass_fail' }).aggregation).toBe('pass_fail')
  })

  it('keeps the layout preset in a reused project clone plan', () => {
    const source: ProjectSnapshot = {
      schemaVersion: 2, id: 'source', name: 'source', revision: 3, archived: false,
      createdAt: '', updatedAt: '', folders: [], artifacts: [], equipmentProfiles: [], templatePins: [],
      exportPresets: [{ ...patternLayoutPreset(DEFAULT_PATTERN_LAYOUT), createdAt: '', updatedAt: '' }],
    }
    const clone = buildProjectClonePlan(source)
    expect(clone.exportPresets).toHaveLength(1)
    expect(clone.exportPresets?.[0]).toMatchObject({ id: PATTERN_LAYOUT_PRESET_ID, name: PATTERN_LAYOUT_PRESET_NAME })
    expect(clone.exportPresets?.[0]?.options).not.toBe(source.exportPresets[0].options)
  })
})
