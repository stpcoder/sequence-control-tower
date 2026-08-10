import { describe, expect, it } from 'vitest'
import { projectLogRecords } from '../../src/state/logRecords'
import { createResultsCsvBlob } from '../../src/views/ResultsView'

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
})
