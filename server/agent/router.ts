import { WebSocket, WebSocketServer } from 'ws';
import { DEBUG, PROJECT_ROOT, REAP_DELAY_MS, requestUrl, stamp } from '../config.js';
import { resolveRoot } from '../paths.js';
import {
	choiceForSession,
	preloadAgentState,
	rememberChoice,
	rememberDefault,
	rememberSessionChoice,
	sessionChoice,
} from './agentState.js';
import { AgentRegistry, type AgentDriver, type AgentSession } from './driver.js';
import type { AgentClientCommand, AgentInfo, AgentServerEvent } from './protocol.js';

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
	readonly session: AgentSession;
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
	socket?: WebSocket;
	reapTimer?: NodeJS.Timeout;
	/** A turn is being answered; reaping now would silently kill the work. */
	busy: boolean;
	/**
	 * Events of the turn currently in flight.
	 *
	 * DISABLED: the same mirror now lives in the browser (IndexedDB, see
	 * `web/components/liveTurnStore.ts`), which keeps the server stateless and
	 * survives a server restart. The field and its writer are kept so the
	 * server-side variant can be brought back by uncommenting `_logEvent`.
	 */
	readonly log: AgentServerEvent[];
	/** Messages sent while a turn is running; the CLI runs them in order. */
	queued: string[];
}

/** Upper bound on the in-flight event log; deltas are numerous. */
const MAX_LOG_EVENTS = 4000;

/** How often dead peers are probed; a missed pong terminates the socket. */
const KEEP_ALIVE_INTERVAL_MS = 30_000;

/** Tracks liveness per socket without leaking a parallel map. */
type TrackedSocket = WebSocket & { _agentAlive?: boolean };

export function createAgentServer(options: Omit<AgentServerOptions, 'cwd'>): WebSocketServer {
	const live = new Map<string, LiveSession>();
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
		const driver = this._driver();
		const choice = choiceForSession(undefined, driver.id);
		this._sendConfig({
			agent: driver.id,
			agents: this._options.registry.list(),
			models: driver.models,
			permissionModes: driver.permissionModes,
			model: this._pendingModel ?? pickModel(driver, choice.model),
			permissionMode: this._pendingMode ?? pickMode(driver, choice.permissionMode),
		});
		if (this._requestedAgent) {
			// Picking a backend in the UI should stick across new sessions.
			void rememberChoice(undefined, { agent: driver.id });
		}
	}

	private _sendConfig(patch: {
		model?: string;
		permissionMode?: string;
		models?: readonly string[];
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
		if (entry.socket && entry.socket !== this._socket) {
			return;
		}
		this._send({ type: 'queue', items: entry.queued });
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
					this._log(`attach adopted ${entry.cliSessionId?.slice(0, 8) ?? '(pending)'} busy=${entry.busy} replay=${command.replay === true}`);
					if (command.replay === true) {
						// The in-flight turn is replayed by the browser from its own
						// IndexedDB copy, so the server only has to report the queue
						// (which the browser cannot know about).
						//
						// Server-side replay, kept for reference:
						// for (const event of entry.log) {
						// 	this._send(event);
						// }
						if (entry.queued.length > 0) {
							this._sendQueue(entry);
						}
					}
					return;
				}
				this._send({ type: 'session_state', live: false, sessionId: requested });
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
				// A new message must not queue behind an approval nobody answered:
				// release the blocked MCP call, abort the stale turn, then send.
				if (entry.session.hasPendingPermission()) {
					this._log('new message while an approval was pending: dropping the approval');
					entry.session.cancelPendingPermissions('用户直接发送了新消息，已取消这次审批。');
					entry.session.interrupt();
					this._send({ type: 'permission_cancelled' });
				} else if (entry.busy) {
					// The CLI runs stdin messages in order, so this is a real queue
					// rather than a dropped message; track it for the UI.
					entry.queued.push(text);
					this._sendQueue(entry);
					this._log(`queued (${entry.queued.length} waiting)`);
				}
				entry.busy = true;
				entry.session.sendUserMessage(text);
				return;
			}
			case 'interrupt':
				// Graceful: the CLI aborts the turn but keeps the session (and its
				// conversation state) alive, so the next message just continues.
				this._entry?.session.interrupt();
				return;
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
				const entry = this._entry;
				this._entry = undefined;
				if (entry) {
					this._finalize(entry, 'kill');
				}
				return;
			}
			case 'reset':
				// Keep the old process alive (it can still be resumed by id), just
				// stop routing its events to this connection.
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
			// Server-side mirror of the in-flight turn. Disabled in favour of the
			// browser copy (IndexedDB); uncomment to restore it.
			// entry.log.push(event);
			// if (entry.log.length > MAX_LOG_EVENTS) {
			// 	entry.log.shift();
			// }
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
			} else if (event.type === 'config') {
				entry.model = event.model ?? entry.model;
				entry.permissionMode = event.permissionMode ?? entry.permissionMode;
			} else if (event.type === 'result') {
				entry.busy = false;
				// Server-side mirror disabled; see the comment on `LiveSession.log`.
				// entry.log.length = 0;
				if (entry.queued.length > 0) {
					entry.queued = [];
					this._sendQueue(entry);
				}
				this._log(`result ${event.subtype}${event.text ? '' : ' (no text)'}`);
				if (!entry.socket) {
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
			const socket = entry.socket;
			if (socket?.readyState === WebSocket.OPEN) {
				const outbound = event.type === 'system'
					? { ...event, agent: entry.agentId, ...(entry.model ? { model: entry.model } : {}) }
					: event;
				socket.send(JSON.stringify(outbound));
			}
		};

		entry = {
			agentId: driver.id,
			session: driver.createSession(
				{
					cwd: this._options.cwd,
					permissionMode,
					model,
					resumeSessionId,
				},
				emit,
			),
			busy: false,
			log: [],
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
		entry.socket = this._socket;
		this._entry = entry;
		// Say outright whether a process backs this session; the UI used to have
		// no way to tell "still running" from "never started".
		this._send({ type: 'session_state', live: true, sessionId: entry.cliSessionId, busy: entry.busy });
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

	private _detach(): void {
		const entry = this._entry;
		this._entry = undefined;
		if (!entry || entry.socket !== this._socket) {
			return;
		}
		entry.socket = undefined;
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
		entry.socket = undefined;
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
	return value && driver.models.includes(value) ? value : undefined;
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
