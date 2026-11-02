import type { AgentClientCommand, AgentServerEvent, QueuedMessage } from '../agentTypes';
import { agentUrl, reportClientLog } from '../api';
import { deleteLiveTurn, writeLiveTurn } from './liveTurnStore';

/**
 * Pool of long-lived agent connections, one per conversation.
 *
 * The chat panel used to own its socket and close it on unmount, which meant
 * switching to another conversation silently cut the stream: the turn kept
 * running on the server (the CLI process is never killed mid-turn), but nothing
 * on this side heard it any more. Owning the sockets here fixes that:
 *
 * - a panel borrows the connection for its session and gives it back on unmount;
 * - an unwatched connection keeps listening while its turn runs, so the
 *   IndexedDB mirror stays complete and no delta is lost;
 * - it is closed once idle (see `IDLE_GRACE_MS`), so background conversations
 *   cannot pile up sockets forever (`MAX_BACKGROUND` is the hard cap);
 * - reconnecting sends the last applied `seq`, but the server no longer buffers
 *   events, so anything missed while the socket was down is gone; this side's
 *   IndexedDB mirror is what a panel falls back to.
 */

/** Reconnect delay after the socket drops. */
const RETRY_MS = 1500;

/** Batched IndexedDB writes: a stream pushes hundreds of deltas per second. */
const FLUSH_MS = 250;

/** Cap per session so a chatty turn cannot blow up IndexedDB. */
const MAX_LIVE_EVENTS = 4000;

/** An unwatched connection closes after this long without a running turn. */
const IDLE_GRACE_MS = 15_000;

/** How many unwatched conversations may keep streaming in the background. */
const MAX_BACKGROUND = 4;

export type AgentConnectionState = 'connecting' | 'open' | 'closed';

type EventListener = (event: AgentServerEvent) => void;
type StateListener = (state: AgentConnectionState) => void;

export interface AgentConnectionHandle {
	readonly root: string;
	readonly agent: string;
	/** Session this connection is following, once the server reported its id. */
	readonly sessionId: string | undefined;
	readonly state: AgentConnectionState;
	send(command: AgentClientCommand): void;
	/** Subscribes to live events; returns the disposer. */
	listen(listener: EventListener): () => void;
	watchState(listener: StateListener): () => void;
	/** Highest `seq` applied so far, which is what a reattach resumes from. */
	lastSeq(): number;
	/**
	 * The turn this connection has recorded so far.
	 *
	 * Slightly newer than the IndexedDB copy (which is written in batches), so a
	 * panel opening mid-turn replays from here and cannot miss the last window.
	 */
	snapshot(): { readonly events: readonly AgentServerEvent[]; readonly queued: readonly QueuedMessage[]; readonly busy: boolean };
	/** Points this connection at another session (a new conversation got its id). */
	follow(sessionId: string | undefined): void;
	/**
	 * Marks a turn as running the moment a message is sent, before the backend
	 * has answered. Without it the idle timer could close the socket of a turn
	 * that only just started.
	 */
	markBusy(): void;
	/** Gives the connection back to the pool. */
	release(): void;
	/** Takes it out of the pool again; every borrow must be paired with a release. */
	retain(): AgentConnectionHandle;
}

class AgentConnection implements AgentConnectionHandle {
	readonly root: string;
	readonly agent: string;
	readonly createdAt = Date.now();

	sessionId: string | undefined;
	state: AgentConnectionState = 'connecting';

	private _socket: WebSocket | undefined;
	private _retryTimer: number | undefined;
	private _idleTimer: number | undefined;
	private _flushTimer: number | undefined;
	private _refs = 0;
	private _closed = false;
	private _busy = false;
	private _lastSeq = 0;
	private readonly _events: AgentServerEvent[] = [];
	private _queued: readonly QueuedMessage[] = [];
	private _dirty = false;
	private readonly _listeners = new Set<EventListener>();
	private readonly _stateListeners = new Set<StateListener>();
	private readonly _onPageHide = () => this._flush();

