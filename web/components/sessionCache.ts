/**
 * Browser-side cache of conversation data, so switching sessions does not need
 * to re-read the server's jsonl every time. The jsonl remains authoritative:
 * this cache is an acceleration layer, and a miss simply falls back to a read.
 *
 * Two stores:
 * - `transcripts`: the parsed page last shown for a session
 * - `streams`: in-flight events, queue snapshot and task state (mirrored from
 *   the in-memory sessionStore so a reload can pick up a running turn)
 */
import type { TranscriptPage } from '../api';
import type { SessionStream } from './sessionStore';

const DB_NAME = 'agent-ui-session-cache';
const DB_VERSION = 1;
const STORE_TRANSCRIPTS = 'transcripts';
const STORE_STREAMS = 'streams';
/** Keep the most recently touched conversations; older ones fall back to jsonl. */
const CACHE_LIMIT = 40;

interface CachedTranscript extends TranscriptPage {
	readonly sessionId: string;
	readonly savedAt: number;
}

interface CachedStream extends SessionStream {
	readonly sessionId: string;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
	database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_TRANSCRIPTS)) {
				db.createObjectStore(STORE_TRANSCRIPTS, { keyPath: 'sessionId' });
			}
			if (!db.objectStoreNames.contains(STORE_STREAMS)) {
				db.createObjectStore(STORE_STREAMS, { keyPath: 'sessionId' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return database;
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error);
	});
}

async function withStore<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(name, mode);
		const store = tx.objectStore(name);
		let result: T;
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error);
		void run(store).then(value => { result = value; }).catch(reject);
	});
}

/** Reads a cached transcript page; `undefined` means fall back to the server. */
export async function readCachedTranscript(sessionId: string): Promise<TranscriptPage | undefined> {
	try {
		const entry = await withStore(STORE_TRANSCRIPTS, 'readonly', store =>
			request(store.get(sessionId) as IDBRequest<CachedTranscript | undefined>));
		if (!entry) {
			return undefined;
		}
		return { items: entry.items, start: entry.start, hasMore: entry.hasMore };
	} catch {
		return undefined;
	}
}

/** Stores a transcript page, evicting the least-recently saved beyond the limit. */
export async function writeCachedTranscript(sessionId: string, page: TranscriptPage): Promise<void> {
	try {
		await withStore(STORE_TRANSCRIPTS, 'readwrite', async store => {
			store.put({ ...page, sessionId, savedAt: Date.now() } satisfies CachedTranscript);
			const all = await request(store.getAll() as IDBRequest<CachedTranscript[]>);
			if (all.length > CACHE_LIMIT) {
				all.sort((a, b) => a.savedAt - b.savedAt);
				for (const old of all.slice(0, all.length - CACHE_LIMIT)) {
					store.delete(old.sessionId);
				}
			}
		});
	} catch {
		// Private mode / quota: the cache is optional.
	}
}

/** Reads a cached stream slot; merged into the in-memory map on startup. */
export async function readCachedStreams(): Promise<readonly CachedStream[]> {
	try {
		return await withStore(STORE_STREAMS, 'readonly', store =>
			request(store.getAll() as IDBRequest<CachedStream[]>));
	} catch {
		return [];
	}
}

/** Persists one stream slot. Fired and forgotten from the write path. */
export function writeCachedStream(sessionId: string, stream: SessionStream): void {
	void withStore(STORE_STREAMS, 'readwrite', async store => {
		store.put({ ...stream, sessionId } satisfies CachedStream);
		const all = await request(store.getAll() as IDBRequest<CachedStream[]>);
		if (all.length > CACHE_LIMIT) {
			all.sort((a, b) => a.updatedAt - b.updatedAt);
			for (const old of all.slice(0, all.length - CACHE_LIMIT)) {
				store.delete(old.sessionId);
			}
		}
	}).catch(() => undefined);
}
