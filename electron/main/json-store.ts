import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Tiny serialized JSON store with atomic replacement; suitable for a local PoC. */
export class AtomicJsonStore<T> {
  private value: T
  private initialized = false
  private operation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T
  ) {
    this.value = structuredClone(defaultValue)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      this.value = JSON.parse(await readFile(this.filePath, 'utf8')) as T
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      // Preserve a malformed store for manual recovery instead of silently
      // replacing the user's only metadata copy.
      if (error instanceof SyntaxError) {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => undefined)
      }
      await this.writeAtomic(this.value)
    }
    this.initialized = true
  }

  async read(): Promise<T> {
    await this.initialize()
    await this.operation
    return structuredClone(this.value)
  }

  async update(mutator: (draft: T) => void | T): Promise<T> {
    await this.initialize()
    const run = async (): Promise<T> => {
      const draft = structuredClone(this.value)
      const replacement = mutator(draft)
      const next = replacement === undefined ? draft : replacement
      await this.writeAtomic(next)
      this.value = next
      return structuredClone(this.value)
    }
    const result = this.operation.then(run, run)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async writeAtomic(value: T): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    try {
      await rename(temporary, this.filePath)
    } catch (error) {
      // Some Windows filesystems do not replace an existing target atomically.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      const backup = `${this.filePath}.${randomUUID()}.bak`
      try {
        await rename(this.filePath, backup)
        await rename(temporary, this.filePath)
        await unlink(backup).catch(() => undefined)
      } catch (replacementError) {
        await rename(backup, this.filePath).catch(() => undefined)
        throw replacementError
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
