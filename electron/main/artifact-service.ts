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
import { basename, extname, join } from 'node:path'
import type {
  ArtifactImportFailure,
  ArtifactImportOptions,
  ArtifactImportResult,
  ArtifactRecord,
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
  return error instanceof Error ? error.message.slice(0, 240) : '알 수 없는 가져오기 오류'
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

  async importFiles(filePaths: string[]): Promise<ArtifactImportResult> {
    const artifacts: ArtifactRecord[] = []
    const failures: ArtifactImportFailure[] = []
    for (const filePath of filePaths) {
      try {
        artifacts.push(await this.ingest(filePath))
      } catch (error) {
        failures.push({ name: basename(filePath), reason: safeFailure(error) })
      }
    }
    return { cancelled: false, artifacts, failures, skippedCount: 0 }
  }

  async importFolder(folderPath: string, options: ArtifactImportOptions = {}): Promise<ArtifactImportResult> {
    const requestedMax = Number(options.maxFiles)
    const maxFiles = Number.isFinite(requestedMax)
      ? Math.floor(Math.min(Math.max(requestedMax, 1), MAX_FOLDER_FILES))
      : 5_000
    const extensions = normalizeExtensions(options.extensions)
    const candidates: string[] = []
    let skippedCount = 0

    const walk = async (directory: string): Promise<void> => {
      if (candidates.length >= maxFiles) return
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (candidates.length >= maxFiles) break
        const filePath = join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          skippedCount += 1
        } else if (entry.isDirectory()) {
          await walk(filePath)
        } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
          candidates.push(filePath)
        } else if (entry.isFile()) {
          skippedCount += 1
        }
      }
    }

    await walk(folderPath)
    const result = await this.importFiles(candidates)
    return { ...result, skippedCount }
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
    const text = await readUtf8Prefix(this.objectPath(id), Math.min(maxBytes, FINGERPRINT_MAX_BYTES))
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

  private async ingest(filePath: string): Promise<ArtifactRecord> {
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
    let fingerprint: SequenceFingerprint | undefined
    if (fileStat.size <= FINGERPRINT_MAX_BYTES) {
      const text = await readUtf8Prefix(filePath, FINGERPRINT_MAX_BYTES)
      if (text !== null) fingerprint = parseSequence(text, name)
    }

    const now = new Date().toISOString()
    const database = await this.store.update((draft) => {
      const previous = draft.artifacts[sha256]
      draft.artifacts[sha256] = previous
        ? {
            ...previous,
            originalNames: [...new Set([...previous.originalNames, name])],
            lastSeenAt: now,
            importCount: previous.importCount + 1,
            fingerprint: previous.fingerprint ?? fingerprint
          }
        : {
            id: sha256,
            sha256,
            size: fileStat.size,
            extension: extname(name).toLowerCase(),
            originalNames: [name],
            importedAt: now,
            lastSeenAt: now,
            importCount: 1,
            fingerprint
          }
    })
    return database.artifacts[sha256]
  }
}
