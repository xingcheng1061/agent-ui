/**
 * clangd, spoken to over stdio.
 *
 * Monaco ships syntax highlighting and nothing else, so "Ctrl+click that
 * function name" needs a real C++ front end with the project's compile flags.
 * clangd is exactly that, and unlike the VS Code extension it does not need an
 * extension host: one process per project root, driven from here.
 *
 * Only the two requests the editor asks for are brokered — `definition` and
 * `hover`. Diagnostics, completion and semantic tokens all ride the same
 * bridge later; they are left out because each one needs UI to go with it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEBUG } from './config.js';
import { normalizeRoot } from './projects.js';

/** A place in a file, 1-based on both axes — what Monaco and the client want. */
export interface DefinitionTarget {
	/** Absolute path: the file may live outside `root`, the client decides. */
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

/** Raised when no clangd binary can be found; the client shows it once. */
export class LspUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LspUnavailableError';
	}
}

interface LspRange {
	readonly start: { readonly line: number; readonly character: number };
	readonly end: { readonly line: number; readonly character: number };
}

interface RpcMessage {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
	readonly error?: { readonly message?: string };
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

interface Session {
	readonly root: string;
	readonly proc: ChildProcessWithoutNullStreams;
	readonly pending: Map<number, Pending>;
	/** uri -> version, for the documents clangd currently has open. */
	readonly documents: Map<string, number>;
	nextId: number;
	/** Bytes of a frame not yet complete: a chunk can split anywhere. */
	buffer: Buffer;
	lastUsed: number;
	closed: boolean;
}

/** A clangd start can index a large project; a request is expected to be quick. */
const INITIALIZE_TIMEOUT_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
/** A directory left alone keeps its process (and its index) for this long. */
const IDLE_MS = 30 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

const sessions = new Map<string, Session>();
/** Starts in flight, so two clicks on one file do not spawn two clangds. */
const starting = new Map<string, Promise<Session>>();
let reaper: NodeJS.Timeout | undefined;

/**
 * Where clangd is.
 *
 * `AGENT_UI_CLANGD` wins, then `PATH` (the normal case on a machine where it
 * was installed properly), then the two places a manual unzip tends to land.
 */
function clangdExecutable(): string | undefined {
	const configured = process.env['AGENT_UI_CLANGD'];
	if (configured && configured.trim() !== '') {
		return configured.trim();
	}
	const name = process.platform === 'win32' ? 'clangd.exe' : 'clangd';
	const folders = (process.env['PATH'] ?? '').split(path.delimiter).filter(folder => folder !== '');
	const guesses = [
		...folders.map(folder => path.join(folder, name)),
		'/usr/bin/clangd',
		'/usr/local/bin/clangd',
		path.join(os.homedir(), '.local', 'bin', 'clangd'),
		'C:\\Program Files\\LLVM\\bin\\clangd.exe',
	];
	for (const guess of guesses) {
		if (existsSync(guess)) {
			return guess;
		}
	}
	return undefined;
}

function label(session: Session): string {
	return path.basename(session.root);
}

function send(session: Session, message: unknown): void {
	if (session.closed) {
		return;
	}
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	session.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
	session.proc.stdin.write(body);
}

function notify(session: Session, method: string, params: unknown): void {
	send(session, { jsonrpc: '2.0', method, params });
}

function request(session: Session, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
	if (session.closed) {
		return Promise.reject(new Error('clangd exited'));
	}
	const id = session.nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			session.pending.delete(id);
			reject(new Error(`${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		session.pending.set(id, { resolve, reject, timer });
		send(session, { jsonrpc: '2.0', id, method, params });
	});
}

/**
 * clangd asks the client questions it will wait for — configuration being the
 * one it always asks. Answering `null` means "use your defaults", which is
 * what we want; leaving it unanswered stalls the request behind it.
 */
function answerClientRequest(session: Session, message: RpcMessage): void {
	let result: unknown = null;
	if (message.method === 'workspace/configuration') {
		const items = (message.params as { items?: unknown[] } | undefined)?.items;
		result = Array.isArray(items) ? items.map(() => null) : [];
	}
	send(session, { jsonrpc: '2.0', id: message.id, result });
}

function handleMessage(session: Session, message: RpcMessage): void {
	if (typeof message.method === 'string') {
		if (message.id === undefined) {
			// publishDiagnostics and friends: the bridge is request/response only.
			return;
		}
		answerClientRequest(session, message);
		return;
	}
	if (message.id === undefined) {
		return;
	}
	const id = Number(message.id);
	const pending = session.pending.get(id);
	if (!pending) {
		return;
	}
	session.pending.delete(id);
	clearTimeout(pending.timer);
	if (message.error) {
		pending.reject(new Error(message.error.message ?? 'clangd request failed'));
	} else {
		pending.resolve(message.result);
	}
}

/** `Content-Length` framed JSON, which is what LSP over stdio is. */
function readFrames(session: Session, chunk: Buffer): void {
	session.buffer = session.buffer.length === 0 ? chunk : Buffer.concat([session.buffer, chunk]);
	for (;;) {
		const headerEnd = session.buffer.indexOf('\r\n\r\n');
		if (headerEnd < 0) {
			return;
		}
		const header = session.buffer.subarray(0, headerEnd).toString('ascii');
		const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
		const start = headerEnd + 4;
		if (!Number.isFinite(length)) {
			// A frame without a usable length cannot be resynchronised by guessing.
			session.buffer = session.buffer.subarray(start);
			continue;
		}
		if (session.buffer.length < start + length) {
			return;
		}
		const body = session.buffer.subarray(start, start + length).toString('utf8');
		session.buffer = session.buffer.subarray(start + length);
		try {
			handleMessage(session, JSON.parse(body) as RpcMessage);
		} catch (error) {
			console.error(`[agent-ui] clangd(${label(session)}) sent unparseable JSON:`, error);
		}
	}
}

function teardown(session: Session, reason: string): void {
	if (session.closed) {
		return;
	}
	session.closed = true;
	sessions.delete(normalizeRoot(session.root));
	for (const [id, pending] of session.pending) {
		clearTimeout(pending.timer);
		pending.reject(new Error(`clangd exited (${reason})`));
		session.pending.delete(id);
	}
	if (DEBUG) {
		console.log(`[agent-ui:lsp] clangd(${label(session)}) stopped: ${reason}`);
	}
}

/**
 * Start clangd for one root and complete the handshake.
 *
 * `compile_commands.json` is found by clangd itself, walking up from the root.
 * `AGENT_UI_COMPILE_COMMANDS_DIR` overrides it for build systems that put the
 * database somewhere else (Bazel: the output base, unless you copy it out).
 */
async function startSession(root: string): Promise<Session> {
	const executable = clangdExecutable();
	if (!executable) {
		throw new LspUnavailableError('找不到 clangd 可执行文件，请安装 LLVM/clangd 或用 AGENT_UI_CLANGD 指定路径');
	}
	const args = ['--log=error', '--enable-config', '--header-insertion=never'];
	const compileCommandsDir = process.env['AGENT_UI_COMPILE_COMMANDS_DIR'];
	if (compileCommandsDir && compileCommandsDir.trim() !== '') {
		args.push(`--compile-commands-dir=${path.resolve(root, compileCommandsDir.trim())}`);
	}
	const proc = spawn(executable, args, {
		cwd: root,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const session: Session = {
		root,
		proc,
		pending: new Map(),
		documents: new Map(),
		nextId: 1,
		buffer: Buffer.alloc(0),
		lastUsed: Date.now(),
		closed: false,
	};
	proc.stdout.on('data', (chunk: Buffer) => readFrames(session, chunk));
	proc.stderr.on('data', (chunk: Buffer) => {
		if (DEBUG) {
			process.stderr.write(`[agent-ui:clangd:${label(session)}] ${chunk.toString('utf8')}`);
		}
	});
	proc.on('error', error => teardown(session, error.message));
	proc.on('exit', (code, signal) => teardown(session, signal ?? String(code)));

	const rootUri = pathToFileURL(root).href;
	await request(session, 'initialize', {
		processId: process.pid,
		clientInfo: { name: 'agent-ui' },
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
		capabilities: {
			textDocument: {
				synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
				definition: { linkSupport: false },
				hover: { contentFormat: ['markdown', 'plaintext'] },
			},
			workspace: { workspaceFolders: true, configuration: true },
			window: { workDoneProgress: true },
		},
	}, INITIALIZE_TIMEOUT_MS);
	notify(session, 'initialized', {});

	if (!reaper) {
		reaper = setInterval(() => {
			const now = Date.now();
			for (const candidate of [...sessions.values()]) {
				if (now - candidate.lastUsed > IDLE_MS) {
					teardown(candidate, 'idle');
					candidate.proc.kill();
				}
			}
		}, REAP_INTERVAL_MS);
		reaper.unref();
	}
	return session;
}

async function sessionFor(root: string): Promise<Session> {
	const key = normalizeRoot(root);
	const existing = sessions.get(key);
	if (existing && !existing.closed) {
		existing.lastUsed = Date.now();
		return existing;
	}
	const inFlight = starting.get(key);
	if (inFlight) {
		return inFlight;
	}
	const created = startSession(root)
		.then(session => {
			sessions.set(key, session);
			if (DEBUG) {
				console.log(`[agent-ui:lsp] clangd(${path.basename(root)}) started`);
			}
			return session;
		})
		.finally(() => starting.delete(key));
	starting.set(key, created);
	return created;
}

function languageIdFor(filePath: string): string {
	const extension = path.extname(filePath).toLowerCase();
	return extension === '.c' ? 'c' : 'cpp';
}

/**
 * Bump the document clangd holds, opening it first if this is the first time.
 *
 * Full-text sync only: the client sends the whole buffer, which is what a
 * 200 kB source file costs anyway, and it removes every reason for the two
 * sides to disagree about what the file contains.
 */
function pushDocument(session: Session, absolutePath: string, text: string): void {
	const uri = pathToFileURL(absolutePath).href;
	const version = (session.documents.get(uri) ?? 0) + 1;
	if (session.documents.has(uri)) {
		notify(session, 'textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
	} else {
		notify(session, 'textDocument/didOpen', {
			textDocument: { uri, languageId: languageIdFor(absolutePath), version, text },
		});
	}
	session.documents.set(uri, version);
}

/** A request about a file clangd has never seen needs its content first. */
async function ensureDocument(session: Session, absolutePath: string): Promise<void> {
	if (session.documents.has(pathToFileURL(absolutePath).href)) {
		return;
	}
	const text = await fs.readFile(absolutePath, 'utf8');
	pushDocument(session, absolutePath, text);
}

function locationsFrom(result: unknown): DefinitionTarget[] {
	const items = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
	const targets: DefinitionTarget[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const value = item as {
			readonly uri?: unknown;
			readonly targetUri?: unknown;
			readonly range?: LspRange;
			readonly targetSelectionRange?: LspRange;
			readonly targetRange?: LspRange;
		} | null;
		if (!value) {
			continue;
		}
		const uri = typeof value.uri === 'string'
			? value.uri
			: typeof value.targetUri === 'string' ? value.targetUri : undefined;
		if (uri === undefined) {
			continue;
		}
		let absolute: string;
		try {
			absolute = fileURLToPath(uri);
		} catch {
			continue;
		}
		const range = value.targetSelectionRange ?? value.range ?? value.targetRange;
		if (!range) {
			continue;
		}
		const target: DefinitionTarget = {
			path: absolute,
			line: range.start.line + 1,
			column: range.start.character + 1,
		};
		const key = `${target.path}:${target.line}:${target.column}`;
		if (!seen.has(key)) {
			seen.add(key);
			targets.push(target);
		}
	}
	return targets;
}

/** Hover content is `string | MarkedString | MarkedString[]`; flatten to markdown. */
function hoverMarkdown(result: unknown): string | undefined {
	const contents = (result as { readonly contents?: unknown } | null | undefined)?.contents;
	if (contents === undefined) {
		return undefined;
	}
	const flatten = (part: unknown): string => {
		if (typeof part === 'string') {
			return part;
		}
		const text = (part as { readonly value?: unknown } | null)?.value;
		return typeof text === 'string' ? text : '';
	};
	const pieces = (Array.isArray(contents) ? contents : [contents]).map(flatten).filter(piece => piece !== '');
	return pieces.length === 0 ? undefined : pieces.join('\n\n');
}

/**
 * Tell clangd what the editor currently holds.
 *
 * Called on open and (debounced, by the client) on every edit; without this
 * the answers describe whatever was last on disk, and jump targets drift.
 */
export async function syncDocument(root: string, absolutePath: string, text: string): Promise<void> {
	const session = await sessionFor(root);
	pushDocument(session, absolutePath, text);
}

export async function closeDocument(root: string, absolutePath: string): Promise<void> {
	const session = sessions.get(normalizeRoot(root));
	const uri = pathToFileURL(absolutePath).href;
	if (!session || session.closed || !session.documents.has(uri)) {
		return;
	}
	session.documents.delete(uri);
	notify(session, 'textDocument/didClose', { textDocument: { uri } });
}

export async function definition(root: string, absolutePath: string, line: number, column: number): Promise<readonly DefinitionTarget[]> {
	const session = await sessionFor(root);
	await ensureDocument(session, absolutePath);
	const result = await request(session, 'textDocument/definition', {
		textDocument: { uri: pathToFileURL(absolutePath).href },
		position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
	});
	return locationsFrom(result);
}

export async function hover(root: string, absolutePath: string, line: number, column: number): Promise<string | undefined> {
	const session = await sessionFor(root);
	await ensureDocument(session, absolutePath);
	const result = await request(session, 'textDocument/hover', {
		textDocument: { uri: pathToFileURL(absolutePath).href },
		position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
	});
	return hoverMarkdown(result);
}

/** Startup cost paid before the first click: handshake only, no indexing wait. */
export async function warmLsp(root: string): Promise<boolean> {
	if (!clangdExecutable()) {
		return false;
	}
	await sessionFor(root);
	return true;
}

export function disposeLsp(): void {
	if (reaper) {
		clearInterval(reaper);
		reaper = undefined;
	}
	for (const session of [...sessions.values()]) {
		teardown(session, 'shutdown');
		session.proc.kill();
	}
}
