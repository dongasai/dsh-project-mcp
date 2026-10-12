/**
 * @module @local/dsh-mcp-json/test/regress
 *
 * 回归测试：用 stub profile ctx + stub 会话（agent）驱动本插件，覆盖配置归一化、
 * 会话级隔离、项目定位、错误路径、热重挂与超时兜底。
 *
 * 为什么用假 mcp-client：本套用例要断言的是**插件的编排行为**（挂到哪个作用域、
 * 什么时候停、什么时候起、谁被跳过），而真客户端会真的起子进程、握手、列工具，既慢又
 * 难制造「重挂交叠」「握手卡死」这些场景。假客户端只保留三条关键语义：
 *   1. serverName 在**一个注册作用域内**独占（`WeakMap` keyed by 作用域 ctx）——
 *      这条正是隔离语义的根基：不同会话可以各挂一份同名 server；
 *   2. 连接有耗时；
 *   3. effect 的归属跟随发起它的那个 fiber。
 *
 * 真链（真起 MCP 子进程、真握手）必须由活 Harness 验证：插件代码不在 HMR 的监视集里，
 * 改了要重启 Harness 才生效。`test/fixtures/` 下的两个真 MCP 服务端可直接被任何项目的
 * `.mcp.json` 引用。
 *
 * 运行：node test/regress.mjs      （或 npm test）
 * 只依赖 node: 内置模块，不写仓库内任何路径（临时目录建在 os.tmpdir()）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 超时在插件里默认 15s / 10s；回归里压到 400ms，否则相关用例要跑几十秒。
// 必须在 import 插件之前设好 —— 这两个常量在模块加载时求值。
process.env.MCP_JSON_STARTUP_TIMEOUT_MS = '400'
process.env.MCP_JSON_DISPOSE_TIMEOUT_MS = '400'

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

/** 假客户端的「连接耗时」，用来把两次重挂撑到交叠。 */
const FAKE_DELAY_MS = 400

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-json-'))
const anchorDir = join(scratch, 'anchor')
mkdirSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'), { recursive: true })

writeFileSync(
  join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', version: '0.0.0', type: 'module', exports: { '.': './index.js' } }),
)
writeFileSync(
  join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'index.js'),
  `const DELAY = Number(process.env.FAKE_DELAY ?? ${FAKE_DELAY_MS})
// serverName 的独占按「注册作用域」算 —— 与官方实现一致（WeakMap keyed by scopeOf(ctx) ?? ctx.root）。
// 于是不同会话可以各挂一份同名 server，这正是隔离语义的根基。
const activeByScope = new WeakMap()
export const name = 'mcp-client'
export async function apply(ctx, config) {
  let active = activeByScope.get(ctx)
  if (active === undefined) { active = new Set(); activeByScope.set(ctx, active) }
  if (active.has(config.serverName)) {
    throw new Error(\`mcp-client: serverName "\${config.serverName}" is already in use by another mcp-client instance in this scope\`)
  }
  active.add(config.serverName)
  ctx.effect(() => () => { active.delete(config.serverName) })
  // serverName 以 hang 开头 ⇒ 注册一个永不 resolve 的 cleanup，用来复现「dispose 挂起」
  if (config.serverName.startsWith('hang')) ctx.effect(() => () => new Promise(() => {}))
  // serverName 以 stall 开头 ⇒ 握手永不返回，用来复现「启动卡死」
  if (config.serverName.startsWith('stall')) await new Promise(() => {})
  else await new Promise((resolve) => setTimeout(resolve, DELAY))
}
`,
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (events) => events.map(([level, message]) => `${level}: ${message}`).join('\n')

/**
 * 造一个带 `.mcp.json` 的项目目录。
 * @param name - 相对 scratch 的目录名（可含子路径）。
 * @param document - 要写入的声明；省略则只建目录。
 * @returns 项目目录绝对路径。
 */
function makeProject(name, document) {
  const directory = join(scratch, name)
  mkdirSync(directory, { recursive: true })
  if (document !== undefined) writeFileSync(join(directory, '.mcp.json'), JSON.stringify(document, null, 2))
  return directory
}

/** 单工具项目声明。 */
const echoOnly = { mcpServers: { echo: { command: 'node' } } }

