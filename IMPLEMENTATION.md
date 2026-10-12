# 实现思路

面向改这个插件的人（人和代理）。**怎么用**见 [README.md](README.md)，这里是**为什么这么写**：
设计决策、并发与超时的取舍、以及每一条约束背后踩过的坑。

源码只有一个文件：[index.js](index.js)（744 行）；测试在 [test/regress.mjs](test/regress.mjs)。

## 一页总览：数据流

```
Harness 启动
  └─ apply(ctx, config)                        profile 作用域
       ├─ normalizeOptions(config)             手工校验（不导出 Config schema，见约束 2）
       ├─ getClient()                          预解析官方客户端：装没装好，启动时就暴露在日志里
       └─ ctx.on('agent/created', …)           每个新会话一次，serial 事件

会话创建（agent/created）
  ├─ cwd = agent.session.header.cwd            项目定位基准（创建时快照的 durable 元数据）
  ├─ createSessionMount(agent.ctx, cwd, …)     所有注册都发生在 agent.ctx 下
  │    ├─ watcher 先注册（agentCtx.effect）     ← 必须在首次挂载之前，见约束 7
  │    └─ mount.start() → reload()             串行链的第一环
  └─ await 到就绪（或 STARTUP_TIMEOUT_MS 超时） 刻意的阻塞，见约束 3

一次挂载（performReload）
  ├─ locateConfigFileIn(base, options)         base 起逐级向上找，最多 8 层
  ├─ readServerSpecs(file, options)            JSON → 声明表 → 逐条翻译成 mcp-client config
  ├─ releaseAll()                              先停旧
  ├─ 剔除 stuck 里的 serverName                回收未结算的不重挂，见生命周期
  └─ agentCtx.plugin(client, spec) × N         并发挂载，每个等握手（STARTUP_TIMEOUT_MS 封顶）
```

工具出现在会话里的名字是 `mcp__<serverName>__<tool>`，由官方客户端按 `config.serverName` 生成。

## 三条不可动摇的设计决策

### D1 挂在会话作用域（`agent.ctx`），不是 profile 根作用域

这是本插件的存在理由。`Agent.ctx` 的契约是 "contributions are agent-local, unwind on
disposal, and reject registration afterward"：注册跟着会话生、跟着会话死，profile 层不留
全局登记。于是 A 项目的会话看不到 B 项目的任何工具，也无法收到 B 项目的 server instructions。

**关键推论：工具名不需要命名空间前缀。** `dsh-mcp-client` 的 `serverName` 独占是按**注册
作用域**算的（`scopeOf(ctx) ?? ctx.root`），所以两个会话可以各挂一份同名 `dbhub`，两边工具名
都是 `mcp__dbhub__execute_sql` —— 与 Claude Code / Codex 一致。v1 的 `projects[]` + 前缀消歧
（`mcp__projA__dbhub__…`）在新语义下是纯粹的负担，已删除。

代价是**一个会话一份实例**：N 个会话同时开着就是 N 份 MCP 子进程。官方设计如此
（"独立 agent 作用域可以复用相同 namespace，因为其工具与传输彼此隔离"），不接受这个代价就
拿不到隔离。

### D2 项目由会话工作目录决定，并向上找

`agent.session.header.cwd` 是创建时快照的 durable 元数据，比「进程当前目录」稳定得多（后者会
被一次 `bash cd` 带跑）。从它出发 `searchUp` 向上找 `.mcp.json`，会话开在 `Modules/Orders`
这类子目录时也能命中项目根的声明 —— 这正是 Claude Code 的行为，也是 `.mcp.json` 属于「项目」
而不是「目录」的体现。

`projectDir` 只作为逃生口保留（显式钉死某个目录）；绝对 `path` 会让所有会话指向同一文件，
此时项目定位事实上失效，README 的「已知边界」有记录。

### D3 挂载发生在 `agent/created` 里并 await 到就绪

官方保证 agentCtx 里的注册在第一次 prompt 组装之前完成。若改成后台挂载，会话开头几步看不到
工具（模型会以为这个项目没有 MCP，甚至先去找配置文件）。所以这里**刻意阻塞会话创建**。

