import { describe, expect, it } from 'vitest'
import type { SequenceFingerprint, StartAnalysisInput } from '../shared/contracts'
import {
  buildMinimalLlmEvidence,
  buildMinimalLlmPrompt,
  MAX_LLM_PROMPT_CHARS,
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

  it('keeps the prompt bounded and retains first/last failure evidence under adversarial volume', () => {
    const facts: SequenceFingerprint['facts'] = Array.from({ length: 80 }, (_item, index) => ({
      key: index === 1 ? 'first-failure-fact' : index === 79 ? 'last-failure-fact' : `fact-${index}`,
      label: index === 1 ? 'FIRST FAILURE evidence' : index === 79 ? 'LAST FAILURE evidence' : `Fact ${index}`,
      value: index === 1
        ? 'timeout password=first-secret /Users/customer/private/first-failure.log'
        : index === 79
          ? 'watchdog error Authorization: Bearer last-secret C:\\Customer\\private\\last-failure.log'
          : `ordinary value ${index} MHz`,
      evidence: index === 1
        ? 'first failure: /opt/customer/first.log api_key=first-key'
        : index === 79
          ? 'last failure: /opt/customer/last.log jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature123'
          : `fact evidence ${index}`,
      line: index + 1,
      confidence: 0.9,
      state: 'extracted'
    }))
    const changes = Array.from({ length: 80 }, (_item, index) => ({
      kind: 'changed' as const,
      key: index === 2 ? 'first-failure-change' : index === 78 ? 'last-failure-change' : `change-${index}`,
      label: index === 2 ? 'first failure change' : index === 78 ? 'last failure change' : `Change ${index}`,
      before: index === 2
        ? 'error before password=change-secret /Users/customer/change-before.log'
        : `before ${index}`,
      after: index === 78
        ? 'timeout after Bearer change-secret C:\\Customer\\change-after.log'
        : `after ${index}`,
      significance: index === 2 || index === 78 ? 'high' as const : 'low' as const
    }))
    const adversarialFingerprint: SequenceFingerprint = {
      parserVersion: 'test',
      lineCount: 2_000_000,
      blockCount: 1_000,
      commandCount: 5_000_000,
      commandTokens: [
        ...Array.from({ length: 79 }, (_item, index) => `command-${index}`),
        'last-command /Users/customer/private/run.log Authorization: Bearer command-secret'
      ],
      structuralHash: 'must-not-be-sent',
      facts
    }

    const evidence = buildMinimalLlmEvidence({
      request: {
        artifactId: 'a'.repeat(64),
        projectContext: `${'context '.repeat(2_000)} /Users/customer/private/context`,
        userComment: `${'comment '.repeat(2_000)} password=comment-secret`,
        parentArtifactId: 'b'.repeat(64)
      },
      fileName: 'C:\\Customer\\private\\adversarial.seq',
      fingerprint: adversarialFingerprint,
      changes
    })
    const firstPrompt = buildMinimalLlmPrompt(evidence)
    const secondPrompt = buildMinimalLlmPrompt(evidence)

    expect(firstPrompt).toBe(secondPrompt)
    expect(firstPrompt.length).toBeLessThanOrEqual(MAX_LLM_PROMPT_CHARS)
    expect(firstPrompt).toContain('first-failure-fact')
    expect(firstPrompt).toContain('last-failure-fact')
    expect(firstPrompt).toContain('first-failure-change')
    expect(firstPrompt).toContain('last-failure-change')
    expect(firstPrompt).not.toContain('first-secret')
    expect(firstPrompt).not.toContain('last-secret')
    expect(firstPrompt).not.toContain('change-secret')
    expect(firstPrompt).not.toContain('command-secret')
    expect(firstPrompt).not.toContain('Customer')
    expect(firstPrompt).not.toContain('/Users/customer')
    expect(firstPrompt).not.toContain('must-not-be-sent')
    expect(firstPrompt).toContain('<SECRET>')
    expect(firstPrompt).toContain('<ABS_PATH>')
  })
})
