# @local/dsh-mcp-json

把**项目自己声明的 MCP**（`.mcp.json`）搬进 DSH：读取**当前会话所在项目**的 `.mcp.json`，
按其中的 `mcpServers` 逐个挂载官方 `@deepseek-ai/dsh-mcp-client`，于是这些 server 的工具
在该会话里直接可用，名字是 `mcp__<serverName>__<tool>`。

与「在 `cordis.patch.yml` 里逐个 insert mcp-client 行」的配置式 bundle 相比：
server 清单归项目所有、跟着仓库走，改 `.mcp.json` 即热重挂，不必再动 profile。

- **怎么用插件** → 本文件（安装、配置、`.mcp.json` 写法、排错）。
- **为什么这么实现** → [IMPLEMENTATION.md](IMPLEMENTATION.md)（隔离原理、实现约束、改动风险）。

## 快速开始

三步：装插件 → 项目根写 `.mcp.json` → 新开会话。

### 1. 装插件

三种装法，按场景选。**都走同一条 pnpm 路径**（`@deepseek-ai/dsh-plugin-manager/operations`，
共用一把 profile 写锁），装完都会出现在侧栏「插件」页的**已安装**列表里。

**都不需要手写注册行**：本包在 `package.json` 里声明了 `dsh.bundle.patch`，只要这个 bundle 被
选中，生效的那一行就来自本包自带的 [cordis.patch.yml](cordis.patch.yml)。命令行（方式二、三）
安装会顺带把它选进 `dsh.profile.bundles`；Web 上（方式一）是装完点 **立即启用**才选中 —— 不点
就只是「装着但没启用」。

本包 `private: true`、未发布到 npm，所以没有「按包名从 registry 装」这条路：spec 要么是本地
路径，要么是 git 地址。

#### 方式一：Web 界面（推荐）

DSH Web → 左侧栏**插件** → **添加插件** → 填入本仓库绝对路径
`/data/ai/dsh/dsh_project_mcp`（或下面的 git 地址）→ **安装** → 装完点**立即启用**。

- 「添加插件」接受：包名（可带版本）、Git 地址、压缩包、**本地绝对路径**。
- 装完不点**立即启用**，就只是「装着但没启用」。
- 侧栏这个「插件」页才能装和开关；**设置 → 内置插件**里的清单是只读的。
- 填 git 地址时若 GitHub 连不上，界面会提示**无法访问 GitHub** 并给出改用国内镜像的选项
  （镜像只提供注册表里的包与依赖，不代替 GitHub 仓库下载）。

#### 方式二：命令行 · git 源（分发）

```bash
dsh plugin --profile web add github:dongasai/dsh-project-mcp
# 或
dsh plugin --profile web add git+https://github.com/dongasai/dsh-project-mcp.git
```

`dsh plugin --profile <name> <pnpm args>` 把参数转发给该 profile 目录里的 pnpm。装进来的是
**副本**：之后改本仓库代码不影响已装的副本。

- `--profile` **必填**（不写直接报 `required option '--profile <name>' not specified`）；
  `web` 换成你要装进的 profile。
- **钉版本**：URL 后加 `#`，例如
  `git+https://github.com/dongasai/dsh-project-mcp.git#v2.0.0`（tag / 分支 / commit 都行）。
- **私有仓库**：`git+ssh://git@github.com/dongasai/dsh-project-mcp.git`（需已配好 SSH key），
  或先把 HTTPS 凭据配好。
- **必须带 `git+` 或 `github:` 前缀**。`git@github.com:owner/repo.git` 这种 scp 写法不会被认成
  git spec，pnpm 会把它当路径，装出一条指向不存在目录的 `link:` 死链（本机 profile 里就留着一条
  这样的残留：依赖名 `git` → `link:github.com:yangshen830-eng/dsh-editor.git`，`node_modules/git`
  是断链）。CLI 识别 git spec 的判定也是这个：`/^git\+|^github:|\.git(?:#|$)/`。
- pnpm 默认会拦 `prepare` 等依赖构建脚本；真被拦时 CLI 会提示把 pnpm 打印的 key 加进该 profile
  `pnpm-workspace.yaml` 的 `allowBuilds` 再重跑。**本包没有构建脚本**（`scripts` 只有 `test`），
  不会遇到。
- git / tarball 这类 spec 要先 fetch 才知道 peer 范围，所以 DSH 版本兼容判定发生在**安装之后**；
  判定不兼容会回滚 `package.json` 与 `pnpm-lock.yaml` 并打印 `allow-version` 命令。本包没有声明
  任何 DSH peer 依赖，不会触发。

#### 方式三：命令行 · 本地目录（link，开发）

```bash
dsh plugin --profile web add link:/data/ai/dsh/dsh_project_mcp
```

装成 `link:` 依赖，代码改动立刻是「已装的那份」—— 适合边改插件边用，但仍需**重启 Harness**
才生效（见「已知边界」）。

#### 装完确认

