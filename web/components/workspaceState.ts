/**
 * What the code pane should look like when a project comes back.
 *
 * Browser-local on purpose: which file was open and where the caret sat is a
 * property of this window, not of the project. Before this, every switch to
 * another project's session (and every reload) dropped both — the panel is
 * mounted with `key={root}`, so nothing survived a remount.
 */

/** Caret + scroll of one file, restored when it is opened again. */
export interface CursorState {
	readonly line: number;
	readonly column: number;
	readonly scrollTop: number;
}

interface ViewState {
	file?: string;
	tab: 'files' | 'changes';
	/** Keyed by the project-relative path. */
	cursor: Record<string, CursorState>;
	/**
	 * Directories the tree had expanded (`''` is the root). The tree is remounted
	 * on every project switch and reload, so without this it collapsed back to the
	 * top level while the open file was still remembered.
	 */
	expanded?: string[];
}

const KEY = 'agentui.workspace';

/**
 * Same folder, different separators or drive-letter case. The workspace root
 * arrives from a session cwd, so it varies between runs.
 */
function keyFor(root: string): string {
	return root.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

let cache: Record<string, ViewState> | undefined;

function load(): Record<string, ViewState> {
	if (cache) {
		return cache;
	}
	try {
		const raw = localStorage.getItem(KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		cache = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, ViewState> : {};
	} catch {
		cache = {};
	}
	return cache;
}

function persist(): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(load()));
	} catch {
		// Private mode: the view simply is not remembered.
	}
}

function entry(root: string): ViewState {
	const store = load();
	const key = keyFor(root);
	let value = store[key];
	if (!value) {
		value = { tab: 'files', cursor: {} };
		store[key] = value;
	}
	if (!value.cursor) {
		value.cursor = {};
	}
	return value;
}

export function readOpenFile(root: string): string | undefined {
	return entry(root).file;
}

export function writeOpenFile(root: string, file: string | undefined): void {
	const value = entry(root);
	if (file === undefined) {
		delete value.file;
	} else {
		value.file = file;
	}
	persist();
}

export function readLeftTab(root: string): 'files' | 'changes' {
	return entry(root).tab === 'changes' ? 'changes' : 'files';
}

export function writeLeftTab(root: string, tab: 'files' | 'changes'): void {
	entry(root).tab = tab;
	persist();
}

/** Directories expanded in the file tree, deepest last. */
export function readExpandedDirs(root: string): readonly string[] {
	const value = entry(root).expanded;
	return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

export function writeExpandedDirs(root: string, directories: readonly string[]): void {
	entry(root).expanded = [...new Set(directories)];
	persist();
}

export function readCursor(root: string, file: string): CursorState | undefined {
	return entry(root).cursor[file];
}

export function writeCursor(root: string, file: string, state: CursorState): void {
	entry(root).cursor[file] = state;
	persist();
}
