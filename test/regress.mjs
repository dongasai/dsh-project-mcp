/**
 * @module @local/dsh-mcp-json/test/regress
 *
 * 回归测试：用 stub ctx + 一个「忠实模拟官方语义」的假 mcp-client 驱动本插件，
 * 覆盖配置归一化、错误路径、热重挂与并发重挂。
 *
 * 为什么用假客户端：本套用例要断言的是**插件的编排行为**（什么时候停、什么时候起、
 * 谁被跳过、多项目下谁被加了前缀），而真客户端会真的起子进程、握手、列工具，既慢又
 * 难制造「重挂交叠」。假客户端只保留两条关键语义：serverName 进程级独占 + 连接有耗时。
 *
 * 真链（真起 MCP 子进程、真握手）必须由活 Harness 验证：插件代码不在 HMR 的监视集里，
 * 改了要重启 Harness 才生效。test/fixtures/ 下的两个真 MCP 服务端可直接被 demo 项目的
 * `.mcp.json` 引用（见 /data/ai/dsh/project_mcp_demo*）。
 *
 * 运行：node test/regress.mjs      （或 npm test）
 * 只依赖 node: 内置模块，不写仓库内任何路径（临时目录建在 os.tmpdir()）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 回收/启动超时在插件里默认 10s / 30s；回归里压到 400ms，否则相关用例要跑几十秒。
// 必须在 import 插件之前设好 —— 这两个常量在模块加载时求值。
process.env.MCP_JSON_DISPOSE_TIMEOUT_MS = '400'
process.env.MCP_JSON_STARTUP_TIMEOUT_MS = '400'

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

/** 假客户端的「连接耗时」，用来把两次重挂撑到交叠。 */
const FAKE_DELAY_MS = 400

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcp-json-'))
const anchorDir = join(scratch, 'anchor')
const projectDir = join(scratch, 'project')
mkdirSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client'), { recursive: true })
mkdirSync(projectDir, { recursive: true })

