# Agent 通道协议

`WS /agent?root=<项目路径>`，一连接一项目目录。协议类型定义在 `server/agent/protocol.ts`，浏览器侧镜像在 `web/agentTypes.ts`——**改协议必须同时改这两处**。

## CLI 是怎么被拉起来的

```
claude --print --verbose \
       --input-format stream-json \
       --output-format stream-json \
       --include-partial-messages \
       --permission-mode <mode> \
       [--model <m>] \
       [--resume <sessionId>] \
       [--mcp-config <inline json> --permission-prompt-tool mcp__agentui__approval]
```

- `--print` + `--input-format stream-json`：进程长驻，stdin 一行一个 JSON 命令，stdout 一行一个 JSON 事件
- `--include-partial-messages`：拿到 `stream_event` 增量，否则只有整条消息
- `--resume`：续接已有会话，上下文由 CLI 从自己的 jsonl 恢复
- 最后两项只在 `default` / `plan` 模式加，原因见 [architecture.md](./architecture.md#2-为什么审批桥只在-defaultplan-模式挂)

环境变量会注入三个给 MCP 子进程用的值：`AGENT_UI_PERMISSION_URL` / `_TOKEN` / `_SESSION`。

## 上行（浏览器 → 服务端）

| 命令 | 字段 | 说明 |
|---|---|---|
| `attach` | `sessionId?`、`lastSeq?` | 连接握手：认领该会话的活进程并加入它的观众集合。`lastSeq` 仅记录在日志里用于对齐，服务端**不补发任何事件**（缓冲已停用，见下文「多会话并行」） |
| `detach` | — | 退出该会话的观众集合，**不碰进程**。切到别的会话时用它；再次 `attach` 时，运行中的内容由客户端自己的镜像接上 |
| `user` | `text`、`sessionId?` | 发消息。`busy` 时进入排队（CLI 按 stdin 顺序执行），服务端回 `queue` 事件；若此时有未处理的审批，会先取消审批再发 |
| `interrupt` | — | 优雅中断：`control_request{subtype:'interrupt'}` |
| `kill` | — | 强杀进程 |
| `set_model` | `model` | `control_request{subtype:'set_model'}` |
| `set_permission_mode` | `mode` | `control_request{subtype:'set_permission_mode'}` |
| `permission_response` | `requestId`、`behavior`、`message?` | 答复审批卡片 |
| `reset` | — | 断开路由（进程保留，可被 `--resume` 找回） |

## 下行（服务端 → 浏览器）

| 事件 | 关键字段 | 来源 |
|---|---|---|
| `system` | `sessionId`、`model`、`cwd`、`permissionMode`、`slashCommands`、`skills`、`agents`、`models`、`toolCount` | CLI 的 `system/init`，**每一轮都会重发**。其中的 `models` 由 router 用 driver 的清单覆盖（`{ id, label? }[]`）：CLI 只认三个别名，不知道网关的目录 |
| `config` | `model?`、`permissionMode?`、`models?` | 控制通道成功后的即时反馈；连接建立时也会推一次静态配置。`models` 同样是 `{ id, label? }[]` |
| `session_state` | `live`、`sessionId?`、`busy?`、`lastSeq?` | `attach` 的答复：后台有没有进程、是否在跑、流现在到哪（`lastSeq`）。**一轮真正开始时服务端会再广播一次 `busy: true`**（`attach` 时 `busy` 还是旧的 `false`，客户端以服务端为准，补发才让按钮切到「停止」；多标签一起收到）。`oldestSeq` 字段仍保留在类型里但**不再发送**——服务端没有缓冲可报 |
| `queue` | `items: string[]` | 排队中的消息 |
| `status` | `status` | `requesting` / `idle` / `compacting` / `compacted` |
| `thinking_tokens` | `estimated`、`delta` | 思考预算，一轮几十条 |
| `assistant_delta` | `text`、`parentToolUseId?` | 助手文本增量 |
| `thinking_delta` | `text`、`parentToolUseId?` | 思考内容增量 |
| `tool_use` | `id`、`name`、`input`、`parentToolUseId?` | 工具调用 |
| `tool_result` | `toolUseId`、`isError`、`content`、`parentToolUseId?` | 工具返回 |
| `task_started` | `taskId`、`toolUseId?`、`description`、`subagentType`、`taskType`、`prompt` | 子 agent / 后台任务启动 |
| `task_updated` | `taskId`、`status` | 任务状态变化 |
| `task_progress` | `taskId`、`description`、`usage` | 子 agent 的实时步骤描述与 token 增量 |
| `task_output` | `taskId`、`file`、`chunk` | 后台任务输出文件的增量 |
| `task_notification` | `taskId`、`status`、`summary`、`outputFile`、`usage` | 任务结束 |
| `permission_request` | `requestId`、`toolName`、`input`、`toolUseId?` | 需要审批。`attach` 时若该会话仍有未答复的审批，会以同一个 `requestId` **补发一次**（刷新、换标签、切走再回来都能重新看到卡片） |
| `permission_cancelled` | — | 用户发了新消息，未处理的审批被取消 |
| `result` | `subtype`、`isError`、`text`、`costUsd`、`durationMs`、`numTurns` | 一轮结束 |
| `error` | `message` | CLI 报错或服务端主动提示 |
| `exit` | `code`、`stderr?` | 进程退出 |

## 多会话并行：seq、缓冲与观众

一条 WS 只承载一条会话的事件，但一次对话可以有多条 WS（多标签、多用户），服务端也同时挂着多个会话的进程。三条规则：

1. **`seq` 每条会话单调递增，永不重置**。流式事件带 `seq`；`session_state` / `config` / `queue` / `system` 描述状态，不带 `seq`。
2. **观众是集合，不是独占**。`attach` 把 socket 加进 `entry.sockets`，`detach` 移出；`emit` 广播给集合里所有活着的 socket。两个标签看同一会话互不顶掉。
3. **服务端不缓冲事件**。`LiveSession.log` 的写入已注释停用（`MAX_LOG_EVENTS`、`_replayTail` 一并保留为注释，需要时可整块恢复）。原因：切会话根本不断 socket，回来看的是客户端自己的镜像；而服务端那份缓冲没有字节上限（`tool_result` 不截断），且一轮跑完后要等到下一轮才清空，活着的会话越多越占内存。代价是 socket 真的断开时，正在流式输出的那一段会丢——jsonl 是逐条落盘的，已完成的 message 不受影响。

由此得到的行为：

```
A 正在跑 → 切到 B：A 的连接不关（只是没人渲染），事件继续进 A 的镜像
        → 切回 A：重放 A 自己的镜像（连接 snapshot / IndexedDB），不需要服务端
刷新页面：靠 jsonl + IndexedDB 镜像
断线重连：断线期间正在流式的那一段丢失，服务端不补
```

前端由 `web/components/agentConnections.ts` 的连接池负责：每个会话一条连接，面板借用再归还，切走不关；没人看时若这一轮还在跑就继续收，跑完 15 秒后关闭（最多保留 4 条后台连接）。

## 控制通道

 stdin 上除了 `user` 消息，还可以发：

```json
{"type":"control_request","request_id":"ctrl_1","request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"rc_2","request":{"subtype":"set_model","model":"haiku"}}
{"type":"control_request","request_id":"rc_3","request":{"subtype":"set_permission_mode","mode":"plan"}}
```

CLI 回：

```json
{"type":"control_response","response":{"subtype":"success","request_id":"rc_2"}}
```

实测结论：

- `interrupt` 会让当前轮以 `result/error_during_execution` 结束，**进程与上下文都保留**
- `set_model` / `set_permission_mode` 就地生效，下一轮 `system/init` 反映新值
- **一轮执行中再发一条 `user`，不会打断**：正在跑的工具会跑完，新消息排队执行。唯一副作用是两轮只产生一个 `result` 事件

## 子 agent 与嵌套

`Agent` 工具启动的子 agent，其内部事件都带 `parentToolUseId`（值 = 发起它的那个工具调用 id）。前端据此把这些内容渲染进对应的 `Agent` 卡片里，而不是平铺进主对话。

子 agent 的生命周期：

```
tool_use(Agent) → task_started → task_progress* → tool_result → task_notification
```

后台任务（`Bash(run_in_background)`）走同一套事件，`taskType` 为 `local_bash`；其实时输出不在事件里，而在工具结果给出的文件路径中，服务端按 500ms 轮询该文件，增量以 `task_output` 推送。

## 斜杠命令与 `@` 引用

**斜杠命令**：`system/init` 会带上 `slash_commands`（24 个左右，含 12 个 skill）与 `agents`。把 `/xxx` 当普通消息发出去即可——CLI 会拦截执行：

- `/compact` → 触发 `system/compact_boundary`
- `/code-review` 等 skill → 真的展开成工具调用
- `/help`、`/model`（无参）→ 返回 `result` 但文本为空（结果走交互 UI，stream-json 里拿不到）

**`@` 引用**：CLI 自己展开 prompt 里的 `@path`，前端只插入文本。搜索用 `GET /api/fs/search`。

## 调试

`AGENT_UI_DEBUG=1` 后服务端会打印（带毫秒时间戳）：

```
[14:16:33.326][agent-ui] system model=… mode=acceptEdits session=d77aa900
[14:16:33.326][agent-ui] permission_request Edit
[14:21:33.920][agent-ui:f78c29a1] permission timeout -> deny
[14:21:33.972][agent-ui] result success
[14:37:02.248][agent-ui] agent socket closed code=1006 reason=-
```

常见形态：

| 日志 | 含义 |
|---|---|
| `socket closed code=1006` | 网络断或标签页崩溃（keepalive 30s 探测到会 terminate，触发前端重连） |
| `socket closed code=1001` | 浏览器主动关闭（刷新/关标签页/导航） |
| `permission_request X` 后长时间没有 `result` | 审批卡挂着没人点 |
| `result success (no text)` | 命中了斜杠命令拦截 |
| `exit code=… stderr=…` | CLI 自己退出，stderr 会说明原因 |
