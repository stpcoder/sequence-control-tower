import { describe, expect, it } from 'vitest'
import {
  explicitLpddrConditions,
  extractLpddrFailureAddress,
  extractLpddrGridLineEvent,
} from '../../src/domain/lpddr-evaluation-baseline'
import { extractLpddrFilenameDimensions } from '../../src/domain/lpddr-filename-dimensions'

describe('LPDDR evaluation baseline', () => {
  it('keeps explicit Grid, temperature, VDD, four-corner, frequency, and TM conditions together', () => {
    expect(explicitLpddrConditions('GRID_ID=G07 TEMP=-20C COLD VDD=1.295V HVDD CORNER=CH FREQ=9600MHz TM=VPERI')).toEqual({
      gridId: 'G07', temperatureC: -20, temperatureCorner: 'COLD', vdd: 1.295,
      vddCorner: 'HVDD', conditionCorner: 'CH', frequencyMHz: 9600, testMode: 'VPERI',
    })
    expect(explicitLpddrConditions('HOT LVDD')).toMatchObject({ temperatureCorner: 'HOT', vddCorner: 'LVDD', conditionCorner: 'HL' })
  })

  it('recognizes standard SKEW tokens without confusing a numeric timing offset', () => {
    expect(extractLpddrFilenameDimensions('LPDDR6_FF_SMP-07_HOT_HVDD_CORNER-HH.log')).toMatchObject({
      skew: 'FF', sample: '07', temperatureCorner: 'HOT', vddCorner: 'HVDD', conditionCorner: 'HH',
    })
    expect(extractLpddrFilenameDimensions('LPDDR6_SKEW-SS_TSKEW--12PS_SMP-01.log')).toMatchObject({ skew: 'SS', timingSkewPs: -12 })
  })

  it('extracts an Hdiag fail address as location and data fields', () => {
    expect(extractLpddrFailureAddress('HIDAG @FAIL CH=0 SUBCH=1 CS=0 BK=5 RK=0 BG=2 ROW=0x2A COL=0x14 WR=0xAA RD=0xA8 DQ=0,1,2 BL=16')).toEqual({
      channel: '0', subChannel: '1', chipSelect: '0', bank: '5', rank: '0', bankGroup: '2', row: '0x2A', column: '0x14',
      writeData: '0xAA', readData: '0xA8', dq: '0,1,2', bl: '16',
    })
  })

  it('separates a Grid boundary, engineer command, and terminal result', () => {
    expect(extractLpddrGridLineEvent('GRID_START ID=G01')).toMatchObject({ boundary: true, boundaryKind: 'grid' })
    expect(extractLpddrGridLineEvent('UEFI> setddrclk 8533')).toMatchObject({
      boundary: false, command: 'setddrclk 8533', conditions: { frequencyMHz: 8533 },
    })
    expect(extractLpddrGridLineEvent('HIDAG @FAIL DQ=9')).toMatchObject({ boundary: false, result: 'FAIL' })
    expect(extractLpddrGridLineEvent('POWER_ON')).toMatchObject({ boundary: true, boundaryKind: 'power-on' })
  })
})
