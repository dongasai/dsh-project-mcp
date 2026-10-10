/**
 * @module @local/dsh-mcp-json/test/fixtures/mcp-stdio-server
 *
 * 极简 stdio MCP 服务端夹具：用来在**真链**上验证本插件能把 `.mcp.json` 里任意一个
 * stdio server 挂起来（而不是只有 dbhub 能跑）。
 *
 * 只实现验证所需的最小方法集：initialize / ping / tools/list / tools/call /
 * resources/list / resources/read。stdout 只允许出现 JSON-RPC 报文（MCP stdio 传输是
 * 换行分隔的 JSON），任何调试输出都必须走 stderr。
 *
 * 用法：node test/fixtures/mcp-stdio-server.mjs
 */

import { createInterface } from 'node:readline'

/** 服务端身份，会在 tools/list 之前随 initialize 返回。 */
const SERVER_INFO = { name: 'dsh-mcp-json-fixture', version: '1.0.0' }

/** 夹具暴露的唯一工具，用于验证 tools/list 与 tools/call。 */
const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
]

/** 夹具暴露的唯一资源，用于验证 resources/list 与 resources/read 的往返。 */
const RESOURCE_URI = 'fixture://stdio/greeting'
const RESOURCES = [{ uri: RESOURCE_URI, name: 'greeting', mimeType: 'text/plain' }]

/**
 * 处理一条 JSON-RPC 请求。
 * @param message - 解析后的报文。
 * @returns result 对象；未知方法返回 `undefined`。
 */
function handle(message) {
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      // 回声客户端请求的版本，避免版本协商失败
      return {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: SERVER_INFO,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return { content: [{ type: 'text', text: `echo: ${String(params.arguments?.text ?? '')}` }], isError: false }
    case 'resources/list':
      return { resources: RESOURCES }
    case 'resources/read':
      return { contents: [{ uri: String(params.uri ?? RESOURCE_URI), mimeType: 'text/plain', text: 'hello from stdio fixture' }] }
    default:
      return undefined
  }
}

/** 按换行分隔的 JSON 写一条报文。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stderr.write(`fixture-stdio: 忽略非 JSON 行\n`)
    return
  }
  // 通知没有 id，不回包
  if (message.id === undefined) return
  const result = handle(message)
  if (result === undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result })
})

process.stdin.on('close', () => process.exit(0))
