import { describe, expect, it } from 'vitest'
import {
  filterLogRecords,
  exportableLogRecords,
  patternMatrix,
  projectLogRecords,
  selectAllFilteredLogRecords,
  selectedLogRecords,
  serializeLogRecordsCsv,
  serializeLogRecordsTsv,
  sortLogRecords,
  toggleLogRecordSelection,
} from '../../src/state/logRecords'
import type { WorkbenchFile } from '../../src/views/WorkbenchView'

const files: WorkbenchFile[] = [
  {
    id: 'pass',
    name: 'LOT12_S01_85C_DIAG.log',
    origin: 'customer-a / 85C',
    relativePath: 'LOT12/SAMPLE_01/LOT12_S01_85C_DIAG.log',
    text: 'mode: DIAG inserted\n@PASS DIAG_COMPLETE\nnormal_end: true',
    decision: 'PASS',
  },
  {
    id: 'halt',
    name: 'LOT12_S03_85C_DIAG.log',
    origin: 'customer-a / 85C',
    relativePath: 'LOT12/SAMPLE_03/LOT12_S03_85C_DIAG.log',
    text: 'stressapp: start\nhidag: start\nwatchdog: heartbeat delayed\npmic: timeout',
  },
  {
    id: 'training',
    name: 'LOT12_S07_105C_DIAG.log',
    origin: 'customer-a / 105C',
    text: 'hidag: start\ntraining: lane1 timeout\nTRAINING_FAIL lane=1\n@FAIL',
  },
]

