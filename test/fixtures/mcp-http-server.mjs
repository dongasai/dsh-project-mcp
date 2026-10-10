/**
 * @module @local/dsh-mcp-json/test/fixtures/mcp-http-server
 *
 * 极简 **streamable-http** MCP 服务端夹具：用来补上本插件 `.mcp.json` 里
 * `type: "http"` 这条传输的端到端验证空白（仓库里 dbhub 走的是 stdio）。
 *
 * 实现要点（对齐 MCP streamable-http 契约的最小面）：
 * - 单一端点（默认 `/mcp`），POST 承载 JSON-RPC；响应 `application/json`（单条或数组）。
 * - `initialize` 时下发 `Mcp-Session-Id`，后续请求带回来；DELETE 结束会话。
 * - 不提供 SSE 流：GET 返回 405（契约允许服务端不提供）。
 * - 纯通知（无 id）返回 202 空体。
 *
 * 用法：FIXTURE_PORT=7391 node test/fixtures/mcp-http-server.mjs
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number(process.env.FIXTURE_PORT ?? 7391)

/** 服务端身份。 */
const SERVER_INFO = { name: 'dsh-mcp-json-http-fixture', version: '1.0.0' }

/** 夹具暴露的唯一工具。 */
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text over streamable HTTP.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

const RESOURCE_URI = 'fixture://http/greeting'
const RESOURCES = [{ uri: RESOURCE_URI, name: 'greeting', mimeType: 'text/plain' }]

/** 已建立的会话。 */
const sessions = new Set()

/**
 * 处理一条 JSON-RPC 请求。
 * @param message - 解析后的报文。
 * @returns `{ result }` 或 `{ error }`。
 */
function handle(message) {
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      return { result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: SERVER_INFO,
      } }
    case 'ping':
      return { result: {} }
    case 'tools/list':
      return { result: { tools: TOOLS } }
    case 'tools/call':
      return { result: { content: [{ type: 'text', text: `http-echo: ${String(params.arguments?.text ?? '')}` }], isError: false } }
    case 'resources/list':
      return { result: { resources: RESOURCES } }
    case 'resources/read':
      return { result: { contents: [{ uri: String(params.uri ?? RESOURCE_URI), mimeType: 'text/plain', text: 'hello from http fixture' }] } }
    default:
      return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } }
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  if (url.pathname !== '/mcp') {
    response.writeHead(404).end()
    return
  }
  if (request.method === 'GET') {
    // 不提供服务端发起的 SSE 流
    response.writeHead(405, { allow: 'POST, DELETE' }).end()
    return
  }
  if (request.method === 'DELETE') {
    sessions.delete(request.headers['mcp-session-id'])
    response.writeHead(204).end()
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST, DELETE' }).end()
    return
  }

  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    const batch = Array.isArray(parsed) ? parsed : [parsed]
    const headers = { 'content-type': 'application/json' }
    if (batch.some((message) => message.method === 'initialize')) {
      const sessionId = randomUUID()
      sessions.add(sessionId)
      headers['mcp-session-id'] = sessionId
    }
    const replies = batch
      .filter((message) => message.id !== undefined)
      .map((message) => {
        const outcome = handle(message)
        return 'error' in outcome
          ? { jsonrpc: '2.0', id: message.id, error: outcome.error }
          : { jsonrpc: '2.0', id: message.id, result: outcome.result }
      })
    if (replies.length === 0) {
      response.writeHead(202, headers).end()
      return
    }
    response.writeHead(200, headers).end(JSON.stringify(replies.length === 1 ? replies[0] : replies))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`fixture-http: MCP streamable-http on http://127.0.0.1:${PORT}/mcp\n`)
})
