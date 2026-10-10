/**
 * @module @local/dsh-mcp-json
 *
 * 项目级 MCP 启动器：读取项目根的 `.mcp.json`（Claude Code / Qoder / VS Code 等
 * 通用的 MCP server 声明格式），把其中每个 server 动态挂载成一份官方
 * `@deepseek-ai/dsh-mcp-client` 实例，于是「项目自己声明的 MCP」就变成当前 Harness
 * 里可直接调用的 `mcp__<serverName>__<tool>` 工具。
 *
 * 为什么不用「配置式 bundle」（在 cordis.patch.yml 里逐个 insert mcp-client 行）：
 * 那种写法把 server 清单钉死在 profile 层，换项目要改 profile；本插件让项目用
 * 自己的 `.mcp.json` 拥有这份清单，改文件即热重挂。
 *
 * 一个 profile 可以同时服务多个项目（`projectDir` + `projects[]`，或 `scanRoot`
 * 自动发现）。因为 dsh-mcp-client 的 serverName 是**进程级独占**的，多项目下同名
 * server 必须靠命名空间前缀区分（见 namespace / composeServerName）：
 *   - 只有一个项目源时默认不加前缀，工具名与单项目时代完全一致（向后兼容）；
 *   - 多个项目源时默认加「目录名」前缀，如 `mcp__demo_dbhub__execute_sql`。
 *
 * 四条实现约束（改代码时别踩）：
 * 1. 本模块只 import `node:` 内置模块。插件包以 `link:` 方式装进 profile，模块
 *    真实路径在插件仓库内，`@deepseek-ai/*` 这类裸包名从这里解析不到；被复用的
 *    官方客户端改为按锚点动态解析（见 resolveAnchors / loadMcpClient）。
 * 2. 不导出 `Config` schema（那需要 import schemastery，违反约束 1），改为在
 *    apply 内手工校验，报错信息直接指到 `.mcp.json` 的具体条目。
 * 3. 热重挂必须串行，且「在途」实例也要能被停掉。dsh-mcp-client 的 serverName 是
 *    进程级独占，两次重挂交叠会漏 dispose：被删掉的 server 继续活着（孤儿 fiber +
 *    泄漏的 MCP 子进程 + 工具仍可见），并撞出虚假的 already in use。
 *    见 createFiberRegistry 与 apply 里的 reloadChain。
 * 4. 多项目重挂是**全量收敛**：每次重挂都重新解析全部项目、停掉全部旧实例、再按
 *    新结果全量起。不要图省事改成「增量 diff 只动变化的那个项目」—— 增量在
 *    「项目 A 的 server 名与项目 B 撞车」「某项目文件刚被删」这类场景下极易漏
 *    dispose，正是约束 3 踩过的坑。
 */

import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
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

/** `scanRoot` 自动发现项目时的默认递归深度（0 表示只看根本身）。 */
const DEFAULT_SCAN_DEPTH = 2

/** serverName 的长度上限，与 dsh-mcp-client 的校验一致。 */
const SERVER_NAME_MAX_LENGTH = 32

/** 自动生成的项目前缀长度上限，给 `_<serverName>` 留出空间。 */
const PREFIX_MAX_LENGTH = 24

/** `scanRoot` 递归时跳过的目录名（依赖树、版本库、构建产物都不该被当成项目）。 */
const SCAN_SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'vendor',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.idea',
  '.vscode',
])

/** 文件变更后的重挂防抖窗口（毫秒）。 */
const RELOAD_DEBOUNCE_MS = 250

/**
 * 解析一个正的超时毫秒数；非法值（NaN、0、负数、空串）一律回落到默认值。
 *
 * 不能直接 `Number(env)`：`MCP_JSON_DISPOSE_TIMEOUT_MS=10s`、留空、`-1` 都会得到
 * NaN/0/负数，而 `setTimeout` 把它们当成 1ms —— 安全网反而变成「每次都立刻超时」，
 * 于是超时告警与重叠窗口在每次重挂都出现。
 * @param raw - 环境变量原文。
 * @param fallback - 默认值。
 * @returns 可用的超时毫秒数。
 */
