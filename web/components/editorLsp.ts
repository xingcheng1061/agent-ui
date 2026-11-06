/**
 * Monaco's half of the clangd bridge.
 *
 * There is no language client library here: Monaco asks a provider, the
 * provider asks the server, and the answer is handed to the workspace instead
 * of back to Monaco. Returning `null` is deliberate — letting Monaco act on a
 * location would open a detached read-only editor outside the workspace's tab,
 * lose the project it belongs to, and skip the "file moved" fallbacks.
 */
import { closeLspDocument, lspDefinition, lspHover, syncLspDocument } from '../api';
import { modelUri, monaco } from '../monacoSetup';

interface DocumentOwner {
	readonly root: string;
	readonly path: string;
}

/** Where the workspace's file opening lives: it owns tabs and status. */
export interface LspBridge {
	/** Opens a file the way a terminal link does: absolute path, 1-based. */
	open(target: { readonly path: string; readonly line: number; readonly column: number }): void;
	/** A one-line status message. */
	notice(message: string): void;
}

/** model uri -> the project file it was created for. */
const owners = new Map<string, DocumentOwner>();
/** Debounced edits, so a burst of typing becomes one sync. */
const pendingText = new Map<string, string>();
const timers = new Map<string, number>();

let bridge: LspBridge | undefined;
let installed = false;
/** A missing clangd fails every click; say it once, not per click. */
let lastNotice = '';

const SYNC_DELAY_MS = 400;

function keyOf(root: string, filePath: string): string {
	return modelUri(root, filePath).toString();
}

function notifyFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (message === lastNotice) {
		return;
	}
	lastNotice = message;
	bridge?.notice(`clangd: ${message}`);
}

function push(root: string, filePath: string, text: string): void {
	void syncLspDocument(root, filePath, text).catch(notifyFailure);
}

/**
 * Registers the providers and the workspace callbacks they answer to.
 *
 * Called once from the workspace; a second call only swaps the callbacks,
 * which is what a project switch does.
 */
export function attachLsp(next: LspBridge): void {
	bridge = next;
	if (installed) {
		return;
	}
	installed = true;
	// Only the two languages that map to C/C++ sources in `languageForPath`.
	for (const language of ['c', 'cpp']) {
		monaco.languages.registerDefinitionProvider(language, { provideDefinition });
		monaco.languages.registerHoverProvider(language, { provideHover });
	}
}

async function provideDefinition(
	model: monaco.editor.ITextModel,
	position: monaco.Position,
): Promise<monaco.languages.Definition | null> {
	const owner = owners.get(model.uri.toString());
	if (!owner) {
		return null;
	}
	try {
		const targets = await lspDefinition(owner.root, owner.path, position.lineNumber, position.column);
		// clangd lists overloads and declarations in order of preference; the
		// first is the one a Ctrl+click in an IDE lands on.
		const target = targets[0];
		if (target) {
			bridge?.open(target);
		}
	} catch (error) {
		notifyFailure(error);
	}
	return null;
}

async function provideHover(
	model: monaco.editor.ITextModel,
	position: monaco.Position,
): Promise<monaco.languages.Hover | null> {
	const owner = owners.get(model.uri.toString());
	if (!owner) {
		return null;
	}
	try {
		const contents = await lspHover(owner.root, owner.path, position.lineNumber, position.column);
		return contents ? { contents: [{ value: contents }] } : null;
	} catch (error) {
		notifyFailure(error);
		return null;
	}
}

/** The file is on screen: clangd gets its content before the first click. */
export function trackDocument(root: string, filePath: string, text: string): void {
	const key = keyOf(root, filePath);
	owners.set(key, { root, path: filePath });
	pendingText.delete(key);
	window.clearTimeout(timers.get(key));
	timers.delete(key);
	push(root, filePath, text);
}

/**
 * An edit, synced on a delay.
 *
 * Full-text sync per keystroke would queue behind clangd's own parsing; the
 * delay is short enough that a click right after typing still lands right.
 */
export function documentEdited(model: monaco.editor.ITextModel, root: string, filePath: string, text: string): void {
	const key = keyOf(root, filePath);
	owners.set(key, { root, path: filePath });
	pendingText.set(key, text);
	window.clearTimeout(timers.get(key));
	timers.set(key, window.setTimeout(() => {
		timers.delete(key);
		const latest = pendingText.get(key);
		pendingText.delete(key);
		if (latest !== undefined) {
			push(root, filePath, latest);
		}
	}, SYNC_DELAY_MS));
}

/** The file left the editor: stop clangd from answering about a stale buffer. */
export function untrackDocument(root: string, filePath: string): void {
	const key = keyOf(root, filePath);
	owners.delete(key);
	pendingText.delete(key);
	window.clearTimeout(timers.get(key));
	timers.delete(key);
	void closeLspDocument(root, filePath).catch(() => undefined);
}
