import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import {
  LLM_COMPLETION_TOKEN_BUDGET,
  LlmConfigService,
  OpenAiCompatibleClient
} from '../../electron/main/llm-service'
import { MAX_LLM_PROMPT_CHARS } from '../../electron/main/llm-evidence'

const roots: string[] = []
const servers: Server[] = []
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

interface TransportRecord {
  method?: string
  url?: string
  authorization?: string
  body: string
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function localLlmMock(): Promise<{ baseUrl: string; records: TransportRecord[] }> {
  const records: TransportRecord[] = []
  const server = createServer(async (request, response) => {
    records.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: await readBody(request)
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: '{"summary":"transport boundary verified","inferences":[],"questions":[],"suggestedTags":[]}'
        }
      }]
    }))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local LLM mock address unavailable')
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, records }
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

async function fixture(configured: boolean, complete = vi.fn(), fileName = artifact.originalNames[0]): Promise<{
  analysis: AnalysisService
  complete: ReturnType<typeof vi.fn>
  root: string
  artifacts: ArtifactService
  llmConfig: LlmConfigService
  llm: OpenAiCompatibleClient
}> {
  const root = await mkdtemp(join(tmpdir(), 'analysis-llm-policy-'))
  roots.push(root)
  const artifacts = {
    require: vi.fn(async () => ({ ...artifact, originalNames: [fileName] })),
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
  return { analysis, complete, root, artifacts, llmConfig, llm }
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
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }))
})

describe('analysis LLM call policy', () => {
  it('uses zero LLM calls for default analysis and caches the deterministic result', async () => {
    const complete = vi.fn(async () => ({
      content: '{"summary":"metadata review","inferences":[],"questions":[],"suggestedTags":[],"metadataSuggestions":[]}',
      model: 'qwen-internal'
    }))
    const test = await fixture(true, complete, 'SAMPLE=QBR-001.TEMP=25C.MODE=DIAG.GRID=2x4.seq')

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

  it('hydrates metadataSuggestions for cache entries written by the previous contract', async () => {
    const test = await fixture(true, vi.fn(), 'SAMPLE=QBR-001.TEMP=25C.MODE=DIAG.GRID=2x4.seq')
    const input = { artifactId }
    const first = await finish(test.analysis, test.analysis.start(input).id)
    const cachePath = `${test.root}/cache/analysis.json`
    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as { entries: Record<string, Record<string, unknown>> }
    const entry = Object.values(cache.entries)[0]
    delete entry.metadataSuggestions
    await writeFile(cachePath, JSON.stringify(cache), 'utf8')

    const compatibleAnalysis = new AnalysisService(test.root, test.artifacts, test.llmConfig, test.llm, vi.fn())
    await compatibleAnalysis.initialize()
    const second = await finish(compatibleAnalysis, compatibleAnalysis.start(input).id)
    expect(first.result?.metadataSuggestions).toEqual([])
    expect(second.result).toEqual(expect.objectContaining({ cached: true, metadataSuggestions: [] }))
  })

  it('uses zero LLM calls when unconfigured and returns a deterministic fallback', async () => {
    const test = await fixture(false)
    const finished = await finish(test.analysis, test.analysis.start({
      artifactId,
      userComment: 'boundary validation'
    }).id)

    expect(test.complete).not.toHaveBeenCalled()
    expect(finished.result?.source).toBe('deterministic-fallback')
    expect(finished.result?.metadataSuggestions).toEqual([])
    expect(finished.result?.warnings).toContain('LLM이 설정되지 않아 결정적 파서로 분석했습니다.')
  })

  it('uses LLM for unresolved filename metadata and discards extracted-field suggestions', async () => {
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        summary: 'metadata candidates', inferences: [], questions: [], suggestedTags: [],
        metadataSuggestions: [
          { field: 'temperature', value: '99', confidence: 0.99, reason: 'conflicts with deterministic filename extraction' },
          { field: 'grid', value: '2X4', confidence: 0.8, reason: 'grid is absent from the filename' },
        ]
      }),
      model: 'qwen-internal'
    }))
    const test = await fixture(true, complete, 'SAMPLE=QBR-001.TEMP=25C.MODE=DIAG.seq')
    const finished = await finish(test.analysis, test.analysis.start({ artifactId }).id)

    expect(complete).toHaveBeenCalledTimes(1)
    expect(finished.result?.metadataSuggestions).toEqual([
      { field: 'grid', value: '2X4', confidence: 0.8, reason: 'grid is absent from the filename' },
    ])
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
    expect(second.result?.warnings).toContain('사내 LLM 요청 시간 초과 로컬 파일 구조와 사용자 코멘트만으로 요약했습니다.')
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
    expect(prompt.length).toBeLessThanOrEqual(MAX_LLM_PROMPT_CHARS)
  })

  it('bounds and redacts the actual chat body at the AnalysisService transport boundary', async () => {
    const mock = await localLlmMock()
    const root = await mkdtemp(join(tmpdir(), 'analysis-llm-transport-'))
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
    const llmConfig = new LlmConfigService(root)
    await llmConfig.initialize()
    await llmConfig.save({
      baseUrl: mock.baseUrl,
      model: 'qwen-internal',
      apiKey: 'transport-api-key',
      requestsPerMinute: 8,
      tokensPerMinute: 80_000,
      timeoutSeconds: 5,
      maxRetries: 0
    })
    const analysis = new AnalysisService(
      root,
      artifacts,
      llmConfig,
      new OpenAiCompatibleClient(llmConfig),
      vi.fn()
    )
    await analysis.initialize()

    const finished = await finish(analysis, analysis.start({
      artifactId,
      userComment: `${'context '.repeat(2_000)} Authorization: Bearer prompt-secret /Users/customer/private/run.log`,
      projectContext: 'C:\\Customer Secret\\Project Q\\sequence.seq'
    }).id)

    expect(finished.result?.source).toBe('llm')
    expect(mock.records).toHaveLength(1)
    expect(mock.records[0]).toEqual(expect.objectContaining({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: 'Bearer transport-api-key'
    }))

    const body = JSON.parse(mock.records[0].body) as {
      messages: Array<{ role: string; content: string }>
      max_tokens: number
    }
    const userMessage = body.messages.find((message) => message.role === 'user')
    expect(userMessage).toBeDefined()
    expect(userMessage?.content.length).toBeLessThanOrEqual(MAX_LLM_PROMPT_CHARS)
    expect(mock.records[0].body.length).toBeLessThanOrEqual(MAX_LLM_PROMPT_CHARS + 2_000)
    expect(body.max_tokens).toBe(LLM_COMPLETION_TOKEN_BUDGET)
    expect(mock.records[0].body).not.toContain(rawSequenceSecret)
    expect(mock.records[0].body).not.toContain('prompt-secret')
    expect(mock.records[0].body).not.toContain('transport-api-key')
    expect(mock.records[0].body).not.toContain('Customer Secret')
    expect(mock.records[0].body).not.toContain('/Users/customer/private')
  })
})
