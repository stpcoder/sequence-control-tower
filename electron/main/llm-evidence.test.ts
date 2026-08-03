import { describe, expect, it } from 'vitest'
import type { SequenceFingerprint, StartAnalysisInput } from '../shared/contracts'
import {
  buildMinimalLlmEvidence,
  buildMinimalLlmPrompt,
  redactSensitiveText
} from './llm-evidence'

const request: StartAnalysisInput = {
  artifactId: 'a'.repeat(64),
  parentArtifactId: 'b'.repeat(64),
  projectContext: 'Qualcomm lab 10.12.4.91 owner test.user@example.com',
  userComment: 'device_id=R58M1234567890 high temperature boundary'
}

const fingerprint: SequenceFingerprint = {
  parserVersion: 'test',
  lineCount: 18_200,
  blockCount: 24,
  commandCount: 163,
  commandTokens: ['diagnostic', 'hdiag64', 'device-bridge', 'adb'],
  structuralHash: 'not-sent-to-llm',
  facts: [
    {
      key: 'clock',
      label: 'Clock',
      value: 'fixed: 9600, 10000, 10660 MHz',
      confidence: 0.98,
      state: 'extracted',
      line: 42,
      evidence:
        'adb -s R58M1234567890 connect 10.12.4.91; owner=test.user@example.com; address=0x1234567890abcdef; clk=10660'
    }
  ]
}

describe('minimal LLM evidence', () => {
  it('redacts deterministic identifiers without changing useful evaluation values', () => {
    const redacted = redactSensitiveText(
      'mail=test.user@example.com ip=10.12.4.91 serial=R58M1234567890 address=0x1234567890abcdef CLK=10660 VDD=0.91',
      500
    )
    expect(redacted).not.toContain('test.user@example.com')
    expect(redacted).not.toContain('10.12.4.91')
    expect(redacted).not.toContain('R58M1234567890')
    expect(redacted).not.toContain('0x1234567890abcdef')
    expect(redacted).toContain('<EMAIL>')
    expect(redacted).toContain('<IP>')
    expect(redacted).toContain('<SERIAL>')
    expect(redacted).toContain('<HEX>')
    expect(redacted).toContain('CLK=10660 VDD=0.91')
  })

  it('redacts bearer credentials, JWTs, and absolute paths on Windows, UNC, and POSIX hosts', () => {
    const redacted = redactSensitiveText([
      'Authorization: Bearer top.secret-token',
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123',
      'source="C:\\Program Files\\Customer A\\run.log"',
      'share=\\\\lab-server\\customer-a\\raw\\run.log',
      'posix=/opt/customer-a/private/run.log',
      'CLK=10660'
    ].join(' '), 1_000)

    expect(redacted).not.toContain('top.secret-token')
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(redacted).not.toContain('Program Files')
    expect(redacted).not.toContain('lab-server')
    expect(redacted).not.toContain('/opt/customer-a')
    expect(redacted).toContain('Bearer <SECRET>')
    expect(redacted).toContain('<ABS_PATH>')
    expect(redacted).toContain('CLK=10660')
  })

  it('sends only structured facts, changes, counts, and short provenance', () => {
    const evidence = buildMinimalLlmEvidence({
      request,
      fileName: 'QCOM_SN_R58M1234567890_105C.seq',
      fingerprint,
      changes: [
        {
          kind: 'changed',
          key: 'clock',
          label: 'Clock',
          before: 'sweep',
          after: 'fixed: 10660 MHz',
          significance: 'high'
        }
      ]
    })
    const serialized = JSON.stringify(evidence)

    expect(evidence.privacy.rawSequenceIncluded).toBe(false)
    expect(evidence).not.toHaveProperty('structuralHash')
    expect(evidence.structure).toEqual(
      expect.objectContaining({ lineCount: 18_200, blockCount: 24, commandCount: 163 })
    )
    expect(evidence.facts[0].provenance?.excerpt.length).toBeLessThanOrEqual(160)
    expect(serialized).not.toContain('R58M1234567890')
    expect(serialized).not.toContain('10.12.4.91')
    expect(serialized).not.toContain('test.user@example.com')
    expect(serialized).not.toContain('0x1234567890abcdef')
    expect(serialized).not.toContain('not-sent-to-llm')
  })

  it('does not put arbitrary raw sequence text into the prompt', () => {
    const evidence = buildMinimalLlmEvidence({
      request,
      fileName: 'boundary.seq',
      fingerprint,
      changes: []
    })
    const prompt = buildMinimalLlmPrompt(evidence)

    expect(prompt).toContain('minimal-sequence-evidence-v1')
    expect(prompt).toContain('rawSequenceIncluded')
    expect(prompt).not.toContain('R58M1234567890')
    expect(prompt).not.toContain('0x1234567890abcdef')
    expect(prompt.length).toBeLessThan(8_000)
  })

  it('never includes an absolute source path even if malformed artifact metadata supplies one', () => {
    const evidence = buildMinimalLlmEvidence({
      request,
      fileName: 'D:\\Customer Secret\\Project Q\\boundary.seq',
      fingerprint,
      changes: []
    })
    const serialized = JSON.stringify(evidence)

    expect(serialized).not.toContain('Customer Secret')
    expect(serialized).not.toContain('Project Q')
    expect(evidence.file.name).toBe('<ABS_PATH>')
  })
})
