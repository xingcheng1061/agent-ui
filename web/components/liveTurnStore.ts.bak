import type { AgentServerEvent, QueuedMessage } from '../agentTypes';

/**
 * Browser-side mirror of the turn currently in flight.
 *
 * The CLI only appends a message to its jsonl once that message is finished, so
 * while a turn streams there is a gap where nothing durable describes it. This
 * store fills exactly that gap: every event the server pushes is appended here,
 * and a page reload replays it on top of the jsonl history.
 *
 * The record is deleted as soon as the turn finishes (`result`), because the
 * jsonl owns it from then on — keeping it would duplicate the turn.
 */

const DB_NAME = 'agent-ui-live';
const DB_VERSION = 1;
const STORE = 'turns';

/** Records nobody touched for this long are dropped on read/write. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LiveTurnRecord {
	readonly sessionId: string;
	/** Server events of the in-flight turn, in order. */
	readonly events: readonly AgentServerEvent[];
	/** Messages waiting for the running turn. */
	readonly queued: readonly QueuedMessage[];
	/** Whether the turn was still running when this was written. */
	readonly busy: boolean;
	readonly updatedAt: number;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
	database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: 'sessionId' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return database;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return open().then(db => new Promise<T>((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		const request = work(transaction.objectStore(STORE));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	}));
}

export async function readLiveTurn(sessionId: string): Promise<LiveTurnRecord | undefined> {
	try {
		return await run<LiveTurnRecord | undefined>('readonly', store => store.get(sessionId));
	} catch {
		// Storage blocked or unreadable: the caller just shows no live turn.
		return undefined;
	}
}

export async function writeLiveTurn(record: LiveTurnRecord): Promise<void> {
	try {
		await run('readwrite', store => store.put(record));
	} catch {
		// Quota or private mode: losing the mirror only costs the catch-up.
	}
}

export async function deleteLiveTurn(sessionId: string): Promise<void> {
	try {
		await run('readwrite', store => store.delete(sessionId));
	} catch {
		// Nothing to do.
	}
}

/** Keeps the store from growing without bound across many sessions. */
export async function pruneLiveTurns(): Promise<void> {
	try {
		const all = await run<LiveTurnRecord[]>('readonly', store => store.getAll());
		const cutoff = Date.now() - MAX_AGE_MS;
		await Promise.all(all.filter(record => record.updatedAt < cutoff).map(record => deleteLiveTurn(record.sessionId)));
	} catch {
		// Nothing to do.
	}
}
