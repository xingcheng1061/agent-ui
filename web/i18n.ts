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
