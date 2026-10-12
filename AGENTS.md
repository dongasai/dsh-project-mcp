# AGENTS.md

给 AI 编码代理的项目须知。文档分工：[README.md](README.md) 讲**怎么用**（安装、配置表、
`.mcp.json` 兼容面、排错、真链 E2E、已知边界），[IMPLEMENTATION.md](IMPLEMENTATION.md) 讲
**为什么这么实现**（设计决策、并发与超时取舍、八条约束的来龙去脉）。与代码冲突时以代码为准。

## 项目是什么

`@local/dsh-mcp-json` —— DSH 插件：读取**当前会话所在项目**的 `.mcp.json`（Claude Code 风格的
`mcpServers` 声明），把每个 server 挂成一份官方 `@deepseek-ai/dsh-mcp-client` 实例，于是工具以
`mcp__<serverName>__<tool>` 出现在该会话里。

三句话概括设计：实例挂在**会话作用域**（`agent.ctx`，不是 profile 根）；项目由**会话工作目录**
决定并 `searchUp` 向上找 `.mcp.json`；文件变更即**热重挂**。隔离是本插件的存在理由 ——
A 项目的会话看不到 B 项目的任何 `mcp__*` 工具。

## 命令

| 目的 | 命令 |
|---|---|
| 回归测试（唯一必跑） | `npm test` —— 等价 `node test/regress.mjs`，35 个用例，约 34 秒 |
| 语法自检 | `node --check index.js` |
| 真链 E2E | 按 README「真链 E2E」在活 Harness 上跑，需两个不同 cwd 的会话 |

无构建、无 lint、无依赖安装：`package.json` 没有 `dependencies`，代码只用 `node:` 内建模块。

**改 `index.js` 后必须重启 Harness 才生效**：包以 `link:` 装进 profile，本目录不在 HMR 的监视集
内，`plugin_manager` 的禁用/启用只会重挂 fiber、不会重新 `import()` 模块。只改 `.mcp.json`
不需要重启（走插件自己的热重挂）。

## 文件地图

| 文件 | 作用 |
|---|---|
| [index.js](index.js) | 插件全部实现（唯一生产代码，744 行） |
| [test/regress.mjs](test/regress.mjs) | 35 个回归用例：stub ctx + 可多会话 stub Harness + 假 mcp-client |
| [test/fixtures/mcp-stdio-server.mjs](test/fixtures/mcp-stdio-server.mjs) | 真 stdio MCP 服务端夹具（工具 `echo`） |
| [test/fixtures/mcp-http-server.mjs](test/fixtures/mcp-http-server.mjs) | 真 streamable-http 服务端夹具（`POST /mcp`） |
| [cordis.patch.yml](cordis.patch.yml) | 插进 profile 的那一行（默认 config） |
| [locale/zh.json](locale/zh.json) / [locale/en.json](locale/en.json) | 插件列表里的标题与描述 |
| [README.md](README.md) | **怎么用**：安装、配置表、兼容面、排错、真链 E2E、已知边界 |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | **为什么**：设计决策、并发/超时取舍、八条约束的来龙去脉 |
| [AGENTS.md](AGENTS.md) | 本文件：命令、约束清单、测试规范、改动连带项 |

`index.js` 内部顺序：常量 → 配置归一化（`normalizeOptions`）→ `${VAR}` 展开（`expandEnv` /
`expandStringList` / `expandStringMap`）→ 声明翻译（`sanitizeServerName` / `normalizeServer` /
`readServerSpecs`）→ 官方客户端动态解析（`resolveAnchors` / `loadMcpClient`）→ 会话挂载
（`createSessionMount`：`release` / `releaseAll` / `performReload` / `reload` 串行链 / `stuck`）
→ 入口 `apply`。

## 硬性约束（违反即出 bug，别试探）

完整来龙去脉与取舍见 [IMPLEMENTATION.md](IMPLEMENTATION.md) —— 这里是要背下来的规则。

1. **只 import `node:` 内建模块**，不新增任何依赖。`@deepseek-ai/*` 一律经 `resolveAnchors()` +
   `createRequire(...).resolve()` 动态解析（锚点顺序：`ctx.baseUrl` → `DSH_PROFILE_DIR` →
   `$DSH_HOME/profiles[/$DSH_PROFILE]` → 本模块目录 → `process.cwd()`）；解析失败**不缓存**，
   下次重试，所以“当时解析不到”不会永久失效。
2. **不导出 `Config` schema**（那需要 import schemastery，与约束 1 冲突）；配置校验手工写在
   `normalizeOptions` 里，非法类型显式抛错，不要静默降级。
3. **任何 MCP 注册都必须挂在 `agentCtx`**，profile 作用域零挂载 —— 回归用例
   `实例挂在会话作用域，profile 作用域零挂载` 正守着这条。工具名保持无前缀形态，不要再引入
   命名空间前缀。
