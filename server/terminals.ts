import type { IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { PROJECT_ROOT, requestUrl } from './config.js';
import { resolveRoot } from './paths.js';
import { JsonStore } from './store.js';

/**
 * Terminal registry.
 *
 * A terminal is a long-lived PTY that outlives its WebSocket: switching tabs,
 * reloading the page or dropping the connection leaves the shell running, and
 * attaching again replays the tail of a rolling buffer of what was printed
 * while nobody was watching. Without that, "multiple terminals" would just mean
 * "whichever one you are looking at right now".
 */

/** How much recent output to keep for a detached terminal. */
const MAX_BUFFER = 100_000;

/**
 * How much of that buffer a newly attached client is sent.
 *
 * A terminal restores a screen, not a session log. Replaying the whole buffer
 * made every reload — and every tab switch, since the view is keyed by terminal
 * id and therefore remounts — look like "all of my old commands, again": the
 * client resets its screen and repaints up to 100 KB, which is roughly a
 * thousand lines, so the shell seemed to replay its history instead of just
 * being there. A few screens is what a terminal is expected to bring back; the
 * rest stays in the buffer for the client's own scrollback.
 */
const SNAPSHOT_LIMIT = 8_000;

/** How long a terminal with no client stays alive. */
const REAP_DELAY_MS = 60 * 60 * 1000;

/**
 * How much output survives a server restart.
 *
 * The shell itself cannot survive one — the PTY dies with the process — so the
 * terminal is respawned when a client attaches again. Persisting the tail is
 * what keeps that respawn from looking like a wiped screen.
 */
const TAIL_LIMIT = 8_000;

/** How often the persisted tail is refreshed while output flows. */
const TAIL_FLUSH_MS = 2_000;

export interface TerminalInfo {
	readonly id: string;
	readonly root: string;
	readonly title: string;
	readonly createdAt: number;
	/**
	 * Where the shell actually is, as reported by its own prompt.
	 *
	 * `root` is where it was *started*, and stays that way; a relative path
	 * printed after `cd web/components` only makes sense against this one.
	 * Absent when the shell never reported it (cmd, or a customised prompt).
	 */
	readonly cwd?: string;
}

interface LiveTerminal {
	readonly info: TerminalInfo;
	readonly pty: IPty;
	/** Last directory the shell reported; `info.root` until it says otherwise. */
	cwd: string;
	/** Tail of an OSC 7 sequence split across two chunks, held back from the screen. */
	pending: string;
	/** Rolling tail of output, replayed to the next client that attaches. */
	buffer: string;
	/**
	 * Every client currently looking at this shell.
	 *
	 * A set, not one socket: the same terminal is shared by a whole project, so
	 * opening that project in two browser tabs attached twice — and the second
	 * attach used to steal the stream, leaving the first tab's screen frozen
	 * while it could still type into the shell.
	 */
	readonly sockets: Set<WebSocket>;
	reapTimer?: NodeJS.Timeout;
}

type ClientMessage =
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number };

const store = new JsonStore<{ terminals: readonly TerminalInfo[]; tails?: Record<string, string> }>('terminals.json', {
	terminals: [],
});

const live = new Map<string, LiveTerminal>();

/** Terminals whose persisted tail is out of date. */
const dirtyTails = new Set<string>();
let tailTimer: NodeJS.Timeout | undefined;

/**
 * Set while the process is going down.
 *
 * Killing the shells during shutdown makes every PTY exit on its own, and the
 * exit handler prunes the terminal from the store — which erased exactly the
 * records the next process needs in order to respawn them.
 */
let shuttingDown = false;

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import('node-pty');

function nodePty(): NodePtyModule {
	// Native CommonJS: `require` works under ESM where a dynamic import of a
	// native addon is fragile across Node versions.
	return require('node-pty') as NodePtyModule;
}

function currentEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return env;
}

function preferredShell(): string {
	const override = process.env['AGENT_UI_SHELL'];
	if (override) {
		return override;
	}
	if (process.platform === 'win32') {
		return 'powershell.exe';
	}
	return process.env['SHELL'] ?? '/bin/bash';
}

/** Start of the sequence a shell uses to report its directory (OSC 7). */
const OSC7_PREFIX = '\x1b]7;';

/**
 * Prompt hooks that make the shell announce its directory as OSC 7.
 *
 * Ctrl+click on a printed path needs a base for relative paths, and the only
 * honest source for that is the shell itself: the PTY runs in `root` forever,
 * so once the user `cd`s, anything derived from `root` points at a file that
 * does not exist. The sequences are stripped from the stream before it reaches
 * the screen, so nothing visual depends on them.
 *
 * PowerShell is wrapped rather than replaced, so a themed prompt keeps working;
 * `[char]92` is the backslash, spelled that way to keep the escaping in this
 * source readable.
 */