代价：开会话要多等一次握手（实测 1~3 秒），且一个卡死的 server 会把会话创建永久挂住 ——
真链实测会静默停摆到 SDK 自己的 120 秒超时。因此 `STARTUP_TIMEOUT_MS`（默认 15s）不是优化，
是**必需的安全网**。超时的 server 本轮不挂载、工具缺席、日志告警，实例留在登记簿里等下次重挂
重新评估（卡死解除后自然收敛）。

## 源码结构

| 区段 | 函数 | 职责 |
|---|---|---|
| 常量 | `positiveTimeout` + `STARTUP_TIMEOUT_MS` / `DISPOSE_TIMEOUT_MS` / `DEFAULTS` / `MAX_SEARCH_UP_LEVELS` / `RELOAD_DEBOUNCE_MS` / `SERVER_NAME_MAX_LENGTH` / `MAX_EXPAND_PASSES` | 全部可调项集中在此 |
| 配置 | `normalizeOptions` | 手工校验 + 补默认值，非法类型显式抛错 |
| 变量展开 | `expandEnv` / `expandStringList` / `expandStringMap` | `${VAR}` / `${VAR:-default}`，多轮展开（`MAX_EXPAND_PASSES`） |
| 声明解析 | `sanitizeServerName` / `locateConfigFileIn` / `normalizeServer` / `readServerSpecs` | `.mcp.json` → mcp-client config 列表 + `skipped` / `warnings` |
| 官方客户端 | `resolveAnchors` / `loadMcpClient` | 按锚点顺序动态解析并 `import()` |
| 会话挂载 | `createSessionMount`：`release` / `releaseAll` / `performReload` / `reload` / `stuck` / `stuckSettled` | 注册簿、串行链、双超时、watcher |
| 入口 | `apply` | 校验配置、预解析客户端、`agent/created` 监听 |

诊断一律通过 `notes` / `warnings` 数组收集，由调用方决定怎么记日志 —— 纯函数好测。

## 声明解析：`.mcp.json` → mcp-client config

1. **读表**：`mcpServers` 优先，其次 `servers`（VS Code 风格）。顶层不是对象、没有声明表，
   都抛错（由调用方决定保留旧实例，见下）。
2. **跳过**：`disabledServers` 按**原始键**匹配（在规范化之前）。
3. **规范化键**：`sanitizeServerName` 把非 `[A-Za-z0-9_-]` 换成 `_` 并截到 32 字符
   （与 dsh-mcp-client 的校验一致）。改名会告警。
4. **判传输**：
   - 有 `command`（或 `type: stdio`）→ `transport: stdio`，`cwd` 缺省取 `.mcp.json` 所在目录，
     相对 `cwd` 也按该目录解析（与 Claude Code 语义一致）；
   - 有 `url`（或 `type: http` / `streamable-http`）→ `transport: streamable-http`；
   - 同时给了 `command` 与 `url` 又没写 `type` → 报错（猜传输比报错更危险）；
   - `type: "sse"` → 跳过并说明（dsh-mcp-client 只有 stdio 与 streamable-http）。
5. **重名**：规范化后重名的条目只保留**第一条**，后一条跳过并告警 —— 同一作用域内 `serverName`
   独占，两条同名 spec 必然有一条起不来，早点说清楚比晚点撞 `already in use` 好。
6. **变量展开**：`ENV_VAR_PATTERN` 的默认值部分写成 `[^{}]*`，故意不含花括号，于是
   `${A:-${B}/x}` 会在**下一轮**才被外层匹配 —— 内层先落地、外层再取默认值，这正是
   `${DSH_HOME:-${HOME}/.dsh}` 需要的语义。
   变量未定义**或为空串**都走默认值分支（空串当未定义，避免 `VAR=` 把配置悄悄变空）；
   既未定义又无默认值 → 空串 + 告警；残留占位符按原样保留 + 告警。

**两种错误处置是刻意的**（改之前先想清楚）：

- `.mcp.json` 写坏（坏 JSON / 缺声明表 / 顶层不是对象）→ **保留当前实例不动**。手抖一次不该
  把在跑的 MCP 全停掉，工具还在，日志里有 error。
- 文件被删 / 再也找不到 → **停掉该会话的全部实例**。声明没了，实例不该继续活着。

## 生命周期与并发控制

### 回收：`release`

`fiber.dispose()` 等 MCP 子进程关闭，子进程一旦不响应就**永不 resolve**。而重挂是串行链，一次
挂起会让此后所有重挂静默失效，所以回收必须有超时（`DISPOSE_TIMEOUT_MS`，默认 10s）。

