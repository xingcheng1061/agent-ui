import fs from 'node:fs/promises';
import path from 'node:path';
import { listProjects, projectsDir } from './projects.js';

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
	| { readonly kind: 'user'; readonly text: string }
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
}

const MAX_ITEMS = 400;
const MAX_TOOL_TEXT = 4000;
const TITLE_BUDGET = 60;

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

async function readTitle(filePath: string): Promise<string> {
	const handle = await fs.open(filePath, 'r').catch(() => undefined);
	if (!handle) {
		return '(untitled)';
	}
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
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
	} finally {
		await handle.close();
	}
	return '(untitled)';
}

/** Every session across every project, newest first. */
export async function listAllSessions(limit = 200): Promise<readonly SessionEntry[]> {
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

	entries.sort((a, b) => b.updatedAt - a.updatedAt);
	const page = entries.slice(0, limit);
	return Promise.all(page.map(async entry => ({
		id: entry.id,
		projectId: entry.projectId,
		cwd: entry.cwd,
		title: await readTitle(entry.filePath),
		updatedAt: entry.updatedAt,
		size: entry.size,
	})));
}

async function findSessionFile(sessionId: string): Promise<string | undefined> {
	if (!/^[A-Za-z0-9-]+$/.test(sessionId)) {
		return undefined;
	}
	const projects = await listProjects();
	for (const project of projects) {
		const candidate = path.join(projectsDir(), project.id, `${sessionId}.jsonl`);
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return undefined;
}

export async function readTranscriptById(sessionId: string): Promise<readonly TranscriptItem[]> {
	const filePath = await findSessionFile(sessionId);
	if (!filePath) {
		return [];
	}
	return readTranscript(filePath);
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