	constructor(root: string, agent: string) {
		this.root = root;
		this.agent = agent;
		this._flushTimer = window.setInterval(() => this._flush(), FLUSH_MS);
		// A refresh or tab close is exactly when the mirror matters most.
		window.addEventListener('pagehide', this._onPageHide);
		this._connect();
	}

	get watched(): boolean {
		return this._refs > 0;
	}

	retain(): AgentConnectionHandle {
		this._refs += 1;
		if (this._idleTimer) {
			window.clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
		return this;
	}

	release(): void {
		this._refs = Math.max(0, this._refs - 1);
		if (this._refs === 0) {
			// Persist before the panel goes away: whoever opens this conversation
			// next must not see a mirror that is a flush interval behind.
			this._flush();
			this._armIdle();
		}
	}

	snapshot(): { readonly events: readonly AgentServerEvent[]; readonly queued: readonly QueuedMessage[]; readonly busy: boolean } {
		return { events: [...this._events], queued: this._queued, busy: this._busy };
	}

	listen(listener: EventListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	watchState(listener: StateListener): () => void {
		this._stateListeners.add(listener);
		listener(this.state);
		return () => this._stateListeners.delete(listener);
	}

	lastSeq(): number {
		return this._lastSeq;
	}

	send(command: AgentClientCommand): void {
		const socket = this._socket;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(command));
		}
	}

	/**
	 * Attaches this connection to another session, resuming from where it is.
	 *
	 * Runs even when the session is unchanged: a panel that borrows a connection
	 * somebody else kept alive still needs the `session_state` answer (is a turn
	 * running? is there a process?), and re-attaching with the applied position
	 * replays nothing it already has.
	 */
	follow(sessionId: string | undefined): void {
		this.sessionId = sessionId;
		if (this._socket?.readyState === WebSocket.OPEN) {
			this.send({ type: 'attach', sessionId, lastSeq: this._lastSeq > 0 ? this._lastSeq : undefined });
		}
	}