`Config.listConfigs`（`name: "@local/dsh-mcp-json"`）里能看到行，即已生效；再新开一个会话
（或重启 Harness）让插件加载，然后按第 3 步验证工具。

### 2. 项目根写 .mcp.json

最省事的验证方式是用仓库自带的**真 MCP 服务端夹具**（只依赖 `node:`，暴露工具 `echo`）：

```json
{
  "mcpServers": {
    "echo": {
      "type": "stdio",
      "command": "node",
      "args": ["/data/ai/dsh/dsh_project_mcp/test/fixtures/mcp-stdio-server.mjs"]
    }
  }
}
```

换成真实 server 是同一形状（下面两条是常见写法，参数以各 server 自己的文档为准）：

```json
{
  "mcpServers": {
    "dbhub": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub", "--transport", "stdio", "--dsn", "${DBHUB_DSN}"]
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

密钥不必写进文件：字符串字段里的 `${VAR}` 从 Harness 进程的环境变量取（见下文）。

### 3. 新开会话，确认工具在

- **会话的工作目录决定用哪份声明**：开在 `/data/ai/dsh/project_mcp_demo1` 就吃它的
  `.mcp.json`；开在它的子目录也能靠 `searchUp` 找到项目根的声明（默认向上找 8 层）。
- 验证：直接调 `mcp__echo__echo`（`{"text": "hi"}` → `echo: hi`）；或看日志里的 `mcp-json:` 行
  —— 就绪时是 `echo 就绪（stdio）`，收尾是 `1/1 个 server 在跑（会话级，来源 …/.mcp.json）`。
- 现成的验证项目：`/data/ai/dsh/project_mcp_demo`、`project_mcp_demo1`、`project_mcp_demo2`
  已经这么配好了。`demo2` 里还特意放了个起不来的 `broken` 条目，用来看「单个 server 失败不连坐」。

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

字段细节：

- 字符串字段（`command` / `args[]` / `env` / `url` / `headers` / `cwd`）支持
  `${VAR}` 与 `${VAR:-default}` 展开，取自 **Harness 进程**的环境变量；
  **默认值里可以再嵌一层占位符**（`${DSH_HOME:-${HOME}/.dsh}`：内层先落地、外层再取默认值）；
  变量未定义**或为空串**时取默认值；既未定义又无默认值 → 展开为空串并告警；
  解析不掉的残留占位符按原样保留并告警。
- `args[]` 与 `env` / `headers` 的值可以写数字或布尔（会转成字符串）。
- 同一文件内条目按声明顺序处理，先到先得。

## 配置

插件那一行的 `config`（见 [cordis.patch.yml](cordis.patch.yml)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `path` | `.mcp.json` | 配置文件名，或绝对路径 |
| `searchUp` | `true` | 从会话工作目录向上最多找 8 层（项目级语义靠它，默认开） |
| `projectDir` | `''` | 显式钉死项目目录，覆盖会话 cwd；留空即按会话走（正常用法） |
| `disabledServers` | `[]` | 按 `.mcp.json` 里的**原始键**跳过某些 server |
| `toolCallTimeoutMs` | `60000` | 透传给每个 server 的工具调用超时 |
| `failOnStartupError` | `false` | 真：任一 server 起不来即抛错；假：只告警 |
| `watch` | `true` | 监视本项目的 `.mcp.json`，变更后先停旧实例再起新实例 |

## 隔离语义（用户能看到的）

**MCP 实例挂在会话作用域（`agent.ctx`）下，不是 profile 根作用域**，因此：

- A 项目的会话**看不到** B 项目的任何 `mcp__*` 工具，也收不到 B 项目的 server instructions；
- 不同会话可以各挂一份**同名** server：两个项目都声明 `dbhub` 时，两边工具名都是
  `mcp__dbhub__execute_sql`，各自连各自的 —— 这正是隔离生效的标志；
- 会话销毁时实例、watcher、工具注册一并回收，profile 层不留任何全局登记。

代价：**一个会话一份实例**，N 个会话同时开着就是 N 份 MCP 子进程。这是隔离的必然成本，
官方设计如此。原理与实现细节见 [IMPLEMENTATION.md](IMPLEMENTATION.md)。

## 排错

先看 Harness 日志里的 `mcp-json:` 行 —— 它每次都会说明「用了哪份文件、挂了几个、谁被跳过」。

| 症状 | 原因 | 处置 |
|---|---|---|
| 一个 `mcp__*` 都没有，日志说「未找到 …，本会话不挂载项目 MCP」 | 会话 cwd（及其 8 层祖先）里没有该文件 | 确认 `.mcp.json` 位置；子目录会话也能命中，除非 `searchUp: false` |
| 一个都没有，日志说「N 个锚点都解析不到 `@deepseek-ai/dsh-mcp-client`」 | profile 里没装官方客户端 | 在 profile 目录装 `@deepseek-ai/dsh-mcp-client`（本插件只复用、不打包它） |
| 某个 server 的工具缺席，日志说「启动失败」/「启动超过 15000ms 仍未就绪」 | 该 server 自己起不来或卡住 | 默认只告警不连坐；查该 server 的命令与环境变量，`failOnStartupError: true` 可改成显式失败 |
| 会话创建比平时慢几秒 | 正常：挂载在 `agent/created` 里 await 到就绪 | 慢 server 会拖到 `STARTUP_TIMEOUT_MS`（默认 15s）为止 |
| 改了 `.mcp.json` 没反应 | 项目目录被整体删掉再重建（`rm -rf && clone`、worktree 换出），inotify watch 已失效 | 重开会话或重启 Harness（见「已知边界」） |
| `.mcp.json` 写坏（坏 JSON / 缺声明表）后工具还在 | 刻意的：解析失败**保留旧实例**，避免手抖一次把在跑的 MCP 全停掉 | 修好文件保存即触发热重挂；日志里有 error 说明 |
| 某个条目没挂上，日志有「跳过 …」 | `type: "sse"` 不支持 / 缺 `command` 或 `url` / 键名规范化后重名 / 被 `disabledServers` 跳过 | 按日志提示改声明 |
| 日志说 serverName 不合法已改用 `xxx` | 键名含 `.` 等非法字符 | 想稳定就自己改成 `[A-Za-z0-9_-]{1,32}` |
| `.mcp.json` 没进 git | 宿主项目 `.gitignore` 常忽略它（属本地配置） | 要共享就改用 `.mcp.json.example`，或与用户确认后调整忽略规则 |
| 改了 `index.js` 不生效 | 插件不在 HMR 监视集内，ESM 模块缓存按解析后的 URL 命中 | **重启 Harness**（禁用/启用插件不够） |

## 测试

```bash
npm test        # 等价于 node test/regress.mjs —— 35 个用例，约 34 秒
node --check index.js   # 语法自检
```

`test/regress.mjs` 用 stub profile ctx + **可创建多个会话的 stub Harness** + 一个「忠实模拟
官方语义」的假 mcp-client（**serverName 按注册作用域独占**、连接耗时、effect 归属跟随 fiber）
驱动本插件，覆盖：

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

| 夹具 | 启动方式 | 传输 | 暴露 |
|---|---|---|---|
| `mcp-stdio-server.mjs` | 由客户端拉起 | stdio（换行分隔 JSON-RPC） | 工具 `echo`、资源 `fixture://stdio/greeting` |
| `mcp-http-server.mjs` | `FIXTURE_PORT=7391 node test/fixtures/mcp-http-server.mjs` | streamable-http（`POST http://127.0.0.1:7391/mcp`） | 工具 `echo`、资源 `fixture://http/greeting` |

