# agent-ui

自托管的 **coding agent Web 工作台**。以「会话」为中心组织一切：每个会话绑定一个项目目录，对话、代码编辑、文件树、PTY 终端、git 变更全部跟着会话走。

它不是 VS Code 的替代品，也不是 `claude` 命令行的包装壳——它把「让 agent 干活」和「人看着它干、随时插手」放进同一个页面：

- **对话区**：流式渲染（Markdown / KaTeX 公式 / 语法高亮 / 可折叠思考块），工具调用有专用卡片，子 agent 与后台任务实时可见
- **代码区**：Monaco 编辑器 + 文件树 + `HEAD ↔ 工作区` diff + 真实 PTY 终端， agent 改的文件立刻能看到、能改、能跑
- **交互**：`/` 唤起命令与 skill、`@` 引用文件、运行时切换模型与权限模式、工具审批卡片、消息排队

后端只有一个 Node 服务，通过 [stream-json 协议](./docs/agent-protocol.md)驱动本机的 `claude` CLI；agent 后端是可插拔的（[cordis 插件](./docs/agent-backends.md)），目前内置 `claude` 与一个用于测试的 `echo`。

## 功能

| 分类 | 能力 |
|---|---|
| 会话 | 自动从 `~/.claude/projects` 反推项目与会话；手动注册新目录；`--resume` 续接；刷新不丢进行中的轮次 |
| 对话 | 流式 Markdown（streamdown）+ KaTeX + shiki 高亮；思考块可折叠；工具卡片（Bash 有专用卡片） |
| 工具可视化 | `tool_use`/`tool_result` 配对；子 agent（`Agent` 工具）嵌套展示；后台任务实时输出轮询 |
| 控制 | 运行时切模型 / 切权限模式；优雅中断；强制结束；消息排队；工具审批（允许 / 总是允许 / 拒绝） |
| 代码 | Monaco 编辑、文件树、git 变更按目录折叠、只读 diff、agent 每轮结束自动刷新变更 |
| 终端 | `node-pty` 真终端，**多标签**，shell 存活于服务端（切标签/刷新/断线都不杀），重连回放错过的输出 |
| 账户 | 登录鉴权，账号密码存 `~/.agent-ui/users.json`（scrypt 哈希），会话令牌走 HttpOnly Cookie |
| 布局 | 会话列表 / 对话 / 代码 三栏，所有分隔线可拖拽，宽度持久化 |
| 主题 | 暗色 / 明亮双主题，跟随系统，选择持久化 |

## 环境要求

- **Node ≥ 20.19**（开发用 24.x）
- **`claude` CLI** 已在 PATH 中且已登录（`claude` 命令本身可用即可，本工具不复刻登录流程）
- `git`（变更面板用；非 git 目录会显示「不是 git 仓库」但不影响其他功能）
- Windows / macOS / Linux 均可；PTY 在 Windows 上走 ConPTY

## 安装

```powershell
# PowerShell
git clone <repo> agent-ui
cd agent-ui
npm install
```

`npm install` 会编译 `node-pty`（原生模块）。如果本机缺少编译工具链，先装 VS Build Tools（Windows）或 Xcode CLT（macOS）。

## 运行

### 开发模式（推荐，热更新）

```powershell
npm run dev
```

- 后端 `http://127.0.0.1:4711`（`tsx watch`，改 `server/` 自动重启）
- 前端 `http://127.0.0.1:4712`（Vite dev server，`/api`、`/pty`、`/agent` 代理到后端）

### 生产模式（单端口）

```powershell
npm run build
npm start
```

打开 `http://127.0.0.1:4711`。`dist/web` 由 Express 直接托管，不需要额外静态服务器。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 后端 + 前端并行开发 |
| `npm run dev:server` | 只跑后端（watch） |
| `npm run dev:web` | 只跑前端（Vite） |
| `npm run build` | 类型检查 + 构建到 `dist/web` |
| `npm start` | 跑生产构建（需先 build） |
| `npm run typecheck` | 分别检查 `server` 与 `web` 两个 tsconfig |

## 配置

全部通过环境变量，见 [docs/operations.md](./docs/operations.md) 的完整表格。

