import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, WikiEntryRecord } from '../../electron/shared/contracts'
import { analysisConfidence, mergeArtifacts, upsertWikiEntries } from '../../src/state/workspace'

function artifact(id: string, lastSeenAt: string, name: string): ArtifactRecord {
  return {
    id,
    sha256: id,
    size: 100,
    extension: '.seq',
    originalNames: [name],
    importedAt: lastSeenAt,
    lastSeenAt,
    importCount: 1,
  }
}

describe('renderer workspace state', () => {
  it('merges re-imported artifacts without duplicating the inbox row', () => {
    const id = 'a'.repeat(64)
    const earlier = artifact(id, '2026-07-01T00:00:00.000Z', 'old.seq')
    const latest = { ...artifact(id, '2026-07-02T00:00:00.000Z', 'new.seq'), importCount: 2 }
    const other = artifact('b'.repeat(64), '2026-07-01T12:00:00.000Z', 'other.seq')

    expect(mergeArtifacts([earlier, other], [latest])).toEqual([latest, other])
  })

  it('moves a saved Wiki revision to the top and keeps one entry per ID', () => {
    const old: WikiEntryRecord = {
      id: '1'.repeat(20),
      artifactId: 'a'.repeat(64),
      title: 'Old title',
      project: 'QCOM',
      status: 'inferred',
      relativeFileName: 'qcom/old.md',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    }
    const updated = { ...old, title: 'Verified title', status: 'verified' as const, updatedAt: '2026-07-03T00:00:00.000Z' }
    const other = { ...old, id: '2'.repeat(20), updatedAt: '2026-07-02T00:00:00.000Z' }

    expect(upsertWikiEntries([old, other], updated)).toEqual([updated, other])
  })

  it('does not present perfect fact extraction as perfect intent confidence', () => {
    expect(analysisConfidence({
      artifactId: 'a'.repeat(64),
      generatedAt: '2026-07-01T00:00:00.000Z',
      parserVersion: 'test',
      source: 'deterministic-fallback',
      cached: false,
      summary: 'summary',
      facts: [{ key: 'temperature', label: 'Temperature', value: '105 C', confidence: 1, state: 'extracted' }],
      changes: [],
      inferences: [],
      questions: [{ id: 'purpose', question: '목적?', why: '파일에 없음' }],
      suggestedTags: [],
      metadataSuggestions: [],
      warnings: [],
    })).toBe(78)
  })
})
