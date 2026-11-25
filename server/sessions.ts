import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { readAgentUiConfig, underAnyRoot } from './appConfig.js';
import { groupForSession } from './groups.js';
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
	/** The group this conversation belongs to, if any. See `groups.ts`. */
	readonly groupId?: string;
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
	/** Set on the user message that carries a compaction summary. */
	readonly isCompactSummary?: boolean;
	/** The newer compaction record: `{"type":"summary","summary":…,"leafUuid":…}`. */
	readonly summary?: string;
}

/** Raw items parsed from one transcript, plus where the newest compaction starts. */
interface ParsedTranscript {
	readonly items: readonly TranscriptItem[];
	/**
	 * Index of the first item after the newest compaction.
	 *
	 * Everything before it is context the model no longer has: the CLI kept it
	 * on disk, but the conversation continues from the summary.
	 */
	readonly compactedAt?: number;
}

const MAX_ITEMS = 4000;
/** Bytes of one transcript page. Big conversations are read in slices. */
const TRANSCRIPT_PAGE_BYTES = 400 * 1024;
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
	// removing the rule brings it straight back. A whole-group archive counts the
	// same way: the group carries the flag, the members only follow it.
	const archived = (entry: { readonly id: string; readonly projectId: string; readonly cwd: string }): boolean =>
		meta[metaKey(entry.projectId, entry.id)]?.archivedAt !== undefined
		|| underAnyRoot(entry.cwd, config.autoArchive)
		|| groupForSession(entry.id)?.archivedAt !== undefined;

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
			// Groups live in their own file, so the rail cannot see them otherwise.
			groupId: groupForSession(entry.id)?.id,
		};
	}));
}

interface FoundSession {
	readonly projectId: string;
	readonly cwd: string;
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
			return { projectId: project.id, cwd: project.cwd, filePath };
		} catch {
			// keep looking
		}
	}
	return undefined;
}

/** One page of a conversation, newest items last. */
export interface TranscriptPage {
	readonly items: readonly TranscriptItem[];
	/** Older items are on disk; `before` takes the next page up from them. */
	readonly hasMore: boolean;
	/**
	 * Index of `items[0]` in the whole transcript, echoed back as the next
	 * `before`: the client renders a filtered version of the list, so it cannot
	 * count its way to this number.
	 */
	readonly start: number;
}

/** Rough wire size of one item, which is what the page budget is about. */
function itemBytes(item: TranscriptItem): number {
	return JSON.stringify(item).length;
}

/**
 * Reads a conversation in pages.
 *
 * A long conversation is megabytes of jsonl, and sending all of it made opening
 * one slow enough to feel broken. The default page is the newest slice, ending
 * at the newest compaction when there is one — the context before it is history
 * the agent no longer has. `before` walks backwards from what is on screen.
 */
