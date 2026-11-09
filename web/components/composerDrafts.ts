/**
 * Unsent composer text, per conversation.
 *
 * The draft was plain component state, so switching conversation — which either
 * remounts the panel or re-targets it — dropped whatever had been typed but not
 * sent. Keeping it here means going back to a conversation brings its draft
 * back, and a reload does too.
 *
 * Browser-local on purpose: a half-written message is a property of this window,
 * not of the session.
 */

const KEY = 'agentui.drafts';
/** Enough for the conversations a person actually returns to; the rest expire. */
const MAX_ENTRIES = 40;

type Store = Record<string, { readonly text: string; readonly at: number }>;

let cache: Store | undefined;

/**
 * Same folder, different separators or drive-letter case. The root arrives from
 * a session cwd, so it varies between runs — the same rule `workspaceState` uses.
 */
function normalizeRoot(root: string): string {
	return root.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Key for one conversation; a session that has no id yet is per-project. */
export function draftKey(root: string, sessionId: string | undefined): string {
	return `${normalizeRoot(root)}|${sessionId ?? 'new'}`;
}

function load(): Store {
	if (cache) {
		return cache;
	}
	try {
		const raw = window.localStorage.getItem(KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		cache = typeof parsed === 'object' && parsed !== null ? parsed as Store : {};
	} catch {
		cache = {};
	}
	return cache;
}

function persist(): void {
	try {
		window.localStorage.setItem(KEY, JSON.stringify(load()));
	} catch {
		// Private mode / quota: the draft simply is not remembered.
	}
}

/** Drops the oldest drafts once the store is full, so it cannot grow forever. */
function evict(store: Store): void {
	const keys = Object.keys(store);
	if (keys.length <= MAX_ENTRIES) {
		return;
	}
	keys
		.sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0))
		.slice(0, keys.length - MAX_ENTRIES)
		.forEach(key => delete store[key]);
}

export function readDraft(key: string): string {
	return load()[key]?.text ?? '';
}

/** `text` with nothing in it removes the entry instead of storing a blank one. */
export function writeDraft(key: string, text: string): void {
	const store = load();
	if (text.trim() === '') {
		delete store[key];
	} else {
		store[key] = { text, at: Date.now() };
	}
	evict(store);
	persist();
}
