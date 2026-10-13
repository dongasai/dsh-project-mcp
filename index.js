/**
 * @module @dongasai/dsh-project-mcp
 *
 * **项目级** MCP 启动器：读取**当前会话所在项目**根目录的 `.mcp.json`
 * （Claude Code / Qoder / VS Code 等通用的 MCP server 声明格式），把其中每个 server
 * 挂载成一份官方 `@deepseek-ai/dsh-mcp-client` 实例，于是「项目自己声明的 MCP」就变成
 * 该会话里可直接调用的 `mcp__<serverName>__<tool>` 工具。
 *
 * ## 隔离语义（这是本插件的核心，别改回去）
 *
 * MCP 实例挂在**会话作用域**（`agent.ctx`）下，不是 profile 根作用域。
 * `Agent.ctx` 的契约是 "contributions are agent-local, unwind on disposal, and reject
 * registration afterward"。因此：
 * - A 项目的会话**看不到** B 项目的任何 `mcp__*` 工具，也收不到 B 项目的 server instructions；
 * - 不同会话可以各挂一份**同名** server（`dsh-mcp-client` 的 serverName 独占按注册作用域算：
 *   `scopeOf(ctx) ?? ctx.root`），所以工具名保持 `mcp__dbhub__execute_sql` 这种无前缀形态，
 *   与 Claude Code / Codex 一致 —— **不需要**也不该再引入命名空间前缀；
 * - 会话销毁时作用域自动回退，实例、watcher、工具注册一并回收，profile 层不留全局登记。
 *
 * 项目由**会话工作目录**（`agent.session.header.cwd`）决定，从该目录向上找 `.mcp.json`
 * （`searchUp`，默认开）—— 会话开在 `Modules/Orders` 这类子目录时也能找到项目根的声明。
 * 一个会话一份实例是隔离的必然代价：N 个会话同时开着就是 N 份 MCP 子进程，官方设计如此
 * （"独立 agent 作用域可以复用相同 namespace，因为其工具与传输彼此隔离"）。
 *
 * ## 四条实现约束（改代码时别踩）
 *
 * 1. 本模块只 import `node:` 内置模块。插件包以 `link:` 方式装进 profile，模块真实路径
 *    在插件仓库内，`@deepseek-ai/*` 这类裸包名从这里解析不到；被复用的官方客户端改为按
 *    锚点动态解析（见 resolveAnchors / loadMcpClient）。
 * 2. 不导出 `Config` schema（那需要 import schemastery，违反约束 1），改为在 `apply` 内
 *    手工校验，报错信息直接指到 `.mcp.json` 的具体条目。
 * 3. 同一会话内的重挂必须串行，且「在途」实例也要能被停掉：`dsh-mcp-client` 的 serverName
 *    在**同一作用域内**独占，两次重挂交叠会漏 dispose（孤儿 fiber + 泄漏子进程 + 工具仍可见）。
 *    见 createSessionMount 里的 reloadChain 与 fibers 登记。
 * 4. 挂载发生在 `agent/created`（serial 事件）里，会**阻塞会话创建**直到 MCP 就绪或超时。
 *    这是刻意的：官方保证 agentCtx 里的注册在第一次 prompt 组装之前完成，若改成后台挂载，
 *    会话开头几步会看不到工具。代价是会话创建要多等一次握手（1~3 秒），所以必须有超时兜底
 *    （STARTUP_TIMEOUT_MS），否则一个卡死的 server 会把会话创建永久挂住。
 */

import { existsSync, readFileSync, watch } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 被复用的官方 MCP 客户端插件包名。 */
const MCP_CLIENT_SPECIFIER = '@deepseek-ai/dsh-mcp-client'

/** `.mcp.json` 字符串里的 `${VAR}` / `${VAR:-default}` 占位符。
 * 默认值里不允许再出现花括号，好让 `${A:-${B}/x}` 先解析内层、再解析外层。 */
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g