/**
 * 造一个 stub Harness：一个 profile 级 ctx，加上能创建任意多个会话的入口。
 *
 * 关键点是 `live` **按会话分开**：每个会话有自己的存活集合，这样才能断言
 * 「A 会话看不到 B 会话的工具」。
 *
 * `plugin.apply` 收到的是 **agentCtx 本身**（不是每次新建的临时对象）—— 假客户端用它
 * 当作用域 key，所以同一会话内的实例共享作用域、不同会话彼此隔离，与真实现一致。
 *
 * 每个用例结束必须 `dispose()`：watcher 是 `agentCtx.effect` 注册的，不回收会一直盯着
 * 同一个目录，后面的用例每写一次文件都会把前面所有 harness 一起触发。
 * @returns `{ ctx, events, createSession, profilePluginCalls, dispose }`
 */
function createHarness() {
  const events = []
  const listeners = new Map()
  const profileEffects = []
  /** profile 作用域上的 plugin 调用次数 —— 必须恒为 0（隔离的核心断言）。 */
  const profilePluginCalls = []
  const sessions = []

  const logger = () => ({
    info: (...args) => events.push(['info', args.join(' ')]),
    warn: (...args) => events.push(['warn', args.join(' ')]),
    error: (...args) => events.push(['error', args.join(' ')]),
  })

  const ctx = {
    logger,
    baseUrl: pathToFileURL(`${anchorDir}/`).href,
    on: (event, handler) => {
      listeners.set(event, handler)
    },
    effect: (callback) => {
      const dispose = callback()
      profileEffects.push(dispose)
      return () => dispose?.()
    },
    plugin: () => {
      profilePluginCalls.push(1)
      throw new Error('mcp-json 不该在 profile 作用域挂 MCP 实例')
    },
  }

  let sessionSeq = 0
  /**
   * 创建一个会话并触发 `agent/created`。
   * @param cwd - 会话工作目录（项目定位基准）。
   * @returns 会话句柄 `{ id, cwd, servers(), live, dispose() }`
   */
  const createSession = async (cwd) => {
    const live = new Set()
    const sessionEffects = []
    const sessionFibers = []
    /** 当前正在启动的那个 fiber 的 effect 回收栈（模拟 Cordis 的 fiber effect 归属）。 */
    let currentCleanups = null

    const agentCtx = {
      effect: (callback) => {
        const dispose = callback()
        ;(currentCleanups ?? sessionEffects).push(dispose)
        return () => dispose?.()
      },
      plugin: (plugin, config) => {
        live.add(config.serverName)
        const ownCleanups = []
        let startup
        currentCleanups = ownCleanups
        try {
          startup = Promise.resolve(plugin.apply(agentCtx, config))
        } catch (error) {
          startup = Promise.reject(error)
        } finally {
          currentCleanups = null
        }
        events.push(['mount', config.serverName, Date.now()])
        let disposed = false
        const fiber = {
          then: (onFulfilled, onRejected) => startup.then(onFulfilled, onRejected),
          dispose: async () => {
            if (disposed) return
            disposed = true
            // 先注销再跑 cleanup：真 fiber 的 dispose 一开始就释放 serverName，
            // 哪怕某个 cleanup 永不 resolve。
            live.delete(config.serverName)
            events.push(['dispose', config.serverName])
            await Promise.all(ownCleanups.reverse().map((cleanup) => cleanup?.()))
          },
        }
        sessionFibers.push(fiber)
        return fiber
      },
    }

    const id = `s${(sessionSeq += 1)}`
    const agent = { ctx: agentCtx, session: { id, header: { cwd } } }
    await listeners.get('agent/created')({ agent })

    const session = {
      id,
      cwd,
      live,
      servers: () => [...live].sort(),
      dispose: async () => {
        // 模拟 Cordis：作用域销毁时先回退 effect，再回收该作用域下的所有 fiber。
        for (const dispose of sessionEffects.reverse()) await dispose?.()
        for (const fiber of sessionFibers.reverse()) await fiber.dispose()
      },
    }
    sessions.push(session)
    return session
  }

  const dispose = async () => {
    for (const session of sessions) await session.dispose()
    for (const disposer of profileEffects.reverse()) await disposer?.()
  }

  const harness = { ctx, events, createSession, profilePluginCalls, dispose }
  activeHarnesses.push(harness)
  return harness
}

