# @local/dsh-mcp-json

把**项目自己声明的 MCP**（`.mcp.json`）搬进 DSH：读取**当前会话所在项目**的 `.mcp.json`，
按其中的 `mcpServers` 逐个挂载官方 `@deepseek-ai/dsh-mcp-client`，于是这些 server 的工具
在该会话里直接可用，名字是 `mcp__<serverName>__<tool>`。

与「在 `cordis.patch.yml` 里逐个 insert mcp-client 行」的配置式 bundle 相比：
server 清单归项目所有、跟着仓库走，改 `.mcp.json` 即热重挂，不必再动 profile。

## 隔离语义（本插件的核心）

**MCP 实例挂在会话作用域（`agent.ctx`）下，不是 profile 根作用域。** `Agent.ctx` 的契约是
"contributions are agent-local, unwind on disposal, and reject registration afterward"，
因此：

- A 项目的会话**看不到** B 项目的任何 `mcp__*` 工具，也收不到 B 项目的 server instructions；
- 不同会话可以各挂一份**同名** server —— `dsh-mcp-client` 的 `serverName` 独占是按注册作用域
  算的（`scopeOf(ctx) ?? ctx.root`），所以工具名保持 `mcp__dbhub__execute_sql` 这种**无前缀**
  形态，与 Claude Code / Codex 一致。**不要**再引入命名空间前缀；
- 会话销毁时作用域自动回退，实例、watcher、工具注册一并回收，profile 层不留任何全局登记。

项目由**会话工作目录**（`agent.session.header.cwd`，创建时快照的 durable 元数据）决定，
从该目录向上找 `.mcp.json`（`searchUp`，默认开）—— 会话开在 `Modules/Orders` 这类子目录时
也能找到项目根的声明，这正是 Claude Code 的行为。

**代价**：一个会话一份实例。N 个会话同时开着就是 N 份 MCP 子进程 —— 这是隔离的必然成本，
官方设计如此（"独立 agent 作用域可以复用相同 namespace，因为其工具与传输彼此隔离"）。

## 安装

用 `plugin_manager` 的 `install_bundle`，target 指向本目录（绝对路径）：

```
plugin_manager(action: "install_bundle", target: "/data/ai/dsh/dsh_project_mcp")
```

安装会执行 `pnpm add <本目录>`（写入 `link:` 依赖）并把本 bundle 加进 profile 的
`dsh.profile.bundles`，随后 `cordis.patch.yml` 里的行生效。装完用
`Config.listConfigs`（`name: "@local/dsh-mcp-json"`）确认行在册，再实调一个
`mcp__<serverName>__<tool>` 才算验过。

## 配置（`cordis.patch.yml` 里本插件那一行的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `path` | `.mcp.json` | 配置文件名，或绝对路径 |
| `searchUp` | `true` | 从会话工作目录向上最多找 8 层（项目级语义靠它，默认开） |
| `projectDir` | `''` | 显式钉死项目目录，覆盖会话 cwd；留空即按会话走（正常用法） |
| `disabledServers` | `[]` | 按 `.mcp.json` 里的原始键跳过某些 server |
| `toolCallTimeoutMs` | `60000` | 透传给每个 server 的工具调用超时 |
| `failOnStartupError` | `false` | 真：任一 server 起不来即抛错；假：只告警 |
| `watch` | `true` | 监视本项目的 `.mcp.json`，变更后先停旧实例再起新实例 |

## `.mcp.json` 兼容面

读取 `mcpServers`（Claude Code 风格），其次 `servers`（VS Code 风格）。
每个条目按下表映射到 dsh-mcp-client 的 config：

| `.mcp.json` | 映射 |
|---|---|
| `type: "stdio"` 或存在 `command` | `transport: stdio`，`command` / `args` / `env` / `cwd` 透传 |
| `type: "http"` / `"streamable-http"` 或存在 `url` | `transport: streamable-http`，`url` / `headers` 透传 |
| `type: "sse"` | **不支持**：dsh-mcp-client 只有 stdio 与 streamable-http，该条目会被跳过并告警 |
| `cwd` 缺省 | 取 `.mcp.json` 所在目录（与 Claude Code 语义一致） |
| 键名含 `.` 等非法字符 | 规范化为 `[A-Za-z0-9_-]{1,32}`，并告警 |
| 规范化后重名（如 `a.b` 与 `a_b`） | 只保留前一条，后一条跳过并告警 —— 同一作用域内 `serverName` 独占 |