/** 嵌套占位符的最大展开轮数。 */
const MAX_EXPAND_PASSES = 4

/** 声明表的候选键，按优先级排列（Claude Code 用前者，VS Code 风格用后者）。 */
const SERVER_TABLE_KEYS = ['mcpServers', 'servers']

/** `searchUp` 向上查找 `.mcp.json` 的最大层数。 */
const MAX_SEARCH_UP_LEVELS = 8

/** 文件变更后的重挂防抖窗口（毫秒）。 */
const RELOAD_DEBOUNCE_MS = 250

/** serverName 的长度上限，与 dsh-mcp-client 的校验一致。 */
const SERVER_NAME_MAX_LENGTH = 32

/**
 * 解析一个正的超时毫秒数；非法值（NaN、0、负数、空串）一律回落到默认值。
 *
 * 不能直接 `Number(env)`：`10s`、留空、`-1` 都会得到 NaN/0/负数，而 `setTimeout` 把它们
 * 当成 1ms —— 安全网反而变成「每次都立刻超时」。
 * @param raw - 环境变量原文。
 * @param fallback - 默认值。
 * @returns 可用的超时毫秒数。
 */
function positiveTimeout(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 单个 server 启动（握手）的等待上限（毫秒）。超时就本轮不等它，免得一个卡死的 server
 * 把会话创建或重挂链拖住（真链实测会静默停摆到 SDK 自己的 120 秒超时）。 */
const STARTUP_TIMEOUT_MS = positiveTimeout(process.env.MCP_JSON_STARTUP_TIMEOUT_MS, 15000)

/** 单个实例回收的等待上限（毫秒）。超时后放弃等待，免得一次挂起堵死整条重挂链。
 * 环境变量是给回归测试用的逃生口，生产别改。 */
const DISPOSE_TIMEOUT_MS = positiveTimeout(process.env.MCP_JSON_DISPOSE_TIMEOUT_MS, 10000)

/** 插件行配置的默认值。 */
const DEFAULTS = {
  path: '.mcp.json',
  projectDir: '',
  searchUp: true,
  disabledServers: [],
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  watch: true,
}

/** Cordis 诊断用的插件名。 */
export const name = 'mcp-json'

/** 是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取错误文本，兼容非 Error 抛出物。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 校验并补全插件行配置。
 * @param raw - 插件行的 `config`。
 * @returns 归一化后的配置对象。
 * @throws 配置类型不合法时抛出（属于装错，应当显式失败而不是静默降级）。
 */
function normalizeOptions(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (!isPlainObject(source)) throw new Error('mcp-json: config must be an object')
  const options = { ...DEFAULTS, disabledServers: [] }

  if (source.path !== undefined) {
    if (typeof source.path !== 'string' || source.path.trim() === '') throw new Error('mcp-json: config.path must be a non-empty string')
    options.path = source.path.trim()
  }
  if (source.projectDir !== undefined) {
    if (typeof source.projectDir !== 'string') throw new Error('mcp-json: config.projectDir must be a string')
    options.projectDir = source.projectDir.trim()
  }
  for (const flag of ['searchUp', 'failOnStartupError', 'watch']) {
    if (source[flag] === undefined) continue
    if (typeof source[flag] !== 'boolean') throw new Error(`mcp-json: config.${flag} must be a boolean`)
    options[flag] = source[flag]
  }
  if (source.toolCallTimeoutMs !== undefined) {
    if (typeof source.toolCallTimeoutMs !== 'number' || !Number.isFinite(source.toolCallTimeoutMs) || source.toolCallTimeoutMs <= 0) {
      throw new Error('mcp-json: config.toolCallTimeoutMs must be a positive number')
    }
    options.toolCallTimeoutMs = source.toolCallTimeoutMs
  }
  if (source.disabledServers !== undefined) {
    if (!Array.isArray(source.disabledServers) || source.disabledServers.some((item) => typeof item !== 'string')) {
      throw new Error('mcp-json: config.disabledServers must be an array of strings')
    }
    options.disabledServers = [...source.disabledServers]
  }
  return options
}

/**
 * 展开字符串里的 `${VAR}` / `${VAR:-default}`，支持一层嵌套默认值。
 * @param value - 原始字符串。
 * @param notes - 诊断信息收集器。
 * @returns 展开后的字符串；未定义且无默认值的占位符替换为空串。
 */
function expandEnv(value, notes) {
  let result = value
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass += 1) {
    if (!result.includes('${')) break
    const next = result.replace(ENV_VAR_PATTERN, (match, variable, fallback) => {
      const fromEnvironment = process.env[variable]
      if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
      if (fallback !== undefined) return fallback
      notes.push(`环境变量 ${variable} 未定义且无默认值，已展开为空串`)
      return ''
    })
    if (next === result) break
    result = next
  }
  if (result.includes('${')) {
    notes.push(`占位符未能解析，已按原样保留：${/\$\{[^}]*\}?/.exec(result)?.[0] ?? result}`)
  }
  return result
}

