# @local/dsh-mcp-json

把**项目自己声明的 MCP**（`.mcp.json`）搬进 DSH：读取项目根的 `.mcp.json`，
按其中的 `mcpServers` 逐个挂载官方 `@deepseek-ai/dsh-mcp-client`，于是这些 server
的工具在当前 Harness 会话里直接可用，名字是 `mcp__<serverName>__<tool>`。

与「在 `cordis.patch.yml` 里逐个 insert mcp-client 行」的配置式 bundle 相比：
server 清单归项目所有、跟着仓库走，改 `.mcp.json` 即热重挂，不必再动 profile。

一个 profile 可以同时服务**多个项目**（见下文「多项目与命名空间」）。

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
| `projectDir` | `''`（= `process.cwd()`） | 单项目写法：`.mcp.json` 的定位基准，同时是 stdio server 的默认 `cwd` |
| `projects` | `[]` | 多项目写法：项目源数组，每项是 `{ dir }` 或 `{ scanRoot, depth }`，见下节 |
| `namespace` | `'auto'` | 工具名前缀策略：`auto`（显式源 >1 或含 `scanRoot` 时加）/ `always` / `never` |
| `path` | `.mcp.json` | 配置文件名或绝对路径 |
| `searchUp` | `false` | 未命中时从 `projectDir` 向上最多找 8 层 |
| `disabledServers` | `[]` | 按 `.mcp.json` 里的原始键跳过某些 server（跨所有项目生效） |
| `toolCallTimeoutMs` | `60000` | 透传给每个 server 的工具调用超时 |
| `failOnStartupError` | `false` | 真：任一 server 起不来即抛错（插件行标记 failed）；假：只告警 |
| `watch` | `true` | 监视各项目的 `.mcp.json`，变更后先停旧实例再起新实例 |

`projectDir` 与 `projects` 可以同时给，`projectDir` 会作为其中一个项目源参与。
一个项目源都没有时退回 `process.cwd()`。

## 多项目与命名空间

`dsh-mcp-client` 的 `serverName` 是**进程级独占**的（内部 `WeakMap` keyed by
`ctx.root`）：两个项目都声明 `dbhub` 时，不加区分地挂载必然有一条起不来，并撞出
`serverName "dbhub" is already in use`。所以多项目下要给工具名加前缀：

```
mcp__lamei_dbhub__execute_sql          # projects[0].prefix = "lamei"
mcp__project_mcp_demo_echo__echo       # 前缀取自目录名
```

前缀的来源与开关：

- `namespace: 'auto'`（默认）—— **配置里显式项目源 > 1，或存在 `scanRoot` 源**时加前缀；
  只写一个 `projectDir` 时不加，工具名与单项目时代完全一致（向后兼容）。
  判据刻意不取「扫描命中几个目录」：`scanRoot` 的命中数天然随目录增删而变，拿它当判据
  的话，新项目一出现就会把其余项目的工具名集体改名 —— 而工具名被 agent preset、
  记忆、文档写死是常态。
- `namespace: 'always'` —— 单项目也加前缀。
- `namespace: 'never'` —— 从不用前缀；跨项目重名时**只保留第一个**，其余跳过并告警。
- 每项可用 `prefix` 显式指定，否则取项目目录名（`basename`）。前缀会被洗成
  `[A-Za-z0-9_-]`，总长触顶 32 字符时**截 server 名、保前缀**：前缀是唯一的消歧手段，
  丢了它两个项目的同名 server 就会撞成一条，而用户照文档加 `prefix` 也救不回来
  （前缀根本没参与拼接）。名字被截会单独告警。
- ⚠ **两个不同路径的项目若目录名相同**（如 `/a/foo` 与 `/b/foo`），自动前缀会撞成同一个
  `foo`，第二条被跨项目重名检查跳过并告警 —— 这种情形请用 `prefix` 显式区分。
  插件选择「拦下并告警」而不是「自动加序号」：自动改名会让工具名变得不可预测。

项目源的两种形态：

```yaml
projects:
  - dir: /data/project/shop/lamei_shop   # 直接点名
    prefix: lamei
  - scanRoot: /data/ai/dsh               # 递归发现带 .mcp.json 的目录
    depth: 1
```

