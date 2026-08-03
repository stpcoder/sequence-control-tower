import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  ArtifactLineWindow,
  ArtifactLineWindowInput,
  ArtifactImportFailure,
  ArtifactImportOptions,
  ArtifactImportResult,
  ArtifactRecord,
  ArtifactSearchFileResult,
  ArtifactSearchInput,
  ArtifactSearchMatch,
  ArtifactSearchResult,
  ArtifactSourceLocation,
  ArtifactTextPreview,
  SimilarArtifact,
  SequenceFingerprint
} from '../shared/contracts'
import { AtomicJsonStore } from './json-store'
import { parseSequence, similarityScore } from './sequence-parser'

interface ArtifactDatabase {
  schemaVersion: 1
  artifacts: Record<string, ArtifactRecord>
}

const DEFAULT_FOLDER_EXTENSIONS = [
  '.seq',
  '.txt',
  '.log',
  '.cfg',
  '.conf',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.csv'
]
const MAX_FOLDER_FILES = 10_000
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const FINGERPRINT_MAX_BYTES = 8 * 1024 * 1024
const MAX_SEARCH_ARTIFACTS = 10_000
const MAX_SEARCH_MATCHES = 2_000
const DEFAULT_SEARCH_MATCHES = 500
const MAX_SEARCH_QUERY_CHARS = 1_000
const MAX_SEARCH_LINE_DISPLAY_CHARS = 4_000
const MAX_CONTEXT_LINE_CHARS = 800
const MAX_LINE_WINDOW_LINES = 1_000
const MAX_LINE_WINDOW_TEXT_CHARS = 20_000
const MAX_SEARCH_LOGICAL_LINE_CHARS = 4 * 1024 * 1024
const MAX_MATCHES_PER_LOGICAL_LINE = 100_000
const METADATA_BATCH_SIZE = 250
const MAX_SOURCES_PER_ARTIFACT = MAX_FOLDER_FILES
const LONG_LINE_ERROR = '한 줄이 4 MB를 초과해 안전하게 검색할 수 없습니다.'
const MATCH_LIMIT_ERROR = '한 줄의 검색 결과가 너무 많아 중단했습니다.'
const ZERO_WIDTH_REGEX_ERROR = '길이가 0인 일치를 만드는 정규식은 안전상 사용할 수 없습니다.'
const UNSAFE_REGEX_ERROR = '반복이 중첩된 정규식은 성능 보호를 위해 사용할 수 없습니다.'

interface ImportCandidate {
  filePath: string
  source: ArtifactSourceLocation
}

interface PreparedArtifact {
  sha256: string
  size: number
  name: string
  source: ArtifactSourceLocation
  fingerprint?: SequenceFingerprint
}

function abortSearch(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('로그 검색이 취소되었습니다.')
  error.name = 'AbortError'
  throw error
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function normalizeExtensions(extensions?: string[]): Set<string> {
  const chosen = Array.isArray(extensions) && extensions.length
    ? extensions.slice(0, 100)
    : DEFAULT_FOLDER_EXTENSIONS
  return new Set(
    chosen
      .map((item) => (typeof item === 'string' ? item.trim().toLowerCase().slice(0, 20) : ''))
      .filter(Boolean)
      .map((item) => (item.startsWith('.') ? item : `.${item}`))
  )
}

function safeFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'EACCES' || code === 'EPERM') return '파일을 읽을 권한이 없습니다.'
  if (code === 'ENOENT') return '파일을 찾을 수 없습니다.'
  if (code === 'ENOSPC') return '저장 공간이 부족합니다.'
  if (code === 'EMFILE' || code === 'ENFILE') return '동시에 열 수 있는 파일 수를 초과했습니다.'
  if (code === 'EFBIG') return '파일이 허용된 크기를 초과했습니다.'
  if (code === 'EBUSY') return '파일을 다른 프로그램이 사용 중입니다.'
  if (code === 'EIO') return '파일 입출력 오류가 발생했습니다.'
  if (code === 'ENAMETOOLONG') return '파일 이름이 너무 깁니다.'
  const controlledMessages = new Set([
    '일반 파일만 가져올 수 있습니다.',
    '파일 크기가 2 GB 제한을 초과했습니다.',
    '복사 중 파일 무결성 검증에 실패했습니다.',
    '이진 파일은 텍스트로 검색할 수 없습니다.',
    '아티팩트를 찾을 수 없습니다.',
    LONG_LINE_ERROR,
    MATCH_LIMIT_ERROR,
    ZERO_WIDTH_REGEX_ERROR,
    UNSAFE_REGEX_ERROR
  ])
  if (error instanceof Error && controlledMessages.has(error.message)) return error.message
  return '파일 처리 중 오류가 발생했습니다.'
}

