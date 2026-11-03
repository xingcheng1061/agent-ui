import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { DEBUG, PROJECT_ROOT, REAP_DELAY_MS, requestUrl, stamp } from '../config.js';
import { resolveRoot } from '../paths.js';
import { JsonStore } from '../store.js';
import {
	choiceForSession,
	preloadAgentState,
	rememberChoice,
	rememberDefault,
	rememberSessionChoice,
	sessionChoice,
} from './agentState.js';
import { AgentRegistry, type AgentDriver, type AgentSession } from './driver.js';
import type { AgentClientCommand, AgentInfo, AgentServerEvent, ModelOption, QueuedMessage } from './protocol.js';

export interface AgentServerOptions {
	/** Working directory the agent runs in. */
	readonly cwd: string;
	/** Backends installed by cordis plugins. */
	readonly registry: AgentRegistry;
	/** Fallback when the request and the persisted state name no backend. */
	readonly defaultAgent?: string;
}

interface LiveSession {
	/** Backend that owns this conversation; a session never switches in place. */
	readonly agentId: string;
	/** Project this conversation runs in; the sidebar groups runs by it. */
	readonly root: string;
	session: AgentSession;
	/** Session id reported by the CLI, which is what `--resume` needs. */
	cliSessionId?: string;
	/** Current model the CLI is running, cached from `system/init` and config changes. */
	model?: string;
	/** Current permission mode, cached the same way; survives reconnects. */
	permissionMode?: string;
	/** Command/skill/agent lists, cached from `system/init` for reconnects. */
	slashCommands?: readonly string[];
	skills?: readonly string[];
	agents?: readonly string[];
	/**
	 * Sockets currently watching this session.
	 *
	 * A set, not a single socket: the same conversation may be open in two tabs,
	 * or still watched by a tab the user switched away from, and neither may
	 * steal the stream from the other. Sending is where dead sockets get pruned.
	 */
	readonly sockets: Set<WebSocket>;
	reapTimer?: NodeJS.Timeout;
	/** A turn is being answered; reaping now would silently kill the work. */
	busy: boolean;
	/**
	 * Buffered events of the turn in flight, each already carrying its `seq`.
	 *
	 * DISABLED: nothing is written here any more. Switching conversations never
	 * closes the socket (the browser pool keeps it, see `agentConnections.ts`),
	 * so the panel coming back has its own copy already, and a finished turn
	 * belongs to the jsonl. The server-side copy therefore only cost memory on
	 * every session that still had a process — up to `MAX_LOG_EVENTS` events,
	 * with no byte cap, kept until the next turn started.
	 *
	 * The field, the `entry.log.push` block, `MAX_LOG_EVENTS` and `_replayTail`
	 * are kept commented/empty so the mechanism can be restored as a unit: the
	 * price of turning it back on is that a dropped socket loses whatever the
	 * browser missed mid-stream, which the jsonl does not have yet.
	 */
	readonly log: AgentServerEvent[];
	/** Highest `seq` handed out for this session; never reset. */
	lastSeq: number;
	/**
	 * Messages waiting for the running turn to end.
	 *
	 * They are deliberately *not* written to stdin while the turn runs: the CLI
	 * would absorb them into that turn, and they would never become user entries
	 * of their own in the transcript. See {@link QueuedMessage}.
	 */
	queued: QueuedMessage[];
}

// /** Upper bound on the in-flight event log; deltas are numerous. */
// const MAX_LOG_EVENTS = 4000;

/** How often dead peers are probed; a missed pong terminates the socket. */
const KEEP_ALIVE_INTERVAL_MS = 30_000;

/** Tracks liveness per socket without leaking a parallel map. */
type TrackedSocket = WebSocket & { _agentAlive?: boolean };

/** What the sidebar needs to know about a conversation that still has a process. */
export interface RunningSessionInfo {
	readonly sessionId: string;
	readonly root: string;
	readonly agent: string;
	/** A turn is being answered right now. */
	readonly busy: boolean;
	/** The tool the process is blocked on, waiting for the user to decide. */
	readonly pendingTool?: string;
	readonly permissionMode?: string;
	readonly lastSeq: number;
}

/**
 * Snapshot hook for `GET /api/agents/running`.
 *
 * The runner map lives per server instance, but the process only ever creates
 * one, and the HTTP side has no way to reach into it otherwise. Replaced on
 * `createAgentServer`, so a second instance (tests) simply takes over.
 */
