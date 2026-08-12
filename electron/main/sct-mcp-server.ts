import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { z } from 'zod'
import {
  LPDDR_AGENT_TOOL_DESCRIPTIONS, type LpddrAgentToolName, type LpddrAgentToolResult, type LpddrAgentToolService
} from './lpddr-agent-tools'

export interface SctMcpToolTrace {
  name: string
  label: string
  summary: string
  evidenceSourceIds: string[]
}

export interface SctMcpServerHandle {
  url: string
  token: string
  createScope(projectId: string, sourceIds: readonly string[]): string
  scopeTraces(scopeToken: string): SctMcpToolTrace[]
  subscribeScope(scopeToken: string, listener: (trace: SctMcpToolTrace) => void): () => void
  releaseScope(scopeToken: string): void
  close(): Promise<void>
}

export class SctMcpScopeRegistry {
  private readonly scopes = new Map<string, {
    projectId: string
    sourceIds: Set<string>
    expiresAt: number
    traces: SctMcpToolTrace[]
    listeners: Set<(trace: SctMcpToolTrace) => void>
  }>()

  create(projectId: string, sourceIds: readonly string[], ttlMs = 10 * 60_000): string {
    const safeProjectId = projectId.trim().slice(0, 160)
    const safeSourceIds = [...new Set(sourceIds.map((item) => item.trim().slice(0, 160)).filter(Boolean))].slice(0, 100)
    if (!safeProjectId || !safeSourceIds.length) throw new Error('MCP 평가 범위가 비어 있습니다.')
    const token = randomBytes(24).toString('hex')
    this.scopes.set(token, {
      projectId: safeProjectId, sourceIds: new Set(safeSourceIds), expiresAt: Date.now() + Math.max(1_000, ttlMs),
      traces: [], listeners: new Set(),
    })
    return token
  }

  record(scopeToken: string, result: LpddrAgentToolResult): void {
    const scope = this.scopes.get(scopeToken.trim())
    if (!scope || scope.expiresAt <= Date.now()) return
    const trace = {
      name: result.name,
      label: result.label,
      summary: result.summary.slice(0, 1_000),
      evidenceSourceIds: result.evidenceSourceIds.filter((sourceId) => scope.sourceIds.has(sourceId)).slice(0, 100),
    }
    scope.traces.push(trace)
    if (scope.traces.length > 20) scope.traces.splice(0, scope.traces.length - 20)
    for (const listener of scope.listeners) listener({ ...trace, evidenceSourceIds: [...trace.evidenceSourceIds] })
  }

  traces(scopeToken: string): SctMcpToolTrace[] {
    return (this.scopes.get(scopeToken.trim())?.traces ?? []).map((trace) => ({ ...trace, evidenceSourceIds: [...trace.evidenceSourceIds] }))
  }

  subscribe(scopeToken: string, listener: (trace: SctMcpToolTrace) => void): () => void {
    const scope = this.scopes.get(scopeToken.trim())
    if (!scope || scope.expiresAt <= Date.now()) return () => undefined
    scope.listeners.add(listener)
    return () => { scope.listeners.delete(listener) }
  }

  authorize(scopeToken: string, projectId: string, requestedSourceIds?: readonly string[]): string[] {
    const token = scopeToken.trim()
    const scope = this.scopes.get(token)
    if (!scope || scope.expiresAt <= Date.now()) { this.scopes.delete(token); throw new Error('MCP 평가 범위가 만료되었습니다.') }
    if (scope.projectId !== projectId.trim()) throw new Error('MCP 프로젝트 범위가 일치하지 않습니다.')
    const requested = requestedSourceIds?.length
      ? [...new Set(requestedSourceIds.map((item) => item.trim()).filter(Boolean))]
      : [...scope.sourceIds]
    if (!requested.length || requested.length > 100 || requested.some((sourceId) => !scope.sourceIds.has(sourceId))) throw new Error('MCP 로그 범위를 벗어났습니다.')
    return requested
  }

  release(scopeToken: string): void { this.scopes.delete(scopeToken.trim()) }
  clear(): void { this.scopes.clear() }
}

const toolNames = Object.keys(LPDDR_AGENT_TOOL_DESCRIPTIONS) as LpddrAgentToolName[]

/** Loopback-only MCP bridge for an optional OpenCode sidecar. Every MCP tool is
 * read-only; project writes remain behind renderer confirmation and project IPC. */
export async function startSctMcpServer(tools: LpddrAgentToolService): Promise<SctMcpServerHandle> {
  const token = randomBytes(32).toString('hex')
  const scopes = new SctMcpScopeRegistry()
  const app = createMcpExpressApp({ host: '127.0.0.1' })
  app.post('/mcp', async (request: any, response: any) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.status(401).json({ error: 'unauthorized' })
      return
    }
    const server = new McpServer({ name: 'sequence-control-tower', version: '0.9.0' })
    for (const name of toolNames) {
      server.registerTool(name, {
        title: name,
        description: LPDDR_AGENT_TOOL_DESCRIPTIONS[name],
        inputSchema: {
          projectId: z.string().min(1).max(160),
          scopeToken: z.string().min(16).max(160),
          sourceIds: z.array(z.string().min(1).max(160)).max(100).optional(),
          args: z.record(z.unknown()).optional()
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      }, async ({ projectId, scopeToken, sourceIds, args }) => {
        try {
          const authorizedSourceIds = scopes.authorize(scopeToken, projectId, sourceIds)
          const result = await tools.execute(projectId, { name, args }, authorizedSourceIds)
          scopes.record(scopeToken, result)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : '도구 실행 실패'
          return { isError: true, content: [{ type: 'text' as const, text: message.slice(0, 500) }] }
        }
      })
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const closeRequest = (): void => {
      void transport.close()
      void server.close()
    }
    response.once('close', closeRequest)
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response, request.body)
    } catch {
      if (!response.headersSent) response.status(500).json({ error: 'mcp request failed' })
    }
  })
  app.get('/mcp', (_request: any, response: any) => response.status(405).end())
  app.delete('/mcp', (_request: any, response: any) => response.status(405).end())

  const http = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('MCP loopback port를 열지 못했습니다.')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    createScope: (projectId, sourceIds) => scopes.create(projectId, sourceIds),
    scopeTraces: (scopeToken) => scopes.traces(scopeToken),
    subscribeScope: (scopeToken, listener) => scopes.subscribe(scopeToken, listener),
    releaseScope: (scopeToken) => scopes.release(scopeToken),
    close: () => new Promise<void>((resolve) => { scopes.clear(); http.close(() => resolve()) })
  }
}
