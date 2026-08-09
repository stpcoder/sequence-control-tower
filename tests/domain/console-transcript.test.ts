import { describe, expect, it } from 'vitest'
import { analyzeConsoleTranscript, classifyConsoleLine } from '../../src/domain/console-transcript'

describe('console transcript classification', () => {
  it('collects only prompt input while retaining status output', () => {
    const noise = Array.from({ length: 2_000 }, (_, index) => `[DEBUG] irq=${index % 32} packet=${index} scheduler tick`).join('\n')
    const analysis = analyzeConsoleTranscript([
      '[00:00:00.100] UEFI> set_rail VDD 1.295',
      '[00:00:00.101] INFO set_rail completed rc=0',
      noise,
      'root@sm8975:/ # sleep 20',
      '[00:00:20.100] stressapptest PASS',
      '[00:00:20.101] @PASS',
    ].join('\n'))

    expect(analysis.inputs.map((item) => item.command)).toEqual(['set_rail VDD 1.295', 'sleep 20'])
    expect(analysis.inputs.map((item) => item.commandSignature)).toEqual(['voltage-control:set_rail', 'timing:sleep'])
    expect(analysis.statusCounts).toMatchObject({ 'stress-pass': 1, 'at-pass': 1 })
    expect(analysis.outputCount).toBeGreaterThan(2_000)
  })

  it('keeps bare prompts ambiguous until an engineer confirms the project rule', () => {
    expect(classifyConsoleLine('# sleep 20').role).toBe('ambiguous')
    expect(classifyConsoleLine('# sleep 20', [{ promptSignature: 'bare-root-hash', role: 'input' }])).toMatchObject({ role: 'input' })
    expect(classifyConsoleLine('# generated report heading', [{ promptSignature: 'bare-root-hash', role: 'output' }])).toMatchObject({ role: 'output' })
  })

  it('does not mistake debug output containing a command name for input', () => {
    const analysis = analyzeConsoleTranscript('[DEBUG] sleep 20 completed\nERROR hdiag failed to allocate buffer\n@FAIL')
    expect(analysis.inputCount).toBe(0)
    expect(analysis.statusCounts['at-fail']).toBe(1)
  })
})