let snapshotRunning: () => readonly RunningSessionInfo[] = () => [];

/**
 * Deferred messages, by CLI session id.
 *
 * A message the user typed and queued must not evaporate when the server
 * restarts: the CLI has not seen it yet, so nothing in the jsonl knows about it.
 * This file is the only copy until it is finally written to stdin.
 */
const queuedStore = new JsonStore<Record<string, QueuedMessage[]>>('agent-queues.json', {});
const queuedReady = queuedStore.load();

/** Conversations with a live process, including ones no tab is watching. */
export function listRunningSessions(): readonly RunningSessionInfo[] {
	return snapshotRunning();
}

export function createAgentServer(options: Omit<AgentServerOptions, 'cwd'>): WebSocketServer {
	const live = new Map<string, LiveSession>();
	snapshotRunning = () => {
		// The map holds the same run under two keys until the CLI reports its id,
		// so dedupe by identity or the sidebar would list a session twice.
		const seen = new Set<LiveSession>();
		const running: RunningSessionInfo[] = [];
		for (const entry of live.values()) {
			if (entry.cliSessionId === undefined || seen.has(entry)) {
				continue;
			}
			seen.add(entry);
			running.push({
				sessionId: entry.cliSessionId,
				root: entry.root,
				agent: entry.agentId,
				busy: entry.busy,
				pendingTool: entry.session.pendingPermission?.()?.prompt.toolName,
				permissionMode: entry.permissionMode,
				lastSeq: entry.lastSeq,
			});
		}
		return running;
	};
	const server = new WebSocketServer({ noServer: true });
	// Persisted model/mode choices; the spawn path reads it synchronously.
	void preloadAgentState();

	// A sleeping laptop or a network switch can silently kill a TCP connection,
	// which used to look like "the agent just stopped". Probing every 30s makes
	// the client's reconnect path fire in seconds instead of minutes.
	const keepAlive = setInterval(() => {
		for (const client of server.clients) {
			const tracked = client as TrackedSocket;
			const alive = tracked._agentAlive !== false;
			tracked._agentAlive = false;
			if (alive) {
				client.ping();
			} else {
				client.terminate();
			}
		}
	}, KEEP_ALIVE_INTERVAL_MS);
	keepAlive.unref();

	server.on('connection', (socket, req) => {
		const tracked = socket as TrackedSocket;
		tracked._agentAlive = true;
		tracked.on('pong', () => { tracked._agentAlive = true; });
		tracked.on('close', (code, reason) => {
			if (DEBUG) {
				console.log(`[${stamp()}][agent-ui] agent socket closed code=${code} reason=${reason.toString() || '-'}`);
			}
		});

		// Resolving the root is async, and a client may send its first command
		// the moment the socket opens. Buffer until the connection is wired up.
		const pending: string[] = [];
		const buffer = (raw: unknown) => pending.push(String(raw));
		socket.on('message', buffer);

		void (async () => {
			const url = requestUrl(req.url, req.headers.host);
			let cwd: string;
			try {
				cwd = await resolveRoot(url.searchParams.get('root') ?? PROJECT_ROOT);
			} catch (error) {
				socket.send(JSON.stringify({
					type: 'error',
					message: error instanceof Error ? error.message : String(error),
				} satisfies AgentServerEvent));
				socket.close();
				return;
			}
			const connection = new AgentConnection(socket, { ...options, cwd }, live, url.searchParams.get('agent') ?? undefined);
			connection.start();
			socket.off('message', buffer);
			for (const raw of pending) {
				connection.dispatch(raw);
			}
		})().catch(error => {
			console.error('[agent-ui] agent connection failed:', error);
			socket.close();
		});
	});
	return server;
}

class AgentConnection {
	private _entry: LiveSession | undefined;
	/** Backend this connection is routed to; fixed for the socket's lifetime. */
	private _agentId: string;
	/** Explicit `?agent=` from the URL, which also becomes the persisted default. */
	private readonly _requestedAgent: string | undefined;
	/** Model / permission-mode chosen before any session exists; applied at spawn. */
	private _pendingModel: string | undefined;
	private _pendingMode: string | undefined;

	constructor(
		private readonly _socket: WebSocket,
		private readonly _options: AgentServerOptions,
		private readonly _live: Map<string, LiveSession>,
		requestedAgent?: string,
	) {
		this._requestedAgent = this._options.registry.has(requestedAgent) ? requestedAgent : undefined;
		this._agentId = (this._requestedAgent ?? this._options.defaultAgent)
			? this._options.registry.require(this._requestedAgent ?? this._options.defaultAgent).id
			: this._options.registry.require().id;
	}

