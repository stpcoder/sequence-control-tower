import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN_CACHE_MS = 35 * 60 * 1_000
const GCLOUD_TIMEOUT_MS = 15_000

export function isVertexOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:' &&
      url.hostname.endsWith('-aiplatform.googleapis.com') &&
      /\/locations\/[^/]+\/endpoints\/openapi(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

export type GcloudTokenRunner = (executable: string, args: string[]) => Promise<string>

function executableCandidates(): string[] {
  const names = process.platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe'] : ['gcloud']
  if (process.platform === 'darwin') {
    names.push(
      '/opt/homebrew/bin/gcloud',
      '/usr/local/bin/gcloud',
      join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud')
    )
  }
  return [...new Set(names)]
}

const runGcloud: GcloudTokenRunner = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, {
    encoding: 'utf8',
    timeout: GCLOUD_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024
  }, (error, stdout) => {
    if (error) reject(error)
    else resolve(stdout)
  })
})

function safeToken(raw: string): string {
  const token = raw.trim()
  if (!token || token.length > 4_096 || /\s/.test(token)) {
    throw new Error('LLM_VERTEX_AUTH_UNAVAILABLE')
  }
  return token
}

export class VertexAccessTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined
  private pending: Promise<string> | undefined

  constructor(
    private readonly runner: GcloudTokenRunner = runGcloud,
    private readonly now: () => number = Date.now
  ) {}

  async token(baseUrl: string): Promise<string | undefined> {
    if (!isVertexOpenAiBaseUrl(baseUrl)) return undefined
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token
    if (this.pending) return this.pending

    this.pending = this.fetchToken()
    try {
      const token = await this.pending
      this.cached = { token, expiresAt: this.now() + TOKEN_CACHE_MS }
      return token
    } finally {
      this.pending = undefined
    }
  }

  clear(): void {
    this.cached = undefined
  }

  private async fetchToken(): Promise<string> {
    for (const executable of executableCandidates()) {
      for (const args of [
        ['auth', 'application-default', 'print-access-token', '--quiet'],
        ['auth', 'print-access-token', '--quiet'],
      ]) {
        try {
          return safeToken(await this.runner(executable, args))
        } catch {
          // Prefer ADC, then use the already active gcloud account. A
          // Finder-launched app can also have a smaller PATH, so continue with
          // known installation locations without reflecting command errors.
        }
      }
    }
    throw new Error('LLM_VERTEX_AUTH_UNAVAILABLE')
  }
}

export const vertexAccessTokenProvider = new VertexAccessTokenProvider()
