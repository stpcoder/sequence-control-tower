import { describe, expect, it } from 'vitest'
import {
  buildLogRecordExportPreview,
  buildPivotGrid,
  isPivotSelectionValid,
  confirmLogRecordExport,
  filterLogRecords,
  exportableLogRecords,
  initLogRecordExportPreview,
  patternMatrix,
  projectLogRecords,
  resultStageCheckpoints,
  selectAllFilteredLogRecords,
  selectedLogRecords,
  serializeLogRecordsCsv,
  serializeLogRecordsTsv,
  serializePivotGridCsv,
  serializePivotGridTsv,
  previewLogRecordExport,
  sortLogRecords,
  toggleLogRecordSelection,
} from '../../src/state/logRecords'
import type { LogResultRecord } from '../../src/state/logRecords'
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
  it('invalidates selected pivot cells when the cell or its source records disappear', () => {
    const rows = projectLogRecords(files)
    const grid = buildPivotGrid(rows, { rows: ['sample'], columns: ['temperature'], aggregation: 'count', filters: { query: '', result: 'all', review: 'all' } })
    const cellKey = `${grid.rows[0].key}-${grid.columns[0].key}`

    expect(isPivotSelectionValid(cellKey, new Set(['pass']), grid, rows)).toBe(true)
    expect(isPivotSelectionValid('missing-cell', new Set(['pass']), grid, rows)).toBe(false)
    expect(isPivotSelectionValid(cellKey, new Set(['pass']), grid, rows.filter((row) => row.id !== 'pass'))).toBe(false)
  })

  it('exports the arranged pivot as an Excel-safe n by m CSV', () => {
    const grid = buildPivotGrid(projectLogRecords(files), { rows: ['sample'], columns: ['temperature'], aggregation: 'count', filters: { query: '', result: 'all', review: 'all' } })
    const csv = serializePivotGridCsv(grid, 'Sample')
    expect(csv).toContain('"Sample"')
    expect(csv).toContain('"85"')
    expect(csv.split('\r\n')).toHaveLength(grid.rows.length + 1)
    expect(serializePivotGridTsv(grid, ['Sample'])).toContain('Sample\t85')
    const report = serializePivotGridCsv(grid, ['Sample'], {
      rowTotals: grid.rows.map((_, index) => grid.cells[index].reduce((sum, cell) => sum + cell.value, 0)),
      columnTotals: grid.columns.map((_, index) => grid.cells.reduce((sum, row) => sum + row[index].value, 0)),
      grandTotal: grid.total,
    })
    expect(report.split('\r\n')).toHaveLength(grid.rows.length + 2)
    expect(report).toContain('"합계"')
  })

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

  it('projects parser grid metadata and keeps durable approval precedence', () => {
    const [row] = projectLogRecords([
      { id: 'grid', name: 'SAMPLE=A17.TEMP=25C.MODE=DIAG.GRID=2x4.log', text: '' },
    ], {}, {
      grid: { grid: { approval: 'approved', approvedValue: '4X8' } },
    })

    expect(row.grid).toEqual({ value: '4X8', state: 'approved' })
    expect(patternMatrix([row], 'grid')).toEqual([{ value: '4X8', total: 1, counts: { UNKNOWN: 1 } }])
    expect(serializeLogRecordsTsv([row], ['grid_value', 'grid_state'])).toContain('grid_value\tgrid_state\r\n4X8\tapproved')
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

  it('builds bounded pivots with explicit unknown buckets, zero cells, and source tracing', () => {
    const rows = projectLogRecords(files)
    const grid = buildPivotGrid(rows, {
      rows: ['temperature'],
      columns: ['mode', 'result'],
      aggregation: 'count',
      filters: { query: '', result: 'all', review: 'all' },
    })

    expect(grid.rows.map((header) => header.label)).toEqual(['85', '105'])
    expect(grid.columns.map((header) => header.label)).toEqual(['DIAG / PASS', 'DIAG / SYSTEM_HALT', 'DIAG / TRAINING_FAIL'])
    expect(grid.cells).toEqual([
      [
        { value: 1, sourceIds: ['pass'] },
        { value: 1, sourceIds: ['halt'] },
        { value: 0, sourceIds: [] },
      ],
      [
        { value: 0, sourceIds: [] },
        { value: 0, sourceIds: [] },
        { value: 1, sourceIds: ['training'] },
      ],
    ])

    const unknown = buildPivotGrid(projectLogRecords([{ id: 'unknown', name: 'plain.log', text: '' }]), {
      rows: ['sample'], columns: [], aggregation: 'count', filters: { query: '', result: 'all', review: 'all' },
    })
    expect(unknown.rows[0].label).toBe('미확인')
    expect(unknown.cells[0][0]).toEqual({ value: 1, sourceIds: ['unknown'] })
  })

  it('uses the same LPDDR dimensions for Agent analysis, pivots, and export', () => {
    const engineeringFiles: WorkbenchFile[] = [
      { id: 'f1', name: 'LPDDR6_SKEW-SS_SMP-01_T85_VDD1p275_F9600_TM-HDIAG_PAT-WR_DQ9_BL16_CH0_SCH1_BG2_BANK5_ROW0x2A_COL0x14_FAIL.log', text: '@FAIL' },
      { id: 'f2', name: 'LPDDR6_SKEW-SS_SMP-02_T85_VDD1p315_F8533_TM-HDIAG_PAT-PRBS_DQ4_BL8_CH1_SCH0_BG1_BANK2_ROW0x10_COL0x08_PASS.log', text: '@PASS' },
    ]
    const rows = projectLogRecords(engineeringFiles)
    expect(rows[0]).toMatchObject({
      mode: { value: 'HDIAG' },
      dimensions: { skew: 'SS', frequencyMHz: 9600, vdd: 1.275, pattern: 'WR', dq: '9', bl: '16', channel: '0', subChannel: '1', bankGroup: '2', bank: '5', row: '0x2A', column: '0x14' },
    })
    const grid = buildPivotGrid(rows, { rows: ['frequencyMHz'], columns: ['dq'], aggregation: 'fail_count', filters: { query: '', result: 'all', review: 'all' } })
    expect(grid.rows.map((row) => row.label)).toEqual(['8533', '9600'])
    expect(grid.columns.map((column) => column.label)).toEqual(['4', '9'])
    expect(serializeLogRecordsCsv(rows, ['filename', 'frequency_mhz', 'vdd', 'dq', 'bl', 'channel', 'sub_channel', 'row', 'column'])).toContain('"9600","1.275","9","16","0","1","0x2A","0x14"')
  })

  it('calculates a shareable FAIL rate while retaining every denominator log as source evidence', () => {
    const rows = projectLogRecords(files)
    const grid = buildPivotGrid(rows, {
      rows: ['temperature'], columns: [], aggregation: 'fail_rate', filters: { query: '', result: 'all', review: 'all' },
    })

    expect(grid.rows.map((row) => row.label)).toEqual(['85', '105'])
    expect(grid.cells[0][0]).toEqual({ value: 50, sourceIds: ['pass', 'halt'] })
    expect(grid.cells[1][0]).toEqual({ value: 100, sourceIds: ['training'] })
    expect(grid.total).toBe(66.7)
  })

  it('counts distinct Samples and excludes unknown outcomes from the FAIL-rate denominator', () => {
    const rows = projectLogRecords([
      { id: 'pass-a', name: 'SMP-01_T85.log', text: '@PASS' },
      { id: 'pass-a-repeat', name: 'SMP-01_T85_RT2.log', text: '@PASS' },
      { id: 'fail-b', name: 'SMP-02_T85.log', text: '@FAIL' },
      { id: 'unknown-c', name: 'SMP-03_T85.log', text: '' },
    ])
    const filters = { query: '', result: 'all' as const, review: 'all' as const }
    expect(buildPivotGrid(rows, { rows: [], columns: [], aggregation: 'sample_count', filters }).total).toBe(3)
    expect(buildPivotGrid(rows, { rows: [], columns: [], aggregation: 'pass_count', filters }).total).toBe(2)
    expect(buildPivotGrid(rows, { rows: [], columns: [], aggregation: 'fail_rate', filters }).total).toBe(33.3)
  })

  it('counts only explicit Grid identities and keeps logs separate from Grid units', () => {
    const rows = projectLogRecords([
      { id: 'grid-1-a', name: 'SMP-01_GRID-01_partA.log', text: '@PASS' },
      { id: 'grid-1-b', name: 'SMP-01_GRID-01_partB.log', text: '@PASS' },
      { id: 'grid-2', name: 'SMP-01_GRID-02.log', text: '@FAIL' },
      { id: 'other-sample-grid-1', name: 'SMP-02_GRID-01.log', text: '@PASS' },
      { id: 'unknown-grid', name: 'SMP-03_plain.log', text: '@PASS' },
    ])
    const filters = { query: '', result: 'all' as const, review: 'all' as const }
    const grid = buildPivotGrid(rows, { rows: [], columns: [], aggregation: 'grid_count', filters })
    expect(grid.total).toBe(3)
    expect(grid.cells[0][0].sourceIds).toEqual(['grid-1-a', 'grid-1-b', 'grid-2', 'other-sample-grid-1'])
    expect(buildPivotGrid(rows, { rows: [], columns: [], aggregation: 'count', filters }).total).toBe(5)
  })

  it('keeps zero-valued fail and evidence pivot rows out of cell source tracing while preserving counts', () => {
    const rows = projectLogRecords([
      { id: 'pass', name: 'pass.log', text: '' },
      { id: 'fail', name: 'fail.log', text: 'TEST_FAIL' },
    ])
    const failGrid = buildPivotGrid(rows, {
      rows: [], columns: [], aggregation: 'fail_count', filters: { query: '', result: 'all', review: 'all' },
    })
    const evidenceGrid = buildPivotGrid(rows, {
      rows: [], columns: [], aggregation: 'evidence_count', filters: { query: '', result: 'all', review: 'all' },
    })
    const countGrid = buildPivotGrid(rows, {
      rows: [], columns: [], aggregation: 'count', filters: { query: '', result: 'all', review: 'all' },
    })

    expect(failGrid.total).toBe(1)
    expect(failGrid.cells[0][0]).toEqual({ value: 1, sourceIds: ['fail'] })
    expect(evidenceGrid.total).toBe(1)
    expect(evidenceGrid.cells[0][0]).toEqual({ value: 1, sourceIds: ['fail'] })
    expect(countGrid.total).toBe(2)
    expect(countGrid.cells[0][0].sourceIds).toEqual(['pass', 'fail'])
  })

  it('supports three-level pivots, rejects deeper axes, and keeps export preview immutable and formula-safe', () => {
    const rows = projectLogRecords(files)
    expect(() => buildPivotGrid(rows, {
      rows: ['sample', 'temperature', 'mode'], columns: [], aggregation: 'count',
      filters: { query: '', result: 'all', review: 'all' },
    })).not.toThrow()
    expect(() => buildPivotGrid(rows, {
      rows: ['sample', 'temperature', 'mode', 'result'], columns: [], aggregation: 'count',
      filters: { query: '', result: 'all', review: 'all' },
    })).toThrow(RangeError)

    const init = initLogRecordExportPreview(rows, new Set(['pass']), ['filename', 'result'])
    const preview = previewLogRecordExport(init, 'tsv')
    const oneShot = buildLogRecordExportPreview(rows, new Set(['pass']), ['filename', 'result'], 'tsv')
    expect(preview.serialized).toBe(oneShot.serialized)
    expect(preview.serialized).toContain('LOT12_S01_85C_DIAG.log')
    expect(confirmLogRecordExport(preview)).toBe(preview.tsv)
    expect(Object.isFrozen(init)).toBe(true)
    expect(Object.isFrozen(preview)).toBe(true)
    expect(() => (init.rows as LogResultRecord[]).pop()).toThrow()
  })

  it('snapshots export rows including nested metadata before source rows change', () => {
    const rows = projectLogRecords(files)
    const init = initLogRecordExportPreview(rows)
    rows[0].sample.value = 'CHANGED'
    rows[0].sample.state = 'rejected'
    rows[0].evidenceCount = 99

    expect(init.rows[0]).toMatchObject({
      sample: { value: '01', state: 'candidate' },
      evidenceCount: 1,
    })
    expect(init.rows[0]).not.toBe(rows[0])
    expect(init.rows[0].sample).not.toBe(rows[0].sample)
    expect(Object.isFrozen(init.rows[0])).toBe(true)
    expect(Object.isFrozen(init.rows[0].sample)).toBe(true)
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
      '\uFEFFsource_id\tartifact_id\tsource_key\trelative_path\trun\tfilename\tfolder\tsample_value\tsample_state\ttemperature_value\ttemperature_state\tmode_value\tmode_state\tgrid_value\tgrid_state\tresult\tresult_source\treview\tstage_results',
      'source-a\tartifact-a\troot:root-a\u001flogs/duplicate.log\tlogs/duplicate.log\t\tduplicate.log\tRoot A\t\tmissing\t\tmissing\t\tmissing\t\tmissing\tPASS\tcandidate\tneeds_review\tTest:PASS',
      'source-b\tartifact-b\troot:root-b\u001flogs/duplicate.log\tlogs/duplicate.log\t\tduplicate.log\tRoot B\t\tmissing\t\tmissing\t\tmissing\t\tmissing\tUNKNOWN\tunreviewed\tneeds_review\t',
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
    expect(lines[1].split('\t').slice(0, 18)).toEqual([
      'approved', '', '', 'LOT_S01_85C_DIAG_run007.log', '007', 'LOT_S01_85C_DIAG_run007.log', 'Imported logs',
      'S-APPROVED', 'approved', '85', 'candidate', 'DIAG', 'candidate', '', 'missing', 'PASS', 'candidate', 'needs_review',
    ])
    expect(lines[2].split('\t').slice(7, 13)).toEqual(['02', 'candidate', '85', 'rejected', 'DIAG', 'candidate'])
    expect(lines[3].split('\t').slice(7, 13)).toEqual(['', 'missing', '', 'missing', '', 'missing'])
    expect(lines[4].split('\t').slice(7, 13)).toEqual(['', 'malformed', '', 'malformed', '', 'malformed'])
  })

  it('undoes a metadata approval back to the current extractor candidate', () => {
    const [row] = projectLogRecords([{ id: 'reset', name: 'LOT_S07_85C_DIAG.log', text: '@PASS' }], {}, {
      reset: { temperature: { approval: 'reset' } },
    })
    expect(row.temperature).toEqual({ value: '85', state: 'candidate' })
  })

  it('keeps explicit boot, training, HDiag and test checkpoints in one log', () => {
    const [row] = projectLogRecords([{ id: 'stages', name: 'stages.log', text: 'POWER_ON\nSYN_UEFI_ENTER\nSYN_UEFI_EXIT\nBOOT COMPLETE\nTRAINING PASS\nHIDAG @FAIL\n@FAIL' }])
    expect(row.stageResults).toEqual([
      { stage: 'power', status: 'reached', evidenceCount: 1 },
      { stage: 'uefi', status: 'pass', evidenceCount: 1 },
      { stage: 'boot', status: 'pass', evidenceCount: 1 },
      { stage: 'training', status: 'pass', evidenceCount: 1 },
      { stage: 'hdiag', status: 'fail', evidenceCount: 1 },
      { stage: 'test', status: 'fail', evidenceCount: 2 },
    ])
    expect(serializeLogRecordsTsv([row], ['stage_results'])).toContain('Power:REACHED | UEFI:PASS | Boot:PASS | Training:PASS | HDiag:FAIL | Test:FAIL')
    expect(resultStageCheckpoints(row.stageResults, 'SM8975_boot.log')).toEqual([
      { group: 'firmware', label: 'UEFI', status: 'pass', evidenceCount: 1 },
      { group: 'test', label: '테스트', status: 'fail', evidenceCount: 2 },
    ])
  })

  it('uses platform firmware labels and omits test for boot-only logs', () => {
    expect(resultStageCheckpoints([
      { stage: 'pbl', status: 'pass', evidenceCount: 1 },
      { stage: 'lk', status: 'pass', evidenceCount: 1 },
      { stage: 'lk2', status: 'pass', evidenceCount: 1 },
      { stage: 'os', status: 'reached', evidenceCount: 1 },
    ], 'MTK_24D_BOOT.log')).toEqual([
      { group: 'firmware', label: 'LK2', status: 'pass', evidenceCount: 1 },
      { group: 'os', label: 'OS', status: 'reached', evidenceCount: 1 },
    ])
  })

  it('shows training failure as the stopped boot checkpoint', () => {
    expect(resultStageCheckpoints([
      { stage: 'uefi', status: 'pass', evidenceCount: 1 },
      { stage: 'training', status: 'fail', evidenceCount: 2 },
      { stage: 'test', status: 'fail', evidenceCount: 1 },
    ], 'SM8975_training.log', 'TRAINING_FAIL')).toEqual([
      { group: 'firmware', label: 'Training', status: 'fail', evidenceCount: 2 },
    ])
  })

  it('marks the active test checkpoint failed when the system reboots', () => {
    const [row] = projectLogRecords([{ id: 'reboot', name: 'SM8975_reboot.log', text: 'UEFI_EXIT\nOS_READY\nstressapp: start\nWATCHDOG_RESET' }])
    expect(row.result).toBe('SYSTEM_REBOOT')
    expect(resultStageCheckpoints(row.stageResults, row.fileName, row.result)).toEqual([
      { group: 'firmware', label: 'UEFI', status: 'pass', evidenceCount: 1 },
      { group: 'os', label: 'OS', status: 'reached', evidenceCount: 1 },
      { group: 'test', label: '테스트', status: 'fail', evidenceCount: 1 },
    ])
  })

  it('uses bounded native stage inspection when artifact text stays outside the renderer', () => {
    const [row] = projectLogRecords(
      [{ id: 'native', artifactId: 'a'.repeat(64), name: 'native.log', text: undefined }],
      {},
      {},
      { native: [{ stage: 'boot', status: 'pass', evidenceCount: 1 }, { stage: 'hdiag', status: 'fail', evidenceCount: 2 }] },
    )
    expect(row.stageResults).toEqual([
      { stage: 'boot', status: 'pass', evidenceCount: 1 },
      { stage: 'hdiag', status: 'fail', evidenceCount: 2 },
    ])
  })

  it('recognizes Qualcomm-style colon prompts as reached and completed stages', () => {
    const [row] = projectLogRecords([{ id: 'qualcomm', name: 'qualcomm.log', text: [
      'POWER_ON', 'PBL: boot start', 'XBL: DDR init', 'UEFI: memory training start',
      'UEFI: memory training complete', 'UEFI: ExitBootServices', 'OS: Linux boot complete', 'HIDAG DIAG START',
    ].join('\n') }])
    expect(row.stageResults).toEqual(expect.arrayContaining([
      { stage: 'power', status: 'reached', evidenceCount: 1 },
      { stage: 'pbl', status: 'reached', evidenceCount: 1 },
      { stage: 'xbl', status: 'reached', evidenceCount: 1 },
      { stage: 'uefi', status: 'pass', evidenceCount: 1 },
      { stage: 'training', status: 'pass', evidenceCount: 1 },
      { stage: 'hdiag', status: 'reached', evidenceCount: 1 },
      { stage: 'os', status: 'reached', evidenceCount: 2 },
    ]))
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

    expect(lines[0].split('\t')).toHaveLength(19)
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