超时后**不能直接遗忘**：登记簿里删掉它只是为了不堵链，实例本身可能还在跑。立刻重挂同名 server
会让新旧两个实例并存 —— 对 sqlite 文件锁、端口、单会话设备这类真互斥资源，重叠就是起不来或
状态错乱。所以记进 `stuck`，在它真正结算前**跳过同名 server 的挂载**，结算后自动解除并触发一次
自愈重挂（`stuckSettled`）。

还有两个细节：

- 超时定时器必须在 `finally` 里 `clearTimeout`：dispose 秒回时定时器照样会触发，留下一条
  「放弃等待」的假告警 —— 真挂起与正常回收就再也分不出来了（回归用例守着这条）。
- 要防的**不是** `already in use`：真 Cordis 的 `_unload()` 用 `Promise.all` **并发**跑所有
  effect disposer，mcp-client 释放 `serverName` 的那一个在 dispose 一开始就执行完了，名字从不
  被长期占用。真正的问题只有一个 —— 漏 dispose。

### 重挂：`reload` 串行链

```
reload() = reloadChain.then(() => performReload())   // 排队
reloadChain = next.then(noop, noop)                  // 吞错，单次失败不卡死后续
```

两次重挂交叠会：漏 dispose 在途实例（孤儿 fiber + 泄漏的 MCP 子进程 + 工具仍可见），以及让
后完成者用旧列表覆盖登记簿、撞出虚假的 `already in use`。所以入口只有一个，而且是链式的
——`performReload` 内部才对 N 个 server 做 `Promise.all` 并发。

### watcher：注册时机与触发面

`agentCtx.effect` 里注册（会话销毁随之关闭，不留全局监听），且**先于首次挂载**：挂载可能耗时
数秒，这几秒里写进来的 `.mcp.json` 改动没有事件源就会被静默吞掉、永不生效。

- 只认目标文件本身（`changed !== filename` 直接返回）：目录里 `.phpunit.result.cache` 这类
  高频变动不该带跑重挂；事件后有 `RELOAD_DEBOUNCE_MS`（250ms）防抖。
- 文件还没出现时，盯它「应该出现」的目录；`path` 可能含子目录（`config/mcp.json`），
  文件名必须取 `basename`，否则 `fs.watch` 报的 basename 永远匹配不上。
- `searchUp` 打开时，祖先目录里之后才出现的文件同样要有事件源，所以那些目录一并监视。
- 目录被整体删掉（`rm -rf`、worktree 换出）时底层 watch 失效，只告警不重建：重建需要一个
  「目录已回来」的事件源，看门狗轮询要挂常驻定时器，代价大于收益。

## 复用官方客户端：锚点与动态解析

本模块**只 import `node:` 内置模块**（约束 1）。插件包以 `link:` 方式装进 profile，模块真实路径
在插件仓库内，`@deepseek-ai/*` 这类裸包名从那里解析不到；被复用的官方客户端改为按锚点动态解析，
逐个 `createRequire(...).resolve()`：

1. **`ctx.baseUrl`** —— Loader 树根的 file URL，**生产环境唯一可靠的锚点**。官方包被 hoist 在
   profile 的**父级** `~/.dsh/profiles/node_modules`，而 Harness **宿主进程本身没有 `DSH_*`
   环境变量**（实测 `/proc/<pid>/environ` 里 `DSH_` 计数为 0，那是 shell 工具执行时才注入的
   overlay）；
2. `DSH_PROFILE_DIR` / `$DSH_HOME/profiles[/$DSH_PROFILE]` —— 程序化加载的兜底；
3. 本模块目录、`process.cwd()` —— 仅当包被复制安装（非 `link:`）时才有用。

解析失败**不缓存**，下次重试，所以「当时解析不到」不会永久失效；`apply` 启动时预解析一次，
让「官方客户端装没装好」在 Harness 启动时就暴露在日志里，而不是等用户开会话才发现。

## 八条实现约束（改代码前先读）

1. **只 import `node:` 内置模块。** 见上一节。
2. **不导出 `Config` schema。** 那需要 import schemastery，违反约束 1；改为 `apply` 内手工校验，
   报错信息直接指到 `.mcp.json` 的具体条目。