	markBusy(): void {
		this._busy = true;
		if (this._idleTimer) {
			window.clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
	}

	/** Closes the socket for good; only the pool calls this. */
	dispose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		if (this._retryTimer) {
			window.clearTimeout(this._retryTimer);
			this._retryTimer = undefined;
		}
		if (this._idleTimer) {
			window.clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
		if (this._flushTimer) {
			window.clearInterval(this._flushTimer);
			this._flushTimer = undefined;
		}
		this._flush();
		window.removeEventListener('pagehide', this._onPageHide);
		this.send({ type: 'detach' });
		this._socket?.close();
		this._socket = undefined;
		this._listeners.clear();
		this._stateListeners.clear();
		this._setState('closed');
	}

	private _connect(): void {
		if (this._closed) {
			return;
		}
		const socket = new WebSocket(agentUrl(this.root, this.agent));
		this._socket = socket;
		this._setState('connecting');
		socket.addEventListener('open', () => {
			if (this._closed) {
				return;
			}
			this._setState('open');
			reportClientLog({ event: 'ws-open', session: this.sessionId });
			// Adopt whatever process still runs for this conversation and resume
			// from the last event applied here.
			this.send({
				type: 'attach',
				sessionId: this.sessionId,
				lastSeq: this._lastSeq > 0 ? this._lastSeq : undefined,
			});
		});
		socket.addEventListener('message', raw => this._onMessage(raw));
		socket.addEventListener('close', event => {
			if (this._socket !== socket) {
				return;
			}
			this._socket = undefined;
			reportClientLog({
				event: 'ws-close',
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
				session: this.sessionId,
			});
			this._setState('closed');
			this._scheduleRetry();
		});
	}

	private _scheduleRetry(): void {
		if (this._closed || this._retryTimer) {
			return;
		}
		// A background conversation still answering must come back on its own;
		// an idle one is only retried while somebody is actually looking at it.
		if (!this.watched && !this._busy) {
			return;
		}
		this._retryTimer = window.setTimeout(() => {
			this._retryTimer = undefined;
			this._connect();
		}, RETRY_MS);
	}

	private _onMessage(raw: MessageEvent): void {
		let event: AgentServerEvent;
		try {
			event = JSON.parse(String(raw.data)) as AgentServerEvent;
		} catch {
			return;
		}
		if (typeof event.seq === 'number' && event.seq > this._lastSeq) {
			this._lastSeq = event.seq;
		}
		if (event.type === 'system' && this.sessionId === undefined) {
			// A conversation started here just got its id.
			this.sessionId = event.sessionId;
		}
		this._record(event);
		for (const listener of this._listeners) {
			listener(event);
		}
	}

	private _record(event: AgentServerEvent): void {
		if (event.type === 'session_state') {
			this._busy = event.live === true && event.busy === true;
			if (!this._busy) {
				this._armIdle();
			}
			return;
		}
		if (event.type === 'queue') {
			this._queued = event.items;
			this._dirty = true;
			return;
		}
		if (event.type === 'result' || event.type === 'exit') {
			// The turn is over: the jsonl owns it now, so the mirror goes away.
			this._events.length = 0;
			this._queued = [];
			this._busy = false;
			this._dirty = true;
			this._flush();
			this._armIdle();
			return;
		}
		if (event.type === 'system' || event.type === 'config') {
			return;
		}
		this._events.push(event);
		if (this._events.length > MAX_LIVE_EVENTS) {
			this._events.shift();
		}
		this._dirty = true;
	}

	private _flush(): void {
		if (!this._dirty) {
			return;
		}
		this._dirty = false;
		const sessionId = this.sessionId;
		if (!sessionId) {
			return;
		}
		if (this._events.length === 0) {
			void deleteLiveTurn(sessionId);
			return;
		}
		void writeLiveTurn({
			sessionId,
			events: this._events,
			queued: this._queued,
			busy: this._busy,
			updatedAt: Date.now(),
		});
	}

	/**
	 * Schedules the close of a connection nobody watches. A running turn postpones
	 * it: killing the stream mid-answer is exactly what this pool exists to avoid.
	 */
	private _armIdle(): void {
		if (this._closed || this.watched) {
			return;
		}
		if (this._idleTimer) {
			window.clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
		if (this._busy) {
			return;
		}
		this._idleTimer = window.setTimeout(() => closeConnection(this), IDLE_GRACE_MS);
	}

	private _setState(state: AgentConnectionState): void {
		if (this.state === state) {
			return;
		}
		this.state = state;
		for (const listener of this._stateListeners) {
			listener(state);
		}
	}
}

const pool = new Map<number, AgentConnection>();
let nextKey = 0;

function closeConnection(connection: AgentConnection): void {
	connection.dispose();
	for (const [key, entry] of pool) {
		if (entry === connection) {
			pool.delete(key);
		}
	}
}

/** Keeps the number of unwatched background streams bounded, oldest first. */
function pruneBackground(): void {
	const background = [...pool.values()].filter(connection => !connection.watched);
	while (background.length > MAX_BACKGROUND) {
		const oldest = background.reduce((left, right) => left.createdAt <= right.createdAt ? left : right);
		background.splice(background.indexOf(oldest), 1);
		closeConnection(oldest);
	}
}

/**
 * Borrows the connection for one conversation, creating it when needed.
 *
 * Borrowing the same conversation twice (a panel that re-renders, a second tab)
 * returns the same socket, and every `acquire` must be paired with `release`.
 */
export function acquireAgentConnection(
	root: string,
	agent: string | undefined,
	sessionId: string | undefined,
): AgentConnectionHandle {
	for (const connection of pool.values()) {
		if (connection.root === root && connection.agent === (agent ?? '') && connection.sessionId === sessionId) {
			connection.follow(sessionId);
			return connection.retain();
		}
	}
	const created = new AgentConnection(root, agent ?? '');
	created.follow(sessionId);
	pool.set(nextKey++, created);
	pruneBackground();
	return created.retain();
}