export async function readTranscriptById(
	sessionId: string,
	page: { readonly before?: number; readonly budgetBytes?: number } = {},
): Promise<TranscriptPage> {
	const found = await findSession(sessionId);
	if (!found) {
		return { items: [], hasMore: false, start: 0 };
	}
	const transcript = await readTranscript(found.filePath);
	const all = transcript.items;
	const budget = page.budgetBytes ?? TRANSCRIPT_PAGE_BYTES;
	const end = page.before === undefined ? all.length : Math.max(0, Math.min(page.before, all.length));
	let start = end;
	let used = 0;
	// At least one item, however large: a single huge message still has to open.
	while (start > 0 && (used < budget || start === end)) {
		const size = itemBytes(all[start - 1]!);
		used += size;
		start -= 1;
	}
	if (page.before === undefined && transcript.compactedAt !== undefined && transcript.compactedAt < end) {
		// Summarised-away context is not what the conversation is about any more;
		// "load more" is where it comes back. A boundary at the very end means
		// the compaction just happened, and there is nothing after it to show.
		start = Math.min(transcript.compactedAt, end);
	}
	return { items: all.slice(start, end), hasMore: start > 0, start };
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

async function readTranscript(filePath: string): Promise<ParsedTranscript> {
	const parsed = await parseItemsFile(filePath);
	const items = [...parsed.items];
	for (const subagent of await readSubagents(filePath)) {
		insertSubagent(items, subagent);
	}
	if (items.length <= MAX_ITEMS) {
		return parsed.compactedAt === undefined ? { items } : { items, compactedAt: parsed.compactedAt };
	}
	const dropped = items.length - MAX_ITEMS;
	return {
		items: items.slice(dropped),
		compactedAt: parsed.compactedAt === undefined ? undefined : Math.max(0, parsed.compactedAt - dropped),
	};
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
 * Accumulates parsed items one jsonl line at a time.
 *
 * Both the whole-string path (subagent files, already in memory) and the
 * streamed path (the main transcript, read in chunks) feed this same parser, so
 * they cannot disagree on how a line is interpreted.
 */
class TranscriptParser {
	readonly items: TranscriptItem[] = [];
	private readonly toolIndexes = new Map<string, number>();
	compactedAt: number | undefined;

	constructor(private readonly parentToolUseId?: string) {}

	feed(line: string): void {
		const entry = parseLine(line);
		if (entry?.type === 'attachment') {
			const queued = queuedCommandText(entry.attachment);
			if (queued) {
				this.items.push({ kind: 'user', text: queued, queued: true });
			}
			return;
		}
		// Two shapes of the same thing: the older `summary` record and the newer
		// `isCompactSummary` user message. Either one marks where the live
		// context begins; everything above it was summarised away.
		if (entry?.type === 'summary' || entry?.isCompactSummary === true) {
			this.compactedAt = this.items.length;
			if (entry?.type !== 'user') {
				return;
			}
		}
		if (entry?.type !== 'user' && entry?.type !== 'assistant') {
			return;
		}
		const messageId = entry.message?.id;
		for (const block of blocksOf(entry)) {
			if (block.type === 'text' && typeof block.text === 'string' && !isMetaText(block.text)) {
				// A subagent's prompt is its task description, already on the card.
				if (this.parentToolUseId && entry.type === 'user') {
					continue;
				}
				this.items.push({ kind: entry.type === 'user' ? 'user' : 'assistant', text: block.text, messageId, parentToolUseId: this.parentToolUseId });
			} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
				// Replayed so the reasoning block survives a page reload; the live
				// stream only carries it as deltas.
				this.items.push({ kind: 'thinking', text: block.thinking, messageId, parentToolUseId: this.parentToolUseId });
			} else if (block.type === 'tool_use' && block.id && block.name) {
				this.toolIndexes.set(block.id, this.items.length);
				this.items.push({ kind: 'tool', id: block.id, name: block.name, input: block.input, parentToolUseId: this.parentToolUseId });
			} else if (block.type === 'tool_result' && block.tool_use_id) {
				const index = this.toolIndexes.get(block.tool_use_id);
				if (index === undefined) {
					continue;
				}
				const tool = this.items[index];
				if (tool && tool.kind === 'tool') {
					this.items[index] = {
						...tool,
						result: { content: truncate(stringifyToolResult(block.content), MAX_TOOL_TEXT), isError: block.is_error === true },
					};
				}
			}
		}
	}

	result(): ParsedTranscript {
		return this.compactedAt === undefined ? { items: this.items } : { items: this.items, compactedAt: this.compactedAt };
	}
}

/** Parses an in-memory jsonl string (used for subagent files). */
function parseItems(raw: string, parentToolUseId?: string): ParsedTranscript {
	const parser = new TranscriptParser(parentToolUseId);
	for (const line of raw.split('\n')) {
		parser.feed(line);
	}
	return parser.result();
}

/**
 * Streams a transcript file line by line instead of loading it whole.
 *
 * A large session used to be held in memory three times over — the file string,
 * the array from `split('\n')` and the parsed items. Chunked reading keeps only
 * one chunk plus the carry line. Benchmarked at comparable speed to the whole-
 * string path on an 18 MB transcript (69-81ms vs 67-85ms).
 */
async function parseItemsFile(filePath: string): Promise<ParsedTranscript> {
	const parser = new TranscriptParser();
	const handle = await fs.open(filePath, 'r').catch(() => undefined);
	if (!handle) {
		return { items: [] };
	}
	try {
		const buffer = Buffer.allocUnsafe(256 * 1024);
		let carry = '';
		let bytesRead = 0;
		while ((bytesRead = (await handle.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
			carry += buffer.subarray(0, bytesRead).toString('utf8');
			let start = 0;
			let newline: number;
			while ((newline = carry.indexOf('\n', start)) !== -1) {
				parser.feed(carry.slice(start, newline));
				start = newline + 1;
			}
			carry = carry.slice(start);
		}
		if (carry !== '') {
			parser.feed(carry);
		}
	} finally {
		await handle.close();
	}
	return parser.result();
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
			items: parseItems(raw, typeof meta['toolUseId'] === 'string' ? meta['toolUseId'] : undefined).items,
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

/** One content hit inside a conversation, enough to locate it in the panel. */
export interface SessionMatch {
	readonly sessionId: string;
	readonly projectId: string;
	readonly cwd: string;
	readonly title: string;
	readonly updatedAt: number;
	readonly archived: boolean;
	/** `user`, `assistant`, `thinking` or a tool name. */
	readonly kind: string;
	/** Text around the match, with the query highlighted by the client. */
	readonly snippet: string;
	/** API message id, used by the client to scroll to the exact bubble. */
	readonly messageId?: string;
	/** Tool-call id when the hit came from a tool's input/result. */
	readonly toolUseId?: string;
	/** Parent tool card when the hit is a subagent step folded into a card. */
	readonly parentToolUseId?: string;
	/**
	 * Zero-based index in the parsed transcript item list — the same coordinate
	 * `readTranscriptById` pages by and the browser uses as its `idx:` anchor.
	 * Not a jsonl line number: those include system records and subagent files.
	 */
	readonly index: number;
}

const SEARCH_SNIPPET = 160;
const MAX_MATCHES_PER_SESSION = 6;

/** Fields shared by every hit from one session. */
type SearchContext = Omit<SessionMatch, 'kind' | 'snippet' | 'messageId' | 'toolUseId' | 'parentToolUseId' | 'index'>;

/** Searchable text carried by one parsed transcript item. */
interface ItemSearchPart {
	readonly text: string;
	readonly kind: string;
	readonly toolUseId?: string;
}

/** Pulls searchable text out of a transcript item, matching how it is rendered. */
function itemSearchParts(item: TranscriptItem): readonly ItemSearchPart[] {
	if (item.kind === 'tool') {
		const parts: ItemSearchPart[] = [];
		const input = typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? {});
		parts.push({ text: input, kind: item.name, toolUseId: item.id });
		if (item.result) {
			parts.push({ text: item.result.content, kind: `${item.name} 结果`, toolUseId: item.id });
		}
		return parts;
	}
	if (item.kind === 'thinking') {
		return [{ text: item.text, kind: 'thinking' }];
	}
	return [{ text: item.text, kind: item.kind }];
}

/**
 * Scans one transcript's parsed items for a needle.
 *
 * The index assigned here is the parsed-item index — the same coordinate
 * `readTranscriptById` pages by — so the browser can load exactly the page
 * containing a hit and jump to `idx:<index>`. Searching raw jsonl lines would
 * yield line numbers, a different system that cannot be paged to.
 */
async function searchFile(filePath: string, context: SearchContext, needle: string, limit: number): Promise<readonly SessionMatch[]> {
	const matches: SessionMatch[] = [];
	const { items } = await readTranscript(filePath);
	for (let index = 0; index < items.length && matches.length < limit; index += 1) {
		const item = items[index]!;
		for (const part of itemSearchParts(item)) {
			if (!part.text) {
				continue;
			}
			const lower = part.text.toLowerCase();
			let from = 0;
			while (matches.length < limit) {
				const at = lower.indexOf(needle, from);
				if (at < 0) {
					break;
				}
				const start = Math.max(0, at - SEARCH_SNIPPET / 2);
				const stop = at + needle.length + SEARCH_SNIPPET / 2;
				const snippet = part.text.slice(start, stop).replace(/\s+/g, ' ').trim();
				matches.push({
					...context,
					kind: part.kind,
					snippet: `${start > 0 ? '…' : ''}${snippet}${stop < part.text.length ? '…' : ''}`,
					messageId: item.kind !== 'tool' && 'messageId' in item ? item.messageId : undefined,
					toolUseId: part.toolUseId,
					parentToolUseId: 'parentToolUseId' in item ? item.parentToolUseId : undefined,
					index,
				});
				from = at + needle.length;
			}
			if (matches.length >= limit) {
				break;
			}
		}
	}
	return matches;
}

/**
 * Searches message content across every transcript.
 *
 * Runs a cheap `includes` on each raw line before parsing, so a large history
 * stays responsive and no file is loaded whole. Hits are capped per session;
 * the goal is to find *which* conversations to open, not to index every word.
 */
export async function searchSessions(query: string, options: { readonly limit?: number; readonly includeArchived?: boolean; readonly sessionId?: string } = {}): Promise<readonly SessionMatch[]> {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [];
	}
	await metaReady;
	const meta = metaStore.snapshot;
	// A session-scoped search must not scan other projects: findSession() already
	// validates the id, and a single file keeps the chat's find fast.
	if (options.sessionId !== undefined) {
		const found = await findSession(options.sessionId);
		if (!found) {
			return [];
		}
		const custom = meta[metaKey(found.projectId, options.sessionId)];
		return searchFile(found.filePath, {
			sessionId: options.sessionId,
			projectId: found.projectId,
			cwd: found.cwd,
			title: custom?.title ?? await readTitle(found.filePath),
			archived: custom?.archivedAt !== undefined
				|| groupForSession(options.sessionId)?.archivedAt !== undefined,
			updatedAt: (await fs.stat(found.filePath).catch(() => undefined))?.mtimeMs ?? 0,
		}, needle, options.limit ?? 40);
	}
	const config = await readAgentUiConfig();
	const projects = await listProjects();
	const found: SessionMatch[] = [];
	const limit = options.limit ?? 40;

	for (const project of projects) {
		if (found.length >= limit) {
			break;
		}
		const directory = path.join(projectsDir(), project.id);
		const files = (await fs.readdir(directory).catch(() => [])).filter(file => file.endsWith('.jsonl'));
		for (const file of files) {
			if (found.length >= limit) {
				break;
			}
			const filePath = path.join(directory, file);
			const stat = await fs.stat(filePath).catch(() => undefined);
			if (!stat) {
				continue;
			}
			const sessionId = file.replace(/\.jsonl$/, '');
			const custom = meta[metaKey(project.id, sessionId)];
			const archived = custom?.archivedAt !== undefined
				|| underAnyRoot(project.cwd, config.autoArchive)
				|| groupForSession(sessionId)?.archivedAt !== undefined;
			if (underAnyRoot(project.cwd, config.hide) || (archived && options.includeArchived !== true)) {
				continue;
			}
			const context: SearchContext = {
				sessionId,
				projectId: project.id,
				cwd: project.cwd,
				title: custom?.title ?? await readTitle(filePath),
				updatedAt: stat.mtimeMs,
				archived,
			};
			found.push(...await searchFile(filePath, context, needle, Math.min(MAX_MATCHES_PER_SESSION, limit - found.length)));
		}
	}
	return found.slice(0, limit);
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}… (${value.length - limit} chars trimmed)` : value;
}

export { TITLE_BUDGET };