`scanRoot` 只认「目录里直接有 `.mcp.json`」，不往上找（`searchUp` 是单项目时代的
语义，多项目下会让多个项目命中同一个文件）；跳过隐藏目录与
`node_modules` / `.git` / `vendor` / `dist` / `build` / `coverage` / `.cache` 等。

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
| 规范化后重名（如 `a.b` 与 `a_b`） | 只保留前一条，后一条跳过并告警 —— `serverName` 是进程级独占 |

字符串字段（`command` / `args[]` / `env` / `url` / `headers` / `cwd`）支持
`${VAR}` 与 `${VAR:-default}` 展开，取自 Harness 进程的环境变量；**默认值里可以再嵌一层
占位符**（`${DSH_HOME:-${HOME}/.dsh}`：内层先落地、外层再取默认值）；未定义且无默认值
的占位符展开为空串并告警，解析不掉的残留占位符按原样保留并告警。
**密钥因此不必写进 `.mcp.json`。**

## 实现约束（改代码前先读）

1. **本模块只 import `node:` 内置模块。** 插件包以 `link:` 方式装进 profile，
   模块真实路径在插件仓库内，`@deepseek-ai/*` 这类裸包名从那里解析不到；
   被复用的官方客户端改为按锚点动态解析，逐个 `createRequire(...).resolve()`，顺序为：

   1. **Loader `ctx.baseUrl`** —— 生产环境唯一可靠的锚点。官方包被 hoist 在 profile 的
      **父级** `~/.dsh/profiles/node_modules`，而 Harness **宿主进程本身没有 `DSH_*`
      环境变量**（实测 `/proc/<pid>/environ` 里 `DSH_` 计数为 0，那是 shell 工具执行时
      才注入的 overlay）；
   2. `DSH_PROFILE_DIR` / `$DSH_HOME/profiles[/$DSH_PROFILE]` —— 程序化加载的兜底；
   3. 本模块目录、`process.cwd()` —— 仅当包被复制安装（非 `link:`）时才有用。

   解析失败**不缓存**，下次重挂会重试，所以「当时解析不到」不会永久失效。
2. **不导出 `Config` schema**（那需要 import schemastery，违反约束 1），
   改为 `apply` 内手工校验，报错直接指到 `.mcp.json` 的具体条目。
3. **热重挂必须串行，且「在途」实例也要能被停掉。** `dsh-mcp-client` 的 `serverName`
   是进程级独占（内部按 `scopeOf(ctx) ?? ctx.root` 记名），两次重挂交叠会漏 dispose：
   被删掉的 server 继续活着（孤儿 fiber + 泄漏的 MCP 子进程 + 工具仍可见），并撞出虚假的
   `already in use`。实现见 `createFiberRegistry`（`ctx.plugin()` 返回即入册，不等
   `await` 完成）与 `apply` 里的 `reloadChain`（promise 链排队）。另外两条同样是血泪：
   - **登记簿要记来源文件**，`releaseMissing` 才能在「全部文件解析失败、决定保留旧实例」
     时，把「来源已经不在本次扫描里」的实例挑出来回收。否则它是**永久幽灵**：继续占
     `serverName`、继续跑 MCP 子进程，`cwd` 还指向已删除的目录。
   - **回收要带超时**（`DISPOSE_TIMEOUT_MS`，可用 `MCP_JSON_DISPOSE_TIMEOUT_MS` 覆盖，
     仅供回归测试压缩）：真客户端的 `dispose()` 会等 MCP 子进程关闭，子进程一旦不响应就
     永不 resolve，而重挂是**串行链** —— 一次挂起会让此后所有项目的热重挂静默失效。
     超时后**不能直接遗忘**：登记簿里删掉它只是为了不堵链，实例本身可能还在跑。插件把它
     记进 `stuck`，在真正结算前**跳过同名 server 的挂载**（避免新旧两个同名实例并存 ——
     对 sqlite 文件锁、端口、单会话设备这类真互斥资源，重叠就是起不来或状态错乱），
     结算后自动解除并触发一次自愈重挂。
     ⚠ 要防的**不是** `already in use`：真 Cordis 的 `_unload()` 用 `Promise.all` **并发**跑
     所有 effect disposer，mcp-client 释放 `serverName` 的那一个在 dispose 一开始就执行完
     了，名字从不被长期占用。（这条我最初写反了，被复核实测纠正。）
   - **启动侧同样要超时**（`STARTUP_TIMEOUT_MS`，默认 30s）：`await fiber` 没有上限时，
     一个握手卡死的 server 会把整条串行重挂链拖住 —— 真链实测静默停摆到 SDK 自己的
     120 秒超时才收场，期间所有项目的工具都不可用。超时后本轮不再等它，实例留在登记簿里，
     后续重挂会重新评估。
   - **超时值必须校验**：`Number(env)` 碰到 `10s` / 空串 / `-1` 会得到 NaN/0/负数，而
     `setTimeout` 把它们当成 1ms —— 安全网反而变成「每次都立刻超时」。统一走
     `positiveTimeout()` 回落到默认值。