最常用的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_UI_PORT` | `4711` | 服务端口 |
| `AGENT_UI_HOST` | `127.0.0.1` | 监听地址。**默认只听回环**，因为本服务等价于远程 shell |
| `AGENT_UI_TOKEN` | 空 | 设置后所有 API 与 WS 都要带 `?token=…` |
| `AGENT_UI_ROOT` | `process.cwd()` | 默认项目根 |
| `AGENT_UI_PERMISSION_MODE` | `acceptEdits` | `default`/`acceptEdits`/`plan`/`bypassPermissions` |
| `AGENT_UI_MODELS` | `sonnet,opus,haiku` | 模型下拉候选 |
| `AGENT_UI_REAP_MS` | `3600000` | 会话断开且空闲多久后回收 CLI 进程 |
| `AGENT_UI_DEBUG` | 空 | `=1` 打开服务端事件日志（排查卡住/中断必开） |
| `AGENT_UI_ADMIN_USER` + `AGENT_UI_ADMIN_PASSWORD` | 空 | 启动时创建（或重置密码）管理员账号，用于无界面部署 |

## 目录结构

```
agent-ui/
├── server/                    # Node 后端（无框架约束，Express + ws）
│   ├── index.ts               # HTTP 路由、WS upgrade、优雅退出
│   ├── config.ts              # 环境变量、超时、内部 token
│   ├── paths.ts               # root 解析、越界防护、忽略规则
│   ├── projects.ts            # 项目发现（CLI 会话库 + 手动注册）
│   ├── projectStore.ts        # ~/.agent-ui/projects.json 持久化
│   ├── sessions.ts            # 解析 CLI jsonl → 可渲染 transcript
│   ├── git.ts                 # git status / 单文件 diff
│   ├── fsApi.ts               # 文件树/读写/搜索路由
│   ├── terminal.ts            # node-pty 封装
│   └── agent/                 # agent 通道
│       ├── protocol.ts        # WS 上行/下行类型（唯一事实来源）
│       ├── router.ts          # 连接管理、生命周期、会话认领
│       ├── driver.ts          # AgentDriver / AgentSession 接缝 + 注册表
│       ├── runtime.ts         # cordis 插件宿主
│       ├── claudeCliSession.ts# claude CLI 驱动实现
│       ├── agentState.ts      # 模型/模式选择的文件持久化
│       ├── permissionGateway.ts # 审批请求的会话路由
│       ├── permissionPrompt.mjs # 被 CLI 拉起的 MCP stdio server
│       └── plugins/           # claude / echo 两个后端
├── web/                       # React 前端（Vite）
│   ├── App.tsx                # 三栏布局、会话状态
│   ├── api.ts                 # REST + WS URL 封装
│   ├── agentTypes.ts          # protocol.ts 的浏览器镜像
│   ├── monacoSetup.ts         # Monaco worker 与语言配置
│   ├── styles.css             # 全部样式（无 UI 框架）
│   └── components/
│       ├── ChatPanel.tsx      # 对话主流程（最大的一块）
│       ├── Workspace.tsx      # 代码区（文件树/编辑器/终端多标签/diff）
│       ├── ChangesList.tsx    # git 变更（按目录折叠）
│       ├── DiffView.tsx       # Monaco diff
│       ├── Editor.tsx         # Monaco 编辑器
│       ├── FileTree.tsx       # 文件树
│       ├── Terminal.tsx       # xterm 封装（按终端 id 挂载）
│       ├── AuthPage.tsx       # 登录 / 首次创建管理员
│       ├── SessionSidebar.tsx # 会话列表
│       ├── NewSessionDialog.tsx
│       ├── Splitter.tsx       # 可拖拽分隔线 + 尺寸持久化
│       ├── Markdown.tsx       # streamdown 封装
│       ├── CodeHighlight.tsx  # shiki 封装
│       └── liveTurnStore.ts   # 进行中轮次的 IndexedDB 镜像
└── docs/                      # 技术方案（本文档群）
```

## 首次使用

打开页面时若没有任何账号，会直接显示「创建管理员账号」表单——这是唯一能建号的入口，防止别人抢先认领一个无人值守的实例。

也可以无界面预置：

```powershell
$env:AGENT_UI_ADMIN_USER='admin'
$env:AGENT_UI_ADMIN_PASSWORD='至少6位'
npm start
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | 整体架构、数据流、关键设计决策与权衡 |
| [docs/agent-protocol.md](./docs/agent-protocol.md) | WS 协议全量定义、CLI 调用方式、控制通道 |
| [docs/agent-backends.md](./docs/agent-backends.md) | 插件化后端、多后端并存与 `?agent=` 路由、如何接一个新的 agent |
| [docs/frontend.md](./docs/frontend.md) | 前端组件树、状态管理、渲染管线 |
| [docs/operations.md](./docs/operations.md) | 环境变量、进程生命周期、调试、故障排查 |

## 安全

这个服务 = **远程 shell + 远程文件读写 + 远程 agent 执行**。默认只听 `127.0.0.1` 正是为此。

对外暴露前必须：

1. 创建强密码账号（或用 `AGENT_UI_ADMIN_*` 预置）
2. 设 `AGENT_UI_TOKEN`（额外共享密钥，给脚本/curl 用）
2. 置于反向代理之后，并启用 TLS
3. 理解 `AGENT_UI_ROOTS` / 项目注册机制决定了 agent 能碰哪些目录——不要图方便把 `/` 加进去

## 路线图

- [ ] 单独终止某个后台任务（CLI 的 `TaskStop` 目前只有模型能调）
- [ ] `/clear` 与界面同步（CLI 清了上下文，前端消息不同步清）
- [ ] LSP：`clangd` / `pyright` / `gopls` + WS 桥 + `monaco-languageclient`
- [ ] Monaco 跨文件跳转（TS worker 已就绪，差「为未打开的 import 建 model」）
- [ ] 会话重命名 / 删除 / 项目过滤
- [ ] 多用户与多端（需要先做账号体系；届时 IndexedDB 镜像的策略要重新评估）