字符串字段（`command` / `args[]` / `env` / `url` / `headers` / `cwd`）支持
`${VAR}` 与 `${VAR:-default}` 展开，取自 Harness 进程的环境变量；**默认值里可以再嵌一层
占位符**（`${DSH_HOME:-${HOME}/.dsh}`：内层先落地、外层再取默认值）；未定义且无默认值
的占位符展开为空串并告警，解析不掉的残留占位符按原样保留并告警。
**密钥因此不必写进 `.mcp.json`。**

## 实现约束（改代码前先读）

1. **本模块只 import `node:` 内置模块。** 插件包以 `link:` 方式装进 profile，模块真实路径
   在插件仓库内，`@deepseek-ai/*` 这类裸包名从那里解析不到；被复用的官方客户端改为按锚点
   动态解析，逐个 `createRequire(...).resolve()`，顺序为：

   1. **Loader `ctx.baseUrl`** —— 生产环境唯一可靠的锚点。官方包被 hoist 在 profile 的
      **父级** `~/.dsh/profiles/node_modules`，而 Harness **宿主进程本身没有 `DSH_*`
      环境变量**（实测 `/proc/<pid>/environ` 里 `DSH_` 计数为 0，那是 shell 工具执行时
      才注入的 overlay）；
   2. `DSH_PROFILE_DIR` / `$DSH_HOME/profiles[/$DSH_PROFILE]` —— 程序化加载的兜底；
   3. 本模块目录、`process.cwd()` —— 仅当包被复制安装（非 `link:`）时才有用。

   解析失败**不缓存**，下次会重试，所以「当时解析不到」不会永久失效。
2. **不导出 `Config` schema**（那需要 import schemastery，违反约束 1），
   改为 `apply` 内手工校验，报错直接指到 `.mcp.json` 的具体条目。
3. **挂载发生在 `agent/created`（serial 事件）里并 await 到就绪。** 这是刻意的：官方保证
   agentCtx 里的注册在第一次 prompt 组装之前完成，若改成后台挂载，会话开头几步会看不到工具。
   代价是**会话创建要多等一次握手**（1~3 秒），所以 `STARTUP_TIMEOUT_MS`（默认 15s）是必需
   的兜底 —— 否则一个卡死的 server 会把会话创建永久挂住（真链实测会静默停摆到 SDK 自己的
   120 秒超时）。
4. **同一会话内的重挂必须串行，且「在途」实例也要能被停掉。** `serverName` 在同一作用域内
   独占，两次重挂交叠会漏 dispose：被删掉的 server 继续活着（孤儿 fiber + 泄漏的 MCP 子进程
   + 工具仍可见），并撞出虚假的 `already in use`。实现见 `createSessionMount` 里的
   `reloadChain` 与 `fibers` 登记。
5. **回收要带超时**（`DISPOSE_TIMEOUT_MS`，默认 10s）：真客户端的 `dispose()` 会等 MCP 子进程
   关闭，子进程一旦不响应就永不 resolve，而重挂是**串行链** —— 一次挂起会让此后所有重挂静默
   失效。超时后**不能直接遗忘**：登记簿里删掉它只是为了不堵链，实例本身可能还在跑，所以要记进
   `stuck`，在它真正结算前**跳过同名 server 的挂载**（避免新旧两个同名实例并存 —— 对 sqlite
   文件锁、端口、单会话设备这类真互斥资源，重叠就是起不来或状态错乱），结算后自动解除并触发
   一次自愈重挂。
   ⚠ 要防的**不是** `already in use`：真 Cordis 的 `_unload()` 用 `Promise.all` **并发**跑所有
   effect disposer，mcp-client 释放 `serverName` 的那一个在 dispose 一开始就执行完了，名字从不
   被长期占用。
6. **超时值必须校验**：`Number(env)` 碰到 `10s` / 空串 / `-1` 会得到 NaN/0/负数，而
   `setTimeout` 把它们当成 1ms —— 安全网反而变成「每次都立刻超时」。统一走 `positiveTimeout()`
   回落到默认值。
7. **watcher 必须在首次挂载之前注册**，否则挂载期间（可达数秒）写进来的 `.mcp.json` 改动会被
   静默吞掉、永不生效。

## 测试

```bash
npm test        # 等价于 node test/regress.mjs
```

