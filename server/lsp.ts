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

/** The subset of `textDocument/publishDiagnostics` the editor needs. */
interface RawDiagnostic {
	readonly range: LspRange;
	readonly severity?: number;
	readonly message: string;
	readonly source?: string;
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

/** The `semanticTokensProvider.legend` from clangd's initialize reply. */
interface SemanticLegend {
	readonly tokenTypes: readonly string[];
	readonly tokenModifiers: readonly string[];
}

interface Session {
	readonly root: string;
	readonly proc: ChildProcessWithoutNullStreams;
	readonly executable: string;
	/** Resolved `--compile-commands-dir`, when one was configured. */
	readonly compileCommandsDir?: string;
	/**
	 * The legend clangd answered with. It does not have to match the one we
	 * declared, and its token types are what the data indexes into.
	 */
	legend?: SemanticLegend;
	readonly pending: Map<number, Pending>;
	/** uri -> version, for the documents clangd currently has open. */
	readonly documents: Map<string, number>;
	/** uri -> the text last pushed, so identical pushes can be skipped. */
	readonly texts: Map<string, string>;
	/** uri -> last diagnostics clangd pushed for it. */
	readonly diagnostics: Map<string, readonly RawDiagnostic[]>;
	/** uri -> syncs blocked on the next `publishDiagnostics` for that file. */
	readonly diagnosticWaiters: Map<string, Array<() => void>>;
	nextId: number;
	/** Bytes of a frame not yet complete: a chunk can split anywhere. */
	buffer: Buffer;
	lastUsed: number;
	closed: boolean;
}

/** A clangd start can index a large project; a request is expected to be quick. */
const INITIALIZE_TIMEOUT_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
/**
 * clangd handles one request at a time, so a hover queued behind the first
 * parse of a large translation unit waits much longer than a definition on an
 * already parsed file. Failing at 15 s only throws away work that was about to
 * finish; the tooltip the user asked for is worth the wait.
 */
const HOVER_TIMEOUT_MS = 60 * 1000;

/**
 * Legend shared with the browser: clangd indexes into these arrays, and the
 * editor has to declare the exact same order to decode the token stream.
 */
export const SEMANTIC_TOKEN_TYPES = [
	'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
	'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
	'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
	'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
	'modification', 'documentation', 'defaultLibrary',
] as const;

/** Token types clangd may send that our legend has no slot for. */
const FALLBACK_TOKEN_TYPES: Record<string, string> = {
	unknown: 'variable',
	concept: 'type',
	bracket: 'operator',
	label: 'variable',
};

/**
 * Rewrites the token type and modifier indexes from clangd's legend into ours.
 *
 * The arrays declared in `initialize` are a capability, not a promise: clangd
 * answers with its own legend and indexes the data into that, so `3` means its
 * third type (`function`), not ours (`enum`). Positions and lengths are left
 * untouched — the relative encoding does not depend on the legend at all.
 */
function remapLegend(session: Session, data: readonly number[]): readonly number[] {
	const legend = session.legend;
	if (!legend) {
		return data;
	}
	const ours = SEMANTIC_TOKEN_TYPES as readonly string[];
	const ourModifiers = SEMANTIC_TOKEN_MODIFIERS as readonly string[];
	const fallbackType = ours.indexOf('variable');
	const typeIndexes = legend.tokenTypes.map(name => {
		const index = ours.indexOf(name);
		if (index >= 0) {
			return index;
		}
		const fallback = FALLBACK_TOKEN_TYPES[name];
		return fallback === undefined ? fallbackType : ours.indexOf(fallback);
	});
	const modifierIndexes = legend.tokenModifiers.map(name => ourModifiers.indexOf(name));

	const out: number[] = [];
	for (let offset = 0; offset + 4 < data.length; offset += 5) {
		const mappedType = typeIndexes[data[offset + 3] ?? -1];
		let modifiers = 0;
		const bits = data[offset + 4] ?? 0;
		for (let bit = 0; bit < modifierIndexes.length; bit += 1) {
			if ((bits & (1 << bit)) !== 0) {
				const target = modifierIndexes[bit];
				if (target !== undefined && target >= 0) {
					modifiers |= 1 << target;
				}
			}
		}
		out.push(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, mappedType ?? fallbackType, modifiers);
	}
	return out;
}

/**
 * A directory left alone keeps its process (and its index) for this long.
 *
 * Three hours by default: a cold start on a large compilation database costs
 * minutes of CPU and churns the index cache, which is worse than the memory an
 * idle process holds. `AGENT_UI_LSP_IDLE_MINUTES` adjusts it either way.
 */
const IDLE_MS = (() => {
	const minutes = Number(process.env['AGENT_UI_LSP_IDLE_MINUTES'] ?? '');
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 180 * 60 * 1000;
})();
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
			// clangd pushes diagnostics after every didOpen/didChange; keeping the
			// latest per file is what lets the editor paint squiggles without a
			// second connection.
			if (message.method === 'textDocument/publishDiagnostics') {
				const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined;
				if (typeof params?.uri === 'string' && Array.isArray(params.diagnostics)) {
					session.diagnostics.set(params.uri, params.diagnostics as readonly RawDiagnostic[]);
					// A sync request is waiting for exactly this push.
					const waiters = session.diagnosticWaiters.get(params.uri);
					if (waiters) {
						session.diagnosticWaiters.delete(params.uri);
						for (const wake of waiters) {
							wake();
						}
					}
				}
			}
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
 * `compile_commands.json` is normally found by clangd itself, walking up from
 * each file. That walk leaves the project: in a worktree, a header belonging to
 * the main checkout resolves the main repository's database, which for a
 * monorepo is hundreds of megabytes and tens of thousands of translation units,
 * re-read on every start. When the root has a database of its own we pin it, so
 * the walk never happens. `AGENT_UI_COMPILE_COMMANDS_DIR` overrides the location
 * for build systems that put the database somewhere else (Bazel: the output
 * base, unless you copy it out).
 */
async function startSession(root: string): Promise<Session> {
	const executable = clangdExecutable();
	if (!executable) {
		throw new LspUnavailableError('找不到 clangd 可执行文件，请安装 LLVM/clangd 或用 AGENT_UI_CLANGD 指定路径');
	}
	// `AGENT_UI_CLANGD_LOG=verbose` makes clangd print which compilation
	// database it loaded, which is the quickest way to check a setup.
	const logLevel = process.env['AGENT_UI_CLANGD_LOG'] ?? 'error';
	// Extra flags, space-separated. `--background-index=0` is the usual one for
	// a huge shared compilation database: jump-to-definition and diagnostics
	// still work, but clangd stops indexing every TU up front.
	const extraArgs = (process.env['AGENT_UI_CLANGD_ARGS'] ?? '').split(/\s+/).filter(Boolean);
	const args = [`--log=${logLevel}`, '--enable-config', '--header-insertion=never', ...extraArgs];
	const compileCommandsDir = process.env['AGENT_UI_COMPILE_COMMANDS_DIR'];
	const configuredCompileCommandsDir = compileCommandsDir && compileCommandsDir.trim() !== ''
		? path.resolve(root, compileCommandsDir.trim())
		: undefined;
	const pinnedCompileCommandsDir = configuredCompileCommandsDir
		?? (existsSync(path.join(root, 'compile_commands.json')) ? root : undefined);
	if (pinnedCompileCommandsDir) {
		args.push(`--compile-commands-dir=${pinnedCompileCommandsDir}`);
	}
	const proc = spawn(executable, args, {
		cwd: root,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const session: Session = {
		root,
		proc,
		executable,
		compileCommandsDir: pinnedCompileCommandsDir,
		pending: new Map(),
		documents: new Map(),
		texts: new Map(),
		diagnostics: new Map(),
		diagnosticWaiters: new Map(),
		nextId: 1,
		buffer: Buffer.alloc(0),
		lastUsed: Date.now(),
		closed: false,
	};
	proc.stdout.on('data', (chunk: Buffer) => readFrames(session, chunk));
	proc.stderr.on('data', (chunk: Buffer) => {
		// A requested log level would print nothing without this, and the whole
		// point of raising it is to watch clangd find its database.
		if (DEBUG || process.env['AGENT_UI_CLANGD_LOG']) {
			process.stderr.write(`[agent-ui:clangd:${label(session)}] ${chunk.toString('utf8')}`);
		}
	});
	proc.on('error', error => teardown(session, error.message));
	proc.on('exit', (code, signal) => teardown(session, signal ?? String(code)));

	const rootUri = pathToFileURL(root).href;
	const initialized = await request(session, 'initialize', {
		processId: process.pid,
		clientInfo: { name: 'agent-ui' },
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
		capabilities: {
			textDocument: {
				synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
				// LocationLink carries `targetSelectionRange`, i.e. the identifier
			// itself rather than the whole declaration. Without it a jump lands
			// on the start of the signature (or a leading comment) and looks
			// like it missed.
			definition: { linkSupport: true },
			hover: { contentFormat: ['markdown', 'plaintext'] },
			semanticTokens: {
				requests: { full: true },
				tokenTypes: [...SEMANTIC_TOKEN_TYPES],
				tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
				formats: ['relative'],
			},
			},
			workspace: { workspaceFolders: true, configuration: true },
			window: { workDoneProgress: true },
		},
	}, INITIALIZE_TIMEOUT_MS);
	// clangd's own legend, not the one we asked for: a token type index in the
	// data refers to this array, so `remapLegend` needs it to translate.
	const advertised = (initialized as {
		capabilities?: { semanticTokensProvider?: { legend?: unknown } };
	} | null)?.capabilities?.semanticTokensProvider?.legend;
	if (advertised && typeof advertised === 'object') {
		const candidate = advertised as { tokenTypes?: unknown; tokenModifiers?: unknown };
		if (Array.isArray(candidate.tokenTypes) && Array.isArray(candidate.tokenModifiers)) {
			session.legend = {
				tokenTypes: candidate.tokenTypes.filter((item): item is string => typeof item === 'string'),
				tokenModifiers: candidate.tokenModifiers.filter((item): item is string => typeof item === 'string'),
			};
		}
	}
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
 *
 * Identical text is dropped instead of re-sent. Every caret-driven request
 * carries the buffer, so opening a file used to push `didOpen` and then an
 * identical `didChange` from the first semantic-token request: a new version,
 * a discarded AST, a full re-parse before anything was painted.
 */
function pushDocument(session: Session, absolutePath: string, text: string): void {
	const uri = pathToFileURL(absolutePath).href;
	if (session.documents.has(uri) && session.texts.get(uri) === text) {
		return;
	}
	const version = (session.documents.get(uri) ?? 0) + 1;
	if (session.documents.has(uri)) {
		notify(session, 'textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
	} else {
		notify(session, 'textDocument/didOpen', {
			textDocument: { uri, languageId: languageIdFor(absolutePath), version, text },
		});
	}
	session.documents.set(uri, version);
	session.texts.set(uri, text);
}

/**
 * Waits for clangd's next `publishDiagnostics` for one file.
 *
 * Pushing the document is a notification, so there is nothing to await on the
 * LSP side; this is the missing edge. It resolves on the first push or on the
 * timeout, because clangd stays silent when the diagnostic set did not change.
 */
function waitForDiagnostics(session: Session, uri: string, timeoutMs: number): Promise<void> {
	return new Promise(resolve => {
		const waiters = session.diagnosticWaiters.get(uri) ?? [];
		let settled = false;
		const finish = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref();
		waiters.push(finish);
		session.diagnosticWaiters.set(uri, waiters);
	});
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
export async function syncDocument(
	root: string,
	absolutePath: string,
	text: string,
	waitMs = 0,
): Promise<readonly LspDiagnostic[]> {
	const session = await sessionFor(root);
	const uri = pathToFileURL(absolutePath).href;
	pushDocument(session, absolutePath, text);
	if (waitMs > 0) {
		await waitForDiagnostics(session, uri, waitMs);
		// The first open of a translation unit may still be building its
		// preamble; clangd publishes again when it is ready, so an empty first
		// window gets a second one instead of looking like "no errors".
		if (!session.diagnostics.has(uri)) {
			await waitForDiagnostics(session, uri, waitMs * 3);
		}
	}
	return diagnostics(root, absolutePath);
}

export async function closeDocument(root: string, absolutePath: string): Promise<void> {
	const session = sessions.get(normalizeRoot(root));
	const uri = pathToFileURL(absolutePath).href;
	if (!session || session.closed || !session.documents.has(uri)) {
		return;
	}
	session.documents.delete(uri);
	session.texts.delete(uri);
	notify(session, 'textDocument/didClose', { textDocument: { uri } });
}

export async function definition(root: string, absolutePath: string, line: number, column: number, text?: string): Promise<readonly DefinitionTarget[]> {
	const session = await sessionFor(root);
	// A click right after typing must not be answered about the previous
	// buffer: the editor's current text wins over both the file on disk and a
	// debounced sync that has not fired yet.
	if (text === undefined) {
		await ensureDocument(session, absolutePath);
	} else {
		pushDocument(session, absolutePath, text);
	}
	const result = await request(session, 'textDocument/definition', {
		textDocument: { uri: pathToFileURL(absolutePath).href },
		position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
	});
	return locationsFrom(result);
}

export async function hover(root: string, absolutePath: string, line: number, column: number, text?: string): Promise<string | undefined> {
	const session = await sessionFor(root);
	if (text === undefined) {
		await ensureDocument(session, absolutePath);
	} else {
		pushDocument(session, absolutePath, text);
	}
	const result = await request(session, 'textDocument/hover', {
		textDocument: { uri: pathToFileURL(absolutePath).href },
		position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
	}, HOVER_TIMEOUT_MS);
	return hoverMarkdown(result);
}

/** One marker for the editor, 1-based like everything the client hands Monaco. */
export interface LspDiagnostic {
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly severity: number;
	readonly message: string;
	readonly source?: string;
}

/**
 * The diagnostics clangd last pushed for a file.
 *
 * Push, not pull: clangd sends them after didOpen/didChange, and the editor
 * polls this snapshot instead of holding an LSP connection open in the tab.
 */
export function diagnostics(root: string, absolutePath: string): readonly LspDiagnostic[] {
	const session = sessions.get(normalizeRoot(root));
	if (!session || session.closed) {
		return [];
	}
	const raw = session.diagnostics.get(pathToFileURL(absolutePath).href) ?? [];
	return raw.map(item => ({
		line: item.range.start.line + 1,
		column: item.range.start.character + 1,
		endLine: item.range.end.line + 1,
		endColumn: item.range.end.character + 1,
		severity: item.severity ?? 1,
		message: item.message,
		source: item.source,
	}));
}

/**
 * Semantic tokens for the whole document, in LSP's relative 5-tuple encoding —
 * the same layout Monaco's provider wants, so the array is passed through.
 */
export async function semanticTokens(
	root: string,
	absolutePath: string,
	text?: string,
): Promise<{ resultId?: string; data: readonly number[] }> {
	const session = await sessionFor(root);
	if (text === undefined) {
		await ensureDocument(session, absolutePath);
	} else {
		pushDocument(session, absolutePath, text);
	}
	const result = await request(session, 'textDocument/semanticTokens/full', {
		textDocument: { uri: pathToFileURL(absolutePath).href },
	}) as { resultId?: string; data?: number[] } | null;
	return { resultId: result?.resultId, data: remapLegend(session, result?.data ?? []) };
}

/**
 * Whether a directory is worth a clangd process at all.
 *
 * Warming every project would spawn a C++ front end for repositories that have
 * no C++ in them; a build file or a source file in the root is the cheap test.
 */
async function looksLikeCppProject(root: string): Promise<boolean> {
	for (const marker of ['compile_commands.json', 'CMakeLists.txt', 'build.ninja', 'meson.build']) {
		if (existsSync(path.join(root, marker))) {
			return true;
		}
	}
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	return entries.some(entry => entry.isFile() && /\.(?:c|cc|cpp|cxx|h|hh|hpp)$/i.test(entry.name));
}

/** Startup cost paid before the first click: handshake only, no indexing wait. */
export async function warmLsp(root: string): Promise<boolean> {
	if (!clangdExecutable()) {
		return false;
	}
	if (!(await looksLikeCppProject(root))) {
		return false;
	}
	await sessionFor(root);
	return true;
}

export interface LspStatus {
	readonly running: boolean;
	readonly pid?: number;
	readonly root: string;
	readonly clangd?: string;
	readonly compileCommandsDir?: string;
	readonly documents: number;
	readonly filesWithDiagnostics: number;
}

/** What the server knows about the clangd backing one project root. */
export function lspStatus(root: string): LspStatus {
	const session = sessions.get(normalizeRoot(root));
	if (!session || session.closed) {
		return { running: false, root, documents: 0, filesWithDiagnostics: 0 };
	}
	return {
		running: true,
		pid: session.proc.pid,
		root: session.root,
		clangd: session.executable,
		compileCommandsDir: session.compileCommandsDir,
		documents: session.documents.size,
		filesWithDiagnostics: session.diagnostics.size,
	};
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
