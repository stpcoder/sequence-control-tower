import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactService } from '../../electron/main/artifact-service'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'log-workbench-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ArtifactService log workbench', () => {
  it('imports multiple folders whose Windows-friendly names contain Korean text and spaces', async () => {
    const root = await temporaryRoot()
    const first = join(root, '고객사 A 로그')
    const second = join(root, '고객사 B 로그')
    await Promise.all([
      mkdir(join(first, '샘플 01'), { recursive: true }),
      mkdir(join(second, '샘플 02'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(first, '샘플 01', '저온 평가.log'), 'stressapp\nhidag\n@PASS\n', 'utf8'),
      writeFile(join(second, '샘플 02', '고온 평가.log'), 'stressapp\nhidag\n@FAIL\n', 'utf8')
    ])

    const service = new ArtifactService(join(root, '앱 데이터'))
    await service.initialize()
    const imported = await service.importFolders([first, second], { extensions: ['log'] })

    expect(imported.failures).toEqual([])
    expect(imported.artifacts).toHaveLength(2)
    expect(imported.artifacts.flatMap((item) => item.sources ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ folderLabel: '고객사 A 로그', relativePath: '샘플 01/저온 평가.log' }),
      expect.objectContaining({ folderLabel: '고객사 B 로그', relativePath: '샘플 02/고온 평가.log' })
    ]))
    expect(JSON.stringify(imported)).not.toContain(root)
  })

  it('imports multiple folder trees while exposing only safe relative source metadata', async () => {
    const root = await temporaryRoot()
    const dataRoot = join(root, 'data')
    const first = join(root, 'customer-a')
    const second = join(root, 'customer-b')
    await mkdir(join(first, 'lot-01'), { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'lot-01', 'sample.log'), 'stressapp\n@PASS\n', 'utf8')
    await writeFile(join(first, 'ignored.txt'), 'ignore me', 'utf8')
    await writeFile(join(second, 'sample.log'), 'stressapp\n@PASS\n', 'utf8')

    const service = new ArtifactService(dataRoot)
    await service.initialize()
    const result = await service.importFolders([first, second], { extensions: ['log'] })
    const records = await service.list()

    expect(result.failures).toEqual([])
    expect(result.skippedCount).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0].sources).toEqual([
      { rootId: expect.any(String), folderLabel: 'customer-a', relativePath: 'lot-01/sample.log' },
      { rootId: expect.any(String), folderLabel: 'customer-b', relativePath: 'sample.log' }
    ])
    expect(records[0].sources?.[0].rootId).not.toBe(records[0].sources?.[1].rootId)
    expect(JSON.stringify(records[0])).not.toContain(root)
  })

  it('keeps identical sources from different roots with the same folder label and relative path', async () => {
    const root = await temporaryRoot()
    const first = join(root, 'site-a', 'logs')
    const second = join(root, 'site-b', 'logs')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'sample.log'), '@PASS\n', 'utf8')
    await writeFile(join(second, 'sample.log'), '@PASS\n', 'utf8')

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    await service.importFolders([first, second], { extensions: ['log'] })
    const [record] = await service.list()

    expect(record.sources).toHaveLength(2)
    expect(record.sources?.map(({ folderLabel, relativePath }) => ({ folderLabel, relativePath }))).toEqual([
      { folderLabel: 'logs', relativePath: 'sample.log' },
      { folderLabel: 'logs', relativePath: 'sample.log' }
    ])
    expect(new Set(record.sources?.map((source) => source.rootId)).size).toBe(2)
    expect(JSON.stringify(record.sources)).not.toContain(root)
  })

  it('returns one artifact with every source when hundreds of logs have identical content', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    const fileCount = 550
    await Promise.all(Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(source, `same-${String(index).padStart(4, '0')}.log`), 'stressapp\n@PASS\n', 'utf8')
    ))

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const result = await service.importFolder(source, { extensions: ['log'], maxFiles: fileCount })

    expect(result.failures).toEqual([])
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].importCount).toBe(fileCount)
    expect(result.artifacts[0].sources).toHaveLength(fileCount)
    expect(new Set(result.artifacts[0].sources?.map((item) => item.relativePath)).size).toBe(fileCount)
  })

  it('searches complete local artifacts, returns capped details, and keeps complete counts', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(
      join(source, 'halt.log'),
      ['boot', 'stressapp start', 'HIDAG active', 'hidag retry', 'shutdown missing'].join('\n'),
      'utf8'
    )
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['.log'] })
    const artifactId = imported.artifacts[0].id

    const result = await service.search({
      artifactIds: [artifactId],
      query: 'hidag',
      maxMatches: 1,
      contextLines: 1
    })

    expect(result.totalMatchCount).toBe(2)
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.files[0]).toMatchObject({ matchCount: 2, searchedLineCount: 5 })
    expect(result.matches[0]).toMatchObject({ lineNumber: 3, columnStart: 1 })
    expect(result.matches[0].before).toEqual(['stressapp start'])
    expect(result.matches[0].after).toEqual(['hidag retry'])
  })

  it('keeps high-volume match counts exact while bounding returned detail and context', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    const lineCount = 5_000
    await writeFile(join(source, 'many-matches.log'), `${'needle '.repeat(10)}\n`.repeat(lineCount), 'utf8')
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })

    const result = await service.search({
      artifactIds: [imported.artifacts[0].id],
      query: 'needle',
      maxMatches: 10,
      contextLines: 5
    })

    expect(result.totalMatchCount).toBe(50_000)
    expect(result.files[0]).toMatchObject({ matchCount: 50_000, searchedLineCount: lineCount })
    expect(result.matches).toHaveLength(10)
    expect(result.matches.every((item) => item.before.length <= 5 && item.after.length <= 5)).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('rejects invalid regular expressions before reading artifacts', async () => {
    const root = await temporaryRoot()
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()

    await expect(service.search({
      artifactIds: ['0'.repeat(64)],
      query: '[',
      mode: 'regex'
    })).rejects.toThrow('정규식을 해석할 수 없습니다')
  })

  it('cancels a streaming search before opening more artifacts', async () => {
    const root = await temporaryRoot()
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const controller = new AbortController()
    controller.abort()

    await expect(service.search({
      artifactIds: ['0'.repeat(64)],
      query: 'needle'
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects zero-width and nested-quantifier regexes conservatively', async () => {
    const root = await temporaryRoot()
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()

    await expect(service.search({
      artifactIds: ['0'.repeat(64)],
      query: '(?:)',
      mode: 'regex'
    })).rejects.toThrow('길이가 0인 일치')
    await expect(service.search({
      artifactIds: ['0'.repeat(64)],
      query: '(a+)+$',
      mode: 'regex'
    })).rejects.toThrow('반복이 중첩된 정규식')
    await expect(service.search({
      artifactIds: ['0'.repeat(64)],
      query: '(a{1,3}){2,}',
      mode: 'regex'
    })).rejects.toThrow('반복이 중첩된 정규식')
  })

  it('stops safely when a searchable logical line exceeds the bounded size', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'single-line.log'), 'x'.repeat(4 * 1024 * 1024 + 1), 'utf8')
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })

    const result = await service.search({ artifactIds: [imported.artifacts[0].id], query: 'needle' })

    expect(result.files[0].error).toContain('한 줄이 4 MB를 초과')
    expect(result.files[0].error).not.toContain(root)
  })

  it('never reflects object-store paths through preview or line-window filesystem errors', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const dataRoot = join(root, 'private-data-root')
    await mkdir(source)
    await writeFile(join(source, 'gone.log'), '@PASS\n', 'utf8')
    const service = new ArtifactService(dataRoot)
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })
    const artifactId = imported.artifacts[0].id
    await unlink(join(dataRoot, 'objects', 'sha256', artifactId.slice(0, 2), artifactId))

    const previewError = await service.preview(artifactId).then(
      () => new Error('예상한 오류가 발생하지 않음'),
      (error: unknown) => error as Error
    )
    const windowError = await service.lineWindow({ artifactId, startLine: 1 }).then(
      () => new Error('예상한 오류가 발생하지 않음'),
      (error: unknown) => error as Error
    )

    expect(previewError.message).toBe('파일을 찾을 수 없습니다.')
    expect(windowError.message).toBe('파일을 찾을 수 없습니다.')
    expect(`${previewError.message}${windowError.message}`).not.toContain(dataRoot)
  })

  it('loads a bounded line window beyond the preview and truncates exceptionally long lines', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    const longLine = `prefix-${'x'.repeat(25_000)}-needle`
    await writeFile(join(source, 'large.log'), `one\ntwo\n${longLine}\nfour\nfive`, 'utf8')
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })
    const artifactId = imported.artifacts[0].id

    const window = await service.lineWindow({ artifactId, startLine: 3, lineCount: 2 })
    expect(window.lines.map((line) => line.lineNumber)).toEqual([3, 4])
    expect(window.lines[0].truncated).toBe(true)
    expect(window.lines[0].text.length).toBeLessThanOrEqual(20_001)
    expect(window.hasMoreBefore).toBe(true)
    expect(window.hasMoreAfter).toBe(true)
    expect(window.totalLines).toBeUndefined()

    const search = await service.search({ artifactIds: [artifactId], query: 'needle' })
    expect(search.matches[0]).toMatchObject({ lineNumber: 3, lineTruncated: true })
    expect(search.matches[0].lineText.length).toBeLessThanOrEqual(4_002)
  })
})
