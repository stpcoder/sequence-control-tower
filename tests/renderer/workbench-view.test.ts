import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, ArtifactSearchResult, ArtifactSourceLocation } from '../../electron/shared/contracts'
import type { PrecomputedDocumentEvidence, RecipeRule } from '../../src/domain/workbench'
import {
  artifactFiles,
  clauseSpecKey,
  dedupeWorkbenchFiles,
  resolvePrecomputedBatch,
  successfulSearchCounts,
  type WorkbenchFile,
} from '../../src/views/WorkbenchView'

function artifact(id: string, lastSeenAt: string, rootId?: string): ArtifactRecord {
  return {
    id,
    sha256: id,
    size: 42,
    extension: '.log',
    originalNames: ['sample.log'],
    importedAt: lastSeenAt,
    lastSeenAt,
    importCount: 1,
    sources: [{
      ...(rootId ? { rootId } : {}),
      folderLabel: 'customer-a',
      relativePath: 'lot-01/sample.log',
    } as ArtifactSourceLocation],
  }
}

function rule(id: string, label: RecipeRule['label'], status: RecipeRule['status']): RecipeRule {
  return {
    id,
    label,
    status,
    scope: { kind: 'analysis' },
    clauses: [{
      id: `${id}-done`,
      presence: 'present',
      matcher: { kind: 'literal', pattern: 'DONE', caseSensitive: true, target: 'content' },
      sourceObservationId: `${id}-observation`,
    }],
    priority: 0,
    confidence: 0.9,
    repetition: 1,
    createdFromSourceIds: ['source'],
  }
}

function evidence(sourceId: string, rules: RecipeRule[], count = 1): PrecomputedDocumentEvidence {
  return {
    sourceId,
    rules: rules.map((item) => ({
      ruleId: item.id,
      clauses: item.clauses.map((clause) => ({ clauseId: clause.id, occurrenceCount: count })),
    })),
  }
}

describe('Log Workbench UI data hardening', () => {
  it('deduplicates a stable root source to its newest SHA without inheriting the old source id', () => {
    const oldSha = 'a'.repeat(64)
    const newSha = 'b'.repeat(64)
    const oldRow = artifactFiles(artifact(oldSha, '2026-01-01T00:00:00.000Z', 'root-stable'))[0]
    const newRow = artifactFiles(artifact(newSha, '2026-02-01T00:00:00.000Z', 'root-stable'))[0]

    expect(oldRow.sourceKey).toBe(newRow.sourceKey)
    expect(oldRow.id).toContain(oldSha)
    expect(newRow.id).toContain(newSha)
    expect(oldRow.id).not.toBe(newRow.id)
    expect(dedupeWorkbenchFiles([oldRow, newRow])).toEqual([newRow])
  })

  it('keeps legacy rows unique when rootId is unavailable', () => {
    const first = artifactFiles(artifact('c'.repeat(64), '2026-01-01T00:00:00.000Z'))[0]
    const second = artifactFiles(artifact('d'.repeat(64), '2026-02-01T00:00:00.000Z'))[0]

    expect(first.sourceKey).not.toBe(second.sourceKey)
    expect(dedupeWorkbenchFiles([first, second])).toHaveLength(2)
  })

  it('does not turn missing or failed backend results into zero-count evidence', () => {
    const rows: WorkbenchFile[] = [
      { id: 'ok-row', artifactId: 'ok', name: 'ok.log' },
      { id: 'failed-row', artifactId: 'failed', name: 'failed.log' },
      { id: 'missing-row', artifactId: 'missing', name: 'missing.log' },
    ]
    const result: ArtifactSearchResult = {
      query: '@PASS',
      mode: 'literal',
      caseSensitive: false,
      matches: [],
      totalMatchCount: 0,
      truncated: false,
      files: [
        { artifactId: 'ok', fileName: 'ok.log', matchCount: 0, searchedLineCount: 3 },
        { artifactId: 'failed', fileName: 'failed.log', matchCount: 0, searchedLineCount: 0, error: 'read failed' },
      ],
    }

    expect(successfulSearchCounts(rows, result)).toEqual({ 'ok-row': 0 })
  })

  it('deduplicates identical clause search specs independently of rule ids and presence', () => {
    const present = rule('one', 'PASS', 'candidate').clauses[0]
    const absent = { ...rule('two', 'SYSTEM_HALT', 'candidate').clauses[0], presence: 'absent' as const }
    expect(clauseSpecKey(present)).toBe(clauseSpecKey(absent))
  })

  it('uses rule precedence but preserves a conflicting confirmed engineer decision', () => {
    const candidate = rule('candidate', 'TEST_FAIL', 'candidate')
    const verified = { ...rule('verified', 'PASS', 'verified'), scope: { kind: 'project' as const } }
    const file: WorkbenchFile = { id: 'log-1', name: 'sample.log', text: 'DONE' }
    const allRules = [candidate, verified]
    const precomputed = new Map([[file.id, evidence(file.id, allRules)]])

    const normal = resolvePrecomputedBatch([file], allRules, precomputed, {})
    expect(normal).toMatchObject({ outcomes: { 'log-1': 'PASS' }, matched: 1, exceptions: 0, conflicts: 0 })

    const protectedDecision = resolvePrecomputedBatch([file], allRules, precomputed, { 'log-1': 'SYSTEM_HALT' })
    expect(protectedDecision).toMatchObject({
      outcomes: { 'log-1': 'SYSTEM_HALT' },
      matched: 0,
      exceptions: 1,
      conflicts: 1,
    })
  })

  it('fails closed when precomputed evidence is missing', () => {
    const candidate = rule('candidate', 'PASS', 'candidate')
    const file: WorkbenchFile = { id: 'log-2', name: 'sample.log', text: 'DONE' }
    const resolved = resolvePrecomputedBatch([file], [candidate], new Map(), {})
    expect(resolved).toMatchObject({ outcomes: { 'log-2': 'UNKNOWN' }, matched: 0, exceptions: 1 })
  })
})
