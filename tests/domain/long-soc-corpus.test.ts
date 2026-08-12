import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../electron/main/artifact-service'
import { classifyLpddrStatus, extractLpddrFilenameDimensions, LpddrAgentToolService, LPDDR_STATUS_SPECS } from '../../electron/main/lpddr-agent-tools'
import { detectSocFilenameContext } from '../../src/domain/soc-profile'

type CorpusManifest = { scenarios: Array<{ file: string; vendor: 'qualcomm' | 'mediatek'; expected: string; lineCount: number }> }
const corpusRoot = resolve('tests/fixtures/long-soc')
const scratch: string[] = []

afterAll(async () => { await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true }))) })

describe('long tangled SoC corpus', () => {
  it('keeps every synthetic capture long and carries the DRAM topology in its durable filename', async () => {
    const manifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as CorpusManifest
    expect(manifest.scenarios).toHaveLength(6)
    for (const scenario of manifest.scenarios) {
      const text = await readFile(join(corpusRoot, scenario.file), 'utf8')
      expect(text.split('\n').length - 1).toBe(scenario.lineCount)
      expect(scenario.lineCount).toBeGreaterThanOrEqual(7_500)
      expect(text).toContain('SYNTHETIC_PUBLIC_FLOW_CORPUS')
      expect(detectSocFilenameContext(scenario.file).vendor).toBe(scenario.vendor)
      expect(extractLpddrFilenameDimensions(scenario.file)).toMatchObject({
        skew: expect.any(String), channel: expect.any(String), subChannel: expect.any(String), rank: expect.any(String),
        bankGroup: expect.any(String), bank: expect.any(String), row: expect.any(String), column: expect.any(String), dq: expect.any(String), bl: expect.any(String),
      })
    }
  })

  it('streams each long log once, finds deep evidence, and applies deterministic result precedence', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'sct-long-corpus-')); scratch.push(dataRoot)
    const artifacts = new ArtifactService(dataRoot); await artifacts.initialize()
    const imported = await artifacts.importFolder(corpusRoot, { extensions: ['log'] })
    expect(imported.failures).toEqual([])
    expect(imported.artifacts).toHaveLength(6)
    const sources = imported.artifacts.flatMap((artifact) => (artifact.sources ?? []).map((source) => ({ sourceId: source.relativePath, artifactId: artifact.id })))
    const inspected = await artifacts.inspectEvidence({ sources, specs: LPDDR_STATUS_SPECS })
    const manifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as CorpusManifest
    const expected = new Map(manifest.scenarios.map((scenario) => [scenario.file, scenario.expected]))
    for (const source of inspected.sources) {
      const counts = Object.fromEntries(source.evidence.map((item) => [item.specId, item.occurrenceCount ?? 0])) as Record<string, number>
      expect(classifyLpddrStatus(counts).status).toBe(expected.get(source.sourceId))
    }
    const deep = await artifacts.search({ artifactIds: imported.artifacts.map((item) => item.id), query: 'EDAC MC', maxMatches: 20, contextLines: 0 })
    expect(deep.matches).toHaveLength(4)
    expect(Math.min(...deep.matches.map((item) => item.lineNumber))).toBeGreaterThan(6_000)

    const projectSources = imported.artifacts.flatMap((artifact) => (artifact.sources ?? []).map((source) => ({
      sourceId: source.relativePath, artifactId: artifact.id, rootId: source.rootId, relativePath: source.relativePath,
    })))
    const project = {
      schemaVersion: 2 as const, id: 'long-soc', name: '장문 SoC 불량 분석', revision: 0, archived: false,
      createdAt: '', updatedAt: '', folders: [...new Set(projectSources.map((source) => source.rootId))].map((rootId) => ({ rootId, displayLabel: '장문 평가', status: 'available' as const, connectedAt: '' })),
      artifacts: projectSources,
      equipmentProfiles: [], templatePins: [], exportPresets: [], failureHypotheses: [], evaluationNodes: [], evidenceRecords: [], lpddrDevelopmentContext: {},
    }
    const tools = new LpddrAgentToolService({
      artifacts,
      projects: { get: async () => project, list: async () => [project] } as never,
      agentStore: {
        searchHistory: async () => [], workflowMemories: async () => [], conversationHistory: async () => [], attemptHistory: async () => [],
        commandKnowledge: async () => [], profileBindings: async () => [], consolePromptRules: async () => [],
      } as never,
    })
    const trend = await tools.execute(project.id, { name: 'failure_trends_get' })
    const trendData = trend.data as {
      denominator: number; numerator: number
      coverage: Array<{ skew: string; sampleCount: number; logCount: number }>
      failAddress: { events: number; distribution: Array<{ dimension: string; value: string; eventCount: number; sourceCount: number }> }
    }
    expect(trendData).toMatchObject({ denominator: 6, numerator: 4 })
    expect(trendData.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ skew: 'SS', sampleCount: 3, logCount: 3 }),
      expect.objectContaining({ skew: 'SF', sampleCount: 1, logCount: 1 }),
    ]))
    expect(trendData.failAddress.events).toBeGreaterThanOrEqual(4)
    expect(trendData.failAddress.distribution).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'DQ', value: '9', eventCount: 2, sourceCount: 2 }),
      expect.objectContaining({ dimension: 'Channel', value: '0', eventCount: 2, sourceCount: 2 }),
      expect.objectContaining({ dimension: 'Sub Channel', value: '1', eventCount: 3, sourceCount: 3 }),
    ]))
  }, 30_000)
})