/**
 * 展开一个字符串数组。
 * @param value - 原始值；`undefined`/`null` 视作空数组。
 * @param label - 报错时用的字段名。
 * @param notes - 诊断信息收集器。
 * @returns 展开后的字符串数组。
 */
function expandStringList(value, label, notes) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item) => {
    if (typeof item === 'string') return expandEnv(item, notes)
    if (typeof item === 'number' || typeof item === 'boolean') return String(item)
    throw new Error(`${label} entries must be strings`)
  })
}

/**
 * 展开一个字符串字典（`env` / `headers`）。
 * @param value - 原始值；`undefined`/`null` 视作空字典。
 * @param label - 报错时用的字段名。
 * @param notes - 诊断信息收集器。
 * @returns 展开后的字符串字典。
 */
function expandStringMap(value, label, notes) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`)
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = expandEnv(item, notes)
    else if (typeof item === 'number' || typeof item === 'boolean') result[key] = String(item)
    else throw new Error(`${label}.${key} must be a string`)
  }
  return result
}

/**
 * 把 `.mcp.json` 的键转成合法的 serverName。
 * @param rawName - 声明表里的原始键。
 * @returns 符合 `[A-Za-z0-9_-]{1,32}` 的命名空间。
 */
function sanitizeServerName(rawName) {
  const cleaned = rawName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, SERVER_NAME_MAX_LENGTH)
  return cleaned === '' ? 'server' : cleaned
}

/**
 * 在指定基准目录里定位 `.mcp.json`。
 *
 * 基准是**会话工作目录**：会话开在项目子目录（比如 `Modules/Orders`）时，靠 `searchUp`
 * 向上找到项目根的声明 —— 这正是 Claude Code 的行为。
 * @param base - 会话工作目录（绝对路径）。
 * @param options - 归一化配置。
 * @returns 命中文件的绝对路径；未命中返回 `undefined`。
 */
function locateConfigFileIn(base, options) {
  if (isAbsolute(options.path)) return existsSync(options.path) ? options.path : undefined
  const direct = resolve(base, options.path)
  if (existsSync(direct)) return direct
  if (!options.searchUp) return undefined
  let directory = base
  for (let level = 0; level < MAX_SEARCH_UP_LEVELS; level += 1) {
    const candidate = join(directory, options.path)
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * 把一个 `.mcp.json` 条目翻译成 dsh-mcp-client 的 config。
 * @param rawName - 声明表里的键，用作 serverName。
 * @param raw - 该 server 的声明。
 * @param projectDirectory - `.mcp.json` 所在目录，stdio 的默认 cwd。
 * @param options - 归一化配置。
 * @returns `{ config }` 或 `{ error }`；两者都带 `warnings`。
 */
function normalizeServer(rawName, raw, projectDirectory, options) {
  const warnings = []
  if (!isPlainObject(raw)) return { error: 'entry must be an object', warnings }
  const serverName = sanitizeServerName(rawName)
  if (serverName !== rawName) warnings.push(`serverName "${rawName}" 不合法，改用 "${serverName}"`)
  const notes = []
  const finish = (outcome) => {
    for (const note of notes) warnings.push(note)
    return { ...outcome, warnings }
  }
  try {
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
    if (type !== '' && !['stdio', 'http', 'streamable-http', 'sse'].includes(type)) {
      return finish({ error: `unsupported "type": ${JSON.stringify(raw.type)}` })
    }
    if (type === 'sse') return finish({ error: 'transport "sse" 不受 dsh-mcp-client 支持（改用 "http" 或 "stdio"）' })

    const command = typeof raw.command === 'string' ? expandEnv(raw.command, notes) : ''
    const url = typeof raw.url === 'string' ? expandEnv(raw.url, notes) : ''
    const wantsHttp = type === 'http' || type === 'streamable-http'
    const wantsStdio = type === 'stdio'

    if (command !== '' && url !== '' && type === '') {
      return finish({ error: '同时声明了 "command" 与 "url"，请用 "type" 指明走哪条传输' })
    }
    const shared = {
      serverName,
      toolCallTimeoutMs: options.toolCallTimeoutMs,
      failOnStartupError: options.failOnStartupError,
    }

    if ((wantsStdio || (!wantsHttp && command !== '')) && command !== '') {
      const rawCwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
      const cwd = rawCwd === '' ? projectDirectory : resolve(projectDirectory, expandEnv(rawCwd, notes))
      return finish({
        config: {
          transport: 'stdio',
          ...shared,
          command,
          args: expandStringList(raw.args, 'args', notes),
          env: expandStringMap(raw.env, 'env', notes),
          cwd,
        },
      })
    }

    if ((wantsHttp || type === '') && url !== '') {
      return finish({
        config: {
          transport: 'streamable-http',
          ...shared,
          url,
          headers: expandStringMap(raw.headers, 'headers', notes),
        },
      })
    }

    if (wantsStdio) return finish({ error: '"type": "stdio" 需要 "command"' })
    if (wantsHttp) return finish({ error: `"type": "${type}" 需要 "url"` })
    return finish({ error: '既没有 "command"（stdio）也没有 "url"（http）' })
  } catch (error) {
    return finish({ error: messageOf(error) })
  }
}

/**
 * 读取并归一化一个 `.mcp.json`。
 *
 * 规范化后重名的 server 只保留第一个：`a.b` 与 `a_b` 都会变成 `a_b`，而同一作用域内
 * serverName 独占，两条同名 spec 必然有一条起不来。
 * @param file - 配置文件绝对路径。
 * @param options - 归一化配置。
 * @returns `{ servers, skipped, warnings }`，`servers[]` 可直接喂给 dsh-mcp-client。
 * @throws 文件读不了、JSON 坏了、或没有声明表时抛出（调用方决定是否保留旧实例）。
 */
function readServerSpecs(file, options) {
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`mcp-json: 读取 ${file} 失败：${messageOf(error)}`)
  }
  if (!isPlainObject(document)) throw new Error(`mcp-json: ${file} 顶层必须是 JSON 对象`)

  let tableKey
  for (const key of SERVER_TABLE_KEYS) {
    if (document[key] === undefined) continue
    if (!isPlainObject(document[key])) throw new Error(`mcp-json: ${file} 的 "${key}" 必须是对象`)
    tableKey = key
    break
  }
  if (tableKey === undefined) throw new Error(`mcp-json: ${file} 没有 "${SERVER_TABLE_KEYS[0]}" 声明表`)

  const servers = []
  const skipped = []
  const warnings = []
  const claimed = new Set()
  for (const [rawName, raw] of Object.entries(document[tableKey])) {
    if (options.disabledServers.includes(rawName)) {
      warnings.push(`已按 disabledServers 跳过 ${rawName}`)
      continue
    }
    const outcome = normalizeServer(rawName, raw, dirname(file), options)
    for (const warning of outcome.warnings) warnings.push(`${tableKey}.${rawName}: ${warning}`)
    if (outcome.error !== undefined) {
      skipped.push(`${tableKey}.${rawName}: ${outcome.error}`)
      continue
    }
    if (claimed.has(outcome.config.serverName)) {
      skipped.push(`${tableKey}.${rawName}: serverName "${outcome.config.serverName}" 与前面的条目规范化后重名，且同一作用域内 serverName 独占，只保留前一条`)
      continue
    }
    claimed.add(outcome.config.serverName)
    servers.push(outcome.config)
  }
  return { servers, skipped, warnings }
}

/**
 * 收集解析 `@deepseek-ai/dsh-mcp-client` 的候选锚点目录。
 *
 * 插件包以 `link:` 装进 profile，Node 会按真实路径（插件仓库内）解析裸包名，那里没有
 * `@deepseek-ai/*`；官方客户端实际被 hoist 在 **profile 目录的父级**
 * `~/.dsh/profiles/node_modules`。锚点按「实际有效概率」排序：
 *
 * 1. `ctx.baseUrl` —— Loader 树根的 file URL，**生产环境唯一可靠的锚点**；
 * 2. `DSH_PROFILE_DIR` / `$DSH_HOME/profiles[/$DSH_PROFILE]` —— 程序化加载的兜底；
 * 3. 本模块目录与 `process.cwd()` —— 仅在包被复制安装（非 link）时才有用。
 *
 * @param ctx - 插件上下文，用于读取 Loader 的 baseUrl。
 * @returns 去重后的锚点目录列表。
 */
