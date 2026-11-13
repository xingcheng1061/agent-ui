/**
 * UI language, Chinese and English for now.
 *
 * The dictionary is keyed by the Chinese string itself rather than by invented
 * ids: a missing entry then falls back to the text that was already written,
 * so a screen can be translated a line at a time instead of all at once. Add a
 * language by adding a map; `t()` picks the one for the current `lang`.
 *
 * Values use `{name}` placeholders, filled by the second argument:
 *
 *     t('{n} 个文件', { n: 3 })
 */
import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'agentui.lang';

/** Chinese source string -> English. */
const EN: Readonly<Record<string, string>> = {
	// ---- shell / top bar
	'新会话': 'New conversation',
	'未选择项目': 'No project selected',
	'改密码': 'Change password',
	'退出': 'Sign out',
	'刷新': 'Refresh',
	'明亮主题': 'Light theme',
	'暗色主题': 'Dark theme',
	'切换明亮 / 暗色主题': 'Toggle light / dark theme',
	'需要审批时用声音和系统通知提醒；开启会请求浏览器通知权限': 'Sound and a system notification when an approval is needed; enabling asks for permission',
	'提醒：开': 'Alerts: on',
	'提醒：关': 'Alerts: off',
	'切换语言': 'Switch language',
	'还没有任何项目会话': 'No project conversations yet',
	'无法连接后端：{error}': 'Cannot reach the backend: {error}',
	'重命名失败：{error}': 'Rename failed: {error}',
	'归档失败：{error}': 'Archive failed: {error}',
	'取消归档失败：{error}': 'Unarchive failed: {error}',
	'删除失败：{error}': 'Delete failed: {error}',
	'删除会话「{title}」？\n\n记录文件会一并删除，无法恢复。': 'Delete the conversation "{title}"?\n\nIts transcript file is deleted too; this cannot be undone.',

	// ---- session rail
	'没有找到项目。跑一次 claude 会话后，它的项目会自动出现在这里；': 'No projects found. Run one claude conversation and its project shows up here;',
	'也可以设置': 'or set',
	'手动指定。': 'by hand.',
	'已归档（{count}）': 'Archived ({count})',
	'＋ 新建会话': '+ New conversation',
	'归档的会话仍保留记录，只是默认不在这里列出': 'Archived conversations keep their transcript; they are only hidden by default',
	'显示已归档': 'Show archived',
	'这个项目还没有会话': 'No conversations in this project yet',
	'待审批': 'Needs approval',
	'等待审批：{tool}': 'Waiting for approval: {tool}',
	'正在回答': 'Answering',
	'进程在运行，空闲': 'Process running, idle',
	'重命名（双击会话也可）': 'Rename (or double-click the conversation)',
	'取消归档': 'Unarchive',
	'归档（保留记录，从列表隐藏）': 'Archive (keeps the transcript, hides it from the list)',
	'删除会话（同时删除记录文件，不可恢复）': 'Delete conversation (removes the transcript too, cannot be undone)',
	'今天': 'Today',
	'昨天': 'Yesterday',
	'本周': 'This week',
	'更早': 'Earlier',

	// ---- project filter
	'全部项目': 'All projects',
	'全部项目（{count}）': 'All projects ({count})',
	'按项目筛选': 'Filter by project',
	'{projects} 个项目，共 {sessions} 条会话': '{projects} projects, {sessions} conversations',
	'搜索项目（名称或路径）': 'Search projects (name or path)',
	'项目': 'Projects',
	'没有匹配「{query}」的项目': 'No project matches "{query}"',

	// ---- file tree
	'目录及其中的内容': 'the folder and everything in it',
	'文件': 'file',
	'删除{what}「{name}」？此操作不可撤销。': 'Delete {what} "{name}"? This cannot be undone.',
	'新目录名': 'New folder name',
	'新文件名': 'New file name',
	'新名称': 'New name',
	'搜索文件': 'Search files',
	'搜索中…': 'Searching…',
	'没有匹配「{query}」的文件或目录': 'No file or folder matches "{query}"',
	'新建文件': 'New file',
	'新建文件夹': 'New folder',
	'重命名「{name}」': 'Rename "{name}"',
	'复制文件名': 'Copy file name',
	'复制路径': 'Copy path',
	'删除「{name}」': 'Delete "{name}"',

	// ---- changes list
	'读取中…': 'Loading…',
	'这个目录不是 git 仓库': 'This directory is not a git repository',
	'{count} 个文件': '{count} files',
	'{matched} / {total} 个文件': '{matched} / {total} files',
	'过滤变更文件': 'Filter changed files',
	'没有匹配「{query}」的变更': 'No change matches "{query}"',
	'工作区干净': 'Working tree clean',
	'{path}（{count} 项）': '{path} ({count} items)',

	// ---- new session dialog
	'新建会话': 'New conversation',
	'已有项目': 'Existing projects',
	'选择目录': 'Choose a folder',
	'还没有项目，切到"选择目录"挑一个': 'No projects yet — pick one under "Choose a folder"',
	'输入绝对路径后回车': 'Type an absolute path and press Enter',
	'前往': 'Go',
	'搜索当前目录及其子目录（至少 2 个字）': 'Search this folder and below (at least 2 characters)',
	'当前目录及子目录里没有匹配的目录；可以回到上层目录再搜': 'No matching folder here or below; try a parent folder',
	'（没有子目录）': '(no subfolders)',
	'在此目录新建会话': 'Start a conversation in this folder',

	// ---- auth
	'两次输入的新密码不一致。': 'The new passwords do not match.',
	'新密码至少 6 位。': 'The new password needs at least 6 characters.',
	'修改密码': 'Change password',
	'修改后当前会话保持登录，其他设备需要重新登录。': 'This session stays signed in; other devices have to sign in again.',
	'当前密码': 'Current password',
	'新密码（至少 6 位）': 'New password (at least 6 characters)',
	'确认新密码': 'Confirm new password',
	'密码已修改。': 'Password changed.',
	'取消': 'Cancel',
	'提交中…': 'Submitting…',
	'确认修改': 'Save',
	'创建失败：{error}': 'Could not create the account: {error}',
	'用户名或密码错误。': 'Wrong username or password.',
	'首次使用：创建管理员账号': 'First run: create the admin account',
	'登录以继续': 'Sign in to continue',
	'用户名': 'Username',
	'密码': 'Password',
	'创建并登录': 'Create and sign in',
	'登录': 'Sign in',
	'密码至少 6 位。账号保存在服务端的 ~/.agent-ui/users.json。': 'At least 6 characters. Accounts live in ~/.agent-ui/users.json on the server.',

	// ---- workspace
	'编辑器里有未保存的修改，重新加载会丢弃它们。\n\n{path}': 'The editor has unsaved changes; reloading discards them.\n\n{path}',
	'不在任何已打开的项目里：{path}': 'Not inside any open project: {path}',
	'按文件名定位：{path}': 'Opened by file name: {path}',
	'找不到文件：{path}': 'File not found: {path}',
	'有 {count} 个同名文件，无法确定：{paths}': '{count} files share that name and it is unclear which: {paths}',
	'变更': 'Changes',
	'重新读取文件列表（agent 新建的文件会在每轮结束时自动出现）': 'Reload the file list (files the agent creates appear at the end of each turn)',
	'选择左侧文件，或看"变更"': 'Pick a file on the left, or open "Changes"',
	'关闭 diff': 'Close diff',
	'从磁盘重新读取该文件（agent 改过会自动重载；有未保存修改时会先确认）': 'Reload this file from disk (agent edits reload automatically; unsaved changes are confirmed first)',
	'重新加载': 'Reload',
	'渲染 Markdown，mermaid 代码块会画成图': 'Render Markdown; mermaid blocks become diagrams',
	'源码': 'Source',
	'预览': 'Preview',
	'隐藏终端': 'Hide terminal',
	'显示终端': 'Show terminal',
	'Ctrl+S 保存 · 终端在该项目根目录启动': "Ctrl+S to save · the terminal starts in this project's root",
	'终端名称': 'Terminal name',
	'{title}\n{root}\n双击重命名': '{title}\n{root}\nDouble-click to rename',
	'新建终端': 'New terminal',

	// ---- editor / diff
	'文件还没载入完，保存会截断后面的内容': 'The file is still loading; saving would truncate the rest',
	'这个文件超过编辑器上限，只能只读预览': 'This file is over the editor limit and is read-only',
	'{path}：已载入 {loaded} / {total} MB，滚动到底部继续载入': '{path}: loaded {loaded} / {total} MB, scroll to the bottom to load more',
	'{path}：共 {size} MB，超过编辑器上限，只读预览': '{path}: {size} MB, over the editor limit — read-only',
	'已重新载入 {path}': 'Reloaded {path}',
	'二进制文件，不显示文本 diff': 'Binary file — no text diff',
	'工作区': 'Working tree',
	'{count} 处变更': '{count} changes',
	'无变更': 'No changes',
	'上一个变更': 'Previous change',
	'下一个变更': 'Next change',

	// ---- terminal
	'连接已断开，shell 仍在服务端运行': 'Disconnected — the shell keeps running on the server',
	'重新连接': 'Reconnect',
	'连接中…': 'Connecting…',
	'[无法读取剪贴板：请通过 localhost 或 HTTPS 打开本页]': '[Cannot read the clipboard: open this page through localhost or HTTPS]',

	// ---- misc
	'渲染出错：{error}\n\n{stack}': 'Render error: {error}\n\n{stack}',

	// ---- chat: connection and status
	'未连接': 'Not connected',
	'已载入 {id}': 'Loaded {id}',
	'就绪': 'Ready',
	'就绪，等待输入': 'Ready, waiting for input',
	'后台没有运行中的会话，发送消息即开始': 'No session is running in the background; send a message to start one',
	'等待你回答问题': 'Waiting for your answers',
	'需要审批': 'Approval needed',
	'{tool} 正在等待你的决定': '{tool} is waiting for your decision',
	'已取消审批': 'Approval cancelled',
	'agent 进程退出（code {code}）{stderr}': 'The agent process exited (code {code}){stderr}',
	'连接已断开，正在重连…': 'Disconnected, reconnecting…',
	'用户拒绝': 'Rejected by the user',
	'先选一个选项，或直接输入回答': 'Pick an option first, or type an answer',
	'用户跳过了这些问题。': 'The user skipped these questions.',
	'已跳过': 'Skipped',

	// ---- chat: menus and pickers
	'切换模型': 'Switch model',
	'切换权限模式': 'Switch permission mode',
	'当前': 'Current',
	'模型': 'Model',
	'权限模式': 'Permission mode',
	'模型（运行时切换，不会重启会话）': 'Model (switched at runtime, no restart)',
	'权限模式（运行时切换）': 'Permission mode (switched at runtime)',
	'Agent 后端（切换会开始新会话）': 'Agent backend (switching starts a new conversation)',
	'Agent / 模型 / 权限模式': 'Agent / model / permission mode',

	// ---- chat: status pills and header
	'进行中': 'Running',
	'思考 {count}': 'Thinking {count}',
	'↳ {count} 个任务运行中': '↳ {count} tasks running',
	'后台 agent 进程仍在运行，刷新不会丢': 'The agent process is still running in the background; a refresh does not lose it',
	'后台没有该会话的进程，下一条消息会新建': 'No process for this conversation; the next message starts one',
	'后台运行中': 'Running in background',
	'后台未运行': 'Not running',
	'输入任务，交给 agent 执行（文件改动可在"代码"页查看）': 'Describe a task and let the agent run it (file changes appear under "Code")',

	// ---- chat: questions and approvals
	'需要你回答': 'Your answers are needed',
	'agent 正在等这几个问题的答案': 'The agent is waiting for answers to these questions',
	'可多选': 'Multi-select',
	'也可以直接输入回答（自由文本，回车提交）': 'Or type an answer (free text, Enter to submit)',
	'提交答案': 'Submit answers',
	'跳过': 'Skip',
	'需要审批：{tool}': 'Approval needed: {tool}',
	'agent 正在等待你的决定': 'The agent is waiting for your decision',
	'允许': 'Allow',
	'本会话总是允许 {tool}': 'Always allow {tool} in this conversation',
	'拒绝': 'Deny',
	'排队中 · {count}': 'Queued · {count}',
	'不等这一轮结束，直接插进当前执行过程': 'Skip the wait and inject this into the running turn',
	'立即发送': 'Send now',
	'当前轮次结束后按顺序执行': 'Runs in order once the current turn ends',

	// ---- chat: composer
	'描述任务；Enter 发送 / Shift+Enter 换行；/ 调命令，@ 引用文件': 'Describe a task; Enter to send / Shift+Enter for a newline; / for commands, @ to reference files',
	'等待审批… 也可以直接发送新消息，这会取消本次审批': 'Waiting for approval… you can also send a new message, which cancels this request',
	'“{command}”不是已注册命令，agent 会把它当斜杠命令拦截并返回空内容': '"{command}" is not a registered command; the agent intercepts it as a slash command and answers with nothing',
	'已请求停止，等待当前轮收尾…': 'Stop requested, waiting for the turn to finish…',
	'已超过 1 分钟没有新输出，可能卡住了（可点「停止」后重发）': 'No new output for over a minute; it may be stuck (stop it and send again)',
	'正在执行，可停止或强制结束': 'Running — you can stop it or kill it',
	'/ 命令 · @ 文件 · Enter 发送': '/ commands · @ files · Enter to send',
	'强制结束': 'Kill',
	'停止': 'Stop',
	'排队发送': 'Queue',
	'发送': 'Send',

	// ---- chat: items
	'本轮执行中插入，未单独成轮': 'Sent mid-turn; not a turn of its own',
	'插话': 'Mid-turn',
	'已中断本轮': 'Turn interrupted',
	'{count} 轮': '{count} turns',
	'{count} 行 · 点击展开': '{count} lines · click to expand',
	'加载技能': 'Load skill',
	'{count} 行': '{count} lines',
	'加载中': 'Loading',
	'(没有命令内容)': '(no command)',
	'运行中': 'Running',
	'失败': 'Failed',
	'完成': 'Done',
	'已停止': 'Stopped',
	'出错': 'Error',
	'待处理': 'Pending',
	'已完成': 'Completed',
	'已删除': 'Deleted',
	'生成中': 'Generating',
	'空闲': 'Idle',
	'压缩上下文': 'Compacting context',
	'已压缩': 'Compacted',
	'已复制': 'Copied',
	'复制': 'Copy',
	'执行中…': 'Running…',
	'等待确认…': 'Waiting for confirmation…',
	'还有 {count} 行未显示': '{count} more lines hidden',
	'提问': 'Question',
	'{count} 个问题': '{count} questions',
	'已回答 {count}': 'Answered {count}',
	'未回答': 'Unanswered',
	'答：{answer}': 'Answer: {answer}',
	'搜索': 'Search',
	'页面': 'Page',
	'{done}/{total} 完成': '{done}/{total} done',
	'提交计划': 'Submit plan',
	'进入计划模式': 'Enter plan mode',
	'原始参数': 'Raw arguments',
	'输出': 'Output',
	'{count} 条': '{count}',
	'提示词': 'Prompt',
	'思考': 'Thinking',
	'{count} 字': '{count} chars',
	'读取 {path}': 'Read {path}',
	'改动 {path}': 'Edit {path}',
	'执行 {command}': 'Run {command}',
	'搜索 {pattern}': 'Search {pattern}',
	'查找 {pattern}': 'Find {pattern}',
	'子 agent：{name}': 'Subagent: {name}',
	'抓取 {url}': 'Fetch {url}',
	'向你提问': 'Asks you a question',
	'更新任务清单': 'Update the todo list',
	'新建任务：{subject}': 'New task: {subject}',
	'更新任务 {id}': 'Update task {id}',
	'读取任务输出 {id}': 'Read task output {id}',
	'停止任务 {id}': 'Stop task {id}',
	'调用 {name}': 'Call {name}',
	'{count} 项': '{count} items',
};

const DICTIONARIES: Readonly<Record<Lang, Readonly<Record<string, string>>>> = {
	zh: {},
	en: EN,
};

function detect(): Lang {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		if (stored === 'zh' || stored === 'en') {
			return stored;
		}
	} catch {
		// Storage blocked: follow the browser.
	}
	return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang: Lang = detect();
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
	return lang;
}

export function setLang(next: Lang): void {
	if (next === lang) {
		return;
	}
	lang = next;
	document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
	try {
		window.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Private mode: the choice just is not remembered.
	}
	for (const listener of listeners) {
		listener(next);
	}
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLangChange(listener: (lang: Lang) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Translate one string.
 *
 * Unknown input comes back unchanged, which is the whole point of keying by
 * the Chinese text: a screen that has not been translated yet still reads.
 */
export function t(text: string, params?: Readonly<Record<string, string | number>>): string {
	const template = DICTIONARIES[lang][text] ?? text;
	if (!params) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		const value = params[key];
		return value === undefined ? match : String(value);
	});
}

/** Components subscribe here so a language switch repaints without a reload. */
export function useLang(): Lang {
	return useSyncExternalStore(onLangChange, getLang, getLang);
}