let passed = 0
let failed = 0
const failures = []

/** 当前用例创建的 harness，用例收尾统一回收。 */
let activeHarnesses = []

/**
 * 跑一个用例。
 * @param title - 用例名。
 * @param body - 用例体，抛错即失败。
 */
async function test(title, body) {
  activeHarnesses = []
  try {
    await body()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failed += 1
    failures.push(`${title}\n    ${error.message.split('\n').join('\n    ')}`)
    console.log(`  ✗ ${title}`)
  } finally {
    for (const harness of activeHarnesses) await harness.dispose()
  }
}

console.log(`regress: 临时目录 ${scratch}\n`)

try {
  // ── 声明表与字段映射 ──────────────────────────────────────────────────────
  await test('VS Code 风格 servers 表 + http 类型映射正确', async () => {
    const project = makeProject('map-http', {
      servers: { remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN_X:-fallback}' } } },
    })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['remote'])
    assert.match(text(h.events), /remote 就绪（streamable-http）/)
  })

  await test('stdio 缺省 cwd 取 .mcp.json 所在目录，相对 cwd 按该目录解析', async () => {
    const project = makeProject('map-cwd', {
      mcpServers: { plain: { command: 'node' }, relative: { command: 'node', cwd: 'sub/dir' } },
    })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['plain', 'relative'])
    assert.match(text(h.events), new RegExp(`plain 就绪`))
  })

  await test('${VAR} / ${VAR:-default} / 嵌套默认值 展开正确', async () => {
    process.env.MCPJSON_TEST_SET = '/from-env'
    const project = makeProject('map-env', {
      mcpServers: {
        expansion: { command: 'node', args: ['${MCPJSON_TEST_SET}/a', '${MCPJSON_TEST_UNSET:-/fallback}/b', '${MCPJSON_TEST_UNSET:-${MCPJSON_TEST_SET}/nested}/c'] },
      },
    })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    await h.createSession(project)
    assert.match(text(h.events), /expansion 就绪/)
    delete process.env.MCPJSON_TEST_SET
  })

  await test('未定义且无默认值的变量展开为空串并告警', async () => {
    const project = makeProject('map-absent', { mcpServers: { missing: { command: 'node', args: ['--x=${MCPJSON_TEST_ABSENT}'] } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    await h.createSession(project)
    assert.match(text(h.events), /环境变量 MCPJSON_TEST_ABSENT 未定义且无默认值/)
  })

  await test('type: "sse" 被跳过并说明原因', async () => {
    const project = makeProject('bad-sse', { mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), [])
    assert.match(text(h.events), /transport "sse" 不受 dsh-mcp-client 支持/)
  })

  await test('同时声明 command 与 url 且无 type 时报错', async () => {
    const project = makeProject('bad-both', { mcpServers: { confused: { command: 'node', url: 'https://x' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), [])
    assert.match(text(h.events), /同时声明了 "command" 与 "url"/)
  })

  await test('非法 serverName 被规范化并告警', async () => {
    const project = makeProject('bad-name', { mcpServers: { 'my.server.v2': { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['my_server_v2'])
    assert.match(text(h.events), /serverName "my\.server\.v2" 不合法/)
  })

  await test('同一文件内规范化后重名只保留前一条', async () => {
    const project = makeProject('bad-dup', { mcpServers: { 'dup.one': { command: 'node' }, dup_one: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['dup_one'])
    assert.match(text(h.events), /规范化后重名/)
    assert.doesNotMatch(text(h.events), /already in use/)
  })

  await test('disabledServers 跳过指定条目', async () => {
    const project = makeProject('cfg-disabled', { mcpServers: { keep: { command: 'node' }, drop: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { disabledServers: ['drop'] })
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['keep'])
    assert.match(text(h.events), /已按 disabledServers 跳过 drop/)
  })

  // ── 会话级隔离（本插件的核心语义）────────────────────────────────────────
  await test('实例挂在会话作用域，profile 作用域零挂载', async () => {
    const project = makeProject('iso-scope', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['echo'])
    assert.equal(h.profilePluginCalls.length, 0, 'profile 层不该挂任何 MCP 实例（否则工具会全局可见）')
  })

  await test('两个会话各自的项目：同名 server 各一份，互不干扰', async () => {
    const a = makeProject('iso-a', { mcpServers: { dbhub: { command: 'node' } } })
    const b = makeProject('iso-b', { mcpServers: { dbhub: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const sa = await h.createSession(a)
    const sb = await h.createSession(b)
    assert.deepEqual(sa.servers(), ['dbhub'], 'A 会话有自己那份')
    assert.deepEqual(sb.servers(), ['dbhub'], 'B 会话也有自己那份')
    assert.doesNotMatch(text(h.events), /already in use/, '不同作用域允许同名，这是隔离的前提')
  })

  await test('A 会话看不到 B 会话的工具（隔离核心）', async () => {
    const a = makeProject('iso2-a', { mcpServers: { onlyA: { command: 'node' } } })
    const b = makeProject('iso2-b', { mcpServers: { onlyB: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const sa = await h.createSession(a)
    const sb = await h.createSession(b)
    assert.deepEqual(sa.servers(), ['onlyA'])
    assert.deepEqual(sb.servers(), ['onlyB'])
    assert.ok(!sa.live.has('onlyB'), 'A 的存活集合里绝不能出现 B 的 server')
    assert.ok(!sb.live.has('onlyA'), 'B 的存活集合里绝不能出现 A 的 server')
  })

  await test('改 A 项目的 .mcp.json 完全不影响 B 会话', async () => {
    const a = makeProject('iso3-a', echoOnly)
    const b = makeProject('iso3-b', { mcpServers: { two: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const sa = await h.createSession(a)
    const sb = await h.createSession(b)
    h.events.length = 0
    writeFileSync(join(a, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'node' }, extra: { command: 'node' } } }, null, 2))
    await sleep(1400)
    assert.deepEqual(sa.servers(), ['echo', 'extra'], 'A 收敛到自己的新内容')
    assert.deepEqual(sb.servers(), ['two'], 'B 一动不动')
    assert.equal(sb.live.has('extra'), false)
  })

  await test('会话销毁后实例被回收，且不影响其它会话', async () => {
    const a = makeProject('iso4-a', echoOnly)
    const b = makeProject('iso4-b', { mcpServers: { two: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const sa = await h.createSession(a)
    const sb = await h.createSession(b)
    await sa.dispose()
    assert.deepEqual(sa.servers(), [], 'A 的实例随会话回收')
    assert.deepEqual(sb.servers(), ['two'], 'B 不受影响')
  })

  // ── 项目定位（会话 cwd）──────────────────────────────────────────────────
  await test('会话 cwd 就是项目根时直接命中 .mcp.json', async () => {
    const project = makeProject('loc-root', { mcpServers: { proj: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['proj'])
  })

  await test('会话开在子目录时靠 searchUp 找到项目根的 .mcp.json', async () => {
    const root = makeProject('loc-sub', { mcpServers: { proj: { command: 'node' } } })
    const deep = join(root, 'Modules', 'Orders')
    mkdirSync(deep, { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(deep)
    assert.deepEqual(s.servers(), ['proj'], '这正是 Claude Code 的行为：子目录会话也认得项目根的声明')
  })

  await test('searchUp 关闭时子目录找不到声明', async () => {
    const root = makeProject('loc-nosearch', { mcpServers: { proj: { command: 'node' } } })
    const deep = join(root, 'Modules', 'Orders')
    mkdirSync(deep, { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, { searchUp: false })
    const s = await h.createSession(deep)
    assert.deepEqual(s.servers(), [])
    assert.match(text(h.events), /未找到 \.mcp\.json/)
  })

  await test('会话 cwd 所在项目没有 .mcp.json 时不挂载也不报错', async () => {
    const bare = makeProject('loc-bare')
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(bare)
    assert.deepEqual(s.servers(), [])
    assert.match(text(h.events), /未找到 \.mcp\.json/)
  })

  await test('projectDir 显式覆盖会话 cwd', async () => {
    const pinned = makeProject('loc-pinned', { mcpServers: { pinned: { command: 'node' } } })
    const other = makeProject('loc-other', { mcpServers: { other: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: pinned })
    const s = await h.createSession(other)
    assert.deepEqual(s.servers(), ['pinned'], 'projectDir 优先于会话 cwd')
  })

  await test('会话没有工作目录时跳过挂载并告警', async () => {
    const h = createHarness()
    await mod.apply(h.ctx, {})
    await h.createSession('')
    assert.match(text(h.events), /会话没有可用的工作目录/)
  })

  // ── 错误路径 ─────────────────────────────────────────────────────────────
  await test('坏 JSON 保留当前实例不动', async () => {
    const project = makeProject('err-json', { mcpServers: { stable: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), '{ broken')
    await sleep(1200)
    assert.deepEqual(s.servers(), ['stable'])
    assert.match(text(h.events), /保留当前已挂载的实例/)
  })

  await test('缺声明表保留当前实例不动', async () => {
    const project = makeProject('err-table', { mcpServers: { stable: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ somethingElse: {} }))
    await sleep(1200)
    assert.deepEqual(s.servers(), ['stable'])
    assert.match(text(h.events), /没有 "mcpServers" 声明表/)
  })

  await test('.mcp.json 被删除则停掉该会话的全部实例', async () => {
    const project = makeProject('err-gone', { mcpServers: { gone: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    rmSync(join(project, '.mcp.json'))
    await sleep(1200)
    assert.deepEqual(s.servers(), [])
    assert.match(text(h.events), /未找到 \.mcp\.json/)
  })

  await test('单个 server 起不来不连坐同文件里的其它 server', async () => {
    const project = makeProject('err-partial', {
      mcpServers: { okone: { command: 'node' }, bad: { type: 'sse', url: 'https://x' }, oktwo: { command: 'node' } },
    })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['okone', 'oktwo'])
    assert.match(text(h.events), /2\/2 个 server 在跑/)
  })

  await test('非法 config 显式失败', async () => {
    const h = createHarness()
    await assert.rejects(() => mod.apply(h.ctx, { watch: 'yes' }), /config\.watch must be a boolean/)
    await assert.rejects(() => mod.apply(h.ctx, { disabledServers: [1] }), /disabledServers must be an array of strings/)
    await assert.rejects(() => mod.apply(h.ctx, { toolCallTimeoutMs: 0 }), /toolCallTimeoutMs must be a positive number/)
    await assert.rejects(() => mod.apply(h.ctx, { path: '' }), /config\.path must be a non-empty string/)
  })

  // ── 热重挂 ───────────────────────────────────────────────────────────────
  await test('单次重挂先停旧、再起新', async () => {
    const project = makeProject('reload-order', { mcpServers: { first: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { second: { command: 'node' } } }, null, 2))
    await sleep(1400)
    assert.deepEqual(s.servers(), ['second'])
    const order = h.events.filter(([kind]) => kind === 'mount' || kind === 'dispose').map(([kind, name]) => `${kind}:${name}`)
    assert.ok(order.indexOf('dispose:first') < order.indexOf('mount:second'), `停旧应早于起新：${order.join(' → ')}`)
  })

  await test('并发重挂收敛到文件内容（回归：在途实例漏 dispose）', async () => {
    const project = makeProject('reload-race', { mcpServers: { dbhub: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['dbhub'])
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { dbhub: { command: 'node' }, extra: { command: 'node' } } }, null, 2))
    await sleep(300) // 第一次重挂仍在途（假客户端要 FAKE_DELAY_MS 才就绪）
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { dbhub: { command: 'node' } } }, null, 2))
    await sleep(2600)
    assert.deepEqual(s.servers(), ['dbhub'], '终态必须等于文件内容')
    assert.doesNotMatch(text(h.events), /already in use/, '不应出现虚假 already-in-use')
  })

  await test('目录内其它文件高频变动不触发重挂', async () => {
    const project = makeProject('reload-noise', { mcpServers: { steady: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    h.events.length = 0
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(project, '.phpunit.result.cache'), `noise ${index}`)
      await sleep(10)
    }
    await sleep(800)
    assert.deepEqual(s.servers(), ['steady'])
    assert.equal(h.events.filter(([kind]) => kind === 'dispose').length, 0)
  })

  await test('首次挂载期间写入的改动不会丢（watcher 已先注册）', async () => {
    const project = makeProject('reload-early', { mcpServers: { initial: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const creating = h.createSession(project)
    await sleep(120) // 首次挂载仍在途（假客户端要 FAKE_DELAY_MS 才就绪）
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { changed_during_startup: { command: 'node' } } }, null, 2))
    const s = await creating
    await sleep(1600)
    assert.deepEqual(s.servers(), ['changed_during_startup'])
  })

  // ── 超时与健壮性 ─────────────────────────────────────────────────────────
  await test('正常回收不产生假「放弃等待」告警（回归：超时定时器未清理）', async () => {
    const project = makeProject('to-spurious', { mcpServers: { plain: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { extra: { command: 'node' }, plain: { command: 'node' } } }, null, 2))
    // 等过 DISPOSE_TIMEOUT_MS（回归里 400ms）+ 防抖：定时器若没被清理，这里会冒出假告警
    await sleep(1500)
    assert.deepEqual(s.servers(), ['extra', 'plain'])
    assert.doesNotMatch(text(h.events), /放弃等待/, 'dispose 秒回时不该出现超时告警')
  })

  await test('启动卡死不会堵死挂载链（启动超时后本轮不再等它）', async () => {
    const project = makeProject('to-stall', { mcpServers: { stallme: { command: 'node' }, fine: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const began = Date.now()
    const s = await h.createSession(project)
    const elapsed = Date.now() - began
    assert.match(text(h.events), /启动超过 \d+ms 仍未就绪/)
    assert.match(text(h.events), /1\/2 个 server 在跑/, '卡死的不计入就绪数')
    assert.ok(s.live.has('fine'), '正常的那个照常就绪')
    assert.ok(elapsed < 2000, `不该被卡死的 server 拖住，实测 ${elapsed}ms`)
  })

  await test('一次 dispose 挂起不会永久堵死重挂链（超时后放弃等待）', async () => {
    const project = makeProject('to-hang', { mcpServers: { hangme: { command: 'node' }, other: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.equal(s.servers().length, 2)
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2))
    await sleep(2600)
    assert.ok(!s.servers().includes('hangme'), '挂起的实例该被放弃等待')
    assert.ok(s.servers().includes('other'), '后续重挂必须继续')
    assert.match(text(h.events), /放弃等待/)
  })

  await test('回收超时的实例结算前不重挂（避免新旧同名实例并存）', async () => {
    const project = makeProject('to-stuck', { mcpServers: { hangme: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), ['hangme'], text(h.events))
    h.events.length = 0
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { hangme: { command: 'node' }, other: { command: 'node' } } }, null, 2))
    await sleep(2600)
    assert.ok(!s.servers().includes('hangme'), `stuck 期间不该重挂同名 server：${s.servers().join(',')}`)
    assert.ok(s.servers().includes('other'), '其它 server 照常挂载')
    assert.match(text(h.events), /尚未结算/)
  })

  await test('searchUp 且文件初始不存在时，之后建到祖先目录也能被发现', async () => {
    const parent = makeProject('to-late-ancestor')
    const deep = join(parent, 'nested', 'deep')
    mkdirSync(deep, { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, {})
    const s = await h.createSession(deep)
    assert.deepEqual(s.servers(), [])
    h.events.length = 0
    writeFileSync(join(parent, '.mcp.json'), JSON.stringify({ mcpServers: { late_ancestor: { command: 'node' } } }, null, 2))
    await sleep(1400)
    assert.deepEqual(s.servers(), ['late_ancestor'], '回归：祖先目录里新建的文件没有事件源')
  })

  await test('path 含子目录且文件初始不存在时，创建后能被发现', async () => {
    const project = makeProject('to-nested-path')
    mkdirSync(join(project, 'config'), { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, { path: 'config/mcp.json' })
    const s = await h.createSession(project)
    assert.deepEqual(s.servers(), [])
    h.events.length = 0
    writeFileSync(join(project, 'config', 'mcp.json'), JSON.stringify({ mcpServers: { created_later: { command: 'node' } } }, null, 2))
    await sleep(1400)
    assert.deepEqual(s.servers(), ['created_later'], '回归：曾把整个 config/mcp.json 当文件名，永远匹配不上')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nregress: ${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.error(`\n失败用例：\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
}
