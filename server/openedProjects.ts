/**
 * Folders the user has opened for reading, persisted per account.
 *
 * Unlike the browser-local list this used to be, the record lives on the
 * service so the same account sees the same folders from every tab and every
 * browser. Archiving hides a folder without losing its place in the list,
 * matching how sessions and groups are archived.
 */
import { JsonStore } from './store.js';

export interface OpenedProject {
	readonly root: string;
	/** When the folder was first opened; never changes on reopen. */
	readonly addedAt: number;
	/** Last time the folder was activated. */
	readonly openedAt: number;
	/** Archived folders stay in the document but leave the default list. */
	readonly archivedAt?: number;
}

interface DraftProject {
	root: string;
	addedAt: number;
	openedAt: number;
	archivedAt?: number;
}

interface Document {
	version: 1;
	/** Account id → folders. Shared-token callers use the `token` key. */
	byUser: Record<string, DraftProject[]>;
}

const store = new JsonStore<Document>('opened-projects.json', { version: 1, byUser: {} });
const ready = store.load();

function keyFor(userId: string): string {
	return userId || 'token';
}

/** Active folders first (by insertion), then archived ones oldest-first. */
export async function listOpenedProjects(userId: string): Promise<readonly OpenedProject[]> {
	await ready;
	return [...(store.snapshot.byUser[keyFor(userId)] ?? [])];
}

/** Opens a folder: adds it, refreshes `openedAt`, and un-archives it. */
export async function touchOpenedProject(userId: string, root: string): Promise<readonly OpenedProject[]> {
	await ready;
	const key = keyFor(userId);
	await store.update(draft => {
		const list = draft.byUser[key] ?? (draft.byUser[key] = []);
		const found = list.find(item => item.root === root);
		if (found) {
			found.openedAt = Date.now();
			delete found.archivedAt;
		} else {
			list.push({ root, addedAt: Date.now(), openedAt: Date.now() });
		}
	});
	return [...(store.snapshot.byUser[key] ?? [])];
}

/** Hides or restores a folder without deleting it. */
export async function setOpenedProjectArchived(userId: string, root: string, archived: boolean): Promise<boolean> {
	await ready;
	let changed = false;
	await store.update(draft => {
		const found = (draft.byUser[keyFor(userId)] ?? []).find(item => item.root === root);
		if (!found) {
			return;
		}
		changed = true;
		if (archived) {
			found.archivedAt = Date.now();
		} else {
			delete found.archivedAt;
		}
	});
	return changed;
}

/** Removes the record entirely; disk contents are untouched. */
export async function deleteOpenedProject(userId: string, root: string): Promise<boolean> {
	await ready;
	let changed = false;
	await store.update(draft => {
		const key = keyFor(userId);
		const list = draft.byUser[key];
		if (!list) {
			return;
		}
		const index = list.findIndex(item => item.root === root);
		if (index >= 0) {
			list.splice(index, 1);
			changed = true;
		}
		if (list.length === 0) {
			delete draft.byUser[key];
		}
	});
	return changed;
}
