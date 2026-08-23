import { describe, expect, it } from 'vitest'
import { normalizedMetadataEdit } from '../../src/views/ResultsView'

describe('result metadata review', () => {
  it('normalizes common VDD input without accepting arbitrary text', () => {
    expect(normalizedMetadataEdit('vdd', '1.295V')).toBe('1.295')
    expect(normalizedMetadataEdit('vdd', '1p315')).toBe('1.315')
    expect(normalizedMetadataEdit('vdd', 'invalid')).toBeNull()
    expect(normalizedMetadataEdit('sample', ' DHCST-89 ')).toBe('DHCST-89')
  })
})
