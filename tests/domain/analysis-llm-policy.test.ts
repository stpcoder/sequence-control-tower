import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import type {
  AnalysisJobSnapshot,
  ArtifactRecord,
  LlmConfigSummary,
  SequenceFingerprint
} from '../../electron/shared/contracts'
import { AnalysisService } from '../../electron/main/analysis-service'
import { ArtifactService } from '../../electron/main/artifact-service'
import { LlmConfigService, OpenAiCompatibleClient } from '../../electron/main/llm-service'

const roots: string[] = []
const artifactId = 'a'.repeat(64)
const rawSequenceSecret = 'RAW_LOG_BODY_MUST_NEVER_REACH_LLM'

const fingerprint: SequenceFingerprint = {
  parserVersion: 'test-parser',
  lineCount: 3,
  blockCount: 1,
  commandCount: 2,
  commandTokens: ['stressapp', 'hdiag'],
  structuralHash: 'local-only-hash',
  facts: [{
    key: 'temperature',
    label: 'Temperature',
    value: '105 C',
    evidence: 'temperature=105',
    line: 1,
    confidence: 0.98,
    state: 'extracted'
  }]
}

const artifact: ArtifactRecord = {
  id: artifactId,
  sha256: artifactId,
  size: 100,
  extension: '.seq',
  originalNames: ['D:\\Customer Secret\\Project Q\\boundary.seq'],
  importedAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  importCount: 1,
  fingerprint
}

function summary(configured: boolean): LlmConfigSummary {
  return {
    baseUrl: configured ? 'http://internal-vllm.example/v1' : '',
    model: configured ? 'qwen-internal' : '',
    configured,
    apiKeyConfigured: configured,
    apiKeyPersisted: false,
    source: configured ? 'saved' : 'none',
    managedByEnvironment: { baseUrl: false, model: false, apiKey: false },
    limits: { requestsPerMinute: 8, tokensPerMinute: 80_000, timeoutMs: 60_000 }
  }
}

async function fixture(configured: boolean, complete = vi.fn()): Promise<{
  analysis: AnalysisService
  complete: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'analysis-llm-policy-'))
  roots.push(root)
  const artifacts = {
    require: vi.fn(async () => artifact),
    readText: vi.fn(async () => ({
      artifactId,
      text: `temperature=105\n${rawSequenceSecret}\n@PASS`,
      truncated: false,
      totalBytes: 100,
      encoding: 'utf-8' as const
    })),
    findSimilar: vi.fn(async () => [])
  } as unknown as ArtifactService
  const llmConfig = {
    summary: vi.fn(async () => summary(configured))
  } as unknown as LlmConfigService
  const llm = { complete } as unknown as OpenAiCompatibleClient
  const analysis = new AnalysisService(root, artifacts, llmConfig, llm, vi.fn())
  await analysis.initialize()
  return { analysis, complete }
}

async function finish(analysis: AnalysisService, jobId: string): Promise<AnalysisJobSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = analysis.get(jobId)
    if (snapshot && ['completed', 'failed', 'cancelled'].includes(snapshot.status)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('analysis job did not finish')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('analysis LLM call policy', () => {
  it('uses zero LLM calls for default analysis and caches the deterministic result', async () => {
    const test = await fixture(true)

    const first = await finish(test.analysis, test.analysis.start({ artifactId }).id)
    const second = await finish(test.analysis, test.analysis.start({ artifactId }).id)

    expect(test.complete).not.toHaveBeenCalled()
    expect(first.result).toEqual(expect.objectContaining({
      source: 'deterministic-fallback',
      cached: false
    }))
    expect(second.result).toEqual(expect.objectContaining({
      source: 'deterministic-fallback',
      cached: true
    }))
  })

  it('uses zero LLM calls when unconfigured and returns a deterministic fallback', async () => {
    const test = await fixture(false)
    const finished = await finish(test.analysis, test.analysis.start({
      artifactId,
      userComment: 'boundary validation'
    }).id)

    expect(test.complete).not.toHaveBeenCalled()
    expect(finished.result?.source).toBe('deterministic-fallback')
    expect(finished.result?.warnings).toContain('LLM이 설정되지 않아 결정적 파서로 분석했습니다.')
  })

  it('does not cache a fallback caused by a transient LLM outage', async () => {
    const complete = vi.fn(async () => { throw new Error('LLM_REQUEST_TIMEOUT') })
    const test = await fixture(true, complete)
    const input = { artifactId, userComment: 'boundary validation' }

    const first = await finish(test.analysis, test.analysis.start(input).id)
    const second = await finish(test.analysis, test.analysis.start(input).id)

    expect(complete).toHaveBeenCalledTimes(2)
    expect(first.result?.cached).toBe(false)
    expect(second.result?.cached).toBe(false)
    expect(second.result?.source).toBe('deterministic-fallback')
  })

  it('sends only redacted minimal evidence when a human hint explicitly enables LLM analysis', async () => {
    const complete = vi.fn(async (prompt: string) => ({
      content: '{"summary":"검증 요약","inferences":[],"questions":[],"suggestedTags":[]}',
      model: 'qwen-internal'
    }))
    const test = await fixture(true, complete)
    const finished = await finish(test.analysis, test.analysis.start({
      artifactId,
      userComment: 'Authorization: Bearer secret-token boundary validation',
      projectContext: '/opt/customer/private/project-q'
    }).id)

    expect(finished.result?.source).toBe('llm')
    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = String(complete.mock.calls[0][0])
    expect(prompt).not.toContain(rawSequenceSecret)
    expect(prompt).not.toContain('Customer Secret')
    expect(prompt).not.toContain('/opt/customer/private')
    expect(prompt).not.toContain('secret-token')
    expect(prompt).not.toContain('local-only-hash')
    expect(prompt).toContain('rawSequenceIncluded')
  })
})
