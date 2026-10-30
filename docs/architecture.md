# 架构

## 一句话

一个 Node 服务把本机的 `claude` CLI 包装成「可被浏览器订阅的会话」：CLI 负责思考和执行，服务负责协议转换、生命周期与文件/git/终端能力，前端负责把人能看到、能插手的一切画出来。

## 全景

```
┌──────────────────────────────────────────────────────────────────┐
│ 浏览器（React）                                                   │
│  App ─┬─ SessionSidebar   会话列表（项目分组）                     │
│       ├─ ChatPanel        对话主流程                               │
│       │    ├─ Markdown / CodeHighlight / BashCard / ThinkingBlock │
│       │    └─ liveTurnStore ──► IndexedDB（进行中轮次的镜像）       │
│       └─ Workspace ─┬─ FileTree / ChangesList                    │
│                     ├─ Editor / DiffView（Monaco）                │
│                     └─ Terminal（xterm）                          │
└───┬──────────────────────────────────────────────────────────────┘
    │ HTTP /api/*                WS /agent            WS /pty
┌───▼──────────────────────────────────────────────────────────────┐
│ Express + ws（server/index.ts）                                    │
│  ├─ fsApi / git / sessions / projects   文件、git、历史、项目       │
│  ├─ terminal.ts                        node-pty                   │
│  └─ agent/router.ts                    连接与生命周期              │
│        └─ AgentSession（driver 实现）                             │
│             └─ spawn("claude --print --input-format stream-json …")│
└───┬──────────────────────────────────────────────────────────────┘
    │ stdin（JSONL 命令 + control_request）      stdout（JSONL 事件）
┌───▼──────────────────────────────────────────────────────────────┐
│ claude CLI（长驻进程，自带会话上下文）                              │
│  ├─ 自身 jsonl：~/.claude/projects/<slug>/<sessionId>.jsonl        │
│  └─ MCP 子进程：permissionPrompt.mjs ──HTTP──► /internal/permission│
└──────────────────────────────────────────────────────────────────┘
```

## 模块职责

### 服务端

| 模块 | 职责 | 关键点 |
|---|---|---|
| `index.ts` | HTTP 路由、WS upgrade、优雅退出 | `/api` 统一鉴权；`/internal/permission` 单独用一次性 token |
| `config.ts` | 环境变量与超时的唯一来源 | `INTERNAL_TOKEN` 每次启动随机生成，MCP 子进程靠它回连 |
| `store.ts` | JSON 文件存储 | 临时文件 + rename 原子写；写操作串行化 |
| `auth.ts` | 账号与会话 | scrypt 哈希、HttpOnly Cookie、30 天滑动有效期 |
| `paths.ts` | `root` 解析、越界防护 | 所有 fs/git 接口都经过 `resolveRoot`，拒绝 `..` 逃逸 |
| `projects.ts` | 项目发现 | 两个来源：CLI 会话库反推 + `~/.agent-ui/projects.json` |
| `sessions.ts` | jsonl → transcript | 只认 `text` / `thinking` / `tool_use` / `tool_result` 四种块 |
| `git.ts` | 变更列表与单文件 diff | `status --porcelain=v1 -uall`（展开未跟踪目录，否则只能看到 `server/` 这种目录行） |
| `terminals.ts` | 多终端注册表 | PTY 存活于服务端，断线保留，重连回放缓冲 |
| `agent/router.ts` | 连接管理、会话认领、排队、回收 | 一个 `LiveSession` = 一个 CLI 进程 |
| `agent/driver.ts` | 后端接缝 | 路由层完全不认识 claude，只认识 `AgentSession` |
| `agent/claudeCliSession.ts` | claude 的具体驱动 | 协议转换 + 控制通道 + 任务输出轮询 |
| `agent/permissionGateway.ts` | 审批请求路由到浏览器 | MCP 子进程是 CLI 的子进程，拿不到 WS，只能走 HTTP 回来 |
| `agent/agentState.ts` | 模型/模式持久化 | `~/.agent-ui/agent-state.json`，会话级 > 后端级 > 全局 |

### 前端

见 [frontend.md](./frontend.md)。

## 三条核心数据流

### 1. 一轮对话

