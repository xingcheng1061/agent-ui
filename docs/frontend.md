# 前端

React 18 + Vite 6，**没有 UI 框架**——全部样式在手写的 `web/styles.css` 里，用 CSS 变量做主题。状态管理不用 Redux/Zustand，`useState` + `useRef` 足够，因为状态基本都长在一个组件里。

## 布局

```
┌───────────────────────────────────────────────────────────┐
│ topbar：标题 · 项目 chip · 路径 · 刷新                      │  36px
├──────────┬─┬──────────────────────┬─┬─────────────────────┤
│ 会话列表  │↔│       对话            │↔│   代码              │
│ 160-520  │ │     320-1200         │ │ 文件树 120-520       │
│          │ │                      │ │ ────↕───────        │
│          │ │                      │ │ 终端 100-720        │
└──────────┴─┴──────────────────────┴─┴─────────────────────┘
```

四条分隔线全部可拖拽，尺寸存 `localStorage`（`agentui.size.rail/chat/tree/terminal`）。关键 CSS：

```css
.body      { grid-template-rows: minmax(0, 1fr); }
.main.split{ grid-template-rows: minmax(0, 1fr); }
```

`minmax(0, 1fr)` 而不是 `1fr`——后者最小值是 `auto`（内容尺寸），会被长对话撑破导致滚动条失效、底部内容被裁掉。这是踩过的坑。

## 组件树

```
App.tsx                         会话状态、三栏布局、新建会话对话框
├── SessionSidebar.tsx          项目 → 会话两级列表
├── ChatPanel.tsx               对话主流程（~1100 行，最大的一块）
│   ├── Markdown.tsx            streamdown 封装
│   ├── CodeHighlight.tsx       shiki 封装
│   ├── ThinkingBlock           思考块（可折叠，默认收起）
│   ├── ToolCard                通用工具卡片（<details> 折叠）
│   └── BashCard                Bash 专用卡片（运行中自动展开，跑完收起）
├── Workspace.tsx               代码区
│   ├── FileTree.tsx            文件树
│   ├── ChangesList.tsx         git 变更（按目录折叠成树）
│   ├── Editor.tsx              Monaco 编辑器
│   ├── DiffView.tsx            Monaco diff（HEAD ↔ 工作区）
│   └── Terminal.tsx            xterm + fit addon
├── NewSessionDialog.tsx        目录选择（/api/fs/browse）
└── Splitter.tsx                拖拽分隔线 + usePersistedSize
```

## ChatPanel 的状态机

这是唯一复杂的地方。核心状态：

| 状态 | 作用 |
|---|---|
| `items` | 渲染用的扁平列表（user / assistant / thinking / tool / result / error） |
| `streamRef` | `Map<parentKey, {assistant?, thinking?}>`，流式气泡 id，按父级隔离 |
| `tasks` | 子 agent / 后台任务列表 |
| `outputs` | `Record<taskId, string>` 后台任务输出累积 |
| `permission` | 待处理的审批 |
| `queued` | 排队中的消息 |
| `meta` | 模型/模式/斜杠命令/skill/agent 列表 |
| `streaming` | 是否正在跑一轮 |

### 嵌套是怎么做的

子 agent 的事件带 `parentToolUseId`。渲染时：

```ts
const parentOf = (item: Item) => 'parentToolUseId' in item ? item.parentToolUseId : undefined;
const roots = items.filter(item => !parentOf(item));
const childrenOf = (id: string) => items.filter(item => parentOf(item) === id);
```

顶层条目平铺，`tool` 条目把自己的 children 渲染进卡片内部。**数据保持扁平**，只在渲染时分层——这样工具结果回填（按 id 找 item）不用递归。

### 流式气泡

`assistant_delta` 到达时按 parent key 找当前气泡 id，没有就建一个；`tool_use` 或 `result` 到达时 `closeStream()` 关闭当前气泡，下一段文本开新气泡。

### 事件 → UI 的映射要点

- `tool_use` 建卡片，`tool_result` 按 `toolUseId` 回填到同一张卡
- `task_started` / `task_progress` / `task_notification` 更新 `tasks`，同时挂到对应的 `Agent` 工具卡片上
- `task_output` 追加到 `outputs[taskId]`，200KB 封顶
- `result` → `streaming=false`、清空思考计数、推 `result` 摘要卡片、触发父组件刷新 git 变更
- `permission_request` → 弹审批卡；`autoAllowRef` 里有的工具名直接自动允许

## 渲染管线

### Markdown

`streamdown`（Vercel，MIT），选它的理由是 `remend` 会修复未闭合的 Markdown——流式中途的 `**粗体` 不会闪原始符号。

```tsx
<Streamdown mode={streaming ? 'streaming' : 'static'} parseIncompleteMarkdown plugins={{ math }}>
```

- `mode` 只对**正在接收 delta 的那一条**用 `streaming`，历史消息用 `static`
- 数学公式走 `@streamdown/math`（KaTeX）。**只认 `$$…$$` 和 `\[…\]`**，单美元 `$…$` 故意关掉——agent 输出里 `$HOME`、`$5` 太常见，会被当成公式吞掉
- `streamdown/styles.css` 只带动画，排版全部自己写（`.md` 系列规则）

### 语法高亮

`shiki` + `github-dark` 主题，**只打包 `bash` / `json` / `diff` 三个语法**（全量要多几 MB）。

Bash 卡片里：