function positiveTimeout(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 单个实例回收的等待上限（毫秒）：超时就放弃等待，免得一次挂起堵死整条重挂链。
 * 环境变量是给回归测试用的逃生口（「dispose 挂起」用例否则要跑满 10 秒），生产别改。 */
const DISPOSE_TIMEOUT_MS = positiveTimeout(process.env.MCP_JSON_DISPOSE_TIMEOUT_MS, 10000)

/** 单个 server 启动（握手）的等待上限（毫秒）：超时就本轮不再等它。
 * 没有它，一个卡死的 server 会把串行重挂链拖住 —— 真链实测会静默停摆到 SDK 自己的
 * 120 秒超时才收场，期间所有项目的 MCP 工具都不可用。 */
const STARTUP_TIMEOUT_MS = positiveTimeout(process.env.MCP_JSON_STARTUP_TIMEOUT_MS, 30000)

/** `namespace` 的合法取值。 */
const NAMESPACE_MODES = ['auto', 'always', 'never']

/** 插件行配置的默认值。 */
const DEFAULTS = {
  path: '.mcp.json',
  projectDir: '',
  searchUp: false,
  disabledServers: [],
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  watch: true,
  projects: [],
  namespace: 'auto',
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
 * 校验并补全 `projects[]` 里的一项。
 *
 * 两种形态二选一：`{ dir }` 直接点名一个项目目录，`{ scanRoot, depth }` 递归发现
 * 该根目录下所有带 `.mcp.json` 的目录。`prefix` 可显式指定命名空间前缀。
 * @param raw - `config.projects` 的一项。
 * @param index - 该项在数组里的下标，仅用于报错定位。
 * @returns 归一化后的项目源 `{ dir, scanRoot, prefix, depth }`。
 * @throws 形态不合法时抛出。
 */
function normalizeProjectSource(raw, index) {
  if (!isPlainObject(raw)) throw new Error(`mcp-json: config.projects[${index}] must be an object`)
  const dir = typeof raw.dir === 'string' ? raw.dir.trim() : ''
  const scanRoot = typeof raw.scanRoot === 'string' ? raw.scanRoot.trim() : ''
  if (dir === '' && scanRoot === '') {
    throw new Error(`mcp-json: config.projects[${index}] needs "dir" or "scanRoot"`)
  }
  if (dir !== '' && scanRoot !== '') {
    throw new Error(`mcp-json: config.projects[${index}] must not set both "dir" and "scanRoot"`)
  }
  if (raw.prefix !== undefined && typeof raw.prefix !== 'string') {
    throw new Error(`mcp-json: config.projects[${index}].prefix must be a string`)
  }
  let depth = DEFAULT_SCAN_DEPTH
  if (raw.depth !== undefined) {
    if (!Number.isInteger(raw.depth) || raw.depth < 0) {
      throw new Error(`mcp-json: config.projects[${index}].depth must be a non-negative integer`)
    }
    depth = raw.depth
  }
  return { dir, scanRoot, prefix: (raw.prefix ?? '').trim(), depth }
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
  const options = { ...DEFAULTS, disabledServers: [], projects: [] }

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
  if (source.projects !== undefined) {
    if (!Array.isArray(source.projects)) throw new Error('mcp-json: config.projects must be an array')
    options.projects = source.projects.map((item, index) => normalizeProjectSource(item, index))
  }
  if (source.namespace !== undefined) {
    if (typeof source.namespace !== 'string' || !NAMESPACE_MODES.includes(source.namespace)) {
      throw new Error(`mcp-json: config.namespace must be one of ${NAMESPACE_MODES.map((mode) => `"${mode}"`).join(' | ')}`)
    }
    options.namespace = source.namespace
  }
  return options
}

/**
 * 展开字符串里的 `${VAR}` / `${VAR:-default}`，支持一层嵌套默认值。
 *
 * `${DSH_HOME:-${HOME}/.dsh}` 会先落地内层 `${HOME}`，再让外层取到默认值。
 * @param value - 原始字符串。
 * @param notes - 诊断信息收集器（未定义变量、解析不掉的残留占位符）。
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
 * 把项目前缀洗成 serverName 允许的字符集。
 * @param rawPrefix - 显式前缀或项目目录名。
 * @returns 洗好的前缀；全部字符都不合法时返回空串（调用方需兜底）。
 */
function sanitizePrefix(rawPrefix) {
  return rawPrefix
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^[_-]+/, '')
    .slice(0, PREFIX_MAX_LENGTH)
}

/**
 * 拼出多项目下的 serverName。
 *
 * 总长必须落在 dsh-mcp-client 的 32 字符上限内。空间不够时**截 server 名、保前缀**：
 * 多项目下前缀是唯一的消歧手段，一旦丢掉，两个项目的同名 server 就会撞成一条，而
 * 用户照文档加 `prefix` 也救不回来（前缀根本没参与拼接）。名字被截会告警。
 * @param prefix - 已洗好的项目前缀；空串表示不加命名空间。
 * @param rawName - 声明表里的原始键。
 * @param warnings - 诊断信息收集器。
 * @returns 合法的 serverName。
 */
function composeServerName(prefix, rawName, warnings) {
  const sanitized = sanitizeServerName(rawName)
  if (prefix === '') return sanitized
  const room = SERVER_NAME_MAX_LENGTH - 1 - prefix.length
  if (room < 1) {
    // prefix 已被 sanitizePrefix 限到 24 字符，正常到不了这里；真到了宁可放弃前缀也不能截出个非法名
    warnings.push(`前缀 "${prefix}" 过长，无法与 serverName 拼接，已放弃前缀`)
    return sanitized
  }
  const trimmed = sanitized.slice(0, room)
  if (trimmed !== sanitized) {
    warnings.push(`serverName "${rawName}" 加前缀后超出 ${SERVER_NAME_MAX_LENGTH} 字符上限，已截为 "${trimmed}"（保前缀以便区分项目）`)
  }
  return `${prefix}_${trimmed}`
}

/**
 * 在指定基准目录里定位 `.mcp.json`。
 * @param base - 项目目录（绝对路径）。
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
 * 递归发现一个根目录下所有带 `.mcp.json` 的项目目录。
 *
 * 只认「目录里直接有该文件」，不往上找（`searchUp` 是单项目时代的语义，多项目下
 * 会让多个项目命中同一个文件）。隐藏目录与依赖/构建目录一律不进。
 * @param root - 扫描根目录（绝对路径）。
 * @param depth - 最大递归层数；0 表示只看根本身。
 * @param pathName - 目标文件名，通常是 `.mcp.json`。
 * @returns 命中的项目目录绝对路径列表（含 root 自身，若命中）。
 */
function scanForProjects(root, depth, pathName) {
  const found = []
  const visit = (directory, level) => {
    if (existsSync(join(directory, pathName))) found.push(directory)
    if (level >= depth) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // 目录读不了（权限、竞态删除）就当作没有子项目
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (SCAN_SKIP_DIRECTORIES.has(entry.name)) continue
      visit(join(directory, entry.name), level + 1)
    }
  }
  if (existsSync(root)) visit(root, 0)
  return found
}