	start(): void {
		this._socket.on('message', raw => this.dispatch(raw.toString()));
		this._socket.on('close', () => this._detach());
		void this._sendInitialConfig();
	}

	private _driver(): AgentDriver {
		return this._options.registry.require(this._agentId);
	}

	/**
	 * Static config the UI needs before any session (and its `system/init`)
	 * exists: the installed backends, their model/mode lists and the last choices
	 * the user made, so a refresh does not fall back to defaults.
	 */
	private async _sendInitialConfig(): Promise<void> {
		const stored = await preloadAgentState();
		// Only adopt the stored default before a session exists; a command buffered
		// during setup may already have created one for the constructor's backend.
		if (!this._requestedAgent && !this._entry && this._options.registry.has(stored.default.agent)) {
			this._agentId = stored.default.agent!;
		}
		this._sendStaticConfig();
		if (this._requestedAgent) {
			// Picking a backend in the UI should stick across new sessions.
			void rememberChoice(undefined, { agent: this._driver().id });
		}
	}

	/**
	 * The pickers' data: backends, their model/mode lists, current choices.
	 *
	 * Sent on connect *and* answered to every `attach`, because it used to go out
	 * exactly once per socket. The browser pool keeps a socket open across panel
	 * remounts and session switches and hands it to whoever comes next; a panel
	 * that subscribes to such a socket has missed the event for good, and its
	 * model picker stayed empty until the first turn's `system` event carried the
	 * list again. Config is state, not a step of the stream, so re-sending it
	 * costs nothing.
	 */
	private _sendStaticConfig(): void {
		const driver = this._driver();
		const choice = choiceForSession(undefined, driver.id);
		this._sendConfig({
			agent: driver.id,
			agents: this._options.registry.list(),
			models: driver.models,
			permissionModes: driver.permissionModes,
			model: this._entry?.model ?? this._pendingModel ?? pickModel(driver, choice.model),
			permissionMode: this._entry?.permissionMode ?? this._pendingMode ?? pickMode(driver, choice.permissionMode),
		});
	}

	private _sendConfig(patch: {
		model?: string;
		permissionMode?: string;
		models?: readonly ModelOption[];
		permissionModes?: readonly string[];
		agent?: string;
		agents?: readonly AgentInfo[];
	}): void {
		this._send({ type: 'config', ...patch });
	}

	private _send(event: AgentServerEvent): void {
		if (this._socket.readyState === WebSocket.OPEN) {
			this._socket.send(JSON.stringify(event));
		}
	}

	private _sendQueue(entry: LiveSession): void {
		// Queue snapshots describe state rather than a step of the stream, so they
		// go to every watcher but never into the replay buffer.
		this._broadcast(entry, JSON.stringify({ type: 'queue', items: entry.queued } satisfies AgentServerEvent));
	}

	/**
	 * Announces that a turn started (or failed to start).
	 *
	 * `entry.busy` is what the send/stop button reads, and it used to change
	 * silently. The order that broke it: `_ensureEntry` attaches, which sends a
	 * `session_state` carrying the *old* `busy: false`, the client adopts it (it
	 * is right to: the server owns this state), and only then does the turn
	 * actually start. Nothing ever contradicted that snapshot, so the button
	 * stayed on 发送 until a reload re-read `busy`. Mirrors `queue`: a state
	 * snapshot, not a step of the stream, hence no `seq` — and a broadcast
	 * rather than a send, so a second tab on the same session sees it too.
	 */
	private _announceBusy(entry: LiveSession): void {
		this._broadcast(entry, JSON.stringify({
			type: 'session_state',
			live: true,
			sessionId: entry.cliSessionId,
			busy: entry.busy,
			lastSeq: entry.lastSeq,
		} satisfies AgentServerEvent));
	}

	/** Mirrors the deferred queue to disk; the CLI has not seen these yet. */
	private _persistQueue(entry: LiveSession): void {
		const sessionId = entry.cliSessionId;
		if (!sessionId) {
			// Nothing to key on until `system/init` names the session; the snapshot
			// is written again when the queue changes or the id arrives.
			return;
		}
		const items = [...entry.queued];
		void queuedReady.then(() => queuedStore.update(draft => {
			if (items.length === 0) {
				delete draft[sessionId];
			} else {
				draft[sessionId] = items;
			}
		}));
	}

