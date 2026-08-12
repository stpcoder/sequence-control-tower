import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn, type ChildProcess, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import type { EffectiveLlmConfig } from './llm-service'
import { NATIVE_AGENT_SYSTEM_PROMPT } from './native-agent-prompt'
import { isVertexOpenAiBaseUrl, vertexAccessTokenProvider, type VertexAccessTokenProvider } from './vertex-auth'
import type { SctMcpToolTrace } from './sct-mcp-server'

const execFileAsync = promisify(execFile)
const clean = (value: unknown, max = 12_000): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max)
  : ''

interface OpenCodeState {
  process: ChildProcess
  client: any
  url: string
  binary: string
  configKey: string
  providerID: string
  modelID: string
}

export interface IsolatedOpenCodePaths {
  home: string
  configHome: string
  dataHome: string
  cacheHome: string
  stateHome: string
  configDir: string
}

export interface VertexOpenCodeTarget {
  project: string
  location: string
  modelID: string
}

export function vertexOpenCodeTarget(baseUrl: string, model: string): VertexOpenCodeTarget | null {
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { return null }
  if (parsed.hostname !== 'aiplatform.googleapis.com') return null
  const match = parsed.pathname.match(/\/projects\/([^/]+)\/locations\/([^/]+)\//i)
  if (!match) return null
  const modelID = model.trim().replace(/^google\//i, '').replace(/^publishers\/google\/models\//i, '')
  return modelID ? { project: decodeURIComponent(match[1]), location: decodeURIComponent(match[2]), modelID } : null
}

/** OpenCode normally merges the user's global plugins and rules. The embedded
 * harness must be deterministic, so it runs in an application-owned XDG home
 * and sees only the inline SCT configuration below. */
export function isolatedOpenCodePaths(dataRoot: string): IsolatedOpenCodePaths {
  const root = join(dataRoot, 'opencode-runtime')
  const configHome = join(root, 'config')
  return {
    home: join(root, 'home'),
    configHome,
    dataHome: join(root, 'data'),
    cacheHome: join(root, 'cache'),
    stateHome: join(root, 'state'),
    configDir: join(configHome, 'opencode')
  }
}

export interface OpenCodeReply {
  externalSessionId: string
  content: string
  toolNames: string[]
  toolTraces: SctMcpToolTrace[]
}

interface OpenCodeMessageRecord {
  info?: { role?: string; time?: { created?: number } }
  parts?: Array<{ type?: string; tool?: string; name?: string }>
}

export const REQUIRED_OPEN_CODE_SKILL = 'lpddr-failure-analysis'

/** OpenCode advertises skills by their path-derived ID. Validate the isolated
 * runtime before accepting a session so a packaging mistake cannot silently
 * downgrade the LPDDR analyst into a generic chat Agent. */
export function hasRequiredOpenCodeSkill(skills: unknown, required = REQUIRED_OPEN_CODE_SKILL): boolean {
  return Array.isArray(skills) && skills.some((skill) => {
    if (!skill || typeof skill !== 'object') return false
    const value = skill as { name?: unknown; location?: unknown }
    const name = clean(value.name, 100).toLowerCase()
    const location = clean(value.location, 2_000).replace(/\\/g, '/').toLowerCase()
    return name === required || location.includes(`/${required}/skill.md`)
  })
}

/** A prompt can span several assistant messages. OpenCode's prompt response only
 * contains the final message, so collect tool calls from the latest user turn in
 * the session timeline instead of silently dropping intermediate evidence. */
export function latestRunToolNames(messages: unknown, fallbackParts: unknown = []): string[] {
  const records = Array.isArray(messages) ? messages as OpenCodeMessageRecord[] : []
  const ordered = [...records].sort((left, right) =>
    Number(left.info?.time?.created ?? 0) - Number(right.info?.time?.created ?? 0))
  const latestUserAt = ordered.reduce((latest, record) =>
    record.info?.role === 'user' ? Math.max(latest, Number(record.info.time?.created ?? 0)) : latest, -1)
  const parts = ordered
    .filter((record) => latestUserAt < 0 || Number(record.info?.time?.created ?? 0) >= latestUserAt)
    .flatMap((record) => Array.isArray(record.parts) ? record.parts : [])
  if (parts.length === 0 && Array.isArray(fallbackParts)) parts.push(...fallbackParts as OpenCodeMessageRecord['parts'] ?? [])
  return [...new Set(parts
    .filter((part) => part?.type === 'tool')
    .map((part) => clean(part.tool ?? part.name, 100))
    .filter(Boolean))]
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
    createMcpScope: (projectId: string, sourceIds: readonly string[]) => string
    mcpScopeTraces: (scopeToken: string) => SctMcpToolTrace[]
    subscribeMcpScope: (scopeToken: string, listener: (trace: SctMcpToolTrace) => void) => () => void
    releaseMcpScope: (scopeToken: string) => void
    effectiveLlm: () => Promise<EffectiveLlmConfig>
  }, private readonly vertexAuth: Pick<VertexAccessTokenProvider, 'token'> = vertexAccessTokenProvider) {}

  async available(): Promise<boolean> {
    try {
      const [binary, llm] = await Promise.all([this.binary(), this.authenticatedLlm()])
      return Boolean(binary && llm.baseUrl && llm.model)
    } catch { return false }
  }

  async send(input: {
    externalSessionId?: string
    projectId: string
    sourceIds: string[]
    title: string
    content: string
    requiredToolNames?: string[]
    onToolTrace?: (trace: SctMcpToolTrace) => void
  }): Promise<OpenCodeReply> {
    const config = await this.authenticatedLlm()
    const state = await this.ensureStarted(config)
    const scopeToken = this.options.createMcpScope(input.projectId, input.sourceIds)
    const unsubscribe = input.onToolTrace
      ? this.options.subscribeMcpScope(scopeToken, input.onToolTrace)
      : () => undefined
    try {
    let externalSessionId = input.externalSessionId
    const requireSkillLoad = !externalSessionId
    if (!externalSessionId) {
      const created = await state.client.session.create({
        directory: join(this.options.dataRoot, 'agent-workspace'),
        title: clean(input.title, 160), agent: 'sct-analyst',
        model: { providerID: state.providerID, id: state.modelID }, metadata: { projectId: input.projectId }
      }, { throwOnError: true })
      externalSessionId = created.data?.id
    }
    if (!externalSessionId) throw new Error('OPENCODE_SESSION_CREATE_FAILED')
    const requiredTools = [...new Set((input.requiredToolNames ?? []).map((name) => clean(name, 100).replace(/^sct_/, '')).filter(Boolean))].slice(0, 4)
    const required = requiredTools.length
      ? `\n이 요청의 최소 근거 도구: ${requiredTools.join(', ')}. 답변을 작성하기 전에 각각 한 번 실행하십시오. 도구 결과가 비어 있어도 실행 사실과 미확인 상태를 근거로 사용하십시오.`
      : ''
    const skill = requireSkillLoad
      ? `\n새 분석 세션입니다. 다른 분석보다 먼저 skill 도구로 ${REQUIRED_OPEN_CODE_SKILL}을 로드하고 그 기준을 이번 대화 전체에 적용하십시오.`
      : ''
    const scope = `\n\n[Sequence Control Tower scope]\nprojectId=${input.projectId}\nscopeToken=${scopeToken}\nallowedSourceIds=${input.sourceIds.join(',')}\n각 MCP 도구에 projectId와 scopeToken을 반드시 전달하십시오. sourceIds를 생략하면 현재 평가 폴더 전체가 사용되며, 허용 범위 밖 sourceId는 서버에서 거부됩니다.${skill}${required}`
    const response = await state.client.session.prompt({
      sessionID: externalSessionId,
      directory: join(this.options.dataRoot, 'agent-workspace'),
      model: { providerID: state.providerID, modelID: state.modelID }, agent: 'sct-analyst',
      system: NATIVE_AGENT_SYSTEM_PROMPT,
      tools: { bash: false, edit: false, write: false, read: false, glob: false, grep: false, webfetch: false, websearch: false, task: false },
      parts: [{ type: 'text', text: `${clean(input.content)}${scope}` }]
    }, { throwOnError: true })
    const parts = Array.isArray(response.data?.parts) ? response.data.parts : []
    const content = parts.filter((part: any) => part?.type === 'text').map((part: any) => clean(part.text)).filter(Boolean).join('\n\n')
    const history = await state.client.session.messages({
      sessionID: externalSessionId,
      directory: join(this.options.dataRoot, 'agent-workspace'),
      limit: 32
    }).catch(() => null)
    const toolNames = latestRunToolNames(history?.data, parts)
    const skillLoaded = toolNames.some((name) => clean(name, 100).toLowerCase() === 'skill')
    const toolTraces = [
      ...(requireSkillLoad && skillLoaded ? [{
        name: `skill:${REQUIRED_OPEN_CODE_SKILL}`,
        label: 'LPDDR 불량분석 기준',
        summary: '평가 단위·근거 순서·이력 관계 기준을 현재 대화에 적용',
        evidenceSourceIds: [],
      }] : []),
      ...this.options.mcpScopeTraces(scopeToken),
    ]
    if (requireSkillLoad && !skillLoaded) {
      throw new Error('OPENCODE_REQUIRED_SKILL_MISSING')
    }
    if (!content) throw new Error('OPENCODE_EMPTY_RESPONSE')
    return { externalSessionId, content, toolNames, toolTraces }
    } finally {
      unsubscribe()
      this.options.releaseMcpScope(scopeToken)
    }
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

  private async ensureStarted(config: EffectiveLlmConfig): Promise<OpenCodeState> {
    const configKey = this.configKey(config)
    if (this.state && this.state.process.exitCode === null && this.state.configKey === configKey) return this.state
    if (this.state) this.close()
    if (this.starting) return this.starting
    this.starting = this.start(config, configKey).finally(() => { this.starting = null })
    return this.starting
  }

  private async start(llm: EffectiveLlmConfig, configKey: string): Promise<OpenCodeState> {
    const binary = await this.binary()
    if (!binary) throw new Error('OPENCODE_UNAVAILABLE')
    if (!llm.baseUrl || !llm.model) throw new Error('LLM_UNAVAILABLE')
    const workspace = join(this.options.dataRoot, 'agent-workspace')
    const isolated = isolatedOpenCodePaths(this.options.dataRoot)
    const vertex = vertexOpenCodeTarget(llm.baseUrl, llm.model)
    const vertexCredentials = vertex ? await this.vertexCredentialsPath() : null
    const providerID = vertex && vertexCredentials ? 'google-vertex' : 'sct'
    const modelID = vertex && vertexCredentials ? vertex.modelID : llm.model
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(isolated.home, { recursive: true }),
      mkdir(isolated.configDir, { recursive: true }),
      mkdir(isolated.dataHome, { recursive: true }),
      mkdir(isolated.cacheHome, { recursive: true }),
      mkdir(isolated.stateHome, { recursive: true })
    ])
    const password = randomBytes(24).toString('hex')
    const builtinTools = Object.fromEntries(['bash', 'edit', 'write', 'read', 'glob', 'grep', 'list', 'task', 'webfetch', 'websearch', 'lsp', 'todowrite'].map((name) => [name, false]))
    const deny = Object.fromEntries(['read', 'edit', 'glob', 'grep', 'list', 'bash', 'task', 'external_directory', 'todowrite', 'question', 'webfetch', 'websearch', 'lsp'].map((name) => [name, 'deny']))
    const config = {
      autoupdate: false, share: 'disabled', snapshot: false, formatter: false, lsp: false,
      model: `${providerID}/${modelID}`, small_model: `${providerID}/${modelID}`,
      enabled_providers: [providerID], disabled_providers: ['opencode'],
      default_agent: 'sct-analyst', tools: builtinTools,
      permission: { ...deny, skill: 'allow', 'sct_*': 'allow' },
      skills: { paths: [this.options.skillRoot] },
      agent: {
        'sct-analyst': {
          description: 'Evidence-bound LPDDR evaluation analyst', mode: 'primary', model: `${providerID}/${modelID}`,
          prompt: NATIVE_AGENT_SYSTEM_PROMPT, temperature: 0.1, steps: 10, tools: builtinTools,
          permission: { ...deny, skill: 'allow', 'sct_*': 'allow' }
        }
      },
      provider: providerID === 'google-vertex' && vertex
        ? {
            'google-vertex': {
              name: 'Sequence Control Tower Vertex AI', npm: '@ai-sdk/google-vertex',
              options: { project: vertex.project, location: vertex.location },
              models: { [modelID]: { id: modelID, name: modelID, tool_call: true, reasoning: true, temperature: true, limit: { context: 128_000, output: 4_096 } } }
            }
          }
        : {
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
      HOME: isolated.home,
      XDG_CONFIG_HOME: isolated.configHome,
      XDG_DATA_HOME: isolated.dataHome,
      XDG_CACHE_HOME: isolated.cacheHome,
      XDG_STATE_HOME: isolated.stateHome,
      OPENCODE_CONFIG_DIR: isolated.configDir,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      ...(vertex && vertexCredentials ? {
        GOOGLE_APPLICATION_CREDENTIALS: vertexCredentials,
        GOOGLE_CLOUD_PROJECT: vertex.project,
        GOOGLE_VERTEX_PROJECT: vertex.project,
        VERTEX_LOCATION: vertex.location,
        GOOGLE_VERTEX_LOCATION: vertex.location
      } : {}),
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
    const state = { process: processHandle, url, binary, configKey, providerID, modelID, client: createOpencodeClient({ baseUrl: url, headers: { Authorization: authorization }, directory: workspace }) }
    const skills = await state.client.app.skills({ directory: workspace }, { throwOnError: true })
      .catch(() => null)
    if (!hasRequiredOpenCodeSkill(skills?.data)) {
      processHandle.kill()
      throw new Error('OPENCODE_SKILL_UNAVAILABLE')
    }
    processHandle.once('exit', () => { if (this.state?.process === processHandle) this.state = null })
    this.state = state
    return state
  }

  private async authenticatedLlm(): Promise<EffectiveLlmConfig> {
    const llm = await this.options.effectiveLlm()
    if (llm.apiKey || !isVertexOpenAiBaseUrl(llm.baseUrl)) return llm
    const accessToken = await this.vertexAuth.token(llm.baseUrl)
    if (!accessToken) throw new Error('LLM_VERTEX_AUTH_UNAVAILABLE')
    return { ...llm, apiKey: accessToken }
  }

  private configKey(llm: EffectiveLlmConfig): string {
    return createHash('sha256').update(`${llm.baseUrl}\n${llm.model}\n${llm.apiKey ?? ''}`).digest('hex')
  }

  private async vertexCredentialsPath(): Promise<string | null> {
    const explicit = clean(process.env.GOOGLE_APPLICATION_CREDENTIALS, 2_000)
    const candidates = [
      explicit,
      process.platform === 'win32'
        ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
        : join(homedir(), '.config', 'gcloud', 'application_default_credentials.json')
    ].filter(Boolean)
    for (const candidate of candidates) {
      try { await access(candidate, constants.R_OK); return candidate } catch { /* next */ }
    }
    return null
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