4. **同一会话内的重挂必须走 `reload()` 那条串行链**。两次重挂交叠会漏 dispose 在途实例：
   孤儿 fiber + 泄漏的 MCP 子进程 + 工具仍可见，并撞出虚假的 `already in use`。
5. **启动与回收都要带超时**（`STARTUP_TIMEOUT_MS` / `DISPOSE_TIMEOUT_MS`）。真客户端的
   `dispose()` 会等子进程关闭，可能永不 resolve，而重挂是串行链 —— 一次挂起会让此后所有重挂
   静默失效。超时后**不能直接遗忘**：要记进 `stuck`，在它真正结算前跳过同名 server 的挂载
   （新旧同名实例并存时，sqlite 文件锁、端口这类真互斥资源会起不来或状态错乱），结算后自动
   解除并触发一次自愈重挂。
6. **超时值必须过 `positiveTimeout()`**：`Number('10s')` / 空串 / `-1` 会得到 NaN/0/负数，而
   `setTimeout` 把它们当 1ms —— 安全网反而变成“每次都立刻超时”。
7. **watcher 必须在首次挂载之前注册**（`agentCtx.effect` 里，先于 `mount.start()`），否则挂载
   期间（可达数秒）写进来的 `.mcp.json` 改动会被静默吞掉、永不生效。
8. **两种错误处置是刻意区分的**：`.mcp.json` 写坏（坏 JSON / 缺声明表）→ 保留当前实例不动，
   别因为手抖一次就把在跑的 MCP 全停掉；文件被删 → 停掉该会话的全部实例。改这个行为前先看
   [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「声明解析」一节。

## 代码风格

- 中文 JSDoc（`@param` / `@returns` / `@throws`）；注释解释**为什么**——尤其是反直觉的取舍
  （超时兜底、stuck 跳过、锚点顺序），不解释语法。
- 无分号、单引号、2 空格缩进；`function` 声明 + 顶层 `const` 常量；工具函数保持纯函数
  （诊断用 `notes` / `warnings` 数组收集，由调用方决定怎么记日志）。
- 报错与告警文本以 `mcp-json:` 开头，尽量指到具体条目（`mcpServers.<name>: ...`）；日志走
  `ctx.logger('mcp-json')`，不要 `console.log`。
- 环境变量是**逃生口**（测试用），不是配置面：`MCP_JSON_STARTUP_TIMEOUT_MS` /
  `MCP_JSON_DISPOSE_TIMEOUT_MS` 只给回归测试压缩等待时间，生产不要依赖。

## 测试规范

- 改任何行为都要在 [test/regress.mjs](test/regress.mjs) 加/改用例；用例名是中文一句话，描述
  **断言的行为**；修掉旧 bug 时在名字里点出「回归：<曾经的 bug>」。
- 假 mcp-client 只保留三条关键语义：`serverName` **按注册作用域**独占（`WeakMap` keyed by
  ctx）、连接有耗时、effect 归属跟随发起它的 fiber。特殊前缀：`stall*` = 握手永不返回，
  `hang*` = dispose 永不结算。
- 用例里用 `createHarness()` 造 stub、`createSession(cwd)` 造会话，断言 `s.servers()` 与
  `text(h.events)`；每个用例由 `test()` 统一 `dispose()` —— watcher 不回收会一直盯着同一目录，
  把后续用例全带跑。
- 临时目录建在 `os.tmpdir()`，**不要在仓库内写文件**。
- 两个超时环境变量必须在 `import` 插件**之前**设置（模块加载时求值），别写进用例体内。
- 收尾标准：`npm test` 全绿（当前 35/35，加了用例则总数相应变化）。

## 提交

历史格式：`<类型>(<范围>): <中文描述>`，例如
`重构(MCP 插件): 改为会话级挂载，项目之间真隔离`。类型用「功能 / 修复 / 重构 / 文档 / 测试」。

## 改动连带项

- 增删配置项 → 同步 `DEFAULTS`、`normalizeOptions` 校验、[cordis.patch.yml](cordis.patch.yml)
  注释、README 配置表。
- 动 `.mcp.json` 兼容面 → 同步 README 映射表，以及 `readServerSpecs` 的跳过/告警文案。
- 动挂载 / 回收 / 超时逻辑 → 同步 [IMPLEMENTATION.md](IMPLEMENTATION.md) 的「生命周期与并发控制」
  与「八条实现约束」。
- 已知边界（目录被整体删掉重建后本会话不再热重挂、绝对 `path` 使项目定位失效、`.mcp.json`
  常被宿主项目 `.gitignore` 忽略等）写在 README 末尾；没真正解决之前不要从文档里删掉。
- **文档分工别混**：README 只回答「怎么用」（用户视角的问题进排错表 / 已知边界），
  IMPLEMENTATION 只回答「为什么」；别让 README 重新长出实现细节。
