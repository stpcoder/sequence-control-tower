import { randomBytes } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { z } from 'zod'
import {
  LPDDR_AGENT_TOOL_DESCRIPTIONS, type LpddrAgentToolName, type LpddrAgentToolService
} from './lpddr-agent-tools'

export interface SctMcpServerHandle { url: string; token: string; close(): Promise<void> }

const toolNames = Object.keys(LPDDR_AGENT_TOOL_DESCRIPTIONS) as LpddrAgentToolName[]

/** Loopback-only MCP bridge for an optional OpenCode sidecar. Every MCP tool is
 * read-only; project writes remain behind renderer confirmation and project IPC. */
export async function startSctMcpServer(tools: LpddrAgentToolService): Promise<SctMcpServerHandle> {
  const token = randomBytes(32).toString('hex')
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
          sourceIds: z.array(z.string().min(1).max(160)).max(100).optional(),
          args: z.record(z.unknown()).optional()
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      }, async ({ projectId, sourceIds, args }) => {
        try {
          const result = await tools.execute(projectId, { name, args }, sourceIds)
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
    close: () => new Promise<void>((resolve) => http.close(() => resolve()))
  }
}