4. **多项目重挂是「全量收敛」**：每次重挂都重新解析全部项目、停掉全部旧实例、再按
   新结果全量起。不要改成「增量 diff 只动变化的那个项目」—— 增量在「项目 A 的
   server 名与项目 B 撞车」「某项目文件刚被删」这类场景下极易漏 dispose，正是约束 3
   踩过的坑。
5. **启动要并发。** `startServers` 用 `Promise.all`：串行 `await` 会让「改一个项目的
   `.mcp.json`」把所有项目的工具停摆 Σ(握手耗时)，真机上每个 server 1~3 秒，多项目下
   就是十几秒的全局空窗；并发后降到 max(握手耗时)。撞名风险不存在 —— 调用方已做跨项目
   全量去重。
6. **watcher 必须在首次 `reload()` 之前注册。** 首次重挂要等所有 server 握手（多 server
   时可达数秒），期间写进来的 `.mcp.json` 改动若还没有 watcher，会被静默吞掉、永不生效。

## 测试

```bash
npm test        # 等价于 node test/regress.mjs
```

`test/regress.mjs` 用 stub ctx + 一个「忠实模拟官方语义」的假 mcp-client（serverName
进程级独占 + 连接耗时）驱动本插件，**45 个用例**覆盖：声明表与字段映射、`${VAR}` 展开
（含嵌套默认值）、不支持/非法声明、错误路径（坏 JSON / 缺声明表 / 文件被删）、
单次重挂顺序、**并发重挂收敛**、噪声文件不触发重挂、`searchUp` 命中父目录时的监视目标，
以及多项目相关的一整组：同名 server 靠前缀区分、单项目不加前缀（向后兼容）、
`namespace` 三态、显式 `prefix`、32 字符触顶裁剪、**长名撞名仍能靠前缀消歧**、
同名目录前缀相撞被拦下、`scanRoot` 递归发现与跳过目录、单项目坏掉不连坐、
全部坏掉时保留旧实例、**被删项目的幽灵实例必被回收**、**扫不到时不回退 cwd**、
**server 并发启动**、**scanRoot 命中数变化不改名**、**dispose 挂起不堵死重挂链**、
**正常回收不产生假超时告警**、**启动卡死不堵死重挂链**、**回收超时的实例结算前不重挂**、
**启动期间的改动不丢**、**`path` 含子目录时首次创建能被发现**、
**`searchUp` 下祖先目录新建也能被发现**、绝对 `path` 的告警、**前缀截断单独告警**、
多项目热重挂收敛、多项目 watcher 隔离。只依赖 `node:` 内置模块，临时目录建在
`os.tmpdir()`，不碰仓库。

### 真链 E2E（在活着的 Harness 上跑）

`test/fixtures/` 有两个真实 MCP 服务端夹具（同样只用 `node:` 内置模块）：

| 夹具 | 传输 | 暴露 |
|---|---|---|
| `mcp-stdio-server.mjs` | stdio（换行分隔 JSON-RPC） | 工具 `echo`、资源 `fixture://stdio/greeting` |
| `mcp-http-server.mjs` | streamable-http（`POST /mcp` + `Mcp-Session-Id`） | 工具 `echo`、资源 `fixture://http/greeting` |

多项目的现成靶子是 `/data/ai/dsh/project_mcp_demo{,1,2}`：三个目录各有一份
`.mcp.json`，前两个都声明同名 `echo`（指向 stdio 夹具），第三个额外声明一个命令不存在
的 `broken`（用来确认单点失败不连坐）。配合 `scanRoot: /data/ai/dsh`，重启 Harness 后
应当看到：