- 命令块 → `bash`
- 输出块 → `guessLanguage()` 猜：JSON 可解析 → `json`；匹配 `diff --git`/`@@` → `diff`；否则 `text`
- `text` 模式把含 `error`/`failed`/`Traceback` 等关键词的行标红——shell 输出大部分不是代码，这比硬套语法实用

高亮是懒加载共享单例，加载完成前显示纯文本，不闪空。shiki 输出自带背景色和内边距，用 CSS 折进卡片（`background: transparent` + 继承字体）。

### Bash 卡片

```tsx
const [open, setOpen] = useState(state === 'running');
const userToggled = useRef(false);

useEffect(() => {
	if (previousState.current === state) { return; }
	previousState.current = state;
	if (userToggled.current) { return; }   // 用户接管后不再自动开合
	setOpen(state === 'running');
}, [state]);
```

折叠态：`▸ ❯ <命令>   完成`。展开态：description → 完整命令（可复制）→ 输出（320px 内部滚动，`overscroll-behavior: contain`）。

不用 `<details>` 而用 `button + 条件渲染`，这样箭头旋转、悬停、样式都能完全控制，也不用跟 React 的 `open` 受控属性打架。

## 输入框

- `/` → 命令菜单，条目来自 `system/init` 的 `slash_commands` + `skills`；`/model`、`/mode` 是前端自己的动作（打开选择器）
- `@` → 文件搜索（`/api/fs/search`，120ms 防抖），选中后插入 `@相对路径 `
- 上下键 / Enter / Tab / Esc 键盘操作；菜单打开时 Enter 不会误发送
- 有文字时按钮是「发送」（流式中变成「排队发送」）；无文字且流式中是「停止」
- 消息以 `/` 开头但不是已注册命令时，输入框会警告「CLI 会把它当斜杠命令拦截并返回空内容」

## 进行中轮次的镜像

`liveTurnStore.ts`，IndexedDB。

**写**：每个 WS 事件追加进内存数组（4000 条上限），250ms 批量刷盘，`pagehide` 时补写。`result` 一到清空并删除记录（jsonl 已接管）。

**读**：刷新后按「jsonl 历史 → 本地镜像 → 实时 delta」拼接。因为服务端不再重放，新页面只会收到「从现在开始」的 delta，与本地镜像首尾相接，不重不漏。

**防护**：若镜像最后一条是 `result`（说明轮次已结束但删除没来得及执行，标签页在 250ms 窗口里崩了），直接丢弃这条记录——那一轮已在 jsonl 里，重放会重复。

**清理**：超过 24 小时的记录在读/写时顺手删掉。

## 主题

两套：**暗色**（默认）与**明亮**。顶栏右侧按钮切换，选择写进 `localStorage`（`agentui.theme`）；首次访问跟随系统 `prefers-color-scheme`。

**机制**：`web/theme.ts` 在模块加载时就把 `data-theme` 写到 `<html>` 上，所以首帧就是对的，不会闪。CSS 侧只有一份规则，暗色是 `:root` 的默认值，明亮是 `:root[data-theme='light']` 的**变量覆盖**——没有任何按主题分支的选择器。

```
:root                         { --bg: #1e1e1e; --fg: #cccccc; … }
:root[data-theme='light']     { --bg: #ffffff; --fg: #1f2328; … }
```

约 30 个语义 token，按用途分组：`--surface*`（卡片/代码块）、`--warn*`（审批卡/队列）、`--ok*` / `--danger*`（状态）、`--user-bubble*`、`--bg-active*`（选中行）。

**不能靠 CSS 的三个组件**各自订阅 `onThemeChange`：

| 组件 | 做法 |
|---|---|
| Monaco | `monaco.editor.setTheme('vs' / 'vs-dark')`，一次调用重绘所有编辑器 |
| xterm | `terminal.options.theme = …`，两套调色板都声明在 `Terminal.tsx` 里 |
| shiki | 高亮器同时加载 `github-dark` 与 `github-light`（后者被 Vite 拆成懒加载 chunk，只有用明亮主题时才下载），每次渲染按当前主题选 |

**踩过的坑**：选中行背景 `--bg-active` 在暗色下配白字，明亮下配浅蓝底——所以额外有 `--bg-active-fg`，两条主题各自给值。漏掉这个的话，明亮主题下选中行会白字白底。

## 踩过的坑

| 现象 | 原因 |
|---|---|
| 刷新后底部内容看不到、滚不动 | grid 隐式行是 `auto`，被内容撑破。要 `minmax(0, 1fr)` |
| 刷新后模型/模式/命令全空 | WS 握手是空的，服务端只在收到 `user` 时才认领会话。加了 `attach` |
| 流式中点发送没反应 | 主按钮在 streaming 时变成「停止」，根本没有排队入口 |
| 未跟踪目录在变更列表里是 `server/` 这种目录行 | `git status` 默认折叠未跟踪目录，要 `-uall` |
| 每一轮都卡在审批、5 分钟循环 | `--permission-prompt-tool` 让 CLI 把所有判定都走 MCP，包括 `acceptEdits` 该放行的编辑 |
| 连上后立刻发第一条消息丢失 | `AgentConnection.start()` 在 `await resolveRoot()` 之后才挂监听。改成连接时先缓冲，接线完再回放 |
| `<details>` 用 `open` 属性时用户展开后又被自动关上 | React 会按 prop 重新应用。改用本地 state + `onToggle` 同步 |