function opaqueRootId(rootPath: string): string {
  const normalized = process.platform === 'win32' ? resolve(rootPath).toLocaleLowerCase() : resolve(rootPath)
  return createHash('sha256').update('sequence-control-tower-root\0').update(normalized).digest('hex').slice(0, 24)
}

function safeSourcePart(value: string, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160)
  return cleaned || fallback
}

function sourceForFolder(folderPath: string, filePath: string): ArtifactSourceLocation {
  const root = resolve(folderPath)
  const candidate = resolve(filePath)
  const relativePath = relative(root, candidate)
  if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('선택한 폴더 밖의 파일은 가져올 수 없습니다.')
  }
  return {
    rootId: opaqueRootId(root),
    folderLabel: safeSourcePart(basename(root), '선택한 폴더'),
    relativePath: relativePath
      .split(sep)
      .map((part) => safeSourcePart(part, '_'))
      .join('/')
  }
}

function sourceForSelectedFile(filePath: string): ArtifactSourceLocation {
  return {
    rootId: opaqueRootId(dirname(resolve(filePath))),
    folderLabel: '선택한 파일',
    relativePath: safeSourcePart(basename(filePath), '이름 없는 파일')
  }
}

function displayName(record: ArtifactRecord): string {
  return record.sources?.[0]?.relativePath ?? record.originalNames[0] ?? record.id
}

function contextText(line: string): string {
  return line.length > MAX_CONTEXT_LINE_CHARS
    ? `${line.slice(0, MAX_CONTEXT_LINE_CHARS)}…`
    : line
}

function displayLine(line: string, anchor: number): { text: string; truncated: boolean } {
  if (line.length <= MAX_SEARCH_LINE_DISPLAY_CHARS) return { text: line, truncated: false }
  const half = Math.floor(MAX_SEARCH_LINE_DISPLAY_CHARS / 2)
  const start = Math.max(0, Math.min(anchor - half, line.length - MAX_SEARCH_LINE_DISPLAY_CHARS))
  const prefix = start > 0 ? '…' : ''
  const suffix = start + MAX_SEARCH_LINE_DISPLAY_CHARS < line.length ? '…' : ''
  return {
    text: `${prefix}${line.slice(start, start + MAX_SEARCH_LINE_DISPLAY_CHARS)}${suffix}`,
    truncated: true
  }
}

function compileSearch(input: ArtifactSearchInput): {
  mode: 'literal' | 'regex'
  caseSensitive: boolean
  find(line: string, detailLimit: number): { count: number; details: Array<{ start: number; end: number }> }
} {
  const query = typeof input.query === 'string' ? input.query : ''
  if (!query) throw new Error('검색어를 입력해 주세요.')
  if (query.length > MAX_SEARCH_QUERY_CHARS) throw new Error('검색어는 1,000자까지 사용할 수 있습니다.')
  const mode = input.mode === 'regex' ? 'regex' : 'literal'
  const caseSensitive = input.caseSensitive === true

  if (mode === 'literal') {
    const needle = caseSensitive ? query : query.toLocaleLowerCase()
    return {
      mode,
      caseSensitive,
      find(line, detailLimit) {
        const haystack = caseSensitive ? line : line.toLocaleLowerCase()
        const details: Array<{ start: number; end: number }> = []
        let count = 0
        let offset = 0
        while (offset <= haystack.length - needle.length) {
          const start = haystack.indexOf(needle, offset)
          if (start < 0) break
          count += 1
          if (count > MAX_MATCHES_PER_LOGICAL_LINE) throw new Error(MATCH_LIMIT_ERROR)
          if (details.length < detailLimit) details.push({ start, end: start + needle.length })
          offset = start + Math.max(needle.length, 1)
        }
        return { count, details }
      }
    }
  }

  let expression: RegExp
  const safetyPattern = query.replace(/\(\?(?:[:=!]|<[=!])/g, '(')
  const nestedQuantifier = /\((?:[^()\\]|\\.)*(?:[+*?]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)\s*(?:[+*?]|\{\d+(?:,\d*)?\})/
  const repeatedWildcard = /\.\s*[+*][^|)]{0,32}\.\s*[+*]/
  if (nestedQuantifier.test(safetyPattern) || repeatedWildcard.test(query) || /\\[1-9]/.test(query)) {
    throw new Error(UNSAFE_REGEX_ERROR)
  }
  try {
    expression = new RegExp(query, caseSensitive ? 'gu' : 'giu')
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 180) : '올바르지 않은 표현식'
    throw new Error(`정규식을 해석할 수 없습니다: ${detail}`)
  }
  expression.lastIndex = 0
  if (expression.test('')) throw new Error(ZERO_WIDTH_REGEX_ERROR)
  return {
    mode,
    caseSensitive,
    find(line, detailLimit) {
      expression.lastIndex = 0
      const details: Array<{ start: number; end: number }> = []
      let count = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(line)) !== null) {
        if (match[0].length === 0) throw new Error(ZERO_WIDTH_REGEX_ERROR)
        count += 1
        if (count > MAX_MATCHES_PER_LOGICAL_LINE) throw new Error(MATCH_LIMIT_ERROR)
        if (details.length < detailLimit) details.push({ start: match.index, end: match.index + match[0].length })
      }
      return { count, details }
    }
  }
}

