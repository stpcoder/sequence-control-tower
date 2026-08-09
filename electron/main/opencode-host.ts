import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import type { EffectiveLlmConfig } from './llm-service'
import { NATIVE_AGENT_SYSTEM_PROMPT } from './native-agent-prompt'

const execFileAsync = promisify(execFile)
const clean = (value: unknown, max = 12_000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''

interface OpenCodeState {
  process: ChildProcess
  client: any
  url: string
  binary: string
}

export interface OpenCodeReply {
  externalSessionId: string
  content: string
  toolNames: string[]
}

/** Optional OpenCode headless adapter. The app owns the project data and tools;
 * OpenCode only supplies the mature conversation/tool-call harness. */
export class OpenCodeHost {
  private state: OpenCodeState | null = null
  private starting: Promise<OpenCodeState> | null = null

  constructor(private readonly options: {
    dataRoot: string
    skillRoot: string
    mcpUrl: string
    mcpToken: string
    effectiveLlm: () => Promise<EffectiveLlmConfig>
  }) {}

  async available(): Promise<boolean> {
    try {
      const [binary, llm] = await Promise.all([this.binary(), this.options.effectiveLlm()])
      return Boolean(binary && llm.baseUrl && llm.model)
    } catch { return false }
  }

  async send(input: {
    externalSessionId?: string
    projectId: string
    sourceIds: string[]
    title: string
    content: string
  }): Promise<OpenCodeReply> {
    const state = await this.ensureStarted()
    const config = await this.options.effectiveLlm()
    let externalSessionId = input.externalSessionId
    if (!externalSessionId) {
      const created = await state.client.session.create({
        directory: join(this.options.dataRoot, 'agent-workspace'),
        title: clean(input.title, 160), agent: 'sct-analyst',
        model: { providerID: 'sct', id: config.model }, metadata: { projectId: input.projectId }
      }, { throwOnError: true })
      externalSessionId = created.data?.id
    }
    if (!externalSessionId) throw new Error('OPENCODE_SESSION_CREATE_FAILED')
    const scope = `\n\n[Sequence Control Tower scope]\nprojectId=${input.projectId}\nallowedSourceIds=${input.sourceIds.join(',')}\n각 MCP 도구에 projectId와 필요한 sourceIds를 전달하십시오.`
    const response = await state.client.session.prompt({
      sessionID: externalSessionId,
      directory: join(this.options.dataRoot, 'agent-workspace'),
      model: { providerID: 'sct', modelID: config.model }, agent: 'sct-analyst',
      system: NATIVE_AGENT_SYSTEM_PROMPT,
      tools: { bash: false, edit: false, write: false, read: false, glob: false, grep: false, webfetch: false, websearch: false, task: false },
      parts: [{ type: 'text', text: `${clean(input.content)}${scope}` }]
    }, { throwOnError: true })
    const parts = Array.isArray(response.data?.parts) ? response.data.parts : []
    const content = parts.filter((part: any) => part?.type === 'text').map((part: any) => clean(part.text)).filter(Boolean).join('\n\n')
    const toolNames = parts.filter((part: any) => part?.type === 'tool').map((part: any) => clean(part.tool ?? part.name, 100)).filter(Boolean)
    if (!content) throw new Error('OPENCODE_EMPTY_RESPONSE')
    return { externalSessionId, content, toolNames }
  }

  async abort(externalSessionId: string): Promise<void> {
    if (!this.state) return
    await this.state.client.session.abort({
      sessionID: externalSessionId,
      directory: join(this.options.dataRoot, 'agent-workspace')
    }).catch(() => undefined)
  }

  close(): void {
    this.state?.process.kill()
    this.state = null
    this.starting = null
  }

  private async ensureStarted(): Promise<OpenCodeState> {
    if (this.state && this.state.process.exitCode === null) return this.state
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start(): Promise<OpenCodeState> {
    const binary = await this.binary()
    if (!binary) throw new Error('OPENCODE_UNAVAILABLE')
    const llm = await this.options.effectiveLlm()
    if (!llm.baseUrl || !llm.model) throw new Error('LLM_UNAVAILABLE')
    const workspace = join(this.options.dataRoot, 'agent-workspace')
    await mkdir(workspace, { recursive: true })
    const password = randomBytes(24).toString('hex')
    const builtinTools = Object.fromEntries(['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'task', 'webfetch', 'websearch', 'lsp', 'todowrite'].map((name) => [name, false]))
    const deny = Object.fromEntries(['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'external_directory', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp'].map((name) => [name, 'deny']))
    const config = {
      autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false,
      model: `sct/${llm.model}`, default_agent: 'sct-analyst', tools: builtinTools,
      permission: { ...deny, skill: 'allow', 'sct_*': 'allow' },
      skills: { paths: [this.options.skillRoot] },
      agent: {
        'sct-analyst': {
          description: 'Evidence-bound LPDDR evaluation analyst', mode: 'primary', model: `sct/${llm.model}`,
          prompt: NATIVE_AGENT_SYSTEM_PROMPT, temperature: 0.1, maxSteps: 6, tools: builtinTools,
          permission: { ...deny, skill: 'allow', 'sct_*': 'allow' }
        }
      },
      provider: {
        sct: {
          name: 'Sequence Control Tower LLM', npm: '@ai-sdk/openai-compatible',
          options: { baseURL: llm.baseUrl, apiKey: llm.apiKey ?? '', timeout: llm.timeoutMs },
          models: { [llm.model]: { id: llm.model, name: llm.model, tool_call: true, temperature: true, limit: { context: 128_000, output: 4_096 } } }
        }
      },
      mcp: { sct: { type: 'remote', url: this.options.mcpUrl, enabled: true, headers: { Authorization: `Bearer ${this.options.mcpToken}` }, oauth: false, timeout: Math.min(llm.timeoutMs, 120_000) } }
    }
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_USERNAME: 'sct', OPENCODE_SERVER_PASSWORD: password
    }
    const processHandle = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OPENCODE_START_TIMEOUT')), 10_000)
      let buffer = ''
      const consume = (chunk: Buffer): void => {
        buffer = `${buffer}${chunk.toString()}`.slice(-8_000)
        const match = buffer.match(/(?:listening[^\n]*?\s+on\s+|)(https?:\/\/127\.0\.0\.1:\d+)/i)
        if (!match) return
        clearTimeout(timer); resolve(match[1])
      }
      processHandle.stdout.on('data', consume)
      processHandle.stderr.on('data', consume)
      processHandle.once('error', (error) => { clearTimeout(timer); reject(error) })
      processHandle.once('exit', () => { clearTimeout(timer); reject(new Error('OPENCODE_EXITED')) })
    }).catch((error) => { processHandle.kill(); throw error })
    const authorization = `Basic ${Buffer.from(`sct:${password}`).toString('base64')}`
    const state = { process: processHandle, url, binary, client: createOpencodeClient({ baseUrl: url, headers: { Authorization: authorization }, directory: workspace }) }
    processHandle.once('exit', () => { if (this.state?.process === processHandle) this.state = null })
    this.state = state
    return state
  }

  private async binary(): Promise<string | null> {
    const explicit = clean(process.env.SEQ_OPENCODE_PATH, 2_000)
    const candidates = [
      explicit,
      join(homedir(), '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    ].filter(Boolean)
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); return candidate } catch { /* next */ }
    }
    try {
      const command = process.platform === 'win32' ? 'where' : 'which'
      const result = await execFileAsync(command, ['opencode'], { env: { ...process.env, PATH: process.env.PATH?.split(delimiter).join(delimiter) } })
      return clean(result.stdout.split(/\r?\n/)[0], 2_000) || null
    } catch { return null }
  }
}