/**
 * 把配置里的项目来源展开成去重后的项目目录列表。
 *
 * `projectDir` 也算一个来源，所以老配置（只写 `projectDir`）行为不变。
 * 一个来源都没有时退回 `process.cwd()`，保持单项目时代的兜底语义。
 * @param options - 归一化配置。
 * @returns `[{ dir, prefix }]`，`dir` 为绝对路径，`prefix` 可能为空串。
 */
function expandProjectSources(options) {
  const sources = []
  if (options.projectDir !== '') sources.push({ dir: resolve(options.projectDir), prefix: '' })
  for (const source of options.projects) {
    if (source.dir !== '') {
      sources.push({ dir: resolve(source.dir), prefix: source.prefix })
      continue
    }
    const root = resolve(source.scanRoot)
    for (const dir of scanForProjects(root, source.depth, options.path)) {
      sources.push({ dir, prefix: source.prefix })
    }
  }
  // 只有「一个项目源都没配」才退回 cwd（单项目时代的兜底语义）。
  // 配了源却一个都没扫到（scanRoot 空目录 / 不存在 / 指向文件）**不能**回退：
  // 那会静默把 Harness 进程 cwd 里的项目 MCP 挂进 profile（真实部署里 cwd 就是当前
  // 业务项目），而且前缀规则还按「0 个源」算，等于凭空多出一套无前缀的工具。
  if (sources.length === 0 && options.projectDir === '' && options.projects.length === 0) {
    sources.push({ dir: process.cwd(), prefix: '' })
  }

  const seen = new Set()
  const unique = []
  for (const source of sources) {
    if (seen.has(source.dir)) continue
    seen.add(source.dir)
    unique.push(source)
  }
  return unique
}