const POWERSHELL_INTEGRATION = [
	'$global:__agentUiPrompt = $function:prompt',
	'function global:prompt {',
	'\t$esc = [char]27',
	'\t$dir = $PWD.Path',
	'\tif ($dir) { [Console]::Write("$esc]7;file:///$($dir.Replace([char]92, [char]47))$([char]7)") }',
	'\tif ($null -ne $global:__agentUiPrompt) { & $global:__agentUiPrompt } else { "PS $dir> " }',
	'}',
].join('\n');

/** The bash/zsh half: additive, so the user's own PROMPT_COMMAND still runs. */
const POSIX_REPORT = 'printf \'\\033]7;file://%s%s\\a\' "${HOSTNAME:-localhost}" "$PWD"';

/**
 * `OSC 7 ; file://host/path BEL`, also accepting the `ST` terminator.
 *
 * The path is everything up to the terminator: a directory with spaces is not
 * percent-encoded by every shell, so the host part cannot be matched greedily.
 */
const OSC7 = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** How much of a half-received sequence is worth waiting for. */
const PENDING_LIMIT = 4096;

function shellIntegration(shell: string): { args: string[]; env: Record<string, string> } {
	const env = currentEnv();
	const name = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
	if (/^pwsh(\.exe)?$/.test(name) || /^powershell(\.exe)?$/.test(name)) {
		return { args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_INTEGRATION], env };
	}
	if (/^(bash|zsh)(\.exe)?$/.test(name)) {
		const existing = env['PROMPT_COMMAND'];
		env['PROMPT_COMMAND'] = existing ? `${POSIX_REPORT}; ${existing}` : POSIX_REPORT;
	}
	return { args: [], env };
}

/** `file:///E:/a/b` -> `E:\a\b`; POSIX paths are left alone. */
function cwdFromReported(reported: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(reported);
	} catch {
		decoded = reported;
	}
	if (/^\/[A-Za-z]:\//.test(decoded)) {
		return decoded.slice(1).replace(/\//g, '\\');
	}
	return decoded;
}

/**
 * Splits the directory reports out of one chunk of output.
 *
 * A PTY chunk can end in the middle of a sequence; rather than printing the
 * fragment and losing the report, the tail is held until the next chunk.
 */
function scanReports(entry: LiveTerminal, chunk: string): { data: string; cwd?: string } {
	const combined = entry.pending + chunk;
	entry.pending = '';
	let cwd: string | undefined;
	const data = combined.replace(OSC7, (_match, reported: string) => {
		cwd = cwdFromReported(reported);
		return '';
	});
	const start = data.lastIndexOf(OSC7_PREFIX);
	if (start >= 0 && data.indexOf('\x07', start) < 0 && data.indexOf('\x1b\\', start) < 0) {
		const partial = data.slice(start);
		if (partial.length <= PENDING_LIMIT) {
			entry.pending = partial;
			return { data: data.slice(0, start), cwd };
		}
	}
	return { data, cwd };
}

function send(socket: WebSocket | undefined, message: unknown): void {
	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}

/** Sends one message to every attached client, dropping the sockets that died. */
function broadcast(entry: LiveTerminal, message: unknown): void {
	for (const socket of entry.sockets) {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(message));
		} else {
			entry.sockets.delete(socket);
		}
	}
}

/**
 * Marks a terminal's screen as worth persisting.
 *
 * Batched: one JSON rewrite per flush window instead of one per output chunk.
 */
function markTailDirty(entry: LiveTerminal): void {
	dirtyTails.add(entry.info.id);
	tailTimer ??= setTimeout(() => {
		tailTimer = undefined;
		void flushTails();
	}, TAIL_FLUSH_MS);
	tailTimer.unref?.();
}

/** Persists the tails of the dirty terminals, or of every live one. */
async function flushTails(everything = false): Promise<void> {
	const ids = everything ? [...live.keys()] : [...dirtyTails];
	if (ids.length === 0) {
		return;
	}
	dirtyTails.clear();
	const tails: Record<string, string> = {};
	for (const id of ids) {
		const entry = live.get(id);
		if (entry && entry.buffer.length > 0) {
			tails[id] = entry.buffer.slice(-TAIL_LIMIT);
		}
	}
	if (Object.keys(tails).length === 0) {
		return;
	}
	await store.update(draft => {
		const stored = (draft.tails ??= {});
		Object.assign(stored, tails);
	});
}

export async function preloadTerminals(): Promise<void> {
	await store.load();
}