```
用户输入
  → WS {type:'user', text}
  → router._ensureEntry() 找到/创建 LiveSession
  → ClaudeCliSession.sendUserMessage() 写一行 JSON 到 claude 的 stdin
  → claude 流式吐出事件（stdout，一行一个 JSON）
  → _handleLine() 翻译成 AgentServerEvent
  → emit()  → 打上 seq、进在途缓冲、广播给所有观众 socket
  → agentConnections 连接池 → 写 IndexedDB 镜像 + 分发给 ChatPanel
  → ChatPanel.handleEvent()  → setItems / setTasks / setPermission …
```

### 2. 刷新 / 切会话恢复

```
新页面加载
  ├─ getTranscript(sessionId)      ← jsonl：截至上一个已完成轮的全部内容
  ├─ 连接池里这一轮的镜像（或 IndexedDB）
  └─ attach{lastSeq}               ← 告诉服务端已经收到哪一条
        ├─ session_state{live, busy, lastSeq, oldestSeq}
        └─ 若仍在跑：补发 seq > lastSeq 的事件
 拼接顺序：jsonl 历史 → 镜像 → 之后到达的实时 delta（按 seq 去重）
```

`result` 一到就删掉镜像——那一轮已经写进 jsonl 了，留着会重复。

会话之间**不共享连接**：连接池按会话各开一条，切走时只是没人渲染，事件继续进那一条的镜像，所以「A 在跑、你去看 B」不会打断 A，切回来也不需要重新加载历史。细节见 [agent-protocol.md](./agent-protocol.md#多会话并行seq缓冲与观众)。

侧栏的「正在回答」标记来自 `GET /api/agents/running`（3 秒轮询）：聊天 socket 只认识自己连着的那一个会话，没打开的会话在干什么只能问服务端。接口返回 `{sessionId, root, agent, busy, pendingTool?, permissionMode, lastSeq}`，`busy` 决定圆点是脉冲还是静态；`pendingTool` 非空表示该会话正卡在审批上，侧栏据此显示「待审批」——包括在别的标签页里被卡住的那种。

### 3. 工具审批

```
claude 需要授权
  → 调用 MCP 工具 mcp__agentui__approval（--permission-prompt-tool 指定）
  → permissionPrompt.mjs（CLI 拉起的子进程）POST /internal/permission
  → permissionGateway 找到会话 → emit permission_request → 浏览器弹卡片
  → 用户点允许/拒绝 → WS permission_response
  → gateway resolve → MCP 工具返回 {behavior:'allow', updatedInput}
  → claude 继续执行
```

审批不会因为界面丢失而蒸发。卡片状态存在浏览器里，而 CLI 仍阻塞在 MCP 调用上，所以 `attach` 时服务端会用**同一个 `requestId` 重发**一次 `permission_request`——刷新、换标签、切到别的会话再回来，卡片都会重新出现。等待上限是 `AGENT_UI_PERMISSION_TIMEOUT_MS`（默认 24 小时），到点自动拒绝并记 `permission timeout -> deny`；用户主动发新消息则立刻取消挂起的审批。

## 多后端并存

agent 通道的上层不认识任何具体后端，只认识 `AgentSession` / `AgentDriver` 两个抽象（定义在 `server/agent/driver.ts`）。后端通过 cordis 插件注册进 `AgentRegistry`，由 `server/agent/runtime.ts` 在 HTTP 服务启动**之前**装好。

```
WS /agent?root=…&agent=claude ─┐
                               ├─ AgentConnection（_agentId 构造时定死）
WS /agent?root=…&agent=echo ───┘        │
                                        └─ AgentSession（一个正在跑的对话）
```

三条不变式：

1. **连接绑定后端**：`_agentId` 在 `AgentConnection` 构造时确定，socket 生命周期内不变。解析顺序 `?agent=` > 持久化 `default.agent` > 第一个注册的
2. **会话绑定后端**：`LiveSession.agentId`，`_findLive()` 按它过滤。一个会话从生到死只属于一个后端，换后端只能新开对话
3. **配置按后端隔离**：`agent-state.json` 的 `defaults` 按 agentId 分层，`choiceForSession(sessionId, agentId)` 优先级「会话 > 后端 > 全局」。给 Echo 选的模型不会污染下一次 Claude 会话

前端同样零硬编码：`system` 事件带 `agent` 与 `agents`（`AgentInfo[]`），顶栏的模型/模式/后端三个下拉全部读它；后端选择器只在 `agents.length > 1` 时出现。

详见 [agent-backends.md](./agent-backends.md)。

## 关键设计决策

### 1. 为什么用 CLI 而不是 SDK

`claude` CLI 自带：登录态、会话持久化（jsonl）、`--resume`、技能与子 agent、权限模式。自己拼 SDK 要把这些全部重造一遍。代价是必须处理「进程生命周期」和「协议翻译」，见下。

### 2. 为什么审批桥所有模式都挂

`--permission-prompt-tool` 现在**无条件注册**。早先只给 `default`/`plan` 挂，理由是：一旦注册，CLI 会把**所有**权限判定交给这个 MCP 工具——包括 `acceptEdits` 本该自动放行的编辑，于是每轮都卡在卡片上，5 分钟超时拒绝，模型再试，无限循环。

但条件注册带来三个更糟的问题：

1. `bypassPermissions` 不是「永不询问」——它对某些工具仍会走权限判定，而这些请求当时直接掉在地上；
2. 工具列表是**启动时**固定的，运行中从 `acceptEdits`/`bypassPermissions` 切回 `default`，进程根本没有审批通道，卡片再也不会出现（只能新开会话）；
3. 没有通道意味着「拒绝」是静默发生的，用户完全不知道发生了什么。

所以改成**无条件注册**：

```ts
// claudeCliSession.ts
args.push('--mcp-config', …, '--permission-prompt-tool', 'mcp__agentui__approval');
```

服务端**不判断、不放行、不改写**任何决定，收到什么就转给浏览器：模式该放行的由 CLI 自己放行，该问的才走到卡片。实测（同一进程依次切模式，每次让模型 Write 一个文件）：

| 模式 | 卡片 | 文件 |
|---|---|---|
| `default` | 1（Write） | 允许后创建 |
| `acceptEdits` | 0 | 创建 |
| `bypassPermissions` | 0 | 创建 |
| 切回 `default` | 1（Write） | 允许后创建 |

即：`acceptEdits` 并不会因为挂了审批工具就变成「每个编辑都问」——早先那条「会把所有判定都交出来」的结论在当前 CLI 上不成立，问题其实出在条件注册把审批通道整个关掉了。

### 3. 为什么中断走 control_request 而不是 kill 进程

`kill()` 会连会话上下文一起毁掉。`control_request{subtype:'interrupt'}` 让 CLI 自己中止本轮并回 `control_response`，进程与历史都保留。5 秒没收到 ack 才降级为强杀（`AGENT_UI_INTERRUPT_GRACE_MS`）。

两个按钮因此在语义上不同：

| | 发什么 | 进程 | 上下文 | 之后 |
|---|---|---|---|---|
| 停止（`interrupt`） | `control_request{interrupt}` | 保留 | 保留 | 直接继续对话 |
| 强制结束（`kill`） | 杀进程树 | 结束 | 保留在 jsonl | 下一条消息用 `--resume` 重开 |

两个坑都在「强制结束」这一侧，已经修掉：

- `_finalize()` 原先先把 `sockets` 清空再 dispose，于是唯一能把 UI 拉回空闲的 `exit` 事件根本发不出去——点了按钮看起来就是卡住。现在先 `_broadcast({type:'exit'})` 再清理。
- Windows 上 `child.kill()` 只信号 `claude.exe` 本身，它拉起的 MCP 审批子进程和工具子进程会变成孤儿。改成 `taskkill /PID <pid> /T /F` 杀整棵树。

### 4. 为什么模型/模式切换也是 control_request

同样为了不重启进程、不丢上下文。CLI 回 `control_response{subtype:'success'}` 后立刻发 `config` 事件让 UI 反馈，下一轮 `system/init` 再校准成真实模型名（`haiku` → `deepseek-flash` 这种别名映射只有 CLI 知道）。

### 5. 为什么进行中轮次的镜像放浏览器

CLI 只在一条消息**写完后**才把它追加进 jsonl。所以流式进行到一半时，磁盘上没有任何东西描述这一轮——刷新就会丢。

两个选项：

- **服务端内存镜像**：实现简单，但服务重启就没，且服务端要多存一份状态
- **浏览器 IndexedDB 镜像**：刷新/关标签页都能恢复，服务端保持无状态

当前实现是后者（`web/components/liveTurnStore.ts`），服务端那份以注释形式保留在 `LiveSession.log`，想切回去取消 `emit` 里几行注释即可。

代价：换一个浏览器看不到进行中的那半轮。这是该方案固有的边界。

### 6. 会话进程什么时候回收

```
可回收：!busy（轮次已结束）      ← 跟 WS 连没连上无关
不可回收：busy（有任务在跑）     ← 永远不杀
```

- WS 断开 + 空闲 → `AGENT_UI_REAP_MS`（默认 1 小时）后 `dispose()`
- WS 断开 + 忙碌 → 不设计时器，等 `result` 出来再算
- WS 没断但人走了 → **不回收**（刻意为之，见 operations.md 的已知限制）

每个会话一个 `claude` 进程，单进程几十到上百 MB——这是内存的主要消耗者，不是事件日志。

### 7. 为什么 `@文件` 不自己做展开

实测 CLI 会自己把 prompt 里的 `@path` 展开成文件内容（问 `@package.json` 的 name，直接得到答案，全程零工具调用）。所以前端只负责插入 `@相对路径 ` 文本，搜索走 `GET /api/fs/search`。

### 8. 为什么变更列表要用 `-uall`

`git status --porcelain` 默认把未跟踪目录折叠成一行 `?? server/`，点它打开 diff 是空的（`git show HEAD:server/` 失败、读目录也失败）。加上 `-uall` 才列出具体文件。未跟踪文件没有 HEAD 版本，`--numstat` 也不统计，所以额外读文件数行补上 `+N`。

## 终端：为什么 PTY 活在服务端

`POST /api/terminals` 创建时就 spawn shell，WS 只是**视图**。切标签、刷新页面、断网重连都不会杀掉 shell——重连时服务端先把期间产生的输出（滚动缓冲，100KB）以 `snapshot` 推给前端，前端 `terminal.reset()` 后重放，然后才接实时流。

```
POST /api/terminals ──► spawn pty ──► terminals.json 记录
                              ▲
WS /terminal?id=xxx ──attach──┘   （无客户端 1 小时后回收）
```

代价是多了一层注册表和一个回收计时器；收益是「多个终端」是真的多个并存的 shell，而不是「当前看得见的那个」。

终端按**项目根目录**共享，不按会话：`Workspace` 只按 `root` 挂载，所以同一项目内切换会话连 WS 都不会断。同一个终端可以被多个客户端同时观看（`LiveTerminal.sockets` 是集合，`onData` 广播给全部），这在「同一个项目开两个浏览器标签」时是必需的——早先是单引用，后 attach 的会把前一个顶掉，前一个标签画面冻结却仍能往 shell 里敲字。唯一保留的竞争是 `resize`：两边窗口大小不同会互相覆盖，最后调用的赢。

## 鉴权：为什么用文件而不是数据库

账号量级是「几个人」，读写频率是「登录时」。一个 JSON 文件 + 原子写足够，而且 `~/.agent-ui/users.json` 可以直接查看、可以直接备份、重置就是删文件。引入 SQLite 或 Postgres 只会多一个需要迁移和备份的组件。

安全性不靠存储形式，靠：scrypt + 随机 salt、`timingSafeEqual` 比对、HttpOnly + SameSite=Strict Cookie、30 天滑动过期。密码哈希永远不出服务端（`sanitize()` 剥掉）。

## 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| WS 不断但人走了，进程不回收 | 没有「用户还在看」的信号 | 内存持续占用，需重启服务 |
| 服务被强杀会留孤儿 CLI 进程 | 信号处理器没机会跑；Ctrl+C 不传播给子进程 | 需手动结束，或重启后清扫 |
| 换浏览器看不到进行中的轮次 | 镜像在浏览器侧 | 同浏览器刷新/重开没问题 |
| 运行时切到 `default` 模式没有审批卡 | 审批桥曾按启动模式条件注册，切回来时通道不存在 | 改为无条件注册，服务端不介入判定 |
| 单独终止某个后台任务 | CLI 的 `TaskStop` 只有模型能调 | 只能停整轮 |