async function* streamTextLines(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  let pending = ''
  try {
    for await (const chunk of stream) {
      abortSearch(signal)
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        abortSearch(signal)
        let line = pending.slice(0, newline)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.length > MAX_SEARCH_LOGICAL_LINE_CHARS) throw new Error(LONG_LINE_ERROR)
        yield line
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
      if (pending.length > MAX_SEARCH_LOGICAL_LINE_CHARS) throw new Error(LONG_LINE_ERROR)
    }
    if (pending.length) yield pending
  } finally {
    stream.destroy()
  }
}

async function readUtf8Prefix(filePath: string, maxBytes: number): Promise<string | null> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    const content = buffer.subarray(0, bytesRead)
    // NULs are a cheap and conservative binary-file detector.
    if (content.includes(0)) return null
    return content.toString('utf8')
  } finally {
    await handle.close()
  }
}

export class ArtifactService {
  private readonly store: AtomicJsonStore<ArtifactDatabase>
  private readonly objectRoot: string

  constructor(dataRoot: string) {
    this.objectRoot = join(dataRoot, 'objects', 'sha256')
    this.store = new AtomicJsonStore(join(dataRoot, 'metadata', 'artifacts.json'), {
      schemaVersion: 1,
      artifacts: {}
    })
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.objectRoot, { recursive: true }), this.store.initialize()])
  }

  async importFiles(
    filePaths: string[],
    sources?: Map<string, ArtifactSourceLocation>
  ): Promise<ArtifactImportResult> {
    const importedIds = new Set<string>()
    const failures: ArtifactImportFailure[] = []
    const fingerprintCache = new Map<string, SequenceFingerprint | undefined>()
    const existing = await this.store.read()
    Object.values(existing.artifacts).forEach((artifact) => fingerprintCache.set(artifact.id, artifact.fingerprint))
    for (let offset = 0; offset < filePaths.length; offset += METADATA_BATCH_SIZE) {
      const prepared: PreparedArtifact[] = []
      for (const filePath of filePaths.slice(offset, offset + METADATA_BATCH_SIZE)) {
        try {
          prepared.push(await this.prepareArtifact(
            filePath,
            sources?.get(filePath) ?? sourceForSelectedFile(filePath),
            fingerprintCache
          ))
        } catch (error) {
          failures.push({ name: basename(filePath), reason: safeFailure(error) })
        }
      }
      if (!prepared.length) continue
      const now = new Date().toISOString()
      try {
        const byHash = new Map<string, PreparedArtifact[]>()
        prepared.forEach((item) => byHash.set(item.sha256, [...(byHash.get(item.sha256) ?? []), item]))
        const database = await this.store.update((draft) => {
          for (const [sha256, group] of byHash) {
            const item = group[0]
            const previous = draft.artifacts[sha256]
            const sourceMap = new Map<string, ArtifactSourceLocation>()
            for (const source of [...(previous?.sources ?? []), ...group.map((entry) => entry.source)]) {
              const key = `${source.rootId ?? ''}\0${source.relativePath}`
              // A refreshed source belongs at the newest end of the bounded list.
              sourceMap.delete(key)
              sourceMap.set(key, source)
            }
            const boundedSources = [...sourceMap.values()].slice(-MAX_SOURCES_PER_ARTIFACT)
            draft.artifacts[sha256] = previous
              ? {
                  ...previous,
                  originalNames: [...new Set([...previous.originalNames, ...group.map((entry) => entry.name)])],
                  sources: boundedSources,
                  lastSeenAt: now,
                  importCount: previous.importCount + group.length,
                  fingerprint: previous.fingerprint ?? group.find((entry) => entry.fingerprint)?.fingerprint
                }
              : {
                  id: item.sha256,
                  sha256: item.sha256,
                  size: item.size,
                  extension: extname(item.name).toLowerCase(),
                  originalNames: [...new Set(group.map((entry) => entry.name))],
                  importedAt: now,
                  lastSeenAt: now,
                  importCount: group.length,
                  sources: boundedSources,
                  fingerprint: group.find((entry) => entry.fingerprint)?.fingerprint
                }
          }
        })
        byHash.forEach((_group, sha256) => {
          if (database.artifacts[sha256]) importedIds.add(sha256)
        })
      } catch (error) {
        const reason = safeFailure(error)
        failures.push(...prepared.map((item) => ({ name: item.name, reason })))
      }
    }
    const database = await this.store.read()
    const artifacts = [...importedIds].flatMap((id) => database.artifacts[id] ? [database.artifacts[id]] : [])
    return { cancelled: false, artifacts, failures, skippedCount: 0 }
  }

  async importFolder(folderPath: string, options: ArtifactImportOptions = {}): Promise<ArtifactImportResult> {
    return this.importFolders([folderPath], options)
  }

  async importFolders(folderPaths: string[], options: ArtifactImportOptions = {}): Promise<ArtifactImportResult> {
    const requestedMax = Number(options.maxFiles)
    const maxFiles = Number.isFinite(requestedMax)
      ? Math.floor(Math.min(Math.max(requestedMax, 1), MAX_FOLDER_FILES))
      : 5_000
    const extensions = normalizeExtensions(options.extensions)
    const roots = [...new Set(folderPaths.map((item) => resolve(item)))]
    if (roots.length > 100) throw new Error('한 번에 폴더 100개까지 선택할 수 있습니다.')
    if (!roots.length) return { cancelled: false, artifacts: [], failures: [], skippedCount: 0 }
    const candidates: ImportCandidate[] = []
    let skippedCount = 0
    let limitReached = false
    const failures: ArtifactImportFailure[] = []

    const walk = async (root: string, directory: string): Promise<void> => {
      if (candidates.length >= maxFiles) {
        limitReached = true
        return
      }
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        failures.push({ name: safeSourcePart(basename(directory), '폴더'), reason: safeFailure(error) })
        return
      }
      for (const entry of entries) {
        if (candidates.length >= maxFiles) {
          limitReached = true
          break
        }
        const filePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          skippedCount += 1
        } else if (entry.isDirectory()) {
          await walk(root, filePath)
        } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
          try {
            candidates.push({ filePath, source: sourceForFolder(root, filePath) })
          } catch (error) {
            failures.push({ name: safeSourcePart(entry.name, '파일'), reason: safeFailure(error) })
          }
        } else if (entry.isFile()) {
          skippedCount += 1
        }
      }
    }

    for (const root of roots) {
      if (candidates.length >= maxFiles) {
        limitReached = true
        break
      }
      await walk(root, root)
    }
    if (limitReached) {
      failures.push({
        name: '가져오기 제한',
        reason: `파일 ${maxFiles.toLocaleString()}개 제한에 도달해 나머지 파일은 가져오지 않았습니다.`
      })
    }
    const sourceMap = new Map(candidates.map((candidate) => [candidate.filePath, candidate.source]))
    const result = await this.importFiles(candidates.map((candidate) => candidate.filePath), sourceMap)
    return { ...result, failures: [...failures, ...result.failures], skippedCount }
  }

  async list(): Promise<ArtifactRecord[]> {
    const database = await this.store.read()
    return Object.values(database.artifacts).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
  }

  async get(id: string): Promise<ArtifactRecord | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null
    const database = await this.store.read()
    return database.artifacts[id] ?? null
  }

  async require(id: string): Promise<ArtifactRecord> {
    const record = await this.get(id)
    if (!record) throw new Error('아티팩트를 찾을 수 없습니다.')
    return record
  }

  objectPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('잘못된 아티팩트 ID입니다.')
    return join(this.objectRoot, id.slice(0, 2), id)
  }

  async readText(id: string, maxBytes = FINGERPRINT_MAX_BYTES): Promise<{ text: string; truncated: boolean }> {
    const record = await this.require(id)
    let text: string | null
    try {
      text = await readUtf8Prefix(this.objectPath(id), Math.min(maxBytes, FINGERPRINT_MAX_BYTES))
    } catch (error) {
      throw new Error(safeFailure(error))
    }
    if (text === null) throw new Error('이진 파일은 텍스트로 분석할 수 없습니다.')
    return { text, truncated: record.size > maxBytes }
  }

  async preview(id: string, maxChars = 200_000): Promise<ArtifactTextPreview> {
    const record = await this.require(id)
    const safeMax = Math.min(Math.max(maxChars, 1_000), 500_000)
    const { text, truncated } = await this.readText(id, safeMax * 4)
    return {
      artifactId: id,
      text: text.slice(0, safeMax),
      truncated: truncated || text.length > safeMax,
      totalBytes: record.size,
      encoding: 'utf-8'
    }
  }

  async search(input: ArtifactSearchInput, signal?: AbortSignal): Promise<ArtifactSearchResult> {
    abortSearch(signal)
    if (!input || !Array.isArray(input.artifactIds)) throw new Error('검색할 로그를 선택해 주세요.')
    const artifactIds = [...new Set(input.artifactIds.map(String))]
    if (!artifactIds.length) throw new Error('검색할 로그를 선택해 주세요.')
    if (artifactIds.length > MAX_SEARCH_ARTIFACTS) {
      throw new Error(`한 번에 ${MAX_SEARCH_ARTIFACTS.toLocaleString()}개까지 검색할 수 있습니다.`)
    }
    const compiled = compileSearch(input)
    const requestedMax = Number(input.maxMatches)
    const maxMatches = Number.isFinite(requestedMax)
      ? Math.min(Math.max(Math.floor(requestedMax), 1), MAX_SEARCH_MATCHES)
      : DEFAULT_SEARCH_MATCHES
    const requestedContext = Number(input.contextLines)
    const contextLines = Number.isFinite(requestedContext)
      ? Math.min(Math.max(Math.floor(requestedContext), 0), 5)
      : 2
    const matches: ArtifactSearchMatch[] = []
    const files: ArtifactSearchFileResult[] = []
    let totalMatchCount = 0
    // Clone metadata once. Calling require()/store.read() per artifact turns a
    // 5k search into O(files × metadata-size) structured cloning.
    const database = await this.store.read()

    for (const artifactId of artifactIds) {
      abortSearch(signal)
      const record = /^[a-f0-9]{64}$/.test(artifactId) ? database.artifacts[artifactId] : undefined
      if (!record) {
        files.push({
          artifactId,
          fileName: artifactId.slice(0, 12),
          matchCount: 0,
          searchedLineCount: 0,
          error: '아티팩트를 찾을 수 없습니다.'
        })
        continue
      }
      const fileResult: ArtifactSearchFileResult = {
        artifactId,
        fileName: displayName(record),
        matchCount: 0,
        searchedLineCount: 0
      }
      const before: string[] = []
      const pending: Array<{ match: ArtifactSearchMatch; remaining: number }> = []
      try {
        for await (const line of streamTextLines(this.objectPath(artifactId), signal)) {
          fileResult.searchedLineCount += 1
          if (line.includes('\0')) throw new Error('이진 파일은 텍스트로 검색할 수 없습니다.')

          for (let index = pending.length - 1; index >= 0; index -= 1) {
            const item = pending[index]
            if (item.remaining > 0) {
              item.match.after.push(contextText(line))
              item.remaining -= 1
            }
            if (item.remaining <= 0) pending.splice(index, 1)
          }

          const lineMatches = compiled.find(line, Math.max(0, maxMatches - matches.length))
          fileResult.matchCount += lineMatches.count
          totalMatchCount = Math.min(Number.MAX_SAFE_INTEGER, totalMatchCount + lineMatches.count)
          for (const found of lineMatches.details) {
            const shown = displayLine(line, found.start)
            const detail: ArtifactSearchMatch = {
              artifactId,
              fileName: fileResult.fileName,
              lineNumber: fileResult.searchedLineCount,
              columnStart: found.start + 1,
              columnEnd: found.end + 1,
              lineText: shown.text,
              lineTruncated: shown.truncated,
              before: [...before],
              after: []
            }
            matches.push(detail)
            if (contextLines > 0) pending.push({ match: detail, remaining: contextLines })
          }

          if (contextLines > 0) {
            before.push(contextText(line))
            if (before.length > contextLines) before.shift()
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
        fileResult.error = safeFailure(error)
      }
      files.push(fileResult)
    }

    return {
      query: input.query,
      mode: compiled.mode,
      caseSensitive: compiled.caseSensitive,
      matches,
      totalMatchCount,
      truncated: totalMatchCount > matches.length,
      files
    }
  }

  async lineWindow(input: ArtifactLineWindowInput): Promise<ArtifactLineWindow> {
    if (!input) throw new Error('로그 위치를 지정해 주세요.')
    const artifactId = String(input.artifactId ?? '')
    await this.require(artifactId)
    const requestedStart = Number(input.startLine)
    const startLine = Number.isFinite(requestedStart) ? Math.max(1, Math.floor(requestedStart)) : 1
    const requestedCount = Number(input.lineCount)
    const lineCount = Number.isFinite(requestedCount)
      ? Math.min(Math.max(Math.floor(requestedCount), 1), MAX_LINE_WINDOW_LINES)
      : 200
    const lines: ArtifactLineWindow['lines'] = []
    let currentLine = 0
    let hasMoreAfter = false
    let reachedEnd = true
    try {
      for await (const line of streamTextLines(this.objectPath(artifactId))) {
        currentLine += 1
        if (line.includes('\0')) throw new Error('이진 파일은 텍스트로 열 수 없습니다.')
        if (currentLine < startLine) continue
        if (lines.length >= lineCount) {
          hasMoreAfter = true
          reachedEnd = false
          break
        }
        lines.push({
          lineNumber: currentLine,
          text: line.length > MAX_LINE_WINDOW_TEXT_CHARS
            ? `${line.slice(0, MAX_LINE_WINDOW_TEXT_CHARS)}…`
            : line,
          truncated: line.length > MAX_LINE_WINDOW_TEXT_CHARS
        })
      }
    } catch (error) {
      throw new Error(safeFailure(error))
    } finally {
      // streamTextLines owns and destroys its read stream even on early exit.
    }
    return {
      artifactId,
      startLine,
      lines,
      hasMoreBefore: startLine > 1 && currentLine > 0,
      hasMoreAfter,
      ...(reachedEnd ? { totalLines: currentLine } : {})
    }
  }

  async findSimilar(id: string, limit = 8): Promise<SimilarArtifact[]> {
    const target = await this.require(id)
    if (!target.fingerprint) return []
    const candidates = (await this.list()).filter(
      (item) => item.id !== id && Boolean(item.fingerprint)
    )
    return candidates
      .map((artifact) => ({ artifact, ...similarityScore(target.fingerprint!, artifact.fingerprint!) }))
      .filter((item) => item.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(limit, 1), 30))
  }

  private async prepareArtifact(
    filePath: string,
    source: ArtifactSourceLocation,
    fingerprintCache: Map<string, SequenceFingerprint | undefined>
  ): Promise<PreparedArtifact> {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) throw new Error('일반 파일만 가져올 수 있습니다.')
    if (fileStat.size > MAX_ARTIFACT_BYTES) throw new Error('파일 크기가 2 GB 제한을 초과했습니다.')

    const sha256 = await hashFile(filePath)
    const destinationDirectory = join(this.objectRoot, sha256.slice(0, 2))
    const destination = join(destinationDirectory, sha256)
    await mkdir(destinationDirectory, { recursive: true })

    try {
      await access(destination)
    } catch {
      const temporary = `${destination}.${process.pid}.tmp`
      try {
        await copyFile(filePath, temporary)
        const copiedHash = await hashFile(temporary)
        if (copiedHash !== sha256) throw new Error('복사 중 파일 무결성 검증에 실패했습니다.')
        try {
          await rename(temporary, destination)
        } catch (error) {
          // A concurrent import may have completed the same content first.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } finally {
        await unlink(temporary).catch(() => undefined)
      }
    }

    const name = basename(filePath)
    let fingerprint = fingerprintCache.get(sha256)
    if (!fingerprintCache.has(sha256) && fileStat.size <= FINGERPRINT_MAX_BYTES) {
      const text = await readUtf8Prefix(filePath, FINGERPRINT_MAX_BYTES)
      if (text !== null) fingerprint = parseSequence(text, name)
    }
    fingerprintCache.set(sha256, fingerprint)

    return { sha256, size: fileStat.size, name, source, fingerprint }
  }
}