writeFileSync(
  join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-mcp-client', version: '0.0.0', type: 'module', exports: { '.': './index.js' } }),
)
writeFileSync(
  join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'index.js'),
  `const DELAY = Number(process.env.FAKE_DELAY ?? ${FAKE_DELAY_MS})
const active = new Set()
export const name = 'mcp-client'
export async function apply(ctx, config) {
  if (active.has(config.serverName)) {
    throw new Error(\`mcp-client: serverName "\${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml\`)
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

const configFile = join(projectDir, '.mcp.json')
const writeConfig = (document) => writeFileSync(configFile, JSON.stringify(document, null, 2))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 造一个最小可用的 ctx。
 *
 * `plugin()` 返回的对象要像真 fiber：可 await（启动完成才 resolve）、可 dispose（幂等）、
 * 且在 `await` 之前就已登记，才能复现「在途实例」的场景。
 *
 * `live` 是**增量维护**的存活集合，不能从 events 反推：用例为了断言日志会清空 events，
 * 那样会连 mount 记录一起丢掉。
 *
 * 每个用例结束必须 `dispose()`：watcher 是 `ctx.effect` 注册的，不回收就会一直盯着同一个
 * 目录，后面的用例每写一次文件都会把前面所有 harness 一起触发。
 * @returns `{ ctx, events, configs, live, dispose }`
 */
function createHarness() {
  const events = []
  const configs = []
  const live = new Set()
  const effectDisposers = []
  const ctx = {
    logger: () => ({
      info: (...args) => events.push(['info', args.join(' ')]),
      warn: (...args) => events.push(['warn', args.join(' ')]),
      error: (...args) => events.push(['error', args.join(' ')]),
    }),
    plugin: (plugin, config) => {
      configs.push(config)
      live.add(config.serverName)
      const cleanups = []
      let startup
      try {
        startup = Promise.resolve(plugin.apply({ effect: (callback) => {
          const dispose = callback()
          cleanups.push(dispose)
          return () => dispose?.()
        } }, config))
      } catch (error) {
        startup = Promise.reject(error)
      }
      events.push(['mount', config.serverName, Date.now()])
      let disposed = false
      return {
        then: (onFulfilled, onRejected) => startup.then(onFulfilled, onRejected),
        dispose: async () => {
          if (disposed) return
          disposed = true
          // 先注销再跑 cleanup：真 fiber 的 dispose 一开始就释放 serverName，
          // 哪怕某个 cleanup 永不 resolve（这正是「dispose 挂起」用例要复现的）。
          live.delete(config.serverName)
          events.push(['dispose', config.serverName])
          // 并发跑所有 cleanup：真 Cordis 的 _unload() 就是 Promise.all 并发跑的。
          // 串行会在某个 cleanup 永不 resolve 时把排在它后面的也一起饿死 —— 假客户端里
          // 「释放 serverName」的 cleanup 排在「永不返回」的 cleanup 之后，就会让 serverName
          // 跨用例残留，后续用例直接撞 already in use。
          await Promise.all(cleanups.reverse().map((cleanup) => cleanup?.()))
        },
      }
    },
    effect: (callback) => {
      const dispose = callback()
      effectDisposers.push(dispose)
      return () => dispose?.()
    },
    baseUrl: pathToFileURL(`${anchorDir}/`).href,
  }
  const dispose = async () => {
    for (const disposer of effectDisposers.reverse()) await disposer?.()
  }
  const harness = { ctx, events, configs, live, dispose }
  activeHarnesses.push(harness)
  return harness
}

/** 当前存活的 serverName（排序后）。 */
function liveServers(harness) {
  return [...harness.live].sort()
}

const text = (events) => events.map(([level, message]) => `${level}: ${message}`).join('\n')

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
    writeConfig({
      servers: {
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN_X:-fallback}' } },
      },
    })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(liveServers(h), ['remote'])
    assert.equal(h.configs[0].transport, 'streamable-http')
    assert.equal(h.configs[0].url, 'https://example.com/mcp')
    assert.equal(h.configs[0].headers.Authorization, 'Bearer fallback')
  })

  await test('stdio 缺省 cwd 取 .mcp.json 所在目录，相对 cwd 按该目录解析', async () => {
    writeConfig({ mcpServers: { plain: { command: 'node' }, relative: { command: 'node', cwd: 'sub/dir' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    const plain = h.configs.find((config) => config.serverName === 'plain')
    const relative = h.configs.find((config) => config.serverName === 'relative')
    assert.equal(plain.cwd, projectDir)
    assert.equal(relative.cwd, join(projectDir, 'sub', 'dir'))
  })

  await test('${VAR} / ${VAR:-default} / 嵌套默认值 展开正确', async () => {
    process.env.MCPJSON_TEST_SET = '/from-env'
    writeConfig({
      mcpServers: {
        expansion: { command: 'node', args: ['${MCPJSON_TEST_SET}/a', '${MCPJSON_TEST_UNSET:-/fallback}/b', '${MCPJSON_TEST_UNSET:-${MCPJSON_TEST_SET}/nested}/c'] },
      },
    })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(h.configs[0].args, ['/from-env/a', '/fallback/b', '/from-env/nested/c'])
    delete process.env.MCPJSON_TEST_SET
  })

  await test('未定义且无默认值的变量展开为空串并告警', async () => {
    writeConfig({ mcpServers: { missing: { command: 'node', args: ['--x=${MCPJSON_TEST_ABSENT}'] } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(h.configs[0].args, ['--x='])
    assert.match(text(h.events), /环境变量 MCPJSON_TEST_ABSENT 未定义且无默认值/)
  })

  // ── 不支持 / 非法声明 ────────────────────────────────────────────────────
  await test('type: "sse" 被跳过并说明原因', async () => {
    writeConfig({ mcpServers: { legacy: { type: 'sse', url: 'https://example.com/sse' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(liveServers(h), [])
    assert.match(text(h.events), /transport "sse" 不受 dsh-mcp-client 支持/)
  })

  await test('同时声明 command 与 url 且无 type 时报错', async () => {
    writeConfig({ mcpServers: { confused: { command: 'node', url: 'https://x' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(liveServers(h), [])
    assert.match(text(h.events), /同时声明了 "command" 与 "url"/)
  })

  await test('非法 serverName 被规范化并告警', async () => {
    writeConfig({ mcpServers: { 'my.server.v2': { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(liveServers(h), ['my_server_v2'])
    assert.match(h.configs[0].serverName, /^[A-Za-z0-9_-]{1,32}$/)
    assert.match(text(h.events), /serverName "my\.server\.v2" 不合法/)
  })

  await test('规范化后重名只保留前一条，且不产生虚假 already-in-use', async () => {
    writeConfig({ mcpServers: { 'dup.one': { command: 'node' }, dup_one: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false })
    assert.deepEqual(liveServers(h), ['dup_one'])
    assert.match(text(h.events), /规范化后重名/)
    assert.doesNotMatch(text(h.events), /already in use/)
  })

  await test('disabledServers 跳过指定条目', async () => {
    writeConfig({ mcpServers: { keep: { command: 'node' }, drop: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir, watch: false, disabledServers: ['drop'] })
    assert.deepEqual(liveServers(h), ['keep'])
    assert.match(text(h.events), /已按 disabledServers 跳过 drop/)
  })

  // ── 错误路径 ─────────────────────────────────────────────────────────────
  await test('坏 JSON 保留当前实例不动', async () => {
    writeConfig({ mcpServers: { stable: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    h.events.length = 0
    writeFileSync(configFile, '{ broken')
    await sleep(900)
    assert.deepEqual(liveServers(h), ['stable'])
    assert.match(text(h.events), /保留当前已挂载的实例/)
  })

  await test('缺声明表保留当前实例不动', async () => {
    writeConfig({ mcpServers: { stable: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    writeConfig({ somethingElse: {} })
    await sleep(900)
    assert.deepEqual(liveServers(h), ['stable'])
    assert.match(text(h.events), /没有 "mcpServers" 声明表/)
  })

  await test('.mcp.json 被删除则停掉全部实例', async () => {
    writeConfig({ mcpServers: { gone: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    rmSync(configFile)
    await sleep(900)
    assert.deepEqual(liveServers(h), [])
    assert.match(text(h.events), /未找到 \.mcp\.json/)
  })

  await test('目录里没有 .mcp.json 时不报错也不挂载', async () => {
    const empty = join(scratch, 'empty')
    mkdirSync(empty, { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: empty })
    assert.deepEqual(liveServers(h), [])
  })

  await test('非法 config 显式失败', async () => {
    const h = createHarness()
    await assert.rejects(() => mod.apply(h.ctx, { projectDir, watch: 'yes' }), /config\.watch must be a boolean/)
    await assert.rejects(() => mod.apply(h.ctx, { projectDir, disabledServers: [1] }), /disabledServers must be an array of strings/)
    await assert.rejects(() => mod.apply(h.ctx, { projectDir, toolCallTimeoutMs: 0 }), /toolCallTimeoutMs must be a positive number/)
  })

  // ── 多项目与命名空间 ─────────────────────────────────────────────────────
  /** 造一个带 `.mcp.json` 的独立项目目录。 */
  const makeProject = (name, document) => {
    const directory = join(scratch, name)
    mkdirSync(directory, { recursive: true })
    if (document !== undefined) writeFileSync(join(directory, '.mcp.json'), JSON.stringify(document, null, 2))
    return directory
  }
  const echoOnly = { mcpServers: { echo: { command: 'node' } } }

  await test('多项目：同名 server 靠目录名前缀区分且同时存活', async () => {
    const a = makeProject('multi-a', echoOnly)
    const b = makeProject('multi-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], watch: false })
    assert.deepEqual(liveServers(h), ['multi-a_echo', 'multi-b_echo'])
    assert.doesNotMatch(text(h.events), /already in use/, '加前缀正是为了避免虚假 already-in-use')
  })

  await test('单项目不加前缀（工具名与单项目时代一致）', async () => {
    const solo = makeProject('solo', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: solo, watch: false })
    assert.deepEqual(liveServers(h), ['echo'])
  })

  await test('namespace: "always" 时单项目也加前缀', async () => {
    const solo = makeProject('always-solo', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: solo, namespace: 'always', watch: false })
    assert.deepEqual(liveServers(h), ['always-solo_echo'])
  })

  await test('namespace: "never" 时跨项目重名只保留第一个并告警', async () => {
    const a = makeProject('never-a', echoOnly)
    const b = makeProject('never-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], namespace: 'never', watch: false })
    assert.deepEqual(liveServers(h), ['echo'])
    assert.match(text(h.events), /跨项目重名/)
    assert.doesNotMatch(text(h.events), /already in use/)
  })

  await test('显式 prefix 覆盖目录名', async () => {
    const a = makeProject('prefixed', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a, prefix: 'my.ns' }], namespace: 'always', watch: false })
    assert.deepEqual(liveServers(h), ['my_ns_echo'], '前缀也要洗成 serverName 合法字符集')
  })

  await test('serverName 触顶 32 字符时截名字、保前缀', async () => {
    const longName = 'n'.repeat(20)
    const prefix = 'p'.repeat(24)
    const a = makeProject('toolong', { mcpServers: { [longName]: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a, prefix }], namespace: 'always', watch: false })
    const [name] = liveServers(h)
    assert.equal(name.length, 32, `必须正好顶到上限：${name}`)
    assert.ok(name.startsWith(`${prefix}_`), `前缀必须完整保留（它是唯一的消歧手段）：${name}`)
    assert.ok(name.endsWith('n'.repeat(7)), `名字截到剩下的空间：${name}`)
    assert.match(text(h.events), /已截为/)
    assert.match(name, /^[A-Za-z0-9_-]{1,32}$/)
  })

  await test('长 server 名跨项目撞名时前缀仍能消歧（回归：曾整段丢弃前缀）', async () => {
    const longName = 'n'.repeat(31)
    const a = makeProject('long-a', { mcpServers: { [longName]: { command: 'node' } } })
    const b = makeProject('long-b', { mcpServers: { [longName]: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, {
      projects: [{ dir: a, prefix: 'aaa' }, { dir: b, prefix: 'bbb' }],
      namespace: 'always',
      watch: false,
    })
    const names = liveServers(h)
    assert.equal(names.length, 2, `两个项目的同名 server 都必须挂上：${names.join(',')}`)
    assert.ok(names.some((name) => name.startsWith('aaa_')), names.join(','))
    assert.ok(names.some((name) => name.startsWith('bbb_')), names.join(','))
    assert.doesNotMatch(text(h.events), /跨项目重名/, '前缀生效后就不该再有跨项目重名')
  })

  await test('多项目：两个目录同名时前缀相撞，只保留第一个并告警', async () => {
    const a = makeProject('same-name/foo', echoOnly)
    const b = makeProject('other-name/foo', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], watch: false })
    assert.deepEqual(liveServers(h), ['foo_echo'], 'basename 相同则自动前缀相同，第二条只能被跳过')
    assert.match(text(h.events), /跨项目重名/)
    assert.doesNotMatch(text(h.events), /already in use/, '必须在挂载前就拦掉，而不是撞给客户端')
  })

  await test('scanRoot 递归发现子项目，且不进 node_modules 与隐藏目录', async () => {
    const root = join(scratch, 'scan-root')
    const one = makeProject('scan-root/one', echoOnly)
    const nested = makeProject('scan-root/two/nested', echoOnly)
    makeProject('scan-root/node_modules/skipme', echoOnly)
    makeProject('scan-root/.hidden/skipme', echoOnly)
    assert.ok(one && nested)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ scanRoot: root, depth: 2 }], watch: false })
    assert.deepEqual(liveServers(h), ['nested_echo', 'one_echo'])
  })

  await test('多项目：一个项目文件坏掉不影响其余项目', async () => {
    const good = makeProject('partial-good', echoOnly)
    const bad = makeProject('partial-bad')
    writeFileSync(join(bad, '.mcp.json'), '{ broken')
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: good }, { dir: bad }], watch: false })
    assert.deepEqual(liveServers(h), ['partial-good_echo'], '坏项目只该拖累自己')
    assert.match(text(h.events), /partial-bad.*失败/)
  })

  await test('多项目：全部项目文件都坏掉时保留当前实例不动', async () => {
    const a = makeProject('allbad-a', echoOnly)
    const b = makeProject('allbad-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }] })
    assert.deepEqual(liveServers(h), ['allbad-a_echo', 'allbad-b_echo'])
    h.events.length = 0
    writeFileSync(join(a, '.mcp.json'), '{ broken')
    writeFileSync(join(b, '.mcp.json'), '{ broken')
    await sleep(900)
    assert.deepEqual(liveServers(h), ['allbad-a_echo', 'allbad-b_echo'])
    assert.match(text(h.events), /全部解析失败；保留当前已挂载的实例/)
  })

  await test('多项目：热重挂会收敛到各项目的最新内容', async () => {
    const a = makeProject('reload-a', echoOnly)
    const b = makeProject('reload-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }] })
    assert.deepEqual(liveServers(h), ['reload-a_echo', 'reload-b_echo'])
    h.events.length = 0
    // 只动 A：删掉它的 server，B 保持原样
    writeFileSync(join(a, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2))
    await sleep(1200)
    assert.deepEqual(liveServers(h), ['reload-b_echo'], 'A 清空后 B 必须还在')
  })

  await test('多项目：只监视配置点名的目录，改 A 不影响 B 的实例', async () => {
    const a = makeProject('watch-a', echoOnly)
    const b = makeProject('watch-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }] })
    h.events.length = 0
    // B 目录里的无关文件高频变动不该触发重挂
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(b, '.phpunit.result.cache'), `noise ${index}`)
      await sleep(10)
    }
    await sleep(700)
    assert.deepEqual(liveServers(h), ['watch-a_echo', 'watch-b_echo'])
    assert.equal(h.events.filter(([kind]) => kind === 'dispose').length, 0)
  })

  await test('多项目：项目文件被删 + 其余全坏时，被删项目的实例必须回收（回归：永久幽灵）', async () => {
    const a = makeProject('ghost-a', echoOnly)
    const b = makeProject('ghost-b', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }] })
    assert.deepEqual(liveServers(h), ['ghost-a_echo', 'ghost-b_echo'])
    h.events.length = 0
    // A 的声明被删（来源消失，该停）；B 的写坏了（来源还在，该保）
    rmSync(join(a, '.mcp.json'))
    writeFileSync(join(b, '.mcp.json'), '{ broken')
    await sleep(1500)
    assert.deepEqual(liveServers(h), ['ghost-b_echo'], 'A 的来源已消失，不该被「保留旧实例」一起保下来')
    assert.match(text(h.events), /已回收/)
  })

  await test('scanRoot 一个项目都没扫到时不回退 cwd（回归：曾静默挂上 cwd 的 MCP）', async () => {
    const cwdProject = makeProject('cwd-project', { mcpServers: { cwd_leak: { command: 'node' } } })
    const emptyRoot = join(scratch, 'empty-scan-root')
    mkdirSync(emptyRoot, { recursive: true })
    const originalCwd = process.cwd()
    process.chdir(cwdProject)
    try {
      const h = createHarness()
      await mod.apply(h.ctx, { projects: [{ scanRoot: emptyRoot, depth: 1 }], watch: false })
      assert.deepEqual(liveServers(h), [], '扫不到就该什么都不挂，而不是去挂进程 cwd 里的项目')
      assert.match(text(h.events), /未找到 \.mcp\.json/)
    } finally {
      process.chdir(originalCwd)
    }
  })

  await test('多项目：server 并发启动（空窗是 max 握手耗时，不是 Σ）', async () => {
    const a = makeProject('par-a', { mcpServers: { s1: { command: 'node' }, s2: { command: 'node' } } })
    const b = makeProject('par-b', { mcpServers: { s3: { command: 'node' }, s4: { command: 'node' } } })
    const h = createHarness()
    const began = Date.now()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], watch: false })
    const elapsed = Date.now() - began
    assert.equal(liveServers(h).length, 4)
    assert.ok(elapsed < FAKE_DELAY_MS * 2, `4 个 server 应并发启动（串行需 ${FAKE_DELAY_MS * 4}ms），实测 ${elapsed}ms`)
  })

  await test('scanRoot 命中数变化不改名（回归：曾按命中数决定前缀）', async () => {
    const root = join(scratch, 'sticky-root')
    const one = makeProject('sticky-root/one', echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ scanRoot: root, depth: 1 }] })
    assert.deepEqual(liveServers(h), ['one_echo'], 'scanRoot 天然意味着多项目，一开始就该带前缀')
    h.events.length = 0
    makeProject('sticky-root/two', echoOnly)
    writeFileSync(join(one, '.mcp.json'), JSON.stringify(echoOnly, null, 2))
    await sleep(1500)
    assert.deepEqual(liveServers(h), ['one_echo', 'two_echo'], '新项目进来不该把 one 的工具名改掉')
  })

  await test('一次 dispose 挂起不会永久堵死重挂链（超时后放弃等待）', async () => {
    writeConfig({ mcpServers: { hangme: { command: 'node' }, other: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    assert.equal(liveServers(h).length, 2)
    h.events.length = 0
    writeConfig({ mcpServers: { other: { command: 'node' } } })
    await sleep(2500)
    assert.deepEqual(liveServers(h), ['other'], '挂起的实例该被放弃等待，后续重挂必须继续')
    assert.match(text(h.events), /放弃等待/)
  })

  await test('首次重挂期间写入的改动不会丢（watcher 已先注册）', async () => {
    writeConfig({ mcpServers: { initial: { command: 'node' } } })
    const h = createHarness()
    const applying = mod.apply(h.ctx, { projectDir })
    await sleep(120) // 首次 reload 仍在途（假客户端要 FAKE_DELAY_MS 才就绪）
    writeConfig({ mcpServers: { changed_during_startup: { command: 'node' } } })
    await applying
    await sleep(1500)
    assert.deepEqual(liveServers(h), ['changed_during_startup'], '回归：启动期间的改动曾被静默吞掉')
  })

  await test('path 含子目录且文件初始不存在时，创建后能被发现', async () => {
    const project = makeProject('nested-path')
    mkdirSync(join(project, 'config'), { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: project, path: 'config/mcp.json' })
    assert.deepEqual(liveServers(h), [])
    h.events.length = 0
    writeFileSync(
      join(project, 'config', 'mcp.json'),
      JSON.stringify({ mcpServers: { created_later: { command: 'node' } } }, null, 2),
    )
    await sleep(1500)
    assert.deepEqual(liveServers(h), ['created_later'], '回归：曾把整个 config/mcp.json 当文件名，永远匹配不上')
  })

  await test('绝对 path + 多项目源时告警说明只服务第一个', async () => {
    const a = makeProject('abs-a', echoOnly)
    const b = makeProject('abs-b', { mcpServers: { absb: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], path: join(a, '.mcp.json'), watch: false })
    assert.deepEqual(liveServers(h), ['abs-a_echo'])
    assert.match(text(h.events), /绝对路径/)
  })

  await test('正常回收不产生假「放弃等待」告警（回归：超时定时器未清理）', async () => {
    writeConfig({ mcpServers: { plain: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    h.events.length = 0
    writeConfig({ mcpServers: { extra: { command: 'node' }, plain: { command: 'node' } } })
    // 等过 DISPOSE_TIMEOUT_MS（回归里 400ms）+ 防抖：定时器若没被清理，这里会冒出假告警
    await sleep(1400)
    assert.deepEqual(liveServers(h), ['extra', 'plain'])
    assert.doesNotMatch(text(h.events), /放弃等待/, 'dispose 秒回时不该出现超时告警')
  })

  await test('启动卡死不会堵死重挂链（启动超时后本轮不再等它）', async () => {
    writeConfig({ mcpServers: { stallme: { command: 'node' }, fine: { command: 'node' } } })
    const h = createHarness()
    const began = Date.now()
    await mod.apply(h.ctx, { projectDir })
    const elapsed = Date.now() - began
    assert.match(text(h.events), /启动超过 \d+ms 仍未就绪/, text(h.events))
    assert.match(text(h.events), /1\/2 个 server 在跑/, '卡死的不计入就绪数')
    // harness 的 live 记的是「已注册 fiber」，卡死的实例仍留在登记簿里（后续重挂会收敛）
    assert.ok(liveServers(h).includes('stallme'))
    assert.ok(liveServers(h).includes('fine'))
    assert.ok(elapsed < 2000, `不该被卡死的 server 拖住，实测 ${elapsed}ms`)
  })

  await test('回收超时的实例结算前不重挂（避免新旧同名实例并存）', async () => {
    writeConfig({ mcpServers: { hangme: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    assert.deepEqual(liveServers(h), ['hangme'], text(h.events))
    h.events.length = 0
    writeConfig({ mcpServers: { hangme: { command: 'node' }, other: { command: 'node' } } })
    await sleep(2200)
    assert.ok(!liveServers(h).includes('hangme'), `stuck 期间不该重挂同名 server：${liveServers(h).join(',')}`)
    assert.ok(liveServers(h).includes('other'), '其它 server 照常挂载')
    assert.match(text(h.events), /尚未结算/)
  })

  await test('searchUp 且文件初始不存在时，之后建到祖先目录也能被发现', async () => {
    const parent = join(scratch, 'late-ancestor')
    const deep = join(parent, 'nested', 'deep')
    mkdirSync(deep, { recursive: true })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: deep, searchUp: true })
    assert.deepEqual(liveServers(h), [])
    h.events.length = 0
    writeFileSync(join(parent, '.mcp.json'), JSON.stringify({ mcpServers: { late_ancestor: { command: 'node' } } }, null, 2))
    await sleep(1500)
    assert.deepEqual(liveServers(h), ['late_ancestor'], '回归：祖先目录里新建的文件没有事件源')
  })

  await test('目录名超 24 字符被截断时单独告警（否则重名告警看不出真因）', async () => {
    const stem = 'p'.repeat(24)
    const a = makeProject(`${stem}-alpha`, echoOnly)
    const b = makeProject(`${stem}-beta`, echoOnly)
    const h = createHarness()
    await mod.apply(h.ctx, { projects: [{ dir: a }, { dir: b }], watch: false })
    assert.match(text(h.events), /超过 24 字符，已截为/, '截断本身要能被看见')
    assert.match(text(h.events), /跨项目重名/, '截断后撞名仍要被拦下')
  })

  await test('projects / namespace 非法配置显式失败', async () => {
    const h = createHarness()
    await assert.rejects(() => mod.apply(h.ctx, { projects: 'nope' }), /config\.projects must be an array/)
    await assert.rejects(() => mod.apply(h.ctx, { projects: [{}] }), /needs "dir" or "scanRoot"/)
    await assert.rejects(() => mod.apply(h.ctx, { projects: [{ dir: '/x', scanRoot: '/y' }] }), /must not set both/)
    await assert.rejects(() => mod.apply(h.ctx, { projects: [{ dir: '/x', depth: -1 }] }), /depth must be a non-negative integer/)
    await assert.rejects(() => mod.apply(h.ctx, { projects: [{ dir: '/x', prefix: 7 }] }), /prefix must be a string/)
    await assert.rejects(() => mod.apply(h.ctx, { namespace: 'sometimes' }), /config\.namespace must be one of/)
  })

  // ── 热重挂 ───────────────────────────────────────────────────────────────
  await test('searchUp 命中父目录时，监视的是父目录里那份文件', async () => {
    const parent = join(scratch, 'searchup')
    const deep = join(parent, 'nested', 'deep')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(parent, '.mcp.json'), JSON.stringify(echoOnly, null, 2))
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir: deep, searchUp: true })
    assert.deepEqual(liveServers(h), ['echo'])
    h.events.length = 0
    writeFileSync(join(parent, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: 'node' }, added: { command: 'node' } } }, null, 2))
    await sleep(1200)
    assert.deepEqual(liveServers(h), ['added', 'echo'], '改父目录那份文件必须触发重挂（回归：曾盯错成项目目录）')
  })

  await test('单次重挂先停旧、再起新', async () => {
    writeConfig({ mcpServers: { first: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    h.events.length = 0
    writeConfig({ mcpServers: { second: { command: 'node' } } })
    await sleep(1200)
    assert.deepEqual(liveServers(h), ['second'])
    const order = h.events.filter(([kind]) => kind === 'mount' || kind === 'dispose').map(([kind, name]) => `${kind}:${name}`)
    assert.ok(order.indexOf('dispose:first') < order.indexOf('mount:second'), `停旧应早于起新：${order.join(' → ')}`)
  })

  await test('并发重挂收敛到文件内容（回归：在途实例漏 dispose）', async () => {
    writeConfig({ mcpServers: { dbhub: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    assert.deepEqual(liveServers(h), ['dbhub'])
    h.events.length = 0
    writeConfig({ mcpServers: { dbhub: { command: 'node' }, extra: { command: 'node' } } })
    await sleep(300) // 第一次重挂仍在途（假客户端要 FAKE_DELAY_MS 才就绪）
    writeConfig({ mcpServers: { dbhub: { command: 'node' } } })
    await sleep(2500)
    assert.deepEqual(liveServers(h), ['dbhub'], '终态必须等于文件内容')
    assert.doesNotMatch(text(h.events), /already in use/, '不应出现虚假 already-in-use')
  })

  await test('目录内其它文件高频变动不触发重挂', async () => {
    writeConfig({ mcpServers: { steady: { command: 'node' } } })
    const h = createHarness()
    await mod.apply(h.ctx, { projectDir })
    h.events.length = 0
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(projectDir, '.phpunit.result.cache'), `noise ${index}`)
      await sleep(10)
    }
    await sleep(700)
    assert.deepEqual(liveServers(h), ['steady'])
    assert.equal(h.events.filter(([kind]) => kind === 'dispose').length, 0)
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nregress: ${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.error(`\n失败用例：\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
}
