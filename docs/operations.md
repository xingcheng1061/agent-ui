# 运维

## 环境变量

### 服务

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_UI_HOST` | `127.0.0.1` | 监听地址。默认只听回环，因为本服务等价于远程 shell |
| `AGENT_UI_PORT` | `4711` | 服务端口 |
| `AGENT_UI_TOKEN` | 空 | 设置后所有 API 与 WS 都要带 `?token=…` |
| `AGENT_UI_ROOT` | `process.cwd()` | 默认项目根，`resolveRoot` 的兜底值 |
| `AGENT_UI_ROOTS` | 空 | 额外项目根，`;` 分隔。用于还没有会话的新目录 |
| `AGENT_UI_CLAUDE_PROJECTS` | `~/.claude/projects` | CLI 会话库位置，项目与会话从这里反推 |
| `AGENT_UI_CLAUDE_BIN` | `claude` | CLI 可执行名/路径 |
| `AGENT_UI_PERMISSION_MODE` | `acceptEdits` | 初始权限模式 |
| `AGENT_UI_MODEL` | 空 | 初始模型（`--model`） |
| `AGENT_UI_MODELS` | `sonnet,opus,haiku` | 模型下拉候选，逗号分隔 |
| `AGENT_UI_SHELL` | Windows `powershell.exe` / *nix `$SHELL` | 终端 shell |

### 生命周期与超时

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_UI_REAP_MS` | `3600000`（1 小时） | WS 断开且空闲多久后回收 CLI 进程 |
| `AGENT_UI_PERMISSION_TIMEOUT_MS` | `86400000`（24 小时） | 审批卡挂多久没点就自动拒绝。设得长是有意的：离开一段时间回来发现「被自动拒绝、任务继续跑偏」比进程空等更糟 |
| `AGENT_UI_INTERRUPT_GRACE_MS` | `5000` | 优雅中断多久没收到 ack 就降级为强杀 |
| `AGENT_UI_DEBUG` | 空 | `=1` 打开服务端事件日志 |
| `AGENT_UI_ADMIN_USER` | 空 | 与 `AGENT_UI_ADMIN_PASSWORD` 一起在启动时创建（或重置密码）管理员账号 |
| `AGENT_UI_ADMIN_PASSWORD` | 空 | 见上；只设其中一个不生效 |

### 构建 / 开发

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_UI_ORIGIN` | `http://127.0.0.1:4711` | Vite dev server 的代理目标 |

### 命令行参数

发布版入口是 `dist/server/cli.js`（`bin: agent-ui`），只负责把参数翻译成上面几个环境变量，然后加载服务本体——`config.ts` 在模块加载时读环境变量，所以顺序不能反：

| 参数 | 等价环境变量 |
|---|---|
| `-p, --port <端口>` | `AGENT_UI_PORT` |
| `-H, --host <地址>` | `AGENT_UI_HOST` |
| `-r, --root <目录>` | `AGENT_UI_ROOT` |

`--help` / `--version` 只读元信息，不启动服务。

### 内部使用（不要手动设）

`AGENT_UI_PERMISSION_URL` / `_TOKEN` / `_SESSION` —— 由服务端在 spawn CLI 时注入，给 MCP 审批子进程回连用。`INTERNAL_TOKEN` 每次启动随机生成。

## 进程模型

```
node server/index.ts
├── claude（每个活跃会话一个，几十~上百 MB）
│   └── node permissionPrompt.mjs（仅 default/plan 模式， CLI 拉起）
└── 终端 shell（每个打开的终端一个）
```

### 生命周期规则

```
可回收：!busy（轮次已结束）      跟 WS 连没连上无关
不可回收：busy（有任务在跑）     永远不杀

WS 断开 + 空闲  → REAP_DELAY_MS 后 dispose()
WS 断开 + 忙碌  → 不设计时器，等 result 出来再算
WS 没断 + 空闲  → 不回收（已知限制，见下）
```

### 已知限制

**WS 没断但人走了，进程不回收。** 没有「用户还在看」的可靠信号，刻意没有做基于时间的强制回收——那会在用户读长回复时误杀。要清理只能重启服务。

**服务被强杀会留孤儿 CLI 进程。** `Stop-Process -Force`、崩溃、断电都让信号处理器没机会运行；Windows 上 Ctrl+C 也不会传播给子进程（`windowsHide: true` + 管道 stdio，子进程不挂同一控制台）。