function resolveAnchors(ctx) {
  const anchors = []
  const add = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return
    if (!anchors.includes(candidate)) anchors.push(candidate)
  }
  if (typeof ctx?.baseUrl === 'string' && ctx.baseUrl.startsWith('file:')) {
    try {
      add(fileURLToPath(ctx.baseUrl))
    } catch {
      // baseUrl 不是可解析的文件 URL，跳过该锚点
    }
  }
  add(process.env.DSH_PROFILE_DIR)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') {
    add(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'web'))
    add(join(process.env.DSH_HOME, 'profiles'))
  }
  add(dirname(fileURLToPath(import.meta.url)))
  add(process.cwd())
  return anchors
}

/**
 * 按锚点动态解析并加载官方 MCP 客户端插件。
 * @param ctx - 插件上下文。
 * @param logger - 诊断日志。
 * @returns 插件模块命名空间（含 `apply`），全部锚点都失败时返回 `undefined`。
 */
async function loadMcpClient(ctx, logger) {
  for (const anchor of resolveAnchors(ctx)) {
    try {
      const require = createRequire(pathToFileURL(join(anchor, '__dsh_mcp_json_anchor__.cjs')))
      const resolved = require.resolve(MCP_CLIENT_SPECIFIER)
      const module = await import(pathToFileURL(resolved).href)
      if (typeof module?.apply === 'function') {
        logger.info(`mcp-json: 复用 ${MCP_CLIENT_SPECIFIER} → ${resolved}（锚点 ${anchor}）`)
        return module
      }
      logger.warn(`mcp-json: ${resolved} 未导出 apply()`)
    } catch {
      // 该锚点解析不到，继续下一个
    }
  }
  return undefined
}

