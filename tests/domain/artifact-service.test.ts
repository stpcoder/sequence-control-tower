const rootReplacementRace = vi.hoisted(() => ({
  requestedPath: undefined as string | undefined,
  movedPath: undefined as string | undefined,
  replacementPath: undefined as string | undefined,
  done: false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (filePath: any) => {
      const canonical = await actual.realpath(filePath)
      if (
        !rootReplacementRace.done
        && rootReplacementRace.requestedPath
        && String(filePath) === rootReplacementRace.requestedPath
      ) {
        rootReplacementRace.done = true
        await actual.rename(rootReplacementRace.requestedPath, rootReplacementRace.movedPath!)
        await actual.symlink(rootReplacementRace.replacementPath!, rootReplacementRace.requestedPath, 'dir')
      }
      return canonical
    }
  }
})

import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactService, isPathWithin } from '../../electron/main/artifact-service'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'log-workbench-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  rootReplacementRace.requestedPath = undefined
  rootReplacementRace.movedPath = undefined
  rootReplacementRace.replacementPath = undefined
  rootReplacementRace.done = false
})

describe('ArtifactService log workbench', () => {
  it('handles POSIX root, Windows drive roots, and UNC roots without prefix collisions', () => {
    expect(isPathWithin('/', '/var/logs', 'darwin')).toBe(true)
    expect(isPathWithin('/var/logs', '/var/logs-archive', 'darwin')).toBe(false)

    expect(isPathWithin('C:\\', 'c:\\Logs\\today', 'win32')).toBe(true)
    expect(isPathWithin('C:\\Logs', 'c:\\logs\\today', 'win32')).toBe(true)
    expect(isPathWithin('C:\\Logs', 'C:\\Logs-archive', 'win32')).toBe(false)
    expect(isPathWithin('\\\\server\\share\\', '\\\\SERVER\\SHARE\\logs', 'win32')).toBe(true)
    expect(isPathWithin('\\\\server\\share\\', '\\\\server\\share-two\\logs', 'win32')).toBe(false)
  })

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

  it('deduplicates duplicate and overlapping roots before applying the file limit', async () => {
    const root = await temporaryRoot()
    const parent = join(root, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, 'root.log'), '@ROOT\n', 'utf8')
    await writeFile(join(child, 'nested.log'), '@NESTED\n', 'utf8')

    const duplicateParent = process.platform === 'win32' ? parent.toUpperCase() : parent
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const result = await service.importFolders([child, parent, duplicateParent], {
      extensions: ['log'],
      maxFiles: 2
    })
    const records = await service.list()

    expect(result.failures).toEqual([])
    expect(result.limitReached).toBe(false)
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.importCount === 1)).toBe(true)
    expect(new Set(records.flatMap((record) => record.sources ?? []).map((source) => source.rootId)).size).toBe(1)
    expect(records.flatMap((record) => record.sources ?? []).map((source) => source.relativePath)).toEqual(
      expect.arrayContaining(['root.log', 'child/nested.log'])
    )
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('reports the bounded intake limit explicitly without a synthetic failure', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await Promise.all([
      writeFile(join(source, 'first.log'), '@FIRST\n', 'utf8'),
      writeFile(join(source, 'second.log'), '@SECOND\n', 'utf8')
    ])

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const result = await service.importFolder(source, { extensions: ['log'], maxFiles: 1 })

    expect(result.limitReached).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.artifacts).toHaveLength(1)
  })

  it('does not report the limit when only ineligible files or empty directories remain', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(join(source, 'nested', 'empty'), { recursive: true })
    await Promise.all([
      writeFile(join(source, 'first.log'), '@FIRST\n', 'utf8'),
      writeFile(join(source, 'ignored.txt'), 'ignore me', 'utf8'),
      writeFile(join(source, 'nested', 'ignored.cfgx'), 'ignore me', 'utf8')
    ])

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const result = await service.importFolder(source, { extensions: ['log'], maxFiles: 1 })

    expect(result.limitReached).toBe(false)
    expect(result.failures).toEqual([])
    expect(result.artifacts).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('fails safely when the selected root is replaced after realpath', async () => {
    const root = await temporaryRoot()
    const selected = join(root, 'selected')
    const original = join(root, 'selected-original')
    const replacement = join(root, 'replacement')
    await mkdir(selected)
    await mkdir(replacement)
    await writeFile(join(selected, 'original.log'), '@ORIGINAL\n', 'utf8')
    await writeFile(join(replacement, 'replacement.log'), '@REPLACEMENT\n', 'utf8')

    rootReplacementRace.requestedPath = selected
    rootReplacementRace.movedPath = original
    rootReplacementRace.replacementPath = replacement
    rootReplacementRace.done = false

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const result = await service.importFolder(selected, { extensions: ['log'] })

    expect(result.artifacts).toEqual([])
    expect(result.failures).toEqual([{
      name: 'selected',
      reason: '심볼릭 링크 폴더는 가져올 수 없습니다.'
    }])
  })

  it.skipIf(process.platform === 'win32')('rejects a selected symlink root while excluding nested symlink directories', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'target')
    const selectedLink = join(root, 'selected-link')
    const source = join(root, 'source')
    const nestedLink = join(source, 'nested-link')
    await mkdir(target)
    await mkdir(source)
    await writeFile(join(target, 'target.log'), '@TARGET\n', 'utf8')
    await writeFile(join(source, 'source.log'), '@SOURCE\n', 'utf8')
    await symlink(target, selectedLink, 'dir')
    await symlink(target, nestedLink, 'dir')

    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const rejected = await service.importFolder(selectedLink, { extensions: ['log'] })
    const imported = await service.importFolder(source, { extensions: ['log'] })

    expect(rejected.artifacts).toEqual([])
    expect(rejected.failures).toEqual([{
      name: 'selected-link',
      reason: '심볼릭 링크 폴더는 가져올 수 없습니다.'
    }])
    expect(imported.failures).toEqual([])
    expect(imported.skippedCount).toBe(1)
    expect(imported.artifacts).toHaveLength(1)
    expect(JSON.stringify(rejected)).not.toContain(root)
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

    const deepPage = await service.search({
      artifactIds: [imported.artifacts[0].id],
      query: 'needle',
      maxMatches: 10,
      detailOffset: 500,
      contextLines: 0,
    })
    expect(deepPage.totalMatchCount).toBe(50_000)
    expect(deepPage.matches).toHaveLength(10)
    expect(deepPage.matches[0]).toMatchObject({ lineNumber: 51, columnStart: 1 })
  })

  it('pages detailed matches without changing the complete count', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'paged.log'), Array.from({ length: 12 }, (_, index) => `needle ${index + 1}`).join('\n'), 'utf8')
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })

    const page = await service.search({
      artifactIds: [imported.artifacts[0].id],
      query: 'needle',
      maxMatches: 4,
      detailOffset: 4,
      contextLines: 0,
    })

    expect(page.totalMatchCount).toBe(12)
    expect(page.detailOffset).toBe(4)
    expect(page.matches.map((item) => item.lineNumber)).toEqual([5, 6, 7, 8])
    expect(page.truncated).toBe(true)
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

  it('inspects stage checkpoints from the complete artifact without returning raw log text', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'multi-stage.log'), [
      'FLOW_CONVENTION=SYN_POWER_ON>SYN_UEFI_ENTER>SYN_UEFI_EXIT>SYN_OS_READY',
      'POWER_ON',
      'SYN_UEFI_ENTER',
      'SYN_UEFI_EXIT',
      'BOOT COMPLETE',
      'TRAINING_PASS',
      'HIDAG @PASS',
      'HIDAG @FAIL code=DQ9',
      'OS_READY',
    ].join('\n'), 'utf8')
    const service = new ArtifactService(join(root, 'data'))
    await service.initialize()
    const imported = await service.importFolder(source, { extensions: ['log'] })
    const artifact = imported.artifacts[0]
    const location = artifact.sources![0]

    const result = await service.inspectStages({
      sources: [{ sourceId: 'source-1', artifactId: artifact.id, rootId: location.rootId, relativePath: location.relativePath }],
    })

    expect(result.sources[0].stages).toEqual(expect.arrayContaining([
      { stage: 'power', status: 'reached', evidenceCount: 1 },
      { stage: 'uefi', status: 'pass', evidenceCount: 1 },
      { stage: 'boot', status: 'pass', evidenceCount: 1 },
      { stage: 'training', status: 'pass', evidenceCount: 1 },
      { stage: 'hdiag', status: 'fail', evidenceCount: 1 },
      { stage: 'test', status: 'fail', evidenceCount: 1 },
      { stage: 'os', status: 'reached', evidenceCount: 1 },
    ]))
    expect(JSON.stringify(result)).not.toContain('code=DQ9')
    expect(JSON.stringify(result)).not.toContain(root)
  })
})