export async function listTerminals(): Promise<readonly TerminalInfo[]> {
	// `cwd` is live state, not something the store keeps: a shell that has
	// never started must not look like it is sitting in the project root.
	return store.snapshot.terminals.map(info => {
		const entry = live.get(info.id);
		return entry ? { ...info, cwd: entry.cwd } : info;
	});
}

/** Spawns the shell right away so the terminal exists before anyone attaches. */
export async function createTerminal(root: string, title?: string): Promise<TerminalInfo> {
	const info: TerminalInfo = {
		id: randomUUID(),
		root,
		title: title?.trim() || preferredShell(),
		createdAt: Date.now(),
	};
	await store.update(draft => {
		(draft.terminals as TerminalInfo[]).push(info);
	});
	spawn(info);
	return info;
}

export async function renameTerminal(id: string, title: string): Promise<TerminalInfo | undefined> {
	const existing = store.snapshot.terminals.find(candidate => candidate.id === id);
	if (!existing || title.trim().length === 0) {
		return undefined;
	}
	const updated = { ...existing, title: title.trim() };
	await store.update(draft => {
		const index = draft.terminals.findIndex(candidate => candidate.id === id);
		if (index >= 0) {
			(draft.terminals as TerminalInfo[])[index] = updated;
		}
	});
	const entry = live.get(id);
	if (entry) {
		(entry as { info: TerminalInfo }).info = updated;
	}
	return updated;
}

/** Kills the shell and forgets the terminal. */
export async function closeTerminal(id: string): Promise<boolean> {
	const entry = live.get(id);
	if (entry) {
		dispose(entry);
	}
	await store.update(draft => {
		const terminals = draft.terminals as TerminalInfo[];
		const index = terminals.findIndex(candidate => candidate.id === id);
		if (index >= 0) {
			terminals.splice(index, 1);
		}
		if (draft.tails) {
			delete draft.tails[id];
		}
	});
	return true;
}

/** Forgets terminals whose shell is gone, so the list does not show dead entries. */
export async function pruneDeadTerminals(): Promise<void> {
	const alive = new Set(live.keys());
	const dead = store.snapshot.terminals.filter(candidate => !alive.has(candidate.id));
	if (dead.length === 0) {
		return;
	}
	await store.update(draft => {
		const terminals = draft.terminals as TerminalInfo[];
		for (const gone of dead) {
			const index = terminals.findIndex(candidate => candidate.id === gone.id);
			if (index >= 0) {
				terminals.splice(index, 1);
			}
			if (draft.tails) {
				delete draft.tails[gone.id];
			}
		}
	});
}

function spawn(info: TerminalInfo): void {
	if (live.has(info.id)) {
		return;
	}
	const shell = preferredShell();
	const integration = shellIntegration(shell);
	let pty: IPty;
	try {
		pty = nodePty().spawn(shell, integration.args, {
			name: 'xterm-256color',
			cols: 80,
			rows: 24,
			cwd: info.root,
			env: integration.env,
		});
	} catch (error) {
		console.error(`[agent-ui] terminal ${info.id.slice(0, 8)} failed to start:`, error);
		void store.update(draft => {
			const terminals = draft.terminals as TerminalInfo[];
			const index = terminals.findIndex(candidate => candidate.id === info.id);
			if (index >= 0) {
				terminals.splice(index, 1);
			}
		});
		return;
	}

	// Respawned after a restart: start from what the screen held, and say why the
	// old prompt is not the live one any more.
	const remembered = store.snapshot.tails?.[info.id] ?? '';
	const entry: LiveTerminal = {
		info,
		pty,
		cwd: info.cwd ?? info.root,
		pending: '',
		buffer: remembered
			? `${remembered}\r\n\x1b[2m[agent-ui] 后端已重启，以上为此前输出；此前的进程不再运行。\x1b[0m\r\n`
			: '',
		sockets: new Set(),
	};
	live.set(info.id, entry);

	pty.onData(chunk => {
		const scanned = scanReports(entry, chunk);
		if (scanned.cwd && scanned.cwd !== entry.cwd) {
			entry.cwd = scanned.cwd;
			// Sent separately from the output so a client that only cares about
			// ctrl+click never has to parse the screen.
			broadcast(entry, { type: 'cwd', cwd: entry.cwd });
		}
		const data = scanned.data;
		if (data.length === 0) {
			return;
		}
		entry.buffer = (entry.buffer + data).slice(-MAX_BUFFER);
		markTailDirty(entry);
		broadcast(entry, { type: 'output', data });
	});
	pty.onExit(({ exitCode }) => {
		dispose(entry, exitCode);
		if (!shuttingDown) {
			void pruneDeadTerminals();
		}
	});
}