describe('renderer log result projection', () => {
  it('keeps one source log per row and marks filename metadata as unconfirmed candidates', () => {
    const rows = projectLogRecords(files)

    expect(rows).toHaveLength(files.length)
    expect(rows[0]).toMatchObject({
      id: 'pass',
      sample: { value: '01', state: 'candidate' },
      temperature: { value: '85', state: 'candidate' },
      mode: { value: 'DIAG', state: 'candidate' },
      result: 'PASS',
      resultSource: 'engineer',
      review: 'confirmed',
    })
  })

  it('keeps local result inference as a reviewable candidate', () => {
    const byId = new Map(projectLogRecords(files).map((row) => [row.id, row]))

    expect(byId.get('halt')).toMatchObject({ result: 'SYSTEM_HALT', resultSource: 'candidate', review: 'needs_review' })
    expect(byId.get('training')).toMatchObject({ result: 'TRAINING_FAIL', resultSource: 'candidate', review: 'needs_review' })
  })

  it('parses deterministic sample prefixes and common filename modes without weakening ambiguity handling', () => {
    const rows = projectLogRecords([
      { id: 'hyphen', name: 'SMP-A17_85C_NORMAL.log', text: '' },
      { id: 'underscore', name: 'SMP_A17_85C_UEFI.log', text: '' },
      { id: 'labeled', name: 'LOT.SAMPLE=A17.TEMP=85C.MODE=UEFI.log', text: '' },
      { id: 'ambiguous', name: 'SMP-A17-SMP-B18_85C_NORMAL.log', text: '' },
    ])

    expect(rows.slice(0, 3).map((row) => [row.sample, row.mode])).toEqual([
      [{ value: 'A17', state: 'candidate' }, { value: 'NORMAL', state: 'candidate' }],
      [{ value: 'A17', state: 'candidate' }, { value: 'UEFI', state: 'candidate' }],
      [{ value: 'A17', state: 'candidate' }, { value: 'UEFI', state: 'candidate' }],
    ])
    expect(rows[3].sample).toEqual({ value: null, state: 'malformed' })
  })

  it('canonicalizes lowercase metadata and one redundant nested sample prefix', () => {
    const rows = projectLogRecords([
      { id: 'hyphen', name: 'smp-a17_85c_normal.log', text: '' },
      { id: 'underscore', name: 'smp_a17_85c_uefi.log', text: '' },
      { id: 'labeled', name: 'lot.sample=a17.temp=85c.mode=uefi.log', text: '' },
      { id: 'nested', name: 'sample=smp-a17_85c_mode=uefi.log', text: '' },
      { id: 'equivalent', name: 'smp-a17_sample=a17_85c_uefi.log', text: '' },
    ])

    expect(rows.map((row) => [row.sample.value, row.mode.value])).toEqual([
      ['A17', 'NORMAL'],
      ['A17', 'UEFI'],
      ['A17', 'UEFI'],
      ['A17', 'UEFI'],
      ['A17', 'UEFI'],
    ])
  })

  it('fails visibly for malformed filenames instead of inventing metadata', () => {
    const [row] = projectLogRecords([{ id: 'bad', name: 'broken.txt', text: '@PASS' }])

    expect(row.sample).toEqual({ value: null, state: 'malformed' })
    expect(row.temperature).toEqual({ value: null, state: 'malformed' })
    expect(row.mode).toEqual({ value: null, state: 'malformed' })
    expect(row.review).toBe('needs_review')
  })

  it('applies search, status, and review filters cumulatively and sorts without mutating input', () => {
    const rows = projectLogRecords(files)
    const filtered = filterLogRecords(rows, { query: '85c', result: 'SYSTEM_HALT', review: 'needs_review' })
    const sorted = sortLogRecords(rows, 'temperature', 'desc')

    expect(filtered.map((row) => row.id)).toEqual(['halt'])
    expect(sorted.map((row) => row.temperature.value)).toEqual(['105', '85', '85'])
    expect(rows.map((row) => row.id)).toEqual(['pass', 'halt', 'training'])
  })

  it('supports explicit folder scope without changing the other filters', () => {
    const rows = projectLogRecords(files)

    expect(filterLogRecords(rows, { query: '', result: 'all', review: 'all', folder: 'customer-a / 85C' }).map((row) => row.id)).toEqual(['pass', 'halt'])
    expect(filterLogRecords(rows, { query: '', result: 'all', review: 'all', folder: 'customer-a / 105C' }).map((row) => row.id)).toEqual(['training'])
  })

  it('keeps duplicate imported roots distinct with stable folder labels and filter scope', () => {
    const rows = projectLogRecords([
      {
        id: 'root-b-file',
        rootId: 'root-b',
        sourceKey: 'root:root-b\u001flogs/duplicate.log',
        name: 'duplicate.log',
        origin: 'logs',
        relativePath: 'logs/duplicate.log',
        text: '@PASS',
      },
      {
        id: 'root-a-file',
        rootId: 'root-a',
        sourceKey: 'root:root-a\u001flogs/duplicate.log',
        name: 'duplicate.log',
        origin: 'logs',
        relativePath: 'logs/duplicate.log',
        text: '',
      },
    ])

    expect(rows.map((row) => row.folder)).toEqual(['logs · 2', 'logs · 1'])
    expect(filterLogRecords(rows, { query: '', result: 'all', review: 'all', folder: 'logs · 1' }).map((row) => row.id)).toEqual(['root-a-file'])
  })

  it('selects filtered rows while preserving selections outside the current page or filter', () => {
    const rows = projectLogRecords(files)
    const firstPage = rows.slice(0, 2)
    const secondPage = rows.slice(2)
    const initial = toggleLogRecordSelection(new Set<string>(), 'training')
    const selectedFirstPage = selectAllFilteredLogRecords(initial, firstPage, true)

    expect([...selectedFirstPage].sort()).toEqual(['halt', 'pass', 'training'])
    expect(selectedLogRecords(rows, selectedFirstPage).map((row) => row.id)).toEqual(['pass', 'halt', 'training'])
    expect([...selectAllFilteredLogRecords(selectedFirstPage, secondPage, false)]).toEqual(['pass', 'halt'])
  })

  it('keeps retained selections out of export when they are outside the current scope', () => {
    const rows = projectLogRecords(files)
    const selected = new Set(['pass', 'training'])

    expect(exportableLogRecords(rows.filter((row) => row.folder === 'customer-a / 85C'), selected).map((row) => row.id)).toEqual(['pass'])
    expect(exportableLogRecords(rows.filter((row) => row.folder === 'missing'), selected)).toEqual([])
    expect(exportableLogRecords(rows, new Set())).toHaveLength(rows.length)
  })

  it('builds a condition-by-result pivot from the same rows', () => {
    const matrix = patternMatrix(projectLogRecords(files), 'temperature')

    expect(matrix).toEqual([
      { value: '85', total: 2, counts: { PASS: 1, SYSTEM_HALT: 1 } },
      { value: '105', total: 1, counts: { TRAINING_FAIL: 1 } },
    ])
  })

  it('exports safe spreadsheet text and preserves the visible row count', () => {
    const rows = projectLogRecords([{ ...files[0], id: 'formula', name: '=cmd.log' }])
    const tsv = serializeLogRecordsTsv(rows)

    expect(tsv.split('\r\n')).toHaveLength(2)
    expect(tsv).toContain("'=cmd.log")
  })

  it('keeps the requested export column order and subset in both serializers', () => {
    const rows = projectLogRecords(files, { pass: 2 })
    const columns = ['result', 'filename', 'selected_evidence_count'] as const
    const tsvLines = serializeLogRecordsTsv(rows.slice(0, 1), columns).split('\r\n')
    const csvLines = serializeLogRecordsCsv(rows.slice(0, 1), columns).split('\r\n')

    expect(tsvLines[0]).toBe('\uFEFFresult\tfilename\tselected_evidence_count')
    expect(tsvLines[1]).toBe('PASS\tLOT12_S01_85C_DIAG.log\t2')
    expect(csvLines[0]).toBe('\uFEFF"result","filename","selected_evidence_count"')
    expect(csvLines[1]).toBe('"PASS","LOT12_S01_85C_DIAG.log","2"')
  })

  it('exports stable source identity and separate metadata value/state columns', () => {
    const duplicateNameFiles: WorkbenchFile[] = [
      {
        id: 'source-a',
        artifactId: 'artifact-a',
        sourceKey: 'root:root-a\u001flogs/duplicate.log',
        name: 'duplicate.log',
        origin: 'Root A',
        relativePath: 'logs/duplicate.log',
        text: '@PASS',
      },
      {
        id: 'source-b',
        artifactId: 'artifact-b',
        sourceKey: 'root:root-b\u001flogs/duplicate.log',
        name: 'duplicate.log',
        origin: 'Root B',
        relativePath: 'logs/duplicate.log',
        text: '',
      },
    ]
    const tsv = serializeLogRecordsTsv(projectLogRecords(duplicateNameFiles))

    expect(tsv).toBe([
      '\uFEFFsource_id\tartifact_id\tsource_key\trelative_path\trun\tfilename\tfolder\tsample_value\tsample_state\ttemperature_value\ttemperature_state\tmode_value\tmode_state\tresult\tresult_source\treview',
      'source-a\tartifact-a\troot:root-a\u001flogs/duplicate.log\tlogs/duplicate.log\t\tduplicate.log\tRoot A\t\tmissing\t\tmissing\t\tmissing\tPASS\tcandidate\tneeds_review',
      'source-b\tartifact-b\troot:root-b\u001flogs/duplicate.log\tlogs/duplicate.log\t\tduplicate.log\tRoot B\t\tmissing\t\tmissing\t\tmissing\tUNKNOWN\tunreviewed\tneeds_review',
    ].join('\r\n'))
  })

  it('exports approved, rejected, missing, and malformed metadata states', () => {
    const metadataFiles: WorkbenchFile[] = [
      { id: 'approved', name: 'LOT_S01_85C_DIAG_run007.log', text: '@PASS' },
      { id: 'rejected', name: 'LOT_S02_85C_DIAG.log', text: '@PASS' },
      { id: 'missing', name: 'plain.log', text: '' },
      { id: 'malformed', name: 'broken.txt', text: '@PASS' },
    ]
    const rows = projectLogRecords(metadataFiles, { approved: 0 }, {
      approved: {
        sample: { approval: 'approved', approvedValue: 'S-APPROVED' },
      },
      rejected: {
        temperature: { approval: 'rejected' },
      },
    })

    expect(rows.map((row) => [
      row.run,
      row.sample.value,
      row.sample.state,
      row.temperature.value,
      row.temperature.state,
      row.mode.value,
      row.mode.state,
      row.evidenceCount,
    ])).toEqual([
      ['007', 'S-APPROVED', 'approved', '85', 'candidate', 'DIAG', 'candidate', 0],
      [undefined, '02', 'candidate', '85', 'rejected', 'DIAG', 'candidate', 1],
      [undefined, null, 'missing', null, 'missing', null, 'missing', 0],
      [undefined, null, 'malformed', null, 'malformed', null, 'malformed', 1],
    ])

    const lines = serializeLogRecordsTsv(rows).split('\r\n')
    expect(lines[1].split('\t').slice(0, 16)).toEqual([
      'approved', '', '', 'LOT_S01_85C_DIAG_run007.log', '007', 'LOT_S01_85C_DIAG_run007.log', 'Imported logs',
      'S-APPROVED', 'approved', '85', 'candidate', 'DIAG', 'candidate', 'PASS', 'candidate', 'needs_review',
    ])
    expect(lines[2].split('\t').slice(7, 13)).toEqual(['02', 'candidate', '85', 'rejected', 'DIAG', 'candidate'])
    expect(lines[3].split('\t').slice(7, 13)).toEqual(['', 'missing', '', 'missing', '', 'missing'])
    expect(lines[4].split('\t').slice(7, 13)).toEqual(['', 'malformed', '', 'malformed', '', 'malformed'])
  })

  it('does not export absolute paths or raw excerpts and preserves CSV quoting', () => {
    const rows = projectLogRecords([{
      id: 'safe',
      artifactId: 'artifact-safe',
      sourceKey: 'root-safe',
      name: 'same.log',
      origin: '/Users/private/root',
      relativePath: '/Users/private/root/same.log',
      text: 'secret excerpt\n@PASS',
    }])
    const csv = serializeLogRecordsCsv(rows)

    expect(csv).toContain('"same.log"')
    expect(csv).not.toContain('/Users/private/root')
    expect(csv).not.toContain('secret excerpt')
    expect(csv.split('\r\n')).toHaveLength(2)
  })

  it('preserves opaque source roots while sanitizing source-key paths', () => {
    const sourceKeyFiles: WorkbenchFile[] = [
      {
        id: 'posix-absolute',
        sourceKey: 'root:opaque-posix\u001f/Users/private/logs/posix.log',
        name: 'posix.log',
        relativePath: 'posix.log',
        text: '@PASS',
      },
      {
        id: 'windows-absolute',
        sourceKey: 'root:opaque-windows\u001fC:\\Users\\private\\logs\\windows.log',
        name: 'windows.log',
        relativePath: 'windows.log',
        text: '@PASS',
      },
      {
        id: 'parent-traversal',
        sourceKey: 'root:opaque-parent\u001f../../private/logs/traversal.log',
        name: 'traversal.log',
        relativePath: 'traversal.log',
        text: '@PASS',
      },
      {
        id: 'relative',
        sourceKey: 'root:opaque-relative\u001flogs/relative.log',
        name: 'relative.log',
        relativePath: 'logs/relative.log',
        text: '@PASS',
      },
    ]
    const rows = projectLogRecords(sourceKeyFiles)
    const tsv = serializeLogRecordsTsv(rows)
    const lines = tsv.split('\r\n')
    const sourceKeyColumn = 2

    expect(lines[0].split('\t')).toHaveLength(16)
    expect(lines.slice(1).map((line) => line.split('\t')[sourceKeyColumn])).toEqual([
      'root:opaque-posix\u001fposix.log',
      'root:opaque-windows\u001fwindows.log',
      'root:opaque-parent\u001ftraversal.log',
      'root:opaque-relative\u001flogs/relative.log',
    ])
    expect(tsv.startsWith('\uFEFF')).toBe(true)
    expect(tsv).toContain('\r\n')
    expect(tsv).not.toContain('/Users/private')
    expect(tsv).not.toContain('C:/Users/private')
    expect(tsv).not.toContain('..')
  })
})
