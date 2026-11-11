import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { readAgentUiConfig, underAnyRoot } from './appConfig.js';
import { invalidateProjectsCache, listProjects, projectsDir } from './projects.js';
import { JsonStore } from './store.js';

/** Badge state of a subagent, replayed so its card keeps its identity. */
export interface TranscriptTask {
	readonly taskId: string;
	readonly status: string;
	readonly description?: string;
	readonly subagentType?: string;
	readonly taskType?: string;
}

/** Normalized view of a transcript, shaped like what the chat panel renders. */
export type TranscriptItem =
	/**
	 * `queued` marks a message the CLI absorbed into a turn that was already
	 * running: it is in the transcript as a `queued_command` attachment rather
	 * than a user entry, and the panel shows it as "sent mid-turn".
	 */
	| { readonly kind: 'user'; readonly text: string; readonly queued?: boolean }
	/**
	 * `messageId` is the API message the text came from. The browser mirrors the
	 * in-flight turn by message id, so replaying it can skip whatever is already
	 * durable here instead of printing the same answer twice.
	 */
	| { readonly kind: 'assistant'; readonly text: string; readonly messageId?: string; readonly parentToolUseId?: string }
	/** Extended reasoning, persisted by the CLI alongside the answer. */
	| { readonly kind: 'thinking'; readonly text: string; readonly messageId?: string; readonly parentToolUseId?: string }
	| {
		readonly kind: 'tool';
		readonly id: string;
		readonly name: string;
		readonly input: unknown;
		readonly result?: { readonly content: string; readonly isError: boolean };
		/** Set on a subagent's own steps: the tool call that spawned it. */
		readonly parentToolUseId?: string;
		readonly task?: TranscriptTask;
	};

export interface SessionEntry {
	readonly id: string;
	readonly projectId: string;
	readonly cwd: string;
	readonly title: string;
	readonly updatedAt: number;
	readonly size: number;
	/** Archived sessions keep their transcript but stay out of the default list. */
	readonly archived: boolean;
}

interface ContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly input?: unknown;
	readonly tool_use_id?: string;
	readonly is_error?: boolean;
	readonly content?: unknown;
}

interface TranscriptLine {
	readonly type?: string;
	readonly message?: { readonly id?: string; readonly content?: string | readonly ContentBlock[] };
	/**
	 * Content the CLI stores outside the message stream. A message that arrived
	 * mid-turn and was absorbed lands here as `queued_command`, which is the only
	 * trace of it: it never becomes a user message of its own.
	 */
	readonly attachment?: { readonly type?: string; readonly prompt?: unknown };
	/**
	 * The CLI's own generated name, written as a `{"type":"ai-title"}` line. It
	 * is appended again whenever the model retitles the conversation, so the
	 * last one wins.
	 */
	readonly aiTitle?: string;
}

const MAX_ITEMS = 400;
const MAX_TOOL_TEXT = 4000;
const TITLE_BUDGET = 60;
/**
 * ai-title records are appended mid-file — the model names the conversation a
 * few turns in — so title discovery scans the whole transcript in chunks of
 * this size, line-aligned, instead of sampling the head and the tail.
 */
const TITLE_CHUNK_BYTES = 256 * 1024;
/** The fallback title still comes from the head of the file. */
const TITLE_HEAD_BYTES = 64 * 1024;

/**
 * User-owned session properties, keyed by `<projectId>/<sessionId>`.
 *
 * The transcript is the CLI's file, so a rename cannot be written into it
 * without confusing the CLI on its next resume. It lives here instead, next to
 * the archive flag, and shadows the auto-generated title when present.
 */
interface SessionMeta {
	readonly title?: string;
	readonly archivedAt?: number;
}

const metaStore = new JsonStore<Record<string, SessionMeta>>('session-meta.json', {});
const metaReady = metaStore.load();

function metaKey(projectId: string, sessionId: string): string {
	return `${projectId}/${sessionId}`;
}

