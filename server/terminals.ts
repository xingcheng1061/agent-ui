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
 * attaching again replays a rolling buffer of what was printed while nobody was
 * watching. Without that, "multiple terminals" would just mean "whichever one
 * you are looking at right now".
 */

/** How much recent output to keep for a detached terminal. */
const MAX_BUFFER = 100_000;

/** How long a terminal with no client stays alive. */
const REAP_DELAY_MS = 60 * 60 * 1000;

export interface TerminalInfo {
	readonly id: string;
	readonly root: string;
	readonly title: string;
	readonly createdAt: number;
}

interface LiveTerminal {
	readonly info: TerminalInfo;
	readonly pty: IPty;
	/** Rolling tail of output, replayed to the next client that attaches. */
	buffer: string;
	socket?: WebSocket;
	reapTimer?: NodeJS.Timeout;
}

type ClientMessage =
	| { type: 'input'; data: string }
	| { type: 'resize'; cols: number; rows: number };

const store = new JsonStore<{ terminals: readonly TerminalInfo[] }>('terminals.json', { terminals: [] });

const live = new Map<string, LiveTerminal>();

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

function send(socket: WebSocket | undefined, message: unknown): void {
	if (socket?.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(message));
	}
}

export async function preloadTerminals(): Promise<void> {
	await store.load();
}

export async function listTerminals(): Promise<readonly TerminalInfo[]> {
	return store.snapshot.terminals;
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
		}
	});
}

function spawn(info: TerminalInfo): void {
	if (live.has(info.id)) {
		return;
	}
	let pty: IPty;
	try {
		pty = nodePty().spawn(preferredShell(), [], {
			name: 'xterm-256color',
			cols: 80,
			rows: 24,
			cwd: info.root,
			env: currentEnv(),
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

	const entry: LiveTerminal = { info, pty, buffer: '' };
	live.set(info.id, entry);

	pty.onData(data => {
		entry.buffer = (entry.buffer + data).slice(-MAX_BUFFER);
		send(entry.socket, { type: 'output', data });
	});
	pty.onExit(({ exitCode }) => {
		send(entry.socket, { type: 'exit', code: exitCode });
		entry.socket?.close();
		dispose(entry);
		void pruneDeadTerminals();
	});
}

function dispose(entry: LiveTerminal): void {
	if (entry.reapTimer) {
		clearTimeout(entry.reapTimer);
		entry.reapTimer = undefined;
	}
	entry.socket = undefined;
	live.delete(entry.info.id);
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
	entry.socket = socket;
	// The client clears its screen and then receives the missed output.
	send(socket, { type: 'snapshot', data: entry.buffer });

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
		if (entry.socket === socket) {
			entry.socket = undefined;
			armReap(entry);
		}
	});
	return true;
}

/** Terminals recorded in the store whose shell is no longer running. */
export function isLive(id: string): boolean {
	return live.has(id);
}

export function disposeAllTerminals(): void {
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