	/**
	 * Writes the next deferred message into stdin, which makes it a turn of its
	 * own — exactly what a message sent while the agent was idle does.
	 */
	private _startNextQueued(entry: LiveSession): void {
		if (entry.busy || entry.queued.length === 0) {
			return;
		}
		const next = entry.queued.shift();
		if (!next) {
			return;
		}
		this._sendQueue(entry);
		this._persistQueue(entry);
		this._log(`starting queued message ${next.id.slice(0, 8)} (${entry.queued.length} left)`);
		entry.busy = true;
		// The client just saw `result` (which ends a turn) and the queue shrink;
		// without this it would think nothing is running while this one works.
		this._announceBusy(entry);
		try {
			entry.session.sendUserMessage(next.text);
		} catch (error) {
			entry.busy = false;
			this._announceBusy(entry);
			this._log(`queued message failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Sends one prepared payload to every socket watching the session. */
	private _broadcast(entry: LiveSession, payload: string): void {
		for (const socket of entry.sockets) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(payload);
			} else {
				// A closed tab would otherwise keep a dead socket in the set for the
				// whole life of the run.
				entry.sockets.delete(socket);
			}
		}
	}

	private _log(message: string): void {
		if (DEBUG) {
			console.log(`[${stamp()}][agent-ui] ${message}`);
		}
	}

	/** Runs one client command; also used to replay commands buffered during setup. */
	dispatch(raw: string): void {
		try {
			this._onMessage(raw);
		} catch (error) {
			// A spawn failure used to be swallowed here, leaving the UI on a
			// silent socket; surface it instead.
			console.error('[agent-ui] agent command failed:', error);
			if (this._socket.readyState === this._socket.OPEN) {
				this._socket.send(JSON.stringify({
					type: 'error',
					message: error instanceof Error ? error.message : String(error),
				} satisfies AgentServerEvent));
			}
		}
	}

	private _onMessage(raw: string): void {
		let command: AgentClientCommand;
		try {
			command = JSON.parse(raw) as AgentClientCommand;
		} catch {
			return;
		}

		switch (command.type) {
			case 'attach': {
				// Handshake on connect. Without it a refreshed page stayed blank
				// until the user typed something, because the session was only
				// adopted on the first `user` command.
				//
				// Answer with the static config too: a pooled socket that outlives
				// a panel already consumed the connect-time one, and its pickers
				// would otherwise stay empty until the next turn.
				this._sendStaticConfig();
				const requested = typeof command.sessionId === 'string' && command.sessionId
					? command.sessionId
					: undefined;
				let entry = this._entry ?? (requested ? this._findLive(requested) : undefined);
				if (!entry && !requested) {
					// The CLI reports its session id with the first `system/init`, so a
					// refresh in that window has nothing to match on. Only such an
					// unnamed entry may be adopted: a named one means the client would
					// have sent its id, so "no id" is a new conversation and adopting a
					// live session here would silently reopen the old transcript.
					const candidates = [...new Set(this._live.values())].filter(candidate => !candidate.cliSessionId);
					if (candidates.length === 1) {
						entry = candidates[0];
					}
				}
				if (entry) {
					this._attach(entry);
					const lastSeq = typeof command.lastSeq === 'number' && command.lastSeq > 0 ? command.lastSeq : undefined;
					this._log(`attach adopted ${entry.cliSessionId?.slice(0, 8) ?? '(pending)'} busy=${entry.busy} lastSeq=${lastSeq ?? '-'}`);
					// Buffering is disabled: the browser pool keeps its socket, so a
					// panel that comes back already has the events it needs.
					// this._replayTail(entry, lastSeq);
					if (entry.queued.length > 0) {
						this._sendQueue(entry);
					}
					return;
				}
				this._send({ type: 'session_state', live: false, sessionId: requested });
				if (requested) {
					// No process here, but a restart may have left messages this session
					// never got to send; show them so they can be started or cancelled.
					void queuedReady.then(() => {
						const waiting = queuedStore.snapshot[requested];
						if (waiting?.length && this._socket.readyState === WebSocket.OPEN) {
							this._send({ type: 'queue', items: waiting });
						}
					});
				}
				return;
			}
			case 'user': {
				const text = typeof command.text === 'string' ? command.text.trim() : '';
				if (!text) {
					return;
				}
				if (command.newSession === true) {
					// "New conversation" while this socket still holds an older process:
					// detach it first, otherwise the message is written into that older
					// transcript and no session file is created for the new one.
					this._log('new conversation requested: detaching the attached session');
					this._detach();
				}
				const resumeId = typeof command.sessionId === 'string' && command.sessionId
					? command.sessionId
					: this._entry?.cliSessionId;
				const entry = this._ensureEntry(resumeId);
				const immediate = command.immediate === true;
				// A new message must not queue behind an approval nobody answered:
				// release the blocked MCP call, abort the stale turn, then send.
				if (entry.session.hasPendingPermission()) {
					this._log('new message while an approval was pending: dropping the approval');
					entry.session.cancelPendingPermissions('用户直接发送了新消息，已取消这次审批。');
					entry.session.interrupt();
					this._send({ type: 'permission_cancelled' });
				} else if (entry.busy && !immediate) {
					// Default: wait for this turn to end. Writing it into stdin now would
					// make the CLI absorb it into the current turn, where it never becomes
					// a user entry of its own in the transcript — the message would be
					// invisible in the history afterwards.
					entry.queued.push({ id: randomUUID(), text, mode: 'defer' });
					this._sendQueue(entry);
					this._persistQueue(entry);
					this._log(`queued for the next turn (${entry.queued.length} waiting)`);
					return;
				}
				entry.busy = true;
				// The attach above already told this client `busy: false`; correct it
				// before the turn's first event, or the button stays on 发送.
				this._announceBusy(entry);
				entry.session.sendUserMessage(text);
				return;
			}
			case 'promote': {
				// "Send now" on a queued message: steering it into the turn in progress
				// is the one thing that keeps it out of the transcript's user entries,
				// so it is never the default.
				const target = this._entry ?? (typeof command.sessionId === 'string' ? this._findLive(command.sessionId) : undefined);
				const index = target?.queued.findIndex(item => item.id === command.id) ?? -1;
				if (!target || index < 0) {
					this._send({ type: 'error', message: '排队消息已经不在了（可能已经开始执行）。' });
					return;
				}
				const [item] = target.queued.splice(index, 1);
				this._sendQueue(target);
				this._persistQueue(target);
				this._log(`promoted ${item.id.slice(0, 8)} into the running turn`);
				target.busy = true;
				this._announceBusy(target);
				target.session.sendUserMessage(item.text);
				return;
			}
			case 'interrupt': {
				// Graceful: the CLI aborts the turn but keeps the session (and its
				// conversation state) alive, so the next message just continues.
				const target = this._entry ?? (typeof command.sessionId === 'string' ? this._findLive(command.sessionId) : undefined);
				if (!target) {
					// Silence here reads as "the button is broken"; say what happened.
					this._send({ type: 'error', message: '没有正在运行的进程可以停止。' });
					return;
				}
				target.session.interrupt();
				return;
			}
			case 'set_model':
				if (this._entry) {
					this._entry.session.setModel(command.model);
					this._entry.model = command.model;
				} else {
					this._pendingModel = command.model;
					this._sendConfig({ model: command.model });
				}
				// Remember it, or a refresh (and the next spawned process) reverts.
				// Defaults are per backend, so an Echo model never leaks into Claude.
				void rememberDefault(this._agentId, { model: command.model });
				void rememberSessionChoice(this._entry?.cliSessionId, { agent: this._agentId, model: command.model });
				return;
			case 'set_permission_mode': {
				const driver = this._driver();
				if (!driver.permissionModes.includes(command.mode)) {
					this._send({ type: 'error', message: `${driver.name} 不支持权限模式 ${command.mode}` });
					return;
				}
				if (this._entry) {
					this._entry.session.setPermissionMode(command.mode);
					this._entry.permissionMode = command.mode;
				} else {
					this._pendingMode = command.mode;
					this._sendConfig({ permissionMode: command.mode });
				}
				void rememberDefault(driver.id, { permissionMode: command.mode });
				void rememberSessionChoice(this._entry?.cliSessionId, { agent: driver.id, permissionMode: command.mode });
				return;
			}
			case 'permission_response':
				this._entry?.session.resolvePermission(command.requestId, {
					behavior: command.behavior,
					message: command.message,
				});
				return;
			case 'kill': {
				// `_entry` can be unset while the browser still shows a running turn
				// (a reattach raced, or the socket that spawned the process is gone),
				// so fall back to the session id the client sends. Otherwise the click
				// died silently and the UI looked frozen.
				const entry = this._entry ?? (typeof command.sessionId === 'string' ? this._findLive(command.sessionId) : undefined);
				if (this._entry === entry) {
					this._entry = undefined;
				}
				if (!entry) {
					this._send({ type: 'error', message: '没有正在运行的进程可以结束（可能已经退出）。' });
					return;
				}
				this._finalize(entry, 'kill');
				return;
			}
			case 'detach':
			case 'reset':
				// Keep the old process alive (it can still be resumed by id), just
				// stop routing its events to this connection. Other tabs watching the
				// same session keep their stream.
				this._detach();
				return;
		}
	}

	private _ensureEntry(resumeSessionId: string | undefined): LiveSession {
		if (this._entry) {
			return this._entry;
		}

		const driver = this._driver();
		// Session ids are backend-owned. Resuming a Claude id through the Echo
		// plugin (or vice versa) would be meaningless, so start fresh instead.
		const boundAgent = sessionChoice(resumeSessionId).agent;
		if (resumeSessionId && boundAgent && boundAgent !== driver.id) {
			this._log(`ignoring resume ${resumeSessionId.slice(0, 8)}: belongs to ${boundAgent}`);
			resumeSessionId = undefined;
		}

		const existing = resumeSessionId ? this._findLive(resumeSessionId) : undefined;
		this._log(`ensureEntry agent=${driver.id} resume=${resumeSessionId?.slice(0, 8) ?? '-'} existing=${existing?.cliSessionId?.slice(0, 8) ?? 'none'} pendingMode=${this._pendingMode ?? '-'}`);
		if (existing) {
			this._attach(existing);
			// A live session outlives page reloads; a mode/model picked before the
			// first message arrived is still pending and must reach the old process.
			const applied = this._applyPending(existing);
			void rememberSessionChoice(existing.cliSessionId ?? resumeSessionId, { agent: driver.id, ...applied });
			// The process may have been started before the user's last pick (or
			// with the server default); reconcile it with what is stored.
			const stored = choiceForSession(resumeSessionId, driver.id);
			const wantedMode = validMode(driver, stored.permissionMode);
			if (wantedMode && wantedMode !== existing.permissionMode) {
				existing.session.setPermissionMode(wantedMode);
				existing.permissionMode = wantedMode;
			}
			const wantedModel = validModel(driver, stored.model);
			if (wantedModel && wantedModel !== existing.model) {
				existing.session.setModel(wantedModel);
				existing.model = wantedModel;
			}
			return existing;
		}

		// A resumed session keeps the model/mode it was last used with; that is
		// the whole point of persisting them, since backends default otherwise.
		const stored = choiceForSession(resumeSessionId, driver.id);
		const model = this._pendingModel ?? pickModel(driver, stored.model);
		const permissionMode = this._pendingMode ?? pickMode(driver, stored.permissionMode);
		// Some backends only report their session id once the first turn starts,
		// so the explicit pick is bound to the session from inside `emit`.
		const requested = {
			agent: driver.id,
			permissionMode,
			...(model ? { model } : {}),
		};

		let entry!: LiveSession;
		const emit = (event: AgentServerEvent) => {
			if (event.type === 'system') {
				entry.cliSessionId = event.sessionId;
				// Keep the alias the user picked (`sonnet`); init reports the
				// provider's canonical id (`deepseek-flash`) instead.
				entry.model = entry.model ?? event.model;
				entry.permissionMode = event.permissionMode ?? entry.permissionMode;
				entry.slashCommands = event.slashCommands;
				entry.skills = event.skills;
				entry.agents = event.agents;
				this._live.set(event.sessionId, entry);
				void rememberSessionChoice(event.sessionId, requested);
				this._log(`system model=${event.model} mode=${event.permissionMode} session=${event.sessionId.slice(0, 8)}`);
				// A restarted server brings its queue back from disk here: the process
				// did not exist while it was down, so those messages were never sent.
				void queuedReady.then(() => {
					const restored = queuedStore.snapshot[event.sessionId];
					if (entry.queued.length === 0 && restored?.length) {
						entry.queued = restored.map(item => ({ ...item, mode: 'defer' as const }));
						this._log(`restored ${entry.queued.length} queued message(s)`);
						this._sendQueue(entry);
					}
					this._startNextQueued(entry);
				});
				// Handshake state rather than a step of the stream: no `seq`. The
				// merged model keeps the alias the user picked. `models` is the
				// driver's list, not the CLI's: the backend knows nothing about the
				// gateway's catalogue, and letting it overwrite this would shrink the
				// picker back to three aliases as soon as a turn starts.
				this._broadcast(entry, JSON.stringify({
					...event,
					agent: entry.agentId,
					models: driver.models,
					...(entry.model ? { model: entry.model } : {}),
				} satisfies AgentServerEvent));
				return;
			} else if (event.type === 'config') {
				entry.model = event.model ?? entry.model;
				entry.permissionMode = event.permissionMode ?? entry.permissionMode;
			} else if (event.type === 'result') {
				entry.busy = false;
				this._log(`result ${event.subtype}${event.text ? '' : ' (no text)'}`);
				// The turn is over, so the next queued message can start one of its
				// own; it must go out before the reap check, or an unwatched session
				// would be killed with messages still waiting.
				this._startNextQueued(entry);
				if (entry.sockets.size === 0) {
					this._armReap(entry);
				}
			} else if (event.type === 'exit') {
				entry.busy = false;
				this._log('exit');
				this._finalize(entry, 'exit');
			} else if (event.type === 'permission_request') {
				this._log(`permission_request ${event.toolName}`);
			} else if (event.type === 'error') {
				this._log(`error ${event.message}`);
			}

			// Config snapshots describe state, not a step of the stream, so they are
			// delivered without consuming a sequence number.
			if (event.type === 'config' || event.type === 'queue' || event.type === 'session_state') {
				this._broadcast(entry, JSON.stringify(event));
				return;
			}

			entry.lastSeq += 1;
			const outbound = { ...event, seq: entry.lastSeq } satisfies AgentServerEvent;
			// Buffering is disabled (see `LiveSession.log`): events go straight to
			// the watchers. Only the turn in flight used to be kept, and it was
			// cleared when the next turn started.
			// if (entry.busy || event.type === 'result' || event.type === 'exit') {
			// 	entry.log.push(outbound);
			// 	if (entry.log.length > MAX_LOG_EVENTS) {
			// 		entry.log.splice(0, entry.log.length - MAX_LOG_EVENTS);
			// 	}
			// }
			this._broadcast(entry, JSON.stringify(outbound));
		};

		entry = {
			agentId: driver.id,
			root: this._options.cwd,
			session: driver.createSession(
				{
					cwd: this._options.cwd,
					permissionMode,
					model,
					resumeSessionId,
				},
				emit,
			),
			sockets: new Set(),
			busy: false,
			log: [],
			lastSeq: 0,
			queued: [],
		};
		entry.model = model;
		entry.permissionMode = permissionMode;
		this._live.set(resumeSessionId ?? entry.session.id, entry);
		this._attach(entry);
		return entry;
	}

	private _findLive(sessionId: string): LiveSession | undefined {
		const direct = this._live.get(sessionId);
		if (direct?.agentId === this._agentId) {
			return direct;
		}
		for (const entry of this._live.values()) {
			if (entry.agentId === this._agentId && entry.cliSessionId === sessionId) {
				return entry;
			}
		}
		return undefined;
	}

	private _attach(entry: LiveSession): void {
		if (entry.reapTimer) {
			clearTimeout(entry.reapTimer);
			entry.reapTimer = undefined;
		}
		entry.sockets.add(this._socket);
		this._entry = entry;
		// Say outright whether a process backs this session, where its stream
		// currently is, and how far back the buffer still reaches — the UI used to
		// have no way to tell "still running" from "never started".
		this._send({
			type: 'session_state',
			live: true,
			sessionId: entry.cliSessionId,
			busy: entry.busy,
			lastSeq: entry.lastSeq,
			// No buffer, so there is nothing to report: a client that missed events
			// has to fall back to its own mirror.
			// oldestSeq: entry.log[0]?.seq,
		});
		// Let a reconnecting client learn the id it should keep using, plus the
		// model/mode the running backend is actually in.
		if (entry.cliSessionId) {
			const driver = this._driver();
			this._send({
				type: 'system',
				sessionId: entry.cliSessionId,
				agent: entry.agentId,
				cwd: this._options.cwd,
				model: entry.model,
				permissionMode: entry.permissionMode,
				slashCommands: entry.slashCommands,
				skills: entry.skills,
				agents: entry.agents,
				models: driver.models,
			});
		}
		// A client that reconnects (refresh, another tab, switching back) never saw
		// the original request, while the CLI is still blocked on it. Replay it.
		const pending = entry.session.pendingPermission?.();
		if (pending) {
			this._send({
				type: 'permission_request',
				requestId: pending.requestId,
				toolName: pending.prompt.toolName,
				input: pending.prompt.input,
				toolUseId: pending.prompt.toolUseId,
			});
		}
	}

	/** Pushes a mode/model picked before the session was attached into the live process. */
	private _applyPending(entry: LiveSession): { model?: string; permissionMode?: string } {
		const applied: { model?: string; permissionMode?: string } = {};
		const driver = this._driver();
		if (this._pendingMode && driver.permissionModes.includes(this._pendingMode)) {
			entry.session.setPermissionMode(this._pendingMode);
			entry.permissionMode = this._pendingMode;
			applied.permissionMode = this._pendingMode;
			this._pendingMode = undefined;
		}
		if (this._pendingModel) {
			entry.session.setModel(this._pendingModel);
			entry.model = this._pendingModel;
			applied.model = this._pendingModel;
			this._pendingModel = undefined;
		}
		return applied;
	}

	/**
	 * DISABLED with the buffer itself — there is nothing to replay.
	 *
	 * What it used to do: replay the part of the running turn a returning client
	 * had not seen, using the client's own high-water mark so only the missed
	 * tail was sent. Kept here so the mechanism can be restored as a unit
	 * together with `LiveSession.log` and the `entry.log.push` block.
	 */
	// private _replayTail(entry: LiveSession, lastSeq: number | undefined): void {
	// 	if (lastSeq === undefined || !entry.busy) {
	// 		return;
	// 	}
	// 	const tail = entry.log.filter(event => (event.seq ?? 0) > lastSeq);
	// 	if (tail.length === 0) {
	// 		return;
	// 	}
	// 	this._log(`replaying ${tail.length} buffered events after seq ${lastSeq}`);
	// 	for (const event of tail) {
	// 		this._send(event);
	// 	}
	// }

	private _detach(): void {
		const entry = this._entry;
		this._entry = undefined;
		if (!entry) {
			return;
		}
		entry.sockets.delete(this._socket);
		if (entry.sockets.size > 0) {
			// Another tab is still watching; its stream must not be interrupted.
			return;
		}
		if (entry.busy) {
			// Never kill a process that is still answering; reap when it finishes.
			this._log('socket closed mid-turn, deferring reap');
			return;
		}
		this._armReap(entry);
	}

	private _armReap(entry: LiveSession): void {
		if (entry.reapTimer) {
			clearTimeout(entry.reapTimer);
		}
		entry.reapTimer = setTimeout(() => this._finalize(entry, 'reap'), REAP_DELAY_MS);
		entry.reapTimer.unref?.();
		this._log(`reap armed in ${REAP_DELAY_MS}ms`);
	}

	private _finalize(entry: LiveSession, reason = 'finalize'): void {
		if (entry.reapTimer) {
			clearTimeout(entry.reapTimer);
			entry.reapTimer = undefined;
		}
		// Tell the watchers *before* dropping them. `kill` used to clear the socket
		// set first, so the only event that flips the UI back to idle never
		// arrived — pressing 强制结束 looked like a hang. `exit` needs no second
		// copy here: the process' own close handler already broadcast one.
		if (reason !== 'exit') {
			this._broadcast(entry, JSON.stringify({
				type: 'exit',
				code: null,
				...(reason === 'kill' ? { stderr: '已被用户强制结束。' } : {}),
			} satisfies AgentServerEvent));
		}
		entry.sockets.clear();
		this._log(`finalize (${reason})`);
		entry.session.dispose();
		for (const [key, value] of this._live) {
			if (value === entry) {
				this._live.delete(key);
			}
		}
	}
}

/** Stored values can come from another backend; only use ones this one accepts. */
function validModel(driver: AgentDriver, value: string | undefined): string | undefined {
	return value && driver.models.some(option => option.id === value) ? value : undefined;
}

function validMode(driver: AgentDriver, value: string | undefined): string | undefined {
	return value && driver.permissionModes.includes(value) ? value : undefined;
}

function pickModel(driver: AgentDriver, value: string | undefined): string | undefined {
	return validModel(driver, value) ?? driver.defaultModel;
}

function pickMode(driver: AgentDriver, value: string | undefined): string {
	return validMode(driver, value) ?? driver.defaultPermissionMode;
}
