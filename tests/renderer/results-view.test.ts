import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { projectLogRecords } from '../../src/state/logRecords'
import { createResultsCsvBlob, normalizedMetadataEdit, ResultsView } from '../../src/views/ResultsView'
import {
  RESULT_EXPORT_PRESET_ID,
  normalizeResultExportLayout,
  resultExportLayoutFromPreset,
  resultExportLayoutPreset,
} from '../../src/state/resultExportLayout'

describe('renderer results export', () => {
  it('downloads one BOM followed by the metadata/result/stage default header and row', async () => {
    const rows = projectLogRecords([{
      id: 'formula',
      name: '=cmd.log',
      origin: '/Users/private/root',
      relativePath: '/Users/private/root/=cmd.log',
      text: 'secret excerpt\n@PASS',
    }])
    const bytes = new Uint8Array(await createResultsCsvBlob(rows).arrayBuffer())
    const content = Buffer.from(bytes).toString('utf8')
    const lines = content.split('\r\n')

    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(content.startsWith('\uFEFF')).toBe(true)
    expect(content.slice(1)).not.toContain('\uFEFF')
    expect(lines).toHaveLength(2)
    expect(lines[0].slice(1).split(',')).toHaveLength(19)
    expect(lines[1].split(',')).toHaveLength(19)
    expect(lines[1]).toContain("\"'=cmd.log\"")
    expect(content).not.toContain('/Users/private/root')
    expect(content).not.toContain('secret excerpt')
  })

  it('creates a shared-column CSV blob for a selected export subset', async () => {
    const rows = projectLogRecords([{ id: 'one', name: 'one.log', text: '@PASS' }])
    const bytes = new Uint8Array(await createResultsCsvBlob(rows, ['filename', 'result']).arrayBuffer())
    const content = Buffer.from(bytes).toString('utf8')

    expect(content).toBe('\uFEFF"filename","result"\r\n"one.log","PASS"')
  })

  it('adds evidence columns only when the evidence group is explicitly selected', async () => {
    const rows = projectLogRecords([{ id: 'one', name: 'one.log', text: '@PASS' }], { one: 2 })
    const bytes = new Uint8Array(await createResultsCsvBlob(rows, ['result', 'evidence_count', 'selected_evidence_count']).arrayBuffer())
    const content = Buffer.from(bytes).toString('utf8')

    expect(content).toBe('\uFEFF"result","evidence_count","selected_evidence_count"\r\n"PASS","2","2"')
  })

  it('persists a normalized ordered column subset as a project export preset', () => {
    const preset = resultExportLayoutPreset({ columns: ['filename', 'result', 'filename', 'evidence_count'] })
    expect(preset).toMatchObject({ id: RESULT_EXPORT_PRESET_ID, format: 'csv', options: { columns: ['filename', 'result', 'evidence_count'] } })
    expect(resultExportLayoutFromPreset({ ...preset, createdAt: '', updatedAt: '' }).columns).toEqual(['filename', 'result', 'evidence_count'])
    expect(normalizeResultExportLayout({ columns: ['not-a-column'] }).columns).not.toHaveLength(0)
  })

  it('stores export columns independently for each evaluation folder', () => {
    const first = resultExportLayoutPreset({ columns: ['filename', 'result'] }, undefined, 'evaluation-a')
    const second = resultExportLayoutPreset({ columns: ['sample_value', 'temperature_value', 'result'] }, { ...first, createdAt: '', updatedAt: '' }, 'evaluation-b')
    const preset = { ...second, createdAt: '', updatedAt: '' }
    expect(resultExportLayoutFromPreset(preset, 'evaluation-a').columns).toEqual(['filename', 'result'])
    expect(resultExportLayoutFromPreset(preset, 'evaluation-b').columns).toEqual(['sample_value', 'temperature_value', 'result'])
  })
})

describe('result metadata review', () => {
  it('normalizes common VDD input without accepting arbitrary text', () => {
    expect(normalizedMetadataEdit('vdd', '1.295V')).toBe('1.295')
    expect(normalizedMetadataEdit('vdd', '1p315')).toBe('1.315')
    expect(normalizedMetadataEdit('vdd', 'invalid')).toBeNull()
    expect(normalizedMetadataEdit('sample', ' DHCST-89 ')).toBe('DHCST-89')
  })
})


it('blocks result export and explains why while address inspection is incomplete', () => {
  const rows = projectLogRecords([{ id: 'one', name: 'one.log', rootId: 'a', text: '@PASS' }])
  const render = (status: 'loading' | 'ready') => renderToStaticMarkup(createElement(ResultsView, {
    records: rows, project: null, onProjectUpdated: () => {}, onOpenFile: () => {}, stageInspectionStates: { one: { status: 'ready' } },
    addressInspectionStates: { one: { status } },
  }))
  const pending = render('loading')
  expect(pending).toContain('주소 검사')
  const copyButton = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes('TSV 복사'))
  expect(copyButton(pending)).toMatch(/^<button[^>]*disabled=/)
  expect(pending).toContain('검사가 끝난 뒤 내보낼 수 있습니다.')
  const ready = render('ready')
  expect(ready).not.toContain('검사가 끝난 뒤 내보낼 수 있습니다.')
  expect(copyButton(ready)).toBeDefined()
  expect(copyButton(ready)).not.toMatch(/^<button[^>]*disabled=/)
})
