# Agent 后端插件化

agent 通道的上层（WS 路由、生命周期、排队、回收、UI 协议）**完全不认识 claude**。它只跟两个抽象打交道，因此同一套 UI 可以同时挂多个 agent 后端。

## 分层：Cordis 管到哪一层

| 层 | 具体内容 | 谁负责 |
|---|---|---|
| 发现/装载 | 扫后端、解析元数据、选默认 | `AgentRegistry`（自己写，Cordis 只提供容器） |
| 依赖 | 后端之间的服务依赖 | **Cordis**（`ctx.inject` 天生对应） |
| 生命周期 | activate / deactivate / 重载 / 资源回收 | **Cordis**（`ctx.plugin` + `ctx.effect`） |
| 隔离 | 独立进程/worker，崩了不拖垮 UI | 各后端自己（claude 用子进程） |
| API 门面 | 把后端运行时翻译成统一事件流 | **各后端自己**（`createSession` 里做） |

所以：**用 Cordis 替换"扩展管理器"是合理的；它不替代"扩展运行时"**。claude 后端的运行时就是一个子进程，echo 的运行时是内存里的定时器——两者对上层完全透明。

## 两个抽象

```ts
// server/agent/driver.ts
interface AgentSession {
	readonly id: string;                          // 后端报告自己的 session id 之前的内部 id
	sendUserMessage(text: string): void;
	interrupt(): void;
	kill(reason?: string): void;
	setModel(model: string): void;
	setPermissionMode(mode: string): void;
	resolvePermission(requestId: string, decision: PermissionDecision): boolean;
	hasPendingPermission(): boolean;
	cancelPendingPermissions(reason: string): void;
	dispose(): void;
}

interface AgentDriver {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly models: readonly string[];
	readonly permissionModes: readonly string[];
	readonly defaultModel?: string;
	readonly defaultPermissionMode: string;
	readonly supportsResume: boolean;
	createSession(options: AgentSessionOptions, emit: (event: AgentServerEvent) => void): AgentSession;
}
```

`AgentSession` 是「一个正在跑的对话」，`AgentDriver` 是「怎么创建它 + UI 需要什么元数据」。

元数据在线上有一份等价类型 `AgentInfo`（`protocol.ts`），随 `system` 事件下发——**前端的模型下拉、权限模式下拉、后端选择器全部读它，没有一处硬编码**：

```ts
interface AgentInfo {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly models: readonly string[];
	readonly permissionModes: readonly string[];
	readonly defaultModel?: string;
	readonly defaultPermissionMode: string;
	readonly supportsResume: boolean;
}
```

## 多个后端如何同时接入同一套 UI

### 1. 连接级路由：`?agent=<id>`

```
WS /agent?root=<项目路径>&agent=claude
WS /agent?root=<项目路径>&agent=echo
```

`AgentConnection` 在构造时就定下 `_agentId`，**整个 socket 生命周期不变**。解析顺序：

```
?agent= 参数（合法时才认）
  → 持久化的 default.agent（~/.agent-ui/agent-state.json）
  → 第一个注册的后端
```

带 `?agent=` 连接时，它同时会被写进持久化状态，成为后续的默认后端。

### 2. 会话与后端绑定，不中途切换

`LiveSession.agentId` 记录这个会话归谁。认领会话时 `_findLive()` **按 agentId 过滤**——另一个后端的同名 sessionId 永远不会被误认。

含义：**一个会话从生到死只属于一个后端**。想换后端只能新开对话（UI 上的后端选择器就是这么干的：`onAgentChange` → App 清掉 `sessionId` → 下一条消息 spawn 新会话）。

### 3. UI 上的后端选择器

`system` 事件带 `agent` 字段（后端 id）和 `agents`（`AgentInfo[]`）。前端：

- 顶栏下拉框**只在 `agents.length > 1` 时渲染**——只装一个后端时不显示，不打扰
- 选中新后端 → `onAgentChange(next)` → `setActive({ root, agent: next })` → `ChatPanel` 用新的 `agentUrl(root, next)` 重连
- 模型/模式下拉的内容也随后端切换（不同后端的 `models` / `permissionModes` 可以完全不同）

### 4. 配置按后端隔离

`agent-state.json` 的结构就是为此设计的：

```json
{
  "default":  { "agent": "claude" },
  "defaults": {
    "claude": { "model": "sonnet", "permissionMode": "acceptEdits" },
    "echo":   { "model": "fast" }
  },
  "sessions": { "d77aa900-…": { "agent": "claude", "model": "haiku" } }
}
```

`choiceForSession(sessionId, agentId)` 的优先级是**会话 > 后端 > 全局**。所以给 Echo 选的 `fast` 模型不会污染下一次 Claude 会话——这是 `defaults` 按 agentId 分层的唯一目的。

## 现有后端

| id | 文件 | 说明 |
|---|---|---|
| `claude` | `server/agent/plugins/claude.ts` | 驱动 `claude` CLI（stream-json + 控制通道 + MCP 审批桥 + 后台任务轮询） |
| `echo` | `server/agent/plugins/echo.ts` | 回显后端，用于跑通协议与 UI，不调用任何模型 |

`echo` 的存在价值：改协议、改 UI 状态机时不用烧 token 也不用等模型，`?agent=echo` 连上就能验证整条链路。

## 插件宿主