/**
 * 定位每个项目的 `.mcp.json`，并算好该项目的 serverName 前缀。
 *
 * 前缀是否启用只取决于**配置里声明的项目源**，不取决于「扫描命中几个目录」：
 * scanRoot 的命中数天然随目录增删而变，拿它当判据的话，某个项目一出现就会把其余
 * 项目的工具名集体改名 —— 对使用者是灾难。所以判据是：显式源数 > 1，或存在
 * scanRoot 源（它天然意味着多项目，且命中数不可预测，必须一开始就带前缀）。
 * @param options - 归一化配置。
 * @param logger - 诊断日志（可选）。
 * @returns `[{ dir, prefix, file }]`；`prefix` 为空串表示不加命名空间。
 */
function locateProjectFiles(options, logger) {
  const projects = expandProjectSources(options)
  const declaredSources = (options.projectDir === '' ? 0 : 1) + options.projects.length
  const scansForProjects = options.projects.some((source) => source.scanRoot !== '')
  const usePrefix =
    options.namespace === 'always' || (options.namespace === 'auto' && (declaredSources > 1 || scansForProjects))
  if (isAbsolute(options.path) && projects.length > 1) {
    logger?.warn(
      `mcp-json: config.path 是绝对路径（${options.path}），所有项目源都指向同一个文件，只会服务第一个；多项目请改用相对文件名`,
    )
  }
  const seenFiles = new Set()
  const targets = []
  for (const project of projects) {
    const file = locateConfigFileIn(project.dir, options)
    if (file === undefined) continue
    if (seenFiles.has(file)) continue
    seenFiles.add(file)
    let prefix = ''
    if (usePrefix) {
      const rawPrefix = project.prefix !== '' ? project.prefix : basename(project.dir)
      const sanitized = sanitizePrefix(rawPrefix)
      // 前缀被截断后可能与另一个项目撞成同一个名字，而重名告警只会说「跨项目重名」——
      // 两个目录名明明不同，运维看不出真因。所以截断本身要单独说一句。
      const cleaned = rawPrefix.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[_-]+/, '')
      if (cleaned.length > PREFIX_MAX_LENGTH) {
        logger?.warn(
          `mcp-json: 前缀 "${rawPrefix}" 超过 ${PREFIX_MAX_LENGTH} 字符，已截为 "${sanitized}"；截断后可能与别的项目撞名，建议显式指定较短的 prefix`,
        )
      }
      prefix = sanitized === '' ? 'p' : sanitized
    }
    targets.push({ dir: project.dir, prefix, file })
  }
  return targets
}

/**
 * 把一个 `.mcp.json` 条目翻译成 dsh-mcp-client 的 config。
 * @param rawName - 声明表里的键，用作 serverName。
 * @param raw - 该 server 的声明。
 * @param projectDirectory - `.mcp.json` 所在目录，stdio 的默认 cwd。
 * @param options - 归一化配置。
 * @param prefix - 该项目命名空间前缀；空串表示不加。
 * @returns `{ config }` 或 `{ error }`；两者都带 `warnings`。
 */