function parseLine(line: string): TranscriptLine | undefined {
	if (!line.startsWith('{')) {
		return undefined;
	}
	try {
		return JSON.parse(line) as TranscriptLine;
	} catch {
		return undefined;
	}
}

function blocksOf(entry: TranscriptLine): readonly ContentBlock[] {
	const content = entry.message?.content;
	if (typeof content === 'string') {
		return [{ type: 'text', text: content }];
	}
	return content ?? [];
}

/** CLI-injected noise such as `<command-name>` wrappers or the system caveat. */
function isMetaText(text: string): boolean {
	return text.startsWith('<command-') || text.startsWith('<local-command') || text.startsWith('Caveat:');
}

/** Last `ai-title` line in a chunk; the model retitles, so the newest wins. */
function aiTitleOf(chunk: string): string | undefined {
	let found: string | undefined;
	for (const line of chunk.split('\n')) {
		// Cheap filter first: a 64KB head is mostly other records.
		if (!line.includes('ai-title')) {
			continue;
		}
		const entry = parseLine(line);
		if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') {
			const title = entry.aiTitle.trim();
			if (title) {
				found = title;
			}
		}
	}
	return found;
}

/**
 * Display title: the CLI's own AI title when it wrote one, otherwise the first
 * real user message.
 *
 * The name the model picks is what `claude --resume` shows, so preferring it
 * keeps the rail and the CLI in agreement. Head/tail sampling missed it on
 * every real transcript, because the record is appended mid-file — a few turns
 * in — and the file only grows afterwards. So the scan covers everything, and
 * the result is cached: the sidebar re-reads titles for every session on every
 * refresh, and rescanning megabytes each time would be the new bottleneck.
 */
const titleCache = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly title: string }>();

async function readTitle(filePath: string): Promise<string> {
	const handle = await fs.open(filePath, 'r').catch(() => undefined);
	if (!handle) {
		return '(untitled)';
	}
	try {
		const stat = await handle.stat();
		const cached = titleCache.get(filePath);
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
			return cached.title;
		}
		const title = (await scanAiTitle(handle, stat.size)) ?? (await firstUserText(handle));
		titleCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, title });
		return title;
	} finally {
		await handle.close();
	}
}

/**
 * Scans the transcript for the last `ai-title` record.
 *
 * Chunks are aligned to record boundaries on purpose: a 0x0A byte can never
 * occur inside a multi-byte UTF-8 sequence, so splitting the raw bytes at the
 * last newline and decoding each side separately cannot corrupt a record that
 * straddles a chunk boundary. Whatever follows the newline rides along to the
 * next chunk as `pending`.
 */
async function scanAiTitle(handle: FileHandle, size: number): Promise<string | undefined> {
	const buffer = Buffer.alloc(TITLE_CHUNK_BYTES);
	let pending: Buffer = Buffer.alloc(0);
	let title: string | undefined;
	for (let position = 0; position < size; ) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (bytesRead === 0) {
			break;
		}
		position += bytesRead;
		// `concat` copies, so `pending` may keep referencing this chunk while
		// `buffer` is refilled on the next iteration.
		const chunk = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
		const lastNewline = chunk.lastIndexOf(0x0a);
		if (lastNewline === -1) {
			pending = chunk;
			continue;
		}
		pending = chunk.subarray(lastNewline + 1);
		for (const line of chunk.subarray(0, lastNewline).toString('utf8').split('\n')) {
			const found = aiTitleOf(line);
			if (found) {
				title = found;
			}
		}
	}
	if (pending.length > 0) {
		const found = aiTitleOf(pending.toString('utf8'));
		if (found) {
			title = found;
		}
	}
	return title;
}

