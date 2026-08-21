import { describe, expect, it } from 'vitest'
import {
  extractLpddrFilenameDimensions,
  extractLpddrFilenameOutcome,
  parsePositionalLabFilename,
} from '../../src/domain/lpddr-filename-dimensions'
import { buildPivotGrid, projectLogRecords, serializeLogRecordsCsv } from '../../src/state/logRecords'

const name = '26-08-07-14-13-17_UTF02A-2_Ch8_SM8975_1_25_1.00_EVA_EN_DEFAULT_5333MHZ_COM74_DHCST-89_C_Pass.log'

describe('underscore-delimited lab filename', () => {
  it('keeps tester fields, material and evaluation Step in their own dimensions', () => {
    expect(parsePositionalLabFilename(name)).toEqual({
      equipmentChannel: '8',
      gridId: '1',
      temperatureC: 25,
      vdd: 1,
      eccMode: 'EN',
      customCondition: 'DEFAULT_5333MHZ',
      material: 'DHCST-89',
      evaluationStep: 'C',
      frequencyMHz: 5333,
      outcome: 'PASS',
    })
    expect(extractLpddrFilenameDimensions(name)).toMatchObject({
      equipmentChannel: '8',
      socVendor: 'qualcomm',
      socModel: 'SM-8975',
      gridId: '1',
      temperatureC: 25,
      vdd: 1,
      eccMode: 'EN',
      customCondition: 'DEFAULT_5333MHZ',
      material: 'DHCST-89',
      sample: 'DHCST-89',
      evaluationStep: 'C',
      frequencyMHz: 5333,
    })
    expect(extractLpddrFilenameDimensions(name).channel).toBeUndefined()
    expect(extractLpddrFilenameDimensions(name).testMode).toBeUndefined()
  })

  it('uses the final filename token for the normalized result', () => {
    const replaceResult = (result: string) => name.replace(/Pass\.log$/, `${result}.log`)
    expect(extractLpddrFilenameOutcome(name)).toBe('PASS')
    expect(extractLpddrFilenameOutcome(replaceResult('HdiagReboot'))).toBe('SYSTEM_REBOOT')
    expect(extractLpddrFilenameOutcome(replaceResult('Mbefail'))).toBe('DIAG_FAIL')
    expect(extractLpddrFilenameOutcome(replaceResult('Fail'))).toBe('TEST_FAIL')
  })

  it('feeds the parsed values into result rows, pivots and CSV export', () => {
    const [row] = projectLogRecords([{ id: 'lab-1', name, text: '' }])
    expect(row).toMatchObject({
      sample: { value: 'DHCST-89', state: 'candidate' },
      temperature: { value: '25', state: 'candidate' },
      grid: { value: '1', state: 'candidate' },
      result: 'PASS',
      dimensions: { material: 'DHCST-89', evaluationStep: 'C', equipmentChannel: '8', eccMode: 'EN' },
    })
    const grid = buildPivotGrid([row], {
      rows: ['material', 'evaluationStep'],
      columns: ['equipmentChannel', 'eccMode'],
      aggregation: 'pass_fail',
      filters: { query: '', result: 'all', review: 'all' },
    })
    expect(grid.rows[0].values).toEqual(['DHCST-89', 'C'])
    expect(grid.columns[0].values).toEqual(['8', 'EN'])
    expect(grid.cells[0][0]).toMatchObject({ breakdown: { passCount: 1, failCount: 0, definitiveCount: 1 } })
    expect(serializeLogRecordsCsv([row], ['sample_value', 'evaluation_step', 'equipment_channel', 'ecc_mode', 'custom_condition', 'frequency_mhz', 'result']))
      .toContain('"DHCST-89","C","8","EN","DEFAULT_5333MHZ","5333","PASS"')
  })

  it('keeps material and Sample as one identifier after engineer correction', () => {
    const [row] = projectLogRecords([{ id: 'lab-1', name, text: '' }], {}, {
      'lab-1': { sample: { approval: 'approved', approvedValue: 'DHCST-90' } },
    })
    expect(row.sample).toEqual({ value: 'DHCST-90', state: 'approved' })
    expect(row.dimensions?.sample).toBe('DHCST-90')
    expect(row.dimensions?.material).toBe('DHCST-90')
  })

  it('normalizes explicit MATERIAL and SAMPLE tokens to the same value', () => {
    expect(extractLpddrFilenameDimensions('run_MATERIAL_DHCST-91.log')).toMatchObject({
      material: 'DHCST-91',
      sample: 'DHCST-91',
    })
    expect(extractLpddrFilenameDimensions('run_SAMPLE_DHCST-92.log')).toMatchObject({
      material: 'DHCST-92',
      sample: 'DHCST-92',
    })
  })

  it('does not positional-parse a partially similar arbitrary filename', () => {
    expect(parsePositionalLabFilename('note_Ch8_SM8975_1_25.log')).toBeUndefined()
  })
})