**隔离的验证方式**（需要两个不同工作目录的会话，现成的就是 `project_mcp_demo1` 与
`project_mcp_demo2`，两者都声明了同名 server `echo`）：

1. 在项目 A 的会话里看工具列表：应当**只有** A 项目的 `mcp__*`；
2. 在项目 B 的会话里看：只有 B 项目的；
3. 两边的工具名都是 `mcp__echo__*`，各自连各自的 —— 这正是隔离生效的标志（旧的全局实现会撞
   `already in use`）。

## 已知边界

- **改了本插件的 JS 需要重启 Harness 才生效。** 包以 `link:` 装进 profile，Node 的 ESM
  模块缓存按解析后的 URL 命中；`plugin_manager` 的禁用/启用只会重新挂载 fiber，不会重新
  `import()` 模块。**本插件所在目录不在 HMR 的监视集内**，所以改 `index.js` 一律要重启；
  改 `.mcp.json` 则不需要（走本插件自己的热重挂）。
- **会话创建会等 MCP 就绪**：`.mcp.json` 里有慢 server 时，开会话会慢几秒。超过
  `STARTUP_TIMEOUT_MS` 的那个 server 本轮不挂载（工具缺席，日志有告警），下次重挂再试。
- **项目目录被整体删掉再重建后，该项目在重启前不再热重挂**：底层 inotify watch 随目录消失
  而失效，Node 不会自动重挂；重建需要一个「目录已回来」的事件源，常驻定时器的代价大于收益。
  `rm -rf && clone`、worktree 换出、容器挂载重建都会踩到 —— 重开会话或重启 Harness 即恢复。
- **`config.path` 为绝对路径时所有会话都指向同一个文件**：此时项目定位失效，等价于把该文件
  的 server 挂给每个会话。
- **`path` 含子目录、且该子目录本身还不存在时，首次创建仍发现不了**：watcher 会因目标目录
  不存在而跳过（子目录已存在则正常）。先建目录即可。
- **解析失败的处置分两种，这是刻意的**：`.mcp.json` 写坏（坏 JSON / 缺声明表）→ 保留当前
  实例不动，避免手抖一次就把在跑的 MCP 全停掉；文件被删 → 停掉该会话的全部实例（声明没了）。
- 不接管 MCP resources（那是 `@deepseek-ai/dsh-mcp-resources` 的活）。