/** First real user message, the fallback when the CLI never titled the file. */
async function firstUserText(handle: FileHandle): Promise<string> {
	const head = Buffer.alloc(TITLE_HEAD_BYTES);
	const { bytesRead } = await handle.read(head, 0, head.length, 0);
	for (const line of head.subarray(0, bytesRead).toString('utf8').split('\n')) {
		const entry = parseLine(line);
		if (entry?.type !== 'user') {
			continue;
		}
		const text = blocksOf(entry)
			.filter(block => block.type === 'text' && typeof block.text === 'string')
			.map(block => block.text ?? '')
			.join(' ')
			.trim();
		if (text && !isMetaText(text)) {
			return text.length > 80 ? `${text.slice(0, 80)}…` : text;
		}
	}
	return '(untitled)';
}

/** Every session across every project, newest first. */
export async function listAllSessions(options: { readonly includeArchived?: boolean; readonly limit?: number } = {}): Promise<readonly SessionEntry[]> {
	const limit = options.limit ?? 200;
	await metaReady;
	const meta = metaStore.snapshot;
	const projects = await listProjects();
	const entries: { id: string; projectId: string; cwd: string; filePath: string; updatedAt: number; size: number }[] = [];

	for (const project of projects) {
		const directory = path.join(projectsDir(), project.id);
		const files = (await fs.readdir(directory).catch(() => [])).filter(file => file.endsWith('.jsonl'));
		const stats = await Promise.all(files.map(async file => {
			const filePath = path.join(directory, file);
			const stat = await fs.stat(filePath).catch(() => undefined);
			return stat ? { id: file.replace(/\.jsonl$/, ''), filePath, updatedAt: stat.mtimeMs, size: stat.size } : undefined;
		}));
		for (const stat of stats) {
			if (stat) {
				entries.push({ ...stat, projectId: project.id, cwd: project.cwd });
			}
		}
	}

	const config = await readAgentUiConfig();
	const shown = entries.filter(entry => !underAnyRoot(entry.cwd, config.hide));
	// A session under an `autoArchive` root is archived without writing meta, so
	// removing the rule brings it straight back.
	const archived = (entry: { readonly id: string; readonly projectId: string; readonly cwd: string }): boolean =>
		meta[metaKey(entry.projectId, entry.id)]?.archivedAt !== undefined
		|| underAnyRoot(entry.cwd, config.autoArchive);

	shown.sort((a, b) => b.updatedAt - a.updatedAt);
	const visible = options.includeArchived === true
		? shown
		: shown.filter(entry => !archived(entry));
	const page = visible.slice(0, limit);
	return Promise.all(page.map(async entry => {
		const custom = meta[metaKey(entry.projectId, entry.id)];
		return {
			id: entry.id,
			projectId: entry.projectId,
			cwd: entry.cwd,
			// Reading the first prompt is the expensive part; a rename skips it.
			title: custom?.title ?? await readTitle(entry.filePath),
			updatedAt: entry.updatedAt,
			size: entry.size,
			archived: archived(entry),
		};
	}));
}

interface FoundSession {
	readonly projectId: string;
	readonly filePath: string;
}

async function findSession(sessionId: string): Promise<FoundSession | undefined> {
	// Ids are CLI-generated uuids; anything else is a path traversal attempt.
	if (!/^[A-Za-z0-9-]+$/.test(sessionId)) {
		return undefined;
	}
	const projects = await listProjects();
	for (const project of projects) {
		const filePath = path.join(projectsDir(), project.id, `${sessionId}.jsonl`);
		try {
			await fs.access(filePath);
			return { projectId: project.id, filePath };
		} catch {
			// keep looking
		}
	}
	return undefined;
}

export async function readTranscriptById(sessionId: string): Promise<readonly TranscriptItem[]> {
	const found = await findSession(sessionId);
	if (!found) {
		return [];
	}
	return readTranscript(found.filePath);
}

/** Renames a session; an empty title restores the generated one. */
export async function renameSession(sessionId: string, title: string): Promise<boolean> {
	const found = await findSession(sessionId);
	if (!found) {
		return false;
	}
	const trimmed = title.trim().slice(0, 200);
	await metaStore.update(draft => {
		const key = metaKey(found.projectId, sessionId);
		const { title: _current, ...rest } = draft[key] ?? {};
		if (trimmed) {
			draft[key] = { ...rest, title: trimmed };
		} else if (Object.keys(rest).length > 0) {
			draft[key] = rest;
		} else {
			delete draft[key];
		}
	});
	return true;
}