3. **同一会话内的重挂必须串行，且在途实例也要能被停掉。** 见「重挂：`reload` 串行链」。
4. **启动与回收都要带超时，且超时后不能遗忘。** 见「回收：`release`」。
5. **超时值必须过 `positiveTimeout()`。** `Number(env)` 碰到 `10s` / 空串 / `-1` 会得到
   NaN/0/负数，而 `setTimeout` 把它们当成 1ms —— 安全网反而变成「每次都立刻超时」。
6. **watcher 必须在首次挂载之前注册。** 见「watcher：注册时机与触发面」。
7. **任何 MCP 注册都必须挂在 `agentCtx`。** profile 层零挂载是隔离的核心断言，回归里有专门用例。
8. **错误处置分两种（保留 / 停实例），是刻意的。** 见「声明解析」结尾。

## 测试怎么设计

跑法见 README。设计意图：

**为什么用假 mcp-client。** 本套用例要断言的是**插件的编排行为**（挂到哪个作用域、什么时候停、
什么时候起、谁被跳过），而真客户端会真的起子进程、握手、列工具，既慢又难制造「重挂交叠」
「握手卡死」「dispose 挂起」这些场景。假客户端只保留三条关键语义：

1. `serverName` 在**一个注册作用域内**独占（`WeakMap` keyed by 作用域 ctx）—— 这条正是隔离
   语义的根基：不同会话可以各挂一份同名 server；
2. 连接有耗时（`FAKE_DELAY_MS`，默认 400ms）；
3. effect 的归属跟随发起它的那个 fiber。

**stub Harness 的要点。** 一个 profile 级 ctx + `createSession(cwd)` 造任意多个会话；每个会话
有自己的存活集合（`live`），这样才能断言「A 会话看不到 B 会话的工具」；`plugin.apply` 收到的是
**agentCtx 本身**（假客户端拿它当作用域 key），与真实现一致。profile 级 `ctx.plugin` 被写成
「一旦被调用就抛错」，把「profile 零挂载」变成结构性断言而不是靠翻日志。

**特殊前缀**：`stall*` = 握手永不返回（测启动超时），`hang*` = dispose 永不结算（测回收超时）。

**超时必须压缩**：插件默认 15s / 10s，用例里靠 `MCP_JSON_STARTUP_TIMEOUT_MS` /
`MCP_JSON_DISPOSE_TIMEOUT_MS` 压到 400ms，否则相关用例要跑几十秒。这两个变量必须在
`import` 插件**之前**设置（模块加载时求值）。它们是给回归用的逃生口，生产别依赖。

**每个用例必须 `dispose()`**（`test()` 统一做）：watcher 是 `agentCtx.effect` 注册的，不回收会
一直盯着同一个目录，后面的用例每写一次文件都会把前面所有 harness 一起触发。

**真链必须由活 Harness 验证**：插件代码不在 HMR 的监视集里，改了要重启 Harness 才生效。
`test/fixtures/` 下两个真 MCP 服务端（stdio / streamable-http）可直接被任何项目的 `.mcp.json`
引用，验证步骤在 README。

## 明确不做的事

| 不做 | 理由 |
|---|---|
| 命名空间前缀（`mcp__projA__…`） | 会话级作用域已经隔离，前缀只会让工具名与 Claude Code 不一致 |
| 接管 MCP resources | 那是 `@deepseek-ai/dsh-mcp-resources` 的活 |
| 目录重建看门狗轮询 | 需要一个常驻定时器，代价大于收益（重开会话即恢复） |
| 导出 `Config` schema | 需要 import schemastery，与「只用 `node:`」冲突 |
| 后台（不 await）挂载 | 会话开头几步会看不到工具，见 D3 |
| 解析失败后立刻重挂同名 server | 新旧实例可能并存，见「回收：`release`」 |
| 超时后直接遗忘挂起实例 | 同上：忘了登记簿，实例还在跑 |

## 相关文件

| 文件 | 关系 |
|---|---|
| [README.md](README.md) | 用法：安装、配置表、`.mcp.json` 写法、排错、已知边界 |
| [index.js](index.js) | 全部实现 |
| [test/regress.mjs](test/regress.mjs) | 35 个回归用例 |
| [test/fixtures/](test/fixtures) | 真 MCP 服务端夹具（stdio / streamable-http） |
| [cordis.patch.yml](cordis.patch.yml) | profile 里的插入行与默认 config |
| [AGENTS.md](AGENTS.md) | 给代理的速查：命令、约束清单、改动连带项 |