手动清理：

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Stop-Process -Force
```

## 账户与鉴权

账号与会话都存在 `~/.agent-ui/` 下的 JSON 文件里（`users.json` / `sessions.json`），没有引入数据库——单用户本地工具用文件更便于查看和备份。

| 文件 | 内容 |
|---|---|
| `users.json` | 账号：`username`、`passwordHash`（scrypt，64 字节）、`salt`、`role` |
| `sessions.json` | 会话令牌：`token`（32 字节随机 hex）、`userId`、`lastSeenAt` |
| `terminals.json` | 终端注册表：`id`、`root`、`title`、`createdAt` |

### 流程

```
首次打开 → 无账号 → UI 显示「创建管理员」→ POST /api/auth/setup
之后打开 → 无 Cookie → 401 {setupRequired:false} → 登录页
登录成功 → Set-Cookie: agentui_session=<hex>; HttpOnly; SameSite=Strict; Max-Age=30d
```

- 密码用 `scryptSync` + 16 字节随机 salt；校验用 `timingSafeEqual`，账号不存在时也跑一次哈希，避免时序侧信道
- 会话 30 天滑动有效期，每次请求刷新 `lastSeenAt`
- `AGENT_UI_TOKEN` 仍然有效，作为脚本/curl 的旁路（只在设置时才生效）
- `/api/health`、`/api/meta`、`/api/agent-log`、`/api/auth/*` 无需登录，其余全部要 Cookie 或 `?token=`
- WS 升级同样校验：浏览器自动带 Cookie，非浏览器客户端用 `?token=<会话令牌>`

### 重置

```powershell
Remove-Item "$env:USERPROFILE\.agent-ui\users.json","$env:USERPROFILE\.agent-ui\sessions.json"
```

删掉这两个文件后重启，下次打开又是「创建管理员」。**所有人都会掉登录**。

## 调试

### 打开日志

```powershell
$env:AGENT_UI_DEBUG='1'
npm start
```

输出带毫秒时间戳，能跟浏览器控制台对照：

```
[14:16:33.326][agent-ui] system model=deepseek-v4-pro mode=acceptEdits session=d77aa900
[14:21:33.920][agent-ui:f78c29a1] permission timeout -> deny
[14:37:02.248][agent-ui] agent socket closed code=1006 reason=-
```

### 浏览器侧

`agent-ui` 会把关键事件回传到 `POST /api/agent-log`（`AGENT_UI_DEBUG=1` 时才打印）：

- `ws-open` / `ws-close`（带 `code`、`reason`、`wasClean`、当时是否在流式中）
- `pagehide` / `visibility-hidden`

**这是区分「用户刷新」和「标签页崩溃」的唯一手段**：刷新一定先有 `pagehide`，崩溃只有 `ws-close code=1006`。

### 查看 IndexedDB 镜像

DevTools → Application → IndexedDB → `agent-ui-live` → `turns`。每条记录是 `{sessionId, events, queued, busy, updatedAt}`。轮次结束后记录会被删掉，所以只有进行中的会话在这里看得见。

### 查看 CLI 的原始会话

`~/.claude/projects/<项目 slug>/<sessionId>.jsonl`，一行一条消息。这是唯一权威的历史来源，`GET /api/sessions/:id` 解析的就是它。

## 故障排查

### 页面能开但发消息没反应

1. 看顶栏「后台运行中 / 后台未运行」徽标
2. `未运行` → 检查 `claude` 是否在 PATH 里、是否已登录：`claude --version`
3. `运行中` 但没输出 → 看服务端日志有没有 `permission_request` 后长时间没有 `result`（审批卡挂着）
4. 浏览器控制台看 WS 是否反复重连（`ws-close` / `ws-open` 成对出现）

### 每一轮都卡住，5 分钟一轮循环

历史上这是 `--permission-prompt-tool` 在 `acceptEdits` 模式下被注册导致的。现已按 `PROMPTING_MODES` 条件注册。若仍出现，确认 `AGENT_UI_PERMISSION_MODE` 的值，并看日志里 `system … mode=xxx`。

### 刷新后看不到进行中的那半轮

IndexedDB 镜像只在**同一个浏览器**有效。换浏览器看不到是设计使然。同浏览器也不行的话，检查 DevTools 里 IndexedDB 是否被禁用（隐私模式）。

### 端口被占用

```powershell
Get-NetTCPConnection -LocalPort 4711 -State Listen | Select-Object OwningProcess
```

注意 `tsx` 会起子进程，实际监听的是子进程 pid，`Start-Process` 返回的父 pid 不是它。

### EADDRINUSE

同上的另一副面孔：已经有一个实例在跑。`npm start` 前先确认端口空闲。

### 变更列表里只有目录

`git status` 默认折叠未跟踪目录，代码里已用 `-uall` 展开。如果还是只有目录，检查该目录是不是真的 git 仓库（非仓库会显示「不是 git 仓库」）。

### 终端打不开

`node-pty` 是原生模块，`npm install` 后需要成功编译。Windows 上缺 VS Build Tools 会静默失败。另外 `AGENT_UI_SHELL` 指向不存在的 shell 也会失败。

## 升级注意

- `dist/web` 是构建产物，`npm start` 直接托管它。改了 `web/` 之后必须重新 `npm run build`，否则浏览器拿到旧 bundle（资源名带 hash，但 `index.html` 可能被缓存，必要时强刷）
- 协议改动必须同步 `server/agent/protocol.ts` 与 `web/agentTypes.ts`，两个 tsconfig 分别检查，`npm run typecheck` 会同时跑