/** Hides a session from the default list without touching its transcript. */
export async function setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
	const found = await findSession(sessionId);
	if (!found) {
		return false;
	}
	await metaStore.update(draft => {
		const key = metaKey(found.projectId, sessionId);
		const { archivedAt: _current, ...rest } = draft[key] ?? {};
		if (archived) {
			draft[key] = { ...rest, archivedAt: Date.now() };
		} else if (Object.keys(rest).length > 0) {
			draft[key] = rest;
		} else {
			delete draft[key];
		}
	});
	return true;
}

/**
 * Removes a path, waiting out the moment a just-killed process still holds it.
 *
 * On Windows a CLI that was stopped a millisecond ago can still own the file
 * and answer EBUSY; the handle is released right after, so a short retry turns
 * a spurious 500 into a successful delete.
 */
async function rmWithRetry(target: string, recursive: boolean): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rm(target, { force: true, recursive });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
			if (!transient || attempt >= 5) {
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}
}

/**
 * Removes a session and everything the CLI wrote beside it.
 *
 * The caller stops a live process first: on Windows a running CLI holds the
 * jsonl open, and deleting it underneath would only fail with EBUSY.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
	const found = await findSession(sessionId);
	if (!found) {
		return false;
	}
	await rmWithRetry(found.filePath, false);
	// `<session>/subagents/` holds the steps of every subagent it spawned.
	await rmWithRetry(path.join(path.dirname(found.filePath), sessionId), true).catch(() => undefined);
	await metaStore.update(draft => {
		delete draft[metaKey(found.projectId, sessionId)];
	});
	invalidateProjectsCache();
	return true;
}

async function readTranscript(filePath: string): Promise<readonly TranscriptItem[]> {
	const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
	const items = parseItems(raw);
	for (const subagent of await readSubagents(filePath)) {
		insertSubagent(items, subagent);
	}
	return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/**
 * Text of a `queued_command` attachment.
 *
 * A message typed while a turn was running is not a user entry in the jsonl: the
 * CLI absorbed it into that turn and only kept the attachment behind. Without
 * this the panel would lose it entirely and read as if the agent answered
 * nothing.
 */
function queuedCommandText(attachment: TranscriptLine['attachment']): string {
	if (attachment?.type !== 'queued_command') {
		return '';
	}
	const prompt = attachment.prompt;
	if (typeof prompt === 'string') {
		return prompt.trim();
	}
	if (!Array.isArray(prompt)) {
		return '';
	}
	const parts: string[] = [];
	for (const block of prompt as readonly ContentBlock[]) {
		if (block && block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
		}
	}
	return parts.join('\n').trim();
}

/**
 * Parses one jsonl file into renderable items.
 *
 * `parentToolUseId` is set for a subagent's own file: everything the subagent
 * did then nests under the tool call that spawned it, exactly like the live
 * stream does.
 */
function parseItems(raw: string, parentToolUseId?: string): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const toolIndexes = new Map<string, number>();

	for (const line of raw.split('\n')) {
		const entry = parseLine(line);
		if (entry?.type === 'attachment') {
			const queued = queuedCommandText(entry.attachment);
			if (queued) {
				items.push({ kind: 'user', text: queued, queued: true });
			}
			continue;
		}
		if (entry?.type !== 'user' && entry?.type !== 'assistant') {
			continue;
		}
		const messageId = entry.message?.id;
		for (const block of blocksOf(entry)) {
			if (block.type === 'text' && typeof block.text === 'string' && !isMetaText(block.text)) {
				// A subagent's prompt is its task description, already on the card.
				if (parentToolUseId && entry.type === 'user') {
					continue;
				}
				items.push({ kind: entry.type === 'user' ? 'user' : 'assistant', text: block.text, messageId, parentToolUseId });
			} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
				// Replayed so the reasoning block survives a page reload; the live
				// stream only carries it as deltas.
				items.push({ kind: 'thinking', text: block.thinking, messageId, parentToolUseId });
			} else if (block.type === 'tool_use' && block.id && block.name) {
				toolIndexes.set(block.id, items.length);
				items.push({ kind: 'tool', id: block.id, name: block.name, input: block.input, parentToolUseId });
			} else if (block.type === 'tool_result' && block.tool_use_id) {
				const index = toolIndexes.get(block.tool_use_id);
				if (index === undefined) {
					continue;
				}
				const tool = items[index];
				if (tool && tool.kind === 'tool') {
					items[index] = {
						...tool,
						result: { content: truncate(stringifyToolResult(block.content), MAX_TOOL_TEXT), isError: block.is_error === true },
					};
				}
			}
		}
	}

	return items;
}

