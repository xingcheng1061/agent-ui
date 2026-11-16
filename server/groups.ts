/**
 * Session groups: conversations from *different* projects, bundled by hand.
 *
 * A project is where a conversation runs (`cwd`); a group is what a person is
 * working on. "Refactor the parser" can touch three checkouts at once, and the
 * rail's time-ordered list has no way to say so.
 *
 * The second half of the feature is the shared files. Every group owns a
 * directory with `memory.md` and `progress.md`; those two paths are injected
 * into each member conversation's system prompt, so a session in one project
 * can pick up where a session in another left off.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, JsonStore } from './store.js';

/** The files a group shares; the names are also the API's `name` parameter. */
export const GROUP_FILES = ['memory', 'progress'] as const;
export type GroupFileName = typeof GROUP_FILES[number];

export interface GroupInfo {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
	/** CLI session ids. A session belongs to at most one group. */
	readonly members: readonly string[];
}

/** The writable shape `JsonStore.update` hands to its mutator. */
interface DraftGroup {
	id: string;
	name: string;
	createdAt: number;
	members: string[];
}

interface GroupsDocument {
	version: 1;
	groups: DraftGroup[];
}

const store = new JsonStore<GroupsDocument>('session-groups.json', { version: 1, groups: [] });

const MAX_NAME = 80;
/** Ids this module hands out; anything else in a URL is a mistake, not a path. */
const ID_PATTERN = /^[0-9a-f-]{36}$/;

const TEMPLATES: Record<GroupFileName, (name: string) => string> = {
	memory: name => `# ${name} · 共享记忆\n\n<!-- 同组的会话都能读写这里：结论、约定、决策、踩过的坑。 -->\n`,
	progress: name => `# ${name} · 进度\n\n<!-- 同组的会话都能读写这里：做到哪了、下一步做什么、卡在哪。 -->\n`,
};

export function isGroupFileName(value: string): value is GroupFileName {
	return (GROUP_FILES as readonly string[]).includes(value);
}

export async function preloadGroups(): Promise<void> {
	await store.load();
}

export function listGroups(): readonly GroupInfo[] {
	return store.snapshot.groups;
}

export function groupById(id: string): GroupInfo | undefined {
	return store.snapshot.groups.find(group => group.id === id);
}

/**
 * The group a conversation belongs to, read synchronously.
 *
 * The agent router spawns processes on a synchronous path, so this cannot
 * await: `session-groups.json` is loaded at boot for exactly this reason.
 */
export function groupForSession(sessionId: string | undefined): GroupInfo | undefined {
	if (!sessionId) {
		return undefined;
	}
	return store.snapshot.groups.find(group => group.members.includes(sessionId));
}

/** Where a group's shared files live: `~/.agent-ui/groups/<id>/`. */
export function groupDir(id: string): string {
	return path.join(DATA_DIR, 'groups', id);
}

async function ensureGroupDir(group: GroupInfo): Promise<void> {
	const directory = groupDir(group.id);
	await fs.mkdir(directory, { recursive: true });
	for (const name of GROUP_FILES) {
		const file = path.join(directory, `${name}.md`);
		// Never overwrite: a re-created directory keeps whatever the group wrote.
		await fs.writeFile(file, TEMPLATES[name](group.name), { flag: 'wx' }).catch(() => undefined);
	}
}

export async function createGroup(name: string): Promise<GroupInfo> {
	const trimmed = name.trim().slice(0, MAX_NAME) || '未命名组';
	const group: GroupInfo = { id: randomUUID(), name: trimmed, createdAt: Date.now(), members: [] };
	await store.update(draft => {
		draft.groups.push({ id: group.id, name: group.name, createdAt: group.createdAt, members: [] });
	});
	await ensureGroupDir(group);
	return group;
}

export async function renameGroup(id: string, name: string): Promise<GroupInfo | undefined> {
	const trimmed = name.trim().slice(0, MAX_NAME);
	if (!trimmed) {
		return undefined;
	}
	let renamed: GroupInfo | undefined;
	await store.update(draft => {
		const group = draft.groups.find(candidate => candidate.id === id);
		if (group) {
			group.name = trimmed;
			renamed = { ...group, members: [...group.members] };
		}
	});
	return renamed;
}

/** Removes the group and its shared files; conversations are untouched. */
export async function deleteGroup(id: string): Promise<boolean> {
	const exists = store.snapshot.groups.some(group => group.id === id);
	if (!exists) {
		return false;
	}
	await store.update(draft => {
		draft.groups = draft.groups.filter(group => group.id !== id);
	});
	await fs.rm(groupDir(id), { recursive: true, force: true }).catch(() => undefined);
	return true;
}

/**
 * Puts a conversation in a group, or takes it out with `group === undefined`.
 *
 * Membership is exclusive: joining a group leaves the previous one, because two
 * different shared-memory sets is a contradiction the UI cannot express.
 */
export async function setMembership(sessionId: string, groupId: string | undefined): Promise<readonly GroupInfo[]> {
	await store.update(draft => {
		for (const group of draft.groups) {
			const index = group.members.indexOf(sessionId);
			if (index >= 0) {
				group.members.splice(index, 1);
			}
		}
		if (groupId !== undefined) {
			draft.groups.find(group => group.id === groupId)?.members.push(sessionId);
		}
	});
	return store.snapshot.groups;
}

async function readFileOrEmpty(directory: string, name: GroupFileName): Promise<string> {
	return fs.readFile(path.join(directory, `${name}.md`), 'utf8').catch(() => '');
}

export async function readGroupFile(id: string, name: GroupFileName): Promise<string> {
	const group = groupById(id);
	if (!group) {
		return '';
	}
	await ensureGroupDir(group);
	return readFileOrEmpty(groupDir(id), name);
}

export async function writeGroupFile(id: string, name: GroupFileName, content: string): Promise<boolean> {
	const group = groupById(id);
	if (!group) {
		return false;
	}
	await ensureGroupDir(group);
	await fs.writeFile(path.join(groupDir(id), `${name}.md`), content, 'utf8');
	return true;
}

/**
 * What a member conversation is told about its group.
 *
 * Injected with `--append-system-prompt`, because the alternative is copying
 * the files into every project's `CLAUDE.md` — which would write into the
 * user's repositories and go stale the moment the group files change.
 */
export function groupSystemPrompt(group: GroupInfo): string {
	const directory = groupDir(group.id);
	return [
		`你正在一个「共享会话组」里工作：${group.name}。`,
		'',
		'同组还有别的会话，可能运行在别的工作区（别处 checkout、别的子项目）。你们之间通过两个共享文件协作：',
		'',
		`- 记忆：${path.join(directory, 'memory.md')}`,
		`- 进度：${path.join(directory, 'progress.md')}`,
		'',
		'开始动手前先读这两个文件；有值得同组会话知道的东西（结论、决策、踩过的坑、已完成的部分、下一步计划）就写回对应文件，别只留在本次对话里。',
		'共享文件是跨会话的唯一通道：你在对话里说的话，别的会话看不到。',
	].join('\n');
}

/** Group directory for a conversation, so its tools may touch the files. */
export function groupDirForSession(sessionId: string | undefined): string | undefined {
	const group = groupForSession(sessionId);
	return group ? groupDir(group.id) : undefined;
}