`test/regress.mjs` 用 stub profile ctx + **可创建多个会话的 stub Harness** + 一个「忠实模拟
官方语义」的假 mcp-client（**serverName 按注册作用域独占**、连接耗时、effect 归属跟随 fiber）
驱动本插件，**35 个用例**覆盖：

- 声明表与字段映射、`${VAR}` 展开（含嵌套默认值）、不支持/非法声明、同一文件内重名；
- **隔离语义**：实例挂在会话作用域且 profile 层零挂载、两个会话同名 server 各一份、
  A 会话看不到 B 会话的工具、改 A 的配置完全不影响 B、会话销毁后实例回收；
- **项目定位**：会话 cwd 命中、子目录靠 `searchUp` 命中、`searchUp` 关闭时找不到、
  无声明不报错、`projectDir` 覆盖、无 cwd 时跳过；
- 错误路径（坏 JSON / 缺声明表 / 文件被删 / 单点失败不连坐）、热重挂（先停旧再起新、
  并发收敛、噪声不触发、首次挂载期间的改动不丢）；
- 超时兜底（正常回收无假告警、启动卡死不堵链、dispose 挂起不堵链、stuck 期间不重挂）。

只依赖 `node:` 内置模块，临时目录建在 `os.tmpdir()`，不碰仓库。

### 真链 E2E（在活着的 Harness 上跑）

`test/fixtures/` 有两个真实 MCP 服务端夹具（同样只用 `node:` 内置模块）：

| 夹具 | 传输 | 暴露 |
|---|---|---|
| `mcp-stdio-server.mjs` | stdio（换行分隔 JSON-RPC） | 工具 `echo`、资源 `fixture://stdio/greeting` |
| `mcp-http-server.mjs` | streamable-http（`POST /mcp` + `Mcp-Session-Id`） | 工具 `echo`、资源 `fixture://http/greeting` |

**隔离的验证方式**（需要两个不同工作目录的会话）：

1. 在项目 A 的会话里看工具列表：应当**只有** A 项目的 `mcp__*`；
2. 在项目 B 的会话里看：只有 B 项目的；
3. 两个项目的 `.mcp.json` 都声明同名 server（如都叫 `dbhub`）时，两边的工具名都是
   `mcp__dbhub__*`，各自连各自的 —— 这正是隔离生效的标志（旧的全局实现会撞 `already in use`）。

## 已知边界

- **改了本插件的 JS 需要重启 Harness 才生效。** 包以 `link:` 装进 profile，Node 的 ESM
  模块缓存按解析后的 URL 命中；`plugin_manager` 的禁用/启用只会重新挂载 fiber，不会重新
  `import()` 模块。**本插件所在目录不在 HMR 的监视集内**，所以改 `index.js` 一律要重启；
  改 `.mcp.json` 则不需要（走本插件自己的热重挂）。
- **会话创建会等 MCP 就绪**（见实现约束 3）：`.mcp.json` 里有慢 server 时，开会话会慢几秒。
  超过 `STARTUP_TIMEOUT_MS` 的那个 server 本轮不挂载（工具缺席，日志有告警），下次重挂再试。
- **项目目录被整体删掉再重建后，该项目在重启前不再热重挂**：底层 inotify watch 随目录消失
  而失效，Node 不会自动重挂；插件只在 watcher 的 `error` 上告警，不做看门狗轮询（重建需要
  一个「目录已回来」的事件源，常驻定时器的代价大于收益）。`rm -rf && clone`、worktree 换出、
  容器挂载重建都会踩到 —— 重开会话或重启 Harness 即恢复。
- **`config.path` 为绝对路径时所有会话都指向同一个文件**：此时项目定位失效，等价于把该文件
  的 server 挂给每个会话。
- **`path` 含子目录、且该子目录本身还不存在时，首次创建仍发现不了**：watcher 会因目标目录
  不存在而跳过（子目录已存在则正常）。先建目录即可。
- **解析失败的处置分两种，这是刻意的**：`.mcp.json` 写坏（坏 JSON / 缺声明表）→ 保留当前
  实例不动，避免手抖一次就把在跑的 MCP 全停掉；文件被删 → 停掉该会话的全部实例（声明没了）。
- 不接管 MCP resources（那是 `@deepseek-ai/dsh-mcp-resources` 的活）。
- 宿主项目的 `.gitignore` 常常忽略 `.mcp.json`（腊梅商城就在第 59 行），此时声明属本地
  配置、不随仓库分发；要共享就改用 `.mcp.json.example` 或与用户确认后调整忽略规则。