/**
 * 为一个会话建立「它自己项目的 MCP」。
 *
 * 所有注册都发生在传入的 **agent 作用域** `agentCtx` 下：工具、watcher、fiber 都随会话
 * 销毁自动回退，profile 层不留任何全局登记。
 *
 * 两个刻意的错误处置：
 * - **解析失败时保留旧实例**：手抖把 `.mcp.json` 写坏，不该让在跑的 MCP 全停掉；
 * - **回收超时后记进 stuck 并跳过同名挂载**：登记簿里删掉它只是为了不堵链，实例本身
 *   可能还在跑，立刻重挂会让新旧两个同名实例并存（对 sqlite 文件锁、端口这类真互斥资源
 *   就是起不来或状态错乱）。等它真正结算后自动解除并触发一次自愈重挂。
 *
 * @param agentCtx - 会话作用域上下文（`agent.ctx`）。
 * @param cwd - 会话工作目录（绝对路径），项目定位的基准。
 * @param options - 归一化配置。
 * @param logger - 诊断日志。
 * @param getClient - 惰性取官方客户端模块（解析失败不缓存，可自愈）。
 * @returns `{ start }`，`start()` 完成首次挂载。
 */
function createSessionMount(agentCtx, cwd, options, logger, getClient) {
  /** 已挂载的 fiber → serverName。 */
  const fibers = new Map()
  /** 回收超时、尚未真正结算的 serverName。 */
  const stuck = new Set()
  /** 有实例从 stuck 里结算出来时调用。 */
  let stuckSettled = () => {}

  /** 项目定位基准：显式 projectDir 优先，否则用会话工作目录。 */
  const base = () => (options.projectDir === '' ? cwd : options.projectDir)

  /**
   * 回收一个实例。
   * @param fiber - 要回收的 fiber。
   * @param knownName - 调用方已知的 serverName（登记簿可能已被清空）。
   */
  const release = async (fiber, knownName) => {
    const serverName = knownName ?? fibers.get(fiber)
    fibers.delete(fiber)

    let timedOut = false
    let timer
    /** 回收动作本身；异常就地吞掉，保证 `disposal` 永不 reject。 */
    const disposal = (async () => {
      try {
        await fiber.dispose()
      } catch (error) {
        logger.warn(`mcp-json: 实例回收异常：${messageOf(error)}`)
      }
    })()

    try {
      await Promise.race([
        disposal,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true
            resolve()
          }, DISPOSE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      // 必须清掉：否则 dispose 秒回时定时器照样会在超时后触发，留下一条「放弃等待」的假告警，
      // 真挂起与正常回收就再也分不出来。
      clearTimeout(timer)
    }

    if (!timedOut || serverName === undefined) return
    logger.warn(
      `mcp-json: ${serverName} 的旧实例回收超过 ${DISPOSE_TIMEOUT_MS}ms 未返回，已放弃等待以免堵住后续重挂；` +
        `在它真正结算前，同名 server 暂不挂载（避免新旧两个同名实例并存）`,
    )
    stuck.add(serverName)
    disposal.finally(() => {
      stuck.delete(serverName)
      logger.info(`mcp-json: ${serverName} 的旧实例已结算，恢复挂载`)
      stuckSettled()
    })
  }

  /** 停掉本会话的全部实例。 */
  const releaseAll = async () => {
    const all = [...fibers.entries()]
    fibers.clear()
    await Promise.all(all.map(([fiber, name]) => release(fiber, name)))
  }

  /** 重新读取本项目 `.mcp.json` 并全量重挂。 */
  const performReload = async () => {
    const root = base()
    const file = locateConfigFileIn(root, options)
    if (file === undefined) {
      logger.info(`mcp-json: 未找到 ${options.path}（基准 ${root}，向上找 ${options.searchUp ? MAX_SEARCH_UP_LEVELS : 0} 层），本会话不挂载项目 MCP`)
      await releaseAll()
      return
    }

    let parsed
    try {
      parsed = readServerSpecs(file, options)
    } catch (error) {
      logger.error(`${messageOf(error)}；保留当前已挂载的实例`)
      return
    }
    for (const warning of parsed.warnings) logger.warn(`mcp-json: ${file}: ${warning}`)
    for (const problem of parsed.skipped) logger.warn(`mcp-json: ${file}: 跳过 ${problem}`)

    const client = await getClient()
    if (client === undefined) {
      if (options.failOnStartupError) throw new Error(`mcp-json: 解析不到 ${MCP_CLIENT_SPECIFIER}，项目 MCP 无法启动`)
      return
    }

    await releaseAll()
    // 回收过程中可能刚把某个 serverName 打进 stuck（回收超时）。那种名字此刻不能立刻重挂，
    // 否则新旧两个同名实例会并存；等它真正结算后由 stuckSettled 自愈。
    const startable = []
    for (const spec of parsed.servers) {
      if (stuck.has(spec.serverName)) {
        logger.warn(`mcp-json: ${spec.serverName} 的旧实例回收超时且尚未结算，本轮先不重挂（结算后自动恢复）`)
        continue
      }
      startable.push(spec)
    }

    const outcomes = await Promise.all(
      startable.map(async (spec) => {
        let fiber
        try {
          fiber = agentCtx.plugin(client, spec)
          fibers.set(fiber, spec.serverName)

          let timedOut = false
          let timer
          try {
            await Promise.race([
              fiber,
              new Promise((resolve) => {
                timer = setTimeout(() => {
                  timedOut = true
                  resolve()
                }, STARTUP_TIMEOUT_MS)
                timer.unref?.()
              }),
            ])
          } finally {
            clearTimeout(timer)
          }
          if (timedOut) {
            // 实例留在登记簿里：后续重挂会重新评估它，卡死解除后自然收敛。
            logger.warn(`mcp-json: ${spec.serverName} 启动超过 ${STARTUP_TIMEOUT_MS}ms 仍未就绪，本轮不再等它（实例留在登记簿里）`)
            return undefined
          }
          logger.info(`mcp-json: ${spec.serverName} 就绪（${spec.transport}）`)
          return spec.serverName
        } catch (error) {
          if (fiber !== undefined) await release(fiber, spec.serverName)
          const message = `mcp-json: ${spec.serverName} 启动失败：${messageOf(error)}`
          if (options.failOnStartupError) {
            await releaseAll()
            throw new Error(message)
          }
          logger.warn(message)
          return undefined
        }
      }),
    )
    const ready = outcomes.filter((serverName) => serverName !== undefined)
    logger.info(`mcp-json: ${ready.length}/${startable.length} 个 server 在跑（会话级，来源 ${file}）`)
  }

  /**
   * 串行化重挂入口。两次重挂交叠会漏 dispose 在途实例，也会让后完成者用旧列表覆盖登记簿；
   * 这里用一条 promise 链排队，并吞掉单次失败以免卡死后续。
   */
  let reloadChain = Promise.resolve()
  const reload = () => {
    const next = reloadChain.then(() => performReload())
    reloadChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  stuckSettled = () => {
    reload().catch((error) => logger.error(`mcp-json: 旧实例结算后的自愈重挂失败：${messageOf(error)}`))
  }

  if (options.watch) {
    // 注册在 agentCtx 下：会话销毁时 watcher 随之关闭，不留全局监听。
    agentCtx.effect(() => {
      const root = base()
      const watched = new Map()
      if (isAbsolute(options.path)) {
        watched.set(dirname(options.path), basename(options.path))
      } else {
        const file = locateConfigFileIn(root, options)
        if (file !== undefined) {
          watched.set(dirname(file), basename(file))
        } else {
          // 文件还没出现：盯它「应该出现」的那个目录。`path` 可能含子目录
          // （`config/mcp.json`），文件名必须取 basename，否则 fs.watch 报的 basename
          // 永远匹配不上，首次创建会被漏掉。
          const expected = resolve(root, options.path)
          watched.set(dirname(expected), basename(expected))
          // searchUp 打开时，文件也可能之后才出现在祖先目录里；那些目录同样要有事件源。
          if (options.searchUp) {
            let directory = dirname(root)
            for (let level = 0; level < MAX_SEARCH_UP_LEVELS; level += 1) {
              const candidate = join(directory, options.path)
              watched.set(dirname(candidate), basename(candidate))
              const parent = dirname(directory)
              if (parent === directory) break
              directory = parent
            }
          }
        }
      }

      let timer
      const watchers = []
      for (const [directory, filename] of watched) {
        if (!existsSync(directory)) continue
        try {
          const watcher = watch(directory, { persistent: false }, (_event, changed) => {
            // 只认目标文件本身；目录里其它文件（.phpunit.result.cache 之类）高频变动，别被带跑
            if (changed !== filename) return
            clearTimeout(timer)
            timer = setTimeout(() => {
              reload().catch((error) => logger.error(`mcp-json: 热重挂失败：${messageOf(error)}`))
            }, RELOAD_DEBOUNCE_MS)
            timer.unref?.()
          })
          // 目录被整体删掉（rm -rf / worktree 换出）时底层 watch 会失效，只告警不重建：
          // 重建需要一个「目录已回来」的事件源，看门狗轮询要挂常驻定时器，代价大于收益。
          watcher.on('error', (error) => {
            logger.warn(`mcp-json: 监视 ${join(directory, filename)} 失效（${messageOf(error)}）；本会话在重开前不再热重挂`)
          })
          watchers.push(watcher)
        } catch (error) {
          logger.warn(`mcp-json: 无法监视 ${join(directory, filename)}：${messageOf(error)}`)
        }
      }
      if (watchers.length === 0) return
      logger.info(`mcp-json: 监视 ${watchers.length} 处 .mcp.json`)
      return () => {
        clearTimeout(timer)
        for (const watcher of watchers) watcher.close()
      }
    })
  }

  return {
    /** 首次挂载。 */
    start: () => reload(),
  }
}

/**
 * 插件入口：为每个新会话挂载**它自己项目**的 MCP。
 *
 * 挂载发生在 `agent/created`（serial 事件）里并 await 到就绪 —— 官方保证 agentCtx 里的
 * 注册在第一次 prompt 组装之前完成，所以会话开头就能看到工具。代价是会话创建要多等一次
 * 握手，因此 STARTUP_TIMEOUT_MS 是必需的兜底。
 * @param ctx - profile 级插件上下文。
 * @param config - 插件行的 `config`。
 */
export async function apply(ctx, config) {
  const options = normalizeOptions(config)
  const logger = ctx.logger('mcp-json')

  /** 已解析到的官方客户端模块；解析失败时不缓存，下次再试（可自愈）。 */
  let mcpClient
  let reportedResolutionFailure = false
  const getClient = async () => {
    if (mcpClient !== undefined) return mcpClient
    mcpClient = await loadMcpClient(ctx, logger)
    if (mcpClient === undefined) {
      if (!reportedResolutionFailure) {
        reportedResolutionFailure = true
        logger.error(`mcp-json: ${resolveAnchors(ctx).length} 个锚点都解析不到 ${MCP_CLIENT_SPECIFIER}，项目 MCP 不会启动`)
      }
      return undefined
    }
    reportedResolutionFailure = false
    return mcpClient
  }

  // 预解析一次：让「官方客户端装没装好」在 Harness 启动时就暴露在日志里，而不是等用户
  // 开会话才发现。失败不致命，getClient 之后还会重试。
  await getClient()

  ctx.on('agent/created', async ({ agent }) => {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      logger.warn('mcp-json: 会话没有可用的工作目录，跳过项目 MCP 挂载')
      return
    }
    const mount = createSessionMount(agent.ctx, cwd, options, logger, getClient)
    try {
      await mount.start()
    } catch (error) {
      // 项目 MCP 起不来不该连坐会话创建本身。
      logger.error(`mcp-json: 会话 ${String(agent.session.id)} 的项目 MCP 挂载失败：${messageOf(error)}`)
    }
  })
}
