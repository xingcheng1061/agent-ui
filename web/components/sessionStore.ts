/**
 * Conversation-scoped stream log — the one place a live turn is recorded.
 *
 * The pooled connection writes here for *every* session it follows, including
 * the ones nobody is looking at. A panel that comes back reads the same log
 * instead of trusting a rendering snapshot it happened to leave behind. That
 * is what "the background keeps writing, the foreground reads that copy" means
 * in practice: there is no second source to reconcile.
 *
 * Deliberately memory-only. A finished turn is durable in the CLI's jsonl; a
 * socket that dropped asks the server for the events it missed (`lastSeq`) and
 * those events land here the same way.
 */
import type { AgentServerEvent, QueuedMessage } from '../agentTypes';
import { readCachedStreams, writeCachedStream } from './sessionCache';

/** A task the CLI reported for this conversation, kept until it finishes. */
export interface StreamTask {
	readonly taskId: string;
	readonly status: string;
	readonly description?: string;
	readonly subagentType?: string;
	readonly startedAt: number;
}

export interface SessionStream {
	/** Events of the turn in flight, in arrival order, with their `seq`. */
	events: AgentServerEvent[];
	/** Last queue snapshot, mirrored here so a panel opening mid-turn sees it. */
	queued: readonly QueuedMessage[];
	/** Running tasks, so a returning panel can paint them before events replay. */
	tasks: readonly StreamTask[];
	/**
	 * User messages sent from this browser that the jsonl has not confirmed yet.
	 * A panel that remounts mid-turn restores these bubbles; messages that later
	 * land in the transcript are removed by text.
	 */
	sent: readonly string[];
	/** Whether the server reported a turn running the last time it spoke. */
	busy: boolean;
	/** Last time anything was written, for pruning. */
	updatedAt: number;
}

/** A chatty turn can push thousands of deltas; keep the newest window. */
const MAX_EVENTS = 4000;

/** Sessions whose stream has been idle this long can be dropped from memory. */
const MAX_IDLE_MS = 24 * 60 * 60 * 1000;

const streams = new Map<string, SessionStream>();

function slot(sessionId: string): SessionStream {
	let stream = streams.get(sessionId);
	if (!stream) {
		stream = { events: [], queued: [], tasks: [], sent: [], busy: false, updatedAt: Date.now() };
		streams.set(sessionId, stream);
	}
	return stream;
}

/** Mirrors a mutated slot into IndexedDB so a reload can resume a live turn. */
function persist(sessionId: string, stream: SessionStream): void {
	writeCachedStream(sessionId, stream);
}

/** Appends one event; a replayed seq that was already applied is ignored. */
export function appendStreamEvent(sessionId: string | undefined, event: AgentServerEvent): void {
	if (!sessionId) {
		return;
	}
	const stream = slot(sessionId);
	const seq = typeof event.seq === 'number' ? event.seq : undefined;
	const newest = stream.events[stream.events.length - 1];
	if (seq !== undefined && newest && typeof newest.seq === 'number' && newest.seq >= seq) {
		// A replay or duplicate: every event already recorded has a lower seq.
		return;
	}
	stream.events.push(event);
	if (stream.events.length > MAX_EVENTS) {
		stream.events.splice(0, stream.events.length - MAX_EVENTS);
	}
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Replaces the queue snapshot for one session. */
export function setStreamQueued(sessionId: string | undefined, items: readonly QueuedMessage[]): void {
	if (!sessionId) {
		return;
	}
	const stream = slot(sessionId);
	stream.queued = items;
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Mirrors task start/progress/notification events into the session slot. */
export function setStreamTask(sessionId: string | undefined, task: StreamTask | undefined): void {
	if (!sessionId) {
		return;
	}
	const stream = slot(sessionId);
	const others = stream.tasks.filter(item => item.taskId !== task?.taskId);
	stream.tasks = task ? [...others, task] : others;
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Removes one finished task from the live panel. */
export function clearStreamTask(sessionId: string | undefined, taskId: string): void {
	if (!sessionId) {
		return;
	}
	const stream = streams.get(sessionId);
	if (!stream) {
		return;
	}
	stream.tasks = stream.tasks.filter(item => item.taskId !== taskId);
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Records a message this browser sent, so a remount can restore its bubble. */
export function addSentMessage(sessionId: string | undefined, text: string): void {
	if (!sessionId) {
		return;
	}
	const stream = slot(sessionId);
	stream.sent = [...stream.sent, text];
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Drops sent texts that the jsonl now carries, so they are not drawn twice. */
export function confirmSentMessages(sessionId: string | undefined, transcriptTexts: ReadonlySet<string>): void {
	if (!sessionId) {
		return;
	}
	const stream = streams.get(sessionId);
	if (!stream || stream.sent.length === 0) {
		return;
	}
	stream.sent = stream.sent.filter(text => !transcriptTexts.has(text));
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** Records whether a turn is running. */
export function setStreamBusy(sessionId: string | undefined, busy: boolean): void {
	if (!sessionId) {
		return;
	}
	const stream = slot(sessionId);
	stream.busy = busy;
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/**
 * Drops the finished turn's events once `result` arrives: from then on the
 * jsonl owns it, and replaying it into a fresh page would duplicate the turn.
 */
export function clearStreamEvents(sessionId: string | undefined): void {
	if (!sessionId) {
		return;
	}
	const stream = streams.get(sessionId);
	if (!stream) {
		return;
	}
	stream.events = [];
	stream.busy = false;
	stream.updatedAt = Date.now();
	persist(sessionId, stream);
}

/** The log for one session, or `undefined` when nothing has been recorded. */
export function getStream(sessionId: string | undefined): Readonly<SessionStream> | undefined {
	return sessionId === undefined ? undefined : streams.get(sessionId);
}

/**
 * Restores cached slots once on startup. Only fills sessions not already seen:
 * a live event that arrived first is newer than anything in storage.
 */
export async function hydrateStreams(): Promise<void> {
	const cached = await readCachedStreams();
	for (const entry of cached) {
		if (!streams.has(entry.sessionId)) {
			const { sessionId: _id, ...stream } = entry;
			streams.set(entry.sessionId, { ...stream, sent: stream.sent ?? [], updatedAt: stream.updatedAt ?? Date.now() });
		}
	}
}

/** Forgets sessions nothing has touched in a long while. */
export function pruneStreams(): void {
	const cutoff = Date.now() - MAX_IDLE_MS;
	for (const [sessionId, stream] of streams) {
		if (stream.updatedAt < cutoff) {
			streams.delete(sessionId);
		}
	}
}
