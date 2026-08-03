import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../electron/main/artifact-service'

const runScale = process.env.RUN_LOG_SCALE === '1'
const roots: string[] = []

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `log-workbench-${label}-`))
  roots.push(root)
  return root
}

async function writeLogs(folder: string, count: number, unique: boolean): Promise<void> {
  const batchSize = 250
  for (let offset = 0; offset < count; offset += batchSize) {
    await Promise.all(Array.from({ length: Math.min(batchSize, count - offset) }, (_, inner) => {
      const index = offset + inner
      const identity = unique ? `sample=${index}` : 'same-sample'
      return writeFile(
        join(folder, `sample-${String(index).padStart(5, '0')}.log`),
        `boot\n${identity}\nstressapp start\n@PASS\nnormal_end\n`,
        'utf8'
      )
    }))
  }
}

function benchmark<T>(label: string, action: () => Promise<T>): Promise<{ result: T; elapsedMs: number; peakRssMiB: number }> {
  const started = performance.now()
  let peakRss = process.memoryUsage().rss
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 10)
  return action().then((result) => ({
    result,
    elapsedMs: Math.round(performance.now() - started),
    peakRssMiB: Number((peakRss / 1024 / 1024).toFixed(1)),
  })).finally(() => clearInterval(sampler)).then((measurement) => {
    console.log(`[scale] ${label}`, JSON.stringify({ elapsedMs: measurement.elapsedMs, peakRssMiB: measurement.peakRssMiB }))
    return measurement
  })
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(runScale)('ArtifactService opt-in scale benchmark', () => {
  it('imports and searches 5,000 unique logs with bounded details', async () => {
    const root = await makeRoot('unique')
    const source = join(root, 'source')
    await mkdir(source)
    await writeLogs(source, 5_000, true)
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()

    const imported = await benchmark('5k-unique-import', () =>
      service.importFolder(source, { extensions: ['log'], maxFiles: 5_000 }))
    expect(imported.result.failures).toEqual([])
    expect(imported.result.artifacts).toHaveLength(5_000)

    const searched = await benchmark('5k-unique-search', () => service.search({
      artifactIds: imported.result.artifacts.map((item) => item.id),
      query: '@PASS',
      maxMatches: 50,
      contextLines: 0,
    }))
    expect(searched.result.files).toHaveLength(5_000)
    expect(searched.result.totalMatchCount).toBe(5_000)
    expect(searched.result.matches).toHaveLength(50)
    expect(searched.result.truncated).toBe(true)

    const window = await service.lineWindow({
      artifactId: imported.result.artifacts[0].id,
      startLine: 1,
      lineCount: 10_000,
    })
    expect(window.lines).toHaveLength(5)
  }, 180_000)

  it('keeps all 10,000 physical sources for one deduplicated CAS artifact', async () => {
    const root = await makeRoot('duplicate')
    const source = join(root, 'source')
    await mkdir(source)
    await writeLogs(source, 10_000, false)
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()

    const imported = await benchmark('10k-duplicate-import', () =>
      service.importFolder(source, { extensions: ['log'], maxFiles: 10_000 }))
    expect(imported.result.failures).toEqual([])
    expect(imported.result.artifacts).toHaveLength(1)
    expect(imported.result.artifacts[0].sources).toHaveLength(10_000)
    expect(imported.result.artifacts[0].importCount).toBe(10_000)
  }, 180_000)

  it('measures deep-window and full-stream search on a one-million-line log', async () => {
    const root = await makeRoot('million-lines')
    const source = join(root, 'source')
    await mkdir(source)
    const lineCount = 1_000_000
    await writeFile(
      join(source, 'million.log'),
      `${'heartbeat temperature=85C\n'.repeat(lineCount - 1)}TAIL_NEEDLE\n`,
      'utf8'
    )
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await benchmark('1m-line-import', () =>
      service.importFolder(source, { extensions: ['log'] }))
    const artifactId = imported.result.artifacts[0].id

    const window = await benchmark('1m-line-deep-window', () => service.lineWindow({
      artifactId,
      startLine: lineCount - 9,
      lineCount: 240,
    }))
    expect(window.result.lines.at(-1)?.text).toBe('TAIL_NEEDLE')
    expect(window.result.totalLines).toBe(lineCount)

    const searched = await benchmark('1m-line-tail-search', () => service.search({
      artifactIds: [artifactId],
      query: 'TAIL_NEEDLE',
      maxMatches: 1,
      contextLines: 0,
    }))
    expect(searched.result.totalMatchCount).toBe(1)
    expect(searched.result.matches[0].lineNumber).toBe(lineCount)
  }, 180_000)
})
