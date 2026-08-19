import { describe, expect, it } from 'vitest'
import { buildProjectClonePlan } from '../components/ProjectControl'
import type { ProjectSnapshot } from '../../electron/shared/contracts'
import {
  DEFAULT_PATTERN_LAYOUT,
  PATTERN_LAYOUT_PRESET_ID,
  PATTERN_LAYOUT_PRESET_NAME,
  normalizePatternLayout,
  patternLayoutPreset,
  patternLayoutWithAgentProposal,
} from './patternLayout'

describe('pattern layout persistence', () => {
  it('normalizes malformed persisted axes, filters, and aggregation to safe values', () => {
    expect(normalizePatternLayout({
      rowAxes: ['sample', 'sample'], columnAxes: ['not-a-dimension', 'folder'], aggregation: 'invalid',
      resultFilter: 'INVALID', folderFilter: 'bad\nfolder', failOnly: 'yes', unknownMetadataOnly: true,
    })).toEqual({ ...DEFAULT_PATTERN_LAYOUT, rowAxes: ['sample'], columnAxes: ['folder'], unknownMetadataOnly: true })
  })

  it('applies a validated Agent view temporarily while preserving unrelated filters', () => {
    const current = { ...DEFAULT_PATTERN_LAYOUT, resultFilter: 'TEST_FAIL' as const, folderFilter: '03-acceleration', unknownMetadataOnly: true }
    const next = patternLayoutWithAgentProposal(current, {
      id: 'proposal-1', dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'],
      aggregation: 'fail_event_count', visualization: 'heatmap', failOnly: true,
    })
    expect(next).toMatchObject({
      dataBasis: 'failure_address', rowAxes: ['dq'], columnAxes: ['bl'], aggregation: 'fail_event_count', visualization: 'heatmap', failOnly: true,
      resultFilter: 'TEST_FAIL', folderFilter: '03-acceleration', unknownMetadataOnly: true,
    })
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

  it('restores a compatible visualization and safely opens incompatible legacy data as a table', () => {
    expect(normalizePatternLayout({ visualization: 'heatmap', aggregation: 'fail_rate' }).visualization).toBe('heatmap')
    expect(normalizePatternLayout({ visualization: 'stacked_percent', aggregation: 'pass_fail' }).visualization).toBe('stacked_percent')
    expect(normalizePatternLayout({ visualization: 'stacked_percent', aggregation: 'count' }).visualization).toBe('cross_table')
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