interface SubagentTranscript {
	readonly agentId: string;
	readonly meta: { readonly agentType?: string; readonly description?: string; readonly toolUseId?: string };
	readonly items: readonly TranscriptItem[];
}

/**
 * Subagents store their own transcript under `<session>/subagents/`. The main
 * jsonl only holds the spawning tool call, so without these files a reload kept
 * the `Agent` card but lost every step it took — its reads, its shell commands,
 * its reasoning all vanished.
 */
async function readSubagents(sessionFile: string): Promise<readonly SubagentTranscript[]> {
	const directory = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
	const files = (await fs.readdir(directory).catch(() => [])).filter(file => file.endsWith('.meta.json'));
	const transcripts: SubagentTranscript[] = [];
	for (const file of files) {
		const meta = parseJson(await fs.readFile(path.join(directory, file), 'utf8').catch(() => ''));
		const raw = await fs.readFile(path.join(directory, file.replace(/\.meta\.json$/, '.jsonl')), 'utf8').catch(() => '');
		if (!raw) {
			continue;
		}
		transcripts.push({
			agentId: file.replace(/\.meta\.json$/, '').replace(/^agent-/, ''),
			meta: {
				agentType: typeof meta['agentType'] === 'string' ? meta['agentType'] : undefined,
				description: typeof meta['description'] === 'string' ? meta['description'] : undefined,
				toolUseId: typeof meta['toolUseId'] === 'string' ? meta['toolUseId'] : undefined,
			},
			items: parseItems(raw, typeof meta['toolUseId'] === 'string' ? meta['toolUseId'] : undefined),
		});
	}
	return transcripts;
}

/** Puts a subagent's steps right after the card that spawned them. */
function insertSubagent(items: TranscriptItem[], subagent: SubagentTranscript): void {
	if (!subagent.meta.toolUseId) {
		items.push(...subagent.items);
		return;
	}
	const toolUseId = subagent.meta.toolUseId;
	const task = {
		taskId: subagent.agentId,
		status: 'completed',
		description: subagent.meta.description,
		subagentType: subagent.meta.agentType,
		taskType: 'local_agent',
	};
	const index = items.findIndex(item => item.kind === 'tool' && item.id === toolUseId);
	if (index >= 0) {
		const card = items[index];
		if (card?.kind === 'tool') {
			items[index] = { ...card, task };
		}
		items.splice(index + 1, 0, ...subagent.items);
		return;
	}
	// The spawning call itself was not recorded (older CLI): synthesize the card
	// so the steps still have somewhere to live.
	items.push({
		kind: 'tool',
		id: toolUseId,
		name: 'Agent',
		input: { description: subagent.meta.description, subagent_type: subagent.meta.agentType },
		task,
	}, ...subagent.items);
}

function parseJson(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(item => {
			if (typeof item === 'string') {
				return item;
			}
			if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
				return (item as { text: string }).text;
			}
			return JSON.stringify(item);
		}).join('\n');
	}
	return content === undefined ? '' : JSON.stringify(content);
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}… (${value.length - limit} chars trimmed)` : value;
}

export { TITLE_BUDGET };
