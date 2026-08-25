import { describe, expect, it } from 'vitest'
import { parseSequence } from './sequence-parser'

describe('console-aware artifact fingerprint', () => {
  it('fingerprints operator input without treating device output as commands', () => {
    const fingerprint = parseSequence([
      '[00:00:00.001] UEFI> set_rail VDD 1.295',
      '[00:00:00.002] INFO set_rail completed',
      '[00:00:00.003] DEBUG scheduler clicked=1 packet=20',
      'root@sm8975:/ # sleep 20',
      '[00:00:20.004] @FAIL',
    ].join('\n'), 'SM-8975_console.log')

    expect(fingerprint.commandCount).toBe(2)
    expect(fingerprint.commandSignatures).toEqual(['timing:sleep', 'voltage-control:set_rail'])
    expect(fingerprint.commandTokens).not.toContain('info')
    expect(fingerprint.console).toMatchObject({ inputCount: 2, ambiguousCount: 0, statusCounts: { 'at-fail': 1 } })
  })

  it('does not include a bare hash line until its project prompt rule is confirmed', () => {
    const fingerprint = parseSequence('# sleep 20\n@PASS', 'bare-console.log')
    expect(fingerprint.commandCount).toBe(0)
    expect(fingerprint.console).toMatchObject({ ambiguousCount: 1, statusCounts: { 'at-pass': 1 } })
  })

  it('fingerprints the real lab firmware-to-console command flow', () => {
    const fingerprint = parseSequence([
      'UEFI] erase ddr',
      'DRAM training information deleted: SUCCESS',
      'UEFI] dtvs',
      'UEFI] dtvs 1',
      'UEFI] reset',
      'B - 008000 - Warm reset asserted',
      'UEFI] exit',
      'console:/ # setddrclk 9600',
      'console:/ # hdiag --pattern WR',
    ].join('\n'), 'SM8975_lab-console.log')

    expect(fingerprint.commandCount).toBe(7)
    expect(fingerprint.commandSignatures).toEqual(expect.arrayContaining([
      'training-control:erase-ddr', 'test-mode-control:dtvs', 'firmware-control:reset',
      'firmware-control:exit', 'clock-control:setddrclk', 'diagnostic:hdiag',
    ]))
  })
})