- `mcp__project_mcp_demo_echo__echo` / `mcp__project_mcp_demo1_echo__echo` 两个同名工具
  **同时**可用，`echo` 的返回分别是各自实例的往返（证明不是同一个实例被复用）；
- `mcp__project_mcp_demo2_echo__echo` 可用，而 `broken` 只在日志里告警；
- `Tool.listTools` 里 `lamei_shop` 的业务 server 带 `lamei_` 前缀。

http 夹具要手动起：`FIXTURE_PORT=7391 node test/fixtures/mcp-http-server.mjs &`，
然后在某个 demo 的 `.mcp.json` 里加 `{"type":"http","url":"http://127.0.0.1:7391/mcp"}`，
等热重挂后核对 `list_mcp_resources` / `read_mcp_resource` 的真往返；验完撤掉声明、
杀掉夹具，确认端口释放。

## 已知边界

- **改了本插件的 JS 需要重启 Harness 才生效。** 包以 `link:` 装进 profile，Node 的 ESM
  模块缓存按解析后的 URL 命中；`plugin_manager` 的禁用/启用只会重新挂载 fiber，不会
  重新 `import()` 模块。**本插件所在目录不在 HMR 的监视集内**，所以改 `index.js` 一律
  要重启；改 `.mcp.json` 则不需要（走本插件自己的热重挂）。
- **`scanRoot` 下新出现的项目要等下一次重挂才被收进来。** watcher 覆盖的是 **apply
  那一刻能定位到的所有目录**（含 `scanRoot` 当场扫到的，所以 watcher 数会随命中数增长，
  大 `scanRoot` 要留意 `fs.inotify.max_user_watches`）；此后新出现的项目不在监视范围内
  —— 让 `scanRoot` 对任意子项变动都重挂，会在依赖树那种高频写入的目录里把 MCP 反复重启。
  改任意一个已知 `.mcp.json` 或重启即可刷新。
- **项目目录被整体删掉再重建后，该项目在重启前不再热重挂。** 底层 inotify watch 随目录
  消失而失效，Node 不会自动重挂；插件只在 watcher 的 `error` 上告警，不做看门狗轮询
  （重建需要一个「目录已回来」的事件源，常驻定时器的代价大于收益）。`rm -rf && clone`、
  worktree 换出、容器挂载重建都会踩到 —— 重启 Harness 即恢复。
- **`config.path` 为绝对路径时只服务一个文件**：所有项目源都指向同一个文件，插件只取
  第一个并告警。多项目请用相对文件名。
- **`path` 含子目录、且该子目录本身还不存在时，首次创建仍发现不了**：watcher 会因目标
  目录不存在而跳过并告警（子目录已存在则正常）。先建目录即可。
- 挂在 Host 层（进程级），工具对所有会话可见；不做按会话/按 workspace 隔离。
  多项目共存靠命名空间前缀，不靠会话过滤 —— 也就是说 A 项目的工具在 B 项目的会话里
  同样可见，只是名字带 A 的前缀。
- 不接管 MCP resources（那是 `@deepseek-ai/dsh-mcp-resources` 的活）。
- 重挂采用「先停旧、再起新」：同名 `serverName` 是进程级独占的，不先停干净会撞
  `serverName already in use`。代价是新配置起不来时该 server 处于停用态，日志会说明
  原因，修好文件即自动恢复。
- **解析失败的处置分两种，这是刻意的**：全部项目都解析失败（含单项目场景）→ 保留当前
  实例不动，避免手抖写坏一个文件就把在跑的 MCP 全停掉；部分成功 → 跳过坏的那些，用
  成功的重挂，坏项目不连坐好项目。注意「保留」只保**来源仍在本次扫描范围内**的实例：
  某个项目的 `.mcp.json` 被删掉时，它的实例照样会被回收（否则就是永久幽灵）。
- 删除 `.mcp.json` → 停掉该项目的实例；某项目声明被清空（`mcpServers: {}`）→ 该项目
  的实例全停，其余项目重新挂载（全量收敛的必然结果）。
- 宿主项目的 `.gitignore` 常常忽略 `.mcp.json`（腊梅商城就在第 59 行），此时声明属本地
  配置、不随仓库分发；要共享就改用 `.mcp.json.example` 或与用户确认后调整忽略规则。