function normalizeServer(rawName, raw, projectDirectory, options, prefix) {
  const warnings = []
  if (!isPlainObject(raw)) return { error: 'entry must be an object', warnings }
  const sanitized = sanitizeServerName(rawName)
  if (sanitized !== rawName) warnings.push(`serverName "${rawName}" 不合法，改用 "${sanitized}"`)
  const serverName = composeServerName(prefix, rawName, warnings)
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
 * 规范化后重名的 server 只保留第一个：`a.b` 与 `a_b` 都会变成 `a_b`，而
 * dsh-mcp-client 的 serverName 是进程级独占，两条同名 spec 必然有一条起不来。
 * （跨文件的同名检查在 performReload 里做，这里只管单个文件内部。）
 * @param file - 配置文件绝对路径。
 * @param options - 归一化配置。
 * @param prefix - 该项目命名空间前缀；空串表示不加。
 * @returns `{ servers, skipped, warnings }`，`servers[]` 可直接喂给 dsh-mcp-client。
 * @throws 文件读不了、JSON 坏了、或没有声明表时抛出（调用方决定跳过还是整体保留）。
 */
function readServerSpecs(file, options, prefix) {
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
  const claimed = new Map()
  for (const [rawName, raw] of Object.entries(document[tableKey])) {
    if (options.disabledServers.includes(rawName)) {
      warnings.push(`已按 disabledServers 跳过 ${rawName}`)
      continue
    }
    const outcome = normalizeServer(rawName, raw, dirname(file), options, prefix)
    for (const warning of outcome.warnings) warnings.push(`${tableKey}.${rawName}: ${warning}`)
    if (outcome.error !== undefined) {
      skipped.push(`${tableKey}.${rawName}: ${outcome.error}`)
      continue
    }
    const previous = claimed.get(outcome.config.serverName)
    if (previous !== undefined) {
      skipped.push(`${tableKey}.${rawName}: serverName "${outcome.config.serverName}" 与 ${tableKey}.${previous} 规范化后重名，且 serverName 进程级独占，只保留前一条`)
      continue
    }
    claimed.set(outcome.config.serverName, rawName)
    servers.push(outcome.config)
  }
  return { servers, skipped, warnings }
}

/**
 * 收集解析 `@deepseek-ai/dsh-mcp-client` 的候选锚点目录。
 *
 * 插件包以 `link:` 装进 profile，Node 会按真实路径（插件仓库内）解析裸包名，
 * 那里没有 `@deepseek-ai/*`；官方客户端实际被 hoist 在 **profile 目录的父级**
 * `~/.dsh/profiles/node_modules`。因此锚点按「实际有效概率」排序：
 *
 * 1. `ctx.baseUrl` —— Loader 树根的 file URL，**生产环境唯一可靠的锚点**；
 * 2. `DSH_PROFILE_DIR` / `$DSH_HOME/profiles[/$DSH_PROFILE]` —— 仅当 Harness
 *    由带 profile 的启动器拉起、或经 shell 工具执行时才存在（宿主进程本身没有
 *    `DSH_*`），留作程序化加载的兜底；
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
 * 已挂载 fiber 的登记簿（fiber → { 来源文件, serverName }）。
 *
 * 四个要点，缺一个都会出真问题：
 * 1. **在途实例也要登记**：`ctx.plugin()` 返回后立刻入册、`await` 完成前也在册。
 *    否则两次重挂交叠时只看到「已就绪」的那批，在途的那个会漏 dispose。
 * 2. **记来源文件**：`releaseMissing` 才能在「全部文件解析失败、决定保留旧实例」时
 *    把「文件已被删掉」的实例挑出来回收 —— 那种实例留着就是永久幽灵（继续占
 *    serverName、继续跑 MCP 子进程、cwd 还指向已删除的目录）。
 * 3. **回收要带超时**：真客户端的 `dispose()` 会等 MCP 子进程关闭，一旦子进程不响应
 *    就永远不 resolve，而重挂是一条串行链 —— 一次挂起会让此后所有项目的热重挂静默失效。
 * 4. **超时后不能直接遗忘**：登记簿里删掉它只是为了不堵链，实例本身可能还在跑。
 *    所以要把它记进 `stuck`，让后续重挂**跳过**同名 server —— 否则会出现新旧两个同名
 *    实例并存的窗口（真互斥资源如 sqlite 文件锁、端口、单会话设备会直接起不来），
 *    而且此后没人再过问它。等它真正结算后自动解除并触发一次自愈重挂。
 * @param logger - 诊断日志。
 * @returns `{ add, release, releaseAll, releaseMissing, isStuck, onStuckSettled }`。
 */
function createFiberRegistry(logger) {
  const fibers = new Map()
  /** 回收超时、尚未真正结算的 serverName。 */
  const stuck = new Set()
  /** 有实例从 stuck 里结算出来时调用（由 apply 注册成「触发一次重挂」）。 */
  let stuckSettledHandler = () => {}

  /**
   * 回收一个实例。
   * @param fiber - 要回收的 fiber。
   * @param knownEntry - 调用方已经取出的登记项。`releaseAll`/`releaseMissing` 会先清空
   *   登记簿再逐个回收，此时再查 `fibers` 只会拿到 undefined，serverName 就丢了 ——
   *   超时告警与 stuck 记录会一起失效。所以由调用方把 entry 递进来。
   */
  const release = async (fiber, knownEntry) => {
    const entry = knownEntry ?? fibers.get(fiber)
    fibers.delete(fiber)
    const serverName = entry?.serverName

    let timedOut = false
    let timer
    /** 回收动作本身；异常在这里就地吞掉，保证 `disposal` 永不 reject。 */
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
      // 必须清掉。否则 dispose 秒回时定时器照样会在超时后触发 —— race 早已结算，
      // 但那条「放弃等待」的告警已经打出去了：正常回收与真挂起就再也分不出来，
      // 而 README 恰恰把这条告警当作超时路径的信号。
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
      stuckSettledHandler()
    })
  }

  return {
    add(fiber, source, serverName) {
      fibers.set(fiber, { source, serverName })
    },
    release,
    /** 该 serverName 是否处于「旧实例回收超时且未结算」状态。 */
    isStuck(serverName) {
      return stuck.has(serverName)
    },
    /** 注册「有实例从 stuck 结算」时的回调。 */
    onStuckSettled(handler) {
      stuckSettledHandler = handler
    },
    async releaseAll() {
      const all = [...fibers.entries()]
      fibers.clear()
      await Promise.all(all.map(([fiber, entry]) => release(fiber, entry)))
    },
    /**
     * 回收「来源已不在 `keep` 集合里」的实例。
     * @param keep - 本次扫描到的文件路径集合。
     * @returns 被回收的实例数。
     */
    async releaseMissing(keep) {
      const stale = [...fibers.entries()].filter(([, entry]) => entry.source !== undefined && !keep.has(entry.source))
      for (const [fiber] of stale) fibers.delete(fiber)
      await Promise.all(stale.map(([fiber, entry]) => release(fiber, entry)))
      return stale.length
    },
  }
}