用 [cordis](https://cordis.koishi.chat/)（Koishi 的插件内核）：

```ts
// server/agent/runtime.ts
const ctx = new Context();
const registry = new AgentRegistry();
ctx.set('agents', registry);          // 注册表作为服务注入

ctx.plugin(claudeAgentPlugin(options.claude));
ctx.plugin(echoAgentPlugin());
for (const plugin of options.plugins ?? []) {
	ctx.plugin(plugin);               // 第三方后端从这里进
}
await ctx.start();

if (options.defaultAgent && registry.has(options.defaultAgent)) {
	registry.setDefault(options.defaultAgent);
}
```

`server/index.ts` 在起 HTTP 服务**之前**就 `await createAgentRuntime()`——后端必须先装好，socket 才能按名字选一个。

## 接一个新后端

### 1. 写 driver

```ts
// server/agent/plugins/myAgent.ts
import type { Plugin, Context } from 'cordis';
import type { AgentDriver, AgentSession } from '../driver.js';

const myDriver: AgentDriver = {
	id: 'my-agent',
	name: 'My Agent',
	description: '通过 HTTP 调用某个 agent 服务',
	models: ['small', 'large'],
	permissionModes: ['default', 'auto'],
	defaultPermissionMode: 'auto',
	supportsResume: false,

	createSession(options, emit): AgentSession {
		// 这里可以做任何事：spawn 进程、开 WebSocket、HTTP 长连接……
		return {
			id: randomUUID(),
			sendUserMessage(text) { /* 发出去，收到流后调 emit(...) */ },
			interrupt() { /* 尽力中止；不支持就空实现 */ },
			kill() { /* 清理 */ },
			setModel(model) { /* 或空实现 + emit error 说明不支持 */ },
			setPermissionMode(mode) { /* 同上 */ },
			resolvePermission() { return false; },
			hasPendingPermission() { return false; },
			cancelPendingPermissions() { /* 空实现 */ },
			dispose() { /* 清理 */ },
		};
	},
};

export const myAgentPlugin: Plugin.Object<Context> = {
	name: 'agent-ui:my-agent',
	inject: ['agents'],                 // 拿注册表
	apply(ctx) {
		ctx.agents.register(myDriver);
	},
};
```

### 2. 注册

内置后端改 `runtime.ts`；**第三方后端不要改仓库代码**，从外面传：

```ts
// server/index.ts
const agents = await createAgentRuntime({
	plugins: [myAgentPlugin()],         // 任意数量
});
```

装好后 UI 立刻多一个下拉选项、`?agent=my-agent` 立刻可用，不需要改前端。

### 3. 要遵守的约定

**必须 emit 的事件**

- `system`：至少带 `sessionId`。没有它前端拿不到会话 id，刷新后无法续接；`supportsResume: false` 时也要给一个稳定 id（用内部 id 即可）
- `assistant_delta` / `thinking_delta`：流式文本
- `tool_use` / `tool_result`：工具调用与返回，`id` 必须能配对
- `result`：一轮结束。前端靠它退出 streaming 状态、刷新代码面板、清掉 IndexedDB 镜像
- `error` / `exit`：失败与进程终止

**语义约定**

- `interrupt()` 之后仍然要 emit `result`（`subtype: 'error_during_execution'`），否则前端永远认为在跑
- 不支持的能力要 emit `error` 说明，不要静默吞掉——静默失败在 UI 上表现为「点了没反应」
- `kill(reason)` 的 `reason` 会进调试日志，用于区分「用户强杀」「中断超时」「回收」
- `models` / `permissionModes` 要如实声明：前端的下拉直接读它们，声明了却不实现就是骗 UI

**权限模型**

如果后端有自己的审批机制，把决策转成 `permission_request` 事件，前端会渲染统一的审批卡片（允许 / 本会话总是允许 / 拒绝）。`resolvePermission` 返回 `false` 表示这个 requestId 不存在或已过期。

实现 `pendingPermission?()` 后，客户端重连时路由会重发那条审批：浏览器里的卡片是易失的，后端那边的阻塞不是，不重发就会出现「界面以为没事了、CLI 一直等着」。返回值要给全 `requestId` + 原始 prompt，否则重发的卡片点下去对不上。

## 与 claude 后端的差异点

`plugins/claude.ts` + `claudeCliSession.ts` 里这些是 claude 特有的，新后端不需要照抄：

| 机制 | claude 特有？ |
|---|---|
| `control_request` 控制通道（中断/切模型/切模式） | 是，换成后端自己的 API |
| MCP 审批桥（`permissionPrompt.mjs`） | 是 |
| `parent_tool_use_id` 嵌套 | 是流式协议自带的；其他后端可按自己的父子关系填 |
| 后台任务输出文件轮询 | 是，因为 claude 把输出写文件 |
| `--resume` | 是；`supportsResume: false` 时前端不会传 sessionId |

## 测试路径

1. **先用 `echo` 验证协议改动**——`?agent=echo` 连上，不烧 token 不等模型
2. 新后端第一版只实现 `sendUserMessage` + `assistant_delta` + `result`，让对话能跑起来
3. 再加 `tool_use` / `tool_result`，验证卡片渲染与嵌套
4. 最后加审批、中断、模型/模式切换
5. 每加一步都用 `?agent=<你的后端>` 与 `?agent=claude` 各跑一遍，确认两条链路互不干扰（尤其是配置隔离）
