import { analyzeSequence as analyzeDomainSequence } from '../../src/domain'
import type { EvidenceValue, Provenance } from '../../src/domain'
import { analyzeConsoleTranscript, looksLikeConsoleTranscript } from '../../src/domain/console-transcript'
import type {
  SemanticChange,
  SequenceFact,
  SequenceFingerprint,
  SimilarArtifact
} from '../shared/contracts'

/**
 * Main-process adapter over the shared, deterministic Sequence domain engine.
 * Only a compact fingerprint is persisted in artifacts.json; full parser
 * results are reproducible from the immutable content-addressed original.
 */
export const PARSER_VERSION = 'domain-sequence-engine-2'

function firstEvidence(value: EvidenceValue<unknown>): Provenance | undefined {
  return value.provenance.find((item) => item.kind === 'source') ?? value.provenance[0]
}

function makeFact<T>(
  key: string,
  label: string,
  evidenceValue: EvidenceValue<T>,
  render: (value: T) => string
): SequenceFact | null {
  if (evidenceValue.status === 'unknown' || evidenceValue.value === null) return null
  const provenance = firstEvidence(evidenceValue)
  const rendered = render(evidenceValue.value)
  if (!rendered) return null
  return {
    key,
    label,
    value: rendered,
    evidence: provenance?.excerpt?.trim().slice(0, 300),
    line: provenance?.range?.startLine,
    confidence: evidenceValue.confidence,
    state: 'extracted'
  }
}

export function parseSequence(text: string, fileName = 'artifact.seq'): SequenceFingerprint {
  const consoleTranscript = looksLikeConsoleTranscript(fileName, text)
    ? analyzeConsoleTranscript(text)
    : undefined
  const sourceText = consoleTranscript
    ? consoleTranscript.inputs.map((item) => `${item.command};`).join('\n')
    : text
  const analysis = analyzeDomainSequence(
    { id: 'artifact', filename: fileName, content: sourceText },
    { askPurposeWhenMissing: false, maxQuestions: 0 }
  )
  const { dna, fingerprint, parsed } = analysis
  const facts = [
    makeFact('temperature', 'Temperature', dna.temperaturesC, (values) =>
      values.map((value) => `${value} °C`).join(', ')
    ),
    makeFact('voltage', 'Voltage', dna.voltages, (values) =>
      values.map((value) => `${value.rail} ${value.volts} V`).join(', ')
    ),
    makeFact('ecc', 'ECC', dna.ecc, (value) => value),
    makeFact('clock', 'Clock', dna.clocks, (value) => {
      const frequencies = value.valuesMHz.length ? `: ${value.valuesMHz.join(', ')} MHz` : ''
      return `${value.mode}${frequencies}`
    }),
    makeFact('pattern', 'Pattern', dna.patterns, (value) => {
      const patterns = value.values.length ? `: ${value.values.join(', ')}` : ''
      return `${value.mode}${patterns}`
    })
  ].filter((item): item is SequenceFact => Boolean(item))

  return {
    parserVersion: PARSER_VERSION,
    lineCount: consoleTranscript?.lineCount ?? parsed.stats.lineCount,
    blockCount: parsed.stats.blockCount,
    commandCount: consoleTranscript?.inputCount ?? parsed.stats.commandCount,
    commandTokens: (dna.commandFamilies.value ?? [])
      .flatMap((item) => [item.family, item.executable])
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 40),
    commandSignatures: (dna.commandFamilies.value ?? [])
      .map((item) => `${item.family}:${item.executable}`)
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 40),
    ...(consoleTranscript ? {
      console: {
        inputCount: consoleTranscript.inputCount,
        ambiguousCount: consoleTranscript.ambiguousCount,
        promptKinds: consoleTranscript.promptKinds,
        statusCounts: Object.fromEntries(Object.entries(consoleTranscript.statusCounts).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
      },
    } : {}),
    structuralHash: fingerprint.structuralHash,
    facts
  }
}

export function semanticChanges(
  parent: SequenceFingerprint | undefined,
  current: SequenceFingerprint
): SemanticChange[] {
  if (!parent) return []
  const before = new Map(parent.facts.map((item) => [item.key, item]))
  const after = new Map(current.facts.map((item) => [item.key, item]))
  const keys = [...new Set([...before.keys(), ...after.keys()])]
  const highImpact = new Set(['temperature', 'voltage', 'ecc', 'clock', 'pattern'])

  return keys.flatMap((key): SemanticChange[] => {
    const previous = before.get(key)
    const next = after.get(key)
    if (previous?.value === next?.value) return []
    return [
      {
        kind: !previous ? 'added' : !next ? 'removed' : 'changed',
        key,
        label: next?.label ?? previous?.label ?? key,
        before: previous?.value,
        after: next?.value,
        significance: highImpact.has(key) ? 'high' : 'medium'
      }
    ]
  })
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  const union = new Set([...a, ...b])
  if (!union.size) return 0
  let intersection = 0
  a.forEach((item) => {
    if (b.has(item)) intersection += 1
  })
  return intersection / union.size
}

export function similarityScore(
  target: SequenceFingerprint,
  candidate: SequenceFingerprint
): Pick<SimilarArtifact, 'score' | 'reasons'> {
  if (target.structuralHash === candidate.structuralHash) {
    return { score: 1, reasons: ['명령 구조가 동일함'] }
  }
  const commandScore = jaccard(target.commandTokens, candidate.commandTokens)
  const targetFacts = target.facts.map((item) => `${item.key}:${item.value}`)
  const candidateFacts = candidate.facts.map((item) => `${item.key}:${item.value}`)
  const factScore = jaccard(targetFacts, candidateFacts)
  const maxBlocks = Math.max(target.blockCount, candidate.blockCount, 1)
  const blockScore = 1 - Math.min(1, Math.abs(target.blockCount - candidate.blockCount) / maxBlocks)
  const maxCommands = Math.max(target.commandCount, candidate.commandCount, 1)
  const commandCountScore =
    1 - Math.min(1, Math.abs(target.commandCount - candidate.commandCount) / maxCommands)
  const score = Number(
    (commandScore * 0.5 + factScore * 0.25 + blockScore * 0.15 + commandCountScore * 0.1).toFixed(4)
  )
  const reasons: string[] = []
  if (commandScore >= 0.8) reasons.push('명령 구성이 매우 유사함')
  else if (commandScore >= 0.55) reasons.push('명령 구성이 유사함')
  if (factScore >= 0.6) reasons.push('평가 조건이 유사함')
  if (blockScore >= 0.9) reasons.push('블록 구조가 유사함')
  if (!reasons.length) reasons.push('부분적인 구조 유사도')
  return { score, reasons }
}