/**
 * 并发挂载 MCP server。
 *
 * **必须并发**：串行 `await` 会让「改一个项目的 `.mcp.json`」把所有项目的工具停摆
 * Σ(各 server 握手耗时)，真机上每个 server 1~3 秒，多项目下就是十几秒的全局空窗。
 * 并发后空窗降到 max(握手耗时)。撞名风险不存在 —— 调用方已做跨项目全量去重。
 *
 * **启动也要有上限**：`await fiber` 无上限时，一个握手卡死的 server 会把整条串行
 * 重挂链拖住（真链实测静默停摆到 SDK 自己的 120 秒超时），期间所有项目的工具都不可用。
 * @param ctx - 插件上下文，子实例挂在它下面，随本插件卸载一起回收。
 * @param mcpClient - 官方客户端插件模块。
 * @param specs - `readServerSpecs` 产出的 `servers`。
 * @param options - 归一化配置。
 * @param logger - 诊断日志。
 * @param registry - fiber 登记簿。
 * @param sourceOf - serverName → 来源文件，用于登记来源。
 * @returns 启动成功的 serverName 列表。
 * @throws 某个 server 起不来且 `failOnStartupError` 为真时抛出。
 */
async function startServers(ctx, mcpClient, specs, options, logger, registry, sourceOf) {
  const outcomes = await Promise.all(
    specs.map(async (spec) => {
      let fiber
      try {
        fiber = ctx.plugin(mcpClient, spec)
        registry.add(fiber, sourceOf.get(spec.serverName), spec.serverName)

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
          logger.warn(
            `mcp-json: ${spec.serverName} 启动超过 ${STARTUP_TIMEOUT_MS}ms 仍未就绪，本轮不再等它（实例留在登记簿里，后续重挂会收敛）`,
          )
          return undefined
        }
        logger.info(`mcp-json: ${spec.serverName} 就绪（${spec.transport}）`)
        return spec.serverName
      } catch (error) {
        if (fiber !== undefined) await registry.release(fiber)
        const message = `mcp-json: ${spec.serverName} 启动失败：${messageOf(error)}`
        if (options.failOnStartupError) {
          await registry.releaseAll()
          throw new Error(message)
        }
        logger.warn(message)
        return undefined
      }
    }),
  )
  return outcomes.filter((serverName) => serverName !== undefined)
}