function dispose(entry: LiveTerminal, exitCode?: number): void {
	if (entry.reapTimer) {
		clearTimeout(entry.reapTimer);
		entry.reapTimer = undefined;
	}
	if (exitCode !== undefined) {
		broadcast(entry, { type: 'exit', code: exitCode });
	}
	// Leave the registry first: the close handlers below check `live` before
	// arming a reap timer, so a disposed terminal cannot be scheduled again.
	live.delete(entry.info.id);
	const sockets = [...entry.sockets];
	entry.sockets.clear();
	for (const socket of sockets) {
		socket.close();
	}
	entry.pty.kill();
}

function armReap(entry: LiveTerminal): void {
	if (entry.reapTimer) {
		clearTimeout(entry.reapTimer);
	}
	entry.reapTimer = setTimeout(() => {
		entry.reapTimer = undefined;
		dispose(entry);
		void pruneDeadTerminals();
	}, REAP_DELAY_MS);
	entry.reapTimer.unref?.();
}

/**
 * The part of the buffer worth replaying to a client that just attached.
 *
 * Cut at a line break: the tail is sliced by characters, and a fragment of a
 * line repainted after `terminal.reset()` renders as garbage.
 */
function snapshotOf(entry: LiveTerminal): string {
	const { buffer } = entry;
	if (buffer.length <= SNAPSHOT_LIMIT) {
		return buffer;
	}
	const tail = buffer.slice(-SNAPSHOT_LIMIT);
	const firstBreak = tail.indexOf('\n');
	return firstBreak < 0 ? tail : tail.slice(firstBreak + 1);
}

/** Attaches a socket to an existing terminal, replaying what it missed. */
export async function attachTerminal(id: string, socket: WebSocket): Promise<boolean> {
	const entry = live.get(id);
	if (!entry) {
		return false;
	}
	if (entry.reapTimer) {
		clearTimeout(entry.reapTimer);
		entry.reapTimer = undefined;
	}
	entry.sockets.add(socket);
	// The client clears its screen and then receives the missed output. Each tab
	// gets its own snapshot, so a second client joining does not disturb the
	// first one's screen. Trimmed to a few screens — see `SNAPSHOT_LIMIT`.
	send(socket, { type: 'snapshot', data: snapshotOf(entry) });
	// Before the next prompt reports again: a client attaching between two
	// prompts must not fall back to the project root for its relative paths.
	send(socket, { type: 'cwd', cwd: entry.cwd });

	socket.on('message', raw => {
		let message: ClientMessage;
		try {
			message = JSON.parse(raw.toString()) as ClientMessage;
		} catch {
			return;
		}
		if (message.type === 'input' && typeof message.data === 'string') {
			entry.pty.write(message.data);
		} else if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
			entry.pty.resize(Math.max(2, Math.floor(message.cols)), Math.max(2, Math.floor(message.rows)));
		}
	});

	socket.on('close', () => {
		entry.sockets.delete(socket);
		// Only a terminal that still exists and has lost its last viewer is a
		// candidate for reaping.
		if (entry.sockets.size === 0 && live.has(entry.info.id)) {
			armReap(entry);
		}
	});
	return true;
}

/** Terminals recorded in the store whose shell is no longer running. */
export function isLive(id: string): boolean {
	return live.has(id);
}

export async function disposeAllTerminals(): Promise<void> {
	shuttingDown = true;
	// Flush first, and await it: the next process replays these tails.
	await flushTails(true);
	for (const entry of [...live.values()]) {
		dispose(entry);
	}
}

export function createTerminalServer(): WebSocketServer {
	const server = new WebSocketServer({ noServer: true });
	server.on('connection', (socket, req) => {
		const url = requestUrl(req.url, req.headers.host);
		const id = url.searchParams.get('id') ?? '';
		void (async () => {
			const root = await resolveRoot(url.searchParams.get('root') ?? PROJECT_ROOT).catch(() => PROJECT_ROOT);
			const known = store.snapshot.terminals.some(candidate => candidate.id === id);
			if (!known) {
				send(socket, { type: 'error', message: `终端不存在：${id}` });
				socket.close();
				return;
			}
			// A recorded terminal whose shell died (server restart) is respawned
			// in its original directory.
			if (!live.has(id)) {
				const info = store.snapshot.terminals.find(candidate => candidate.id === id);
				if (info) {
					spawn({ ...info, root: info.root || root });
				}
			}
			const attached = await attachTerminal(id, socket);
			if (!attached) {
				send(socket, { type: 'error', message: `终端启动失败：${id}` });
				socket.close();
			}
		})();
	});
	return server;
}