/**
 * 插件入口：先起一次，再盯着各项目的 `.mcp.json` 热重挂。
 * @param ctx - 插件上下文。
 * @param config - 插件行的 `config`。
 */
export async function apply(ctx, config) {
  const options = normalizeOptions(config)
  const logger = ctx.logger('mcp-json')
  const registry = createFiberRegistry(logger)

  /** 已解析到的官方客户端模块；解析失败时不缓存，下次重挂再试（可自愈）。 */
  let mcpClient
  let reportedResolutionFailure = false

  /** 惰性解析官方客户端，失败只报一次错，且不影响已在跑的实例。 */
  const ensureMcpClient = async () => {
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

  /**
   * 重新读取全部项目的 `.mcp.json` 并按新内容全量重挂。
   *
   * 解析失败的处置分两种，这是刻意的：
   * - **全都没解析成功**（含单项目场景）→ 保留当前已挂载的实例不动，避免手抖写坏
   *   一个文件就把在跑的 MCP 全停掉；
   * - **部分成功** → 跳过坏的那些，用成功的重挂，坏项目不影响好项目。
   */
  const performReload = async () => {
    const targets = locateProjectFiles(options, logger)
    if (targets.length === 0) {
      logger.info(`mcp-json: 未找到 .mcp.json（已查 ${expandProjectSources(options).length} 个候选目录），不启动任何项目 MCP`)
      await registry.releaseAll()
      return
    }

    const servers = []
    const sourceOf = new Map()
    const claimed = new Map()
    let parsedAny = false
    for (const target of targets) {
      let parsed
      try {
        parsed = readServerSpecs(target.file, options, target.prefix)
      } catch (error) {
        logger.error(`${messageOf(error)}`)
        continue
      }
      parsedAny = true
      for (const warning of parsed.warnings) logger.warn(`mcp-json: ${target.file}: ${warning}`)
      for (const problem of parsed.skipped) logger.warn(`mcp-json: ${target.file}: 跳过 ${problem}`)
      for (const spec of parsed.servers) {
        const previous = claimed.get(spec.serverName)
        if (previous !== undefined) {
          logger.warn(`mcp-json: ${target.file}: 跳过 ${spec.serverName}，它与 ${previous} 跨项目重名（serverName 进程级独占）`)
          continue
        }
        if (registry.isStuck(spec.serverName)) {
          logger.warn(`mcp-json: ${target.file}: 跳过 ${spec.serverName}，它的上一个实例回收超时且尚未结算（避免新旧同名实例并存）`)
          continue
        }
        claimed.set(spec.serverName, target.file)
        sourceOf.set(spec.serverName, target.file)
        servers.push(spec)
      }
    }

    if (!parsedAny) {
      // 「保留旧实例」只该保「文件还在、只是写坏了」的那些。来源已经不在本次 targets
      // 里的实例必须回收，否则文件被删掉的那个项目会变成永久幽灵：继续占 serverName、
      // 继续跑 MCP 子进程，cwd 还指向已删除的目录。
      const targetFiles = new Set(targets.map((target) => target.file))
      const dropped = await registry.releaseMissing(targetFiles)
      logger.error(
        `mcp-json: ${targets.length} 个 .mcp.json 全部解析失败；保留当前已挂载的实例` +
          (dropped > 0 ? `（其中 ${dropped} 个实例的来源已不在本次扫描范围内，已回收）` : ''),
      )
      return
    }

    const client = await ensureMcpClient()
    if (client === undefined) {
      if (options.failOnStartupError) throw new Error(`mcp-json: 解析不到 ${MCP_CLIENT_SPECIFIER}，项目 MCP 无法启动`)
      return
    }

    await registry.releaseAll()
    // 回收过程中可能刚把某个 serverName 打进 stuck（回收超时）。那种名字**此刻**不能
    // 立刻重挂，否则新旧两个同名实例会并存 —— 收集阶段那次检查拦不住它，因为那时还没回收。
    // 等它真正结算后由 onStuckSettled 自愈。
    const startable = []
    for (const spec of servers) {
      if (registry.isStuck(spec.serverName)) {
        logger.warn(`mcp-json: ${spec.serverName} 的旧实例回收超时且尚未结算，本轮先不重挂（结算后自动恢复）`)
        continue
      }
      startable.push(spec)
    }
    const started = await startServers(ctx, client, startable, options, logger, registry, sourceOf)
    const sources = targets.map((target) => target.file).join(', ')
    logger.info(`mcp-json: ${started.length}/${startable.length} 个 server 在跑，来源 ${sources}`)
  }

  /**
   * 串行化重挂入口。
   *
   * 两次重挂交叠会同时踩两件事：在途实例漏 dispose（见 createFiberRegistry），
   * 以及后完成者用旧列表覆盖登记簿。这里用一条 promise 链把重挂排成队列，
   * 并吞掉单次失败以免卡死后续。
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

  // 回收超时的实例真正结算后自愈一次：把当时被跳过的同名 server 重新挂上。
  registry.onStuckSettled(() => {
    reload().catch((error) => logger.error(`mcp-json: 旧实例结算后的自愈重挂失败：${messageOf(error)}`))
  })

  ctx.effect(() => {
    if (!options.watch) return
    /**
     * 要盯的「目录 → 文件名」对。
     *
     * 覆盖的是 **apply 这一刻能定位到的所有项目目录**（含 `scanRoot` 当场扫到的），
     * 每个目录一个 watcher。此后**新出现**的项目要等下一次重挂（改任意一个已知
     * `.mcp.json`，或重启 Harness）才会被收进来 —— 让 scanRoot 对任意子项变动都重挂，
     * 会在依赖树那种高频写入的目录里把 MCP 反复重启。
     */
    const watched = new Map()
    if (isAbsolute(options.path)) {
      watched.set(dirname(options.path), basename(options.path))
    } else {
      for (const project of expandProjectSources(options)) {
        // 盯「文件实际所在的目录」：searchUp 命中父目录时，真正会变的是父目录里那份文件。
        const file = locateConfigFileIn(project.dir, options)
        if (file !== undefined) {
          watched.set(dirname(file), basename(file))
          continue
        }
        // 文件还没出现：盯它「应该出现」的那个目录。注意 `path` 可能含子目录
        // （`config/mcp.json`），文件名必须取 basename 而不是整个 `config/mcp.json`，
        // 否则 fs.watch 报的 basename 永远匹配不上，首次创建会被漏掉。
        const expected = resolve(project.dir, options.path)
        watched.set(dirname(expected), basename(expected))
        // searchUp 打开时，文件也可能之后才出现在祖先目录里；那些目录同样要有事件源，
        // 否则「先启动、后放配置」在祖先目录下永远发现不了 —— reload 逻辑能 searchUp 找到它，
        // 但没有任何事件会触发那次 reload。
        if (options.searchUp) {
          let directory = dirname(project.dir)
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
      if (!existsSync(directory)) {
        logger.warn(`mcp-json: 监视目录 ${directory} 不存在，跳过该处热重挂`)
        continue
      }
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
        // 项目目录被整体删掉（rm -rf / worktree 换出 / 容器挂载重建）时底层 watch 会失效。
        // 这里只告警不重建：重建需要一个「目录已回来」的事件源，而看门狗轮询要挂常驻定时器，
        // 代价大于收益。要恢复就重启 Harness，或触发一次其它项目的重挂。
        watcher.on('error', (error) => {
          logger.warn(`mcp-json: 监视 ${join(directory, filename)} 失效（${messageOf(error)}）；该项目在重启前不再热重挂`)
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

  // 首次重挂放在 watcher 注册**之后**：首次要等所有 server 握手（多 server 时可达数秒），
  // 期间写进来的 `.mcp.json` 改动若还没有 watcher，就会被静默吞掉、永不生效。
  await reload()

  // 插件卸载时回收所有实例（含在途的）。
  ctx.effect(() => () => registry.releaseAll())
}
