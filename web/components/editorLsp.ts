/**
 * Monaco's half of the clangd bridge.
 *
 * There is no language client library here: Monaco asks a provider, the
 * provider asks the server, and the workspace opens the answer.
 *
 * Definitions are returned as real `Location`s instead of being swallowed to
 * `null`: Monaco only paints the Ctrl+hover underline, the "go to definition"
 * cursor and the F12 command when a provider returns one, so returning `null`
 * made the editor feel dead even though the click still worked. Opening stays
 * ours — `registerEditorOpener` intercepts the jump, so the file lands in a
 * workspace tab and keeps the project lookup and "moved file" fallbacks.
 */
import { closeLspDocument, lspDefinition, lspHover, lspSemanticTokens, syncLspDocument, type LspDiagnostic } from '../api';
import { languageForPath, modelUri, monaco } from '../monacoSetup';

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

/**
 * How long to wait before asking for semantic tokens a second time.
 *
 * clangd answers with an empty array when the document arrives before the
 * first parse finished, and Monaco takes that as "nothing to colour" rather
 * than asking again — the file stayed plain until the next keystroke.
 */
const TOKEN_RETRY_MS = 900;

/**
 * Legend shared with `server/lsp.ts`. clangd encodes each token as an index
 * into these arrays, so the order has to match the server exactly.
 */
const SEMANTIC_TOKEN_TYPES = [
	'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
	'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
	'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
];

const SEMANTIC_TOKEN_MODIFIERS = [
	'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
	'modification', 'documentation', 'defaultLibrary',
];

/** LSP severity (1..4) -> Monaco marker severity. */
const MARKER_SEVERITY: Record<number, monaco.MarkerSeverity> = {
	1: monaco.MarkerSeverity.Error,
	2: monaco.MarkerSeverity.Warning,
	3: monaco.MarkerSeverity.Info,
	4: monaco.MarkerSeverity.Hint,
};

/** Paints clangd's diagnostics as the editor's squiggles. */
function applyDiagnostics(model: monaco.editor.ITextModel, items: readonly LspDiagnostic[]): void {
	monaco.editor.setModelMarkers(model, 'clangd', items.map(item => ({
		severity: MARKER_SEVERITY[item.severity] ?? monaco.MarkerSeverity.Error,
		message: item.message,
		source: item.source ?? 'clangd',
		startLineNumber: item.line,
		startColumn: item.column,
		endLineNumber: item.endLine,
		endColumn: item.endColumn,
	})));
}

function keyOf(root: string, filePath: string): string {
	return modelUri(root, filePath).toString();
}

/**
 * The absolute path behind a URI.
 *
 * `monaco.Uri.file()` encodes the drive letter (`file:///e%3A/repo/a.cpp`) and
 * leaves a leading slash in front of it; the filesystem wants `e:/repo/a.cpp`.
 */
function pathFromUri(uri: monaco.Uri): string {
	const raw = decodeURIComponent(uri.path);
	return /^\/[A-Za-z]:\//.test(raw) ? raw.slice(1) : raw;
}

/** The editor opener hands either a range or a bare position. */
function positionOf(selectionOrPosition: monaco.IRange | monaco.IPosition | undefined): { line: number; column: number } {
	if (!selectionOrPosition) {
		return { line: 1, column: 1 };
	}
	if ('startLineNumber' in selectionOrPosition) {
		return { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn };
	}
	return { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column };
}

function notifyFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (message === lastNotice) {
		return;
	}
	lastNotice = message;
	bridge?.notice(`clangd: ${message}`);
}

/**
 * The whole document's tokens, with one retry for the "not parsed yet" answer.
 *
 * LSP's relative 5-tuple encoding is exactly what Monaco decodes, so the array
 * only has to be handed over as `Uint32Array`.
 */
async function requestTokens(
	root: string,
	filePath: string,
	text: string,
): Promise<{ resultId?: string; data: Uint32Array } | null> {
	const first = await lspSemanticTokens(root, filePath, text);
	if (first.data.length > 0) {
		return { resultId: first.resultId, data: new Uint32Array(first.data) };
	}
	await new Promise<void>(resolve => {
		window.setTimeout(resolve, TOKEN_RETRY_MS);
	});
	const second = await lspSemanticTokens(root, filePath, text);
	if (second.data.length === 0) {
		return null;
	}
	return { resultId: second.resultId, data: new Uint32Array(second.data) };
}

/**
 * Hover, deduplicated while in flight.
 *
 * Monaco asks on every mouse move over a symbol, and clangd answers one
 * request at a time: the same tooltip queued three times pushes everything
 * behind it past the timeout. Only concurrent calls are shared — a cached
 * answer would be wrong as soon as the buffer changes.
 */
const hoversInFlight = new Map<string, Promise<string | undefined>>();

function hoverAt(root: string, filePath: string, line: number, column: number, text: string): Promise<string | undefined> {
	const key = `${root}\u0000${filePath}\u0000${line}\u0000${column}`;
	const pending = hoversInFlight.get(key);
	if (pending) {
		return pending;
	}
	const started = lspHover(root, filePath, line, column, text)
		.finally(() => hoversInFlight.delete(key));
	hoversInFlight.set(key, started);
	return started;
}

function push(root: string, filePath: string, text: string): void {
	void syncLspDocument(root, filePath, text)
		.then(result => {
			const model = monaco.editor.getModel(modelUri(root, filePath));
			if (model) {
				applyDiagnostics(model, result.diagnostics ?? []);
			}
		})
		.catch(notifyFailure);
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
	monaco.languages.registerDocumentSemanticTokensProvider(['c', 'cpp'], {
		getLegend: () => ({
			tokenTypes: [...SEMANTIC_TOKEN_TYPES],
			tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
		}),
		provideDocumentSemanticTokens: async (model, _lastResultId) => {
			const owner = owners.get(model.uri.toString());
			if (!owner) {
				return null;
			}
			try {
				return await requestTokens(owner.root, owner.path, model.getValue());
			} catch {
				return null;
			}
		},
		releaseDocumentSemanticTokens: () => undefined,
	});
	monaco.editor.registerEditorOpener({
		openCodeEditor(_source, resource, selectionOrPosition) {
			const position = positionOf(selectionOrPosition);
			bridge?.open({ path: pathFromUri(resource), line: position.line, column: position.column });
			// Handled: Monaco must not fall back to a detached read-only editor
			// outside the workspace, which would lose the project context.
			return true;
		},
	});
}

async function provideDefinition(
	model: monaco.editor.ITextModel,
	position: monaco.Position,
): Promise<monaco.languages.Location[] | null> {
	const owner = owners.get(model.uri.toString());
	if (!owner) {
		return null;
	}
	try {
		// The buffer goes with the request: clangd must answer about the text
		// on screen, not a debounced copy that is a few edits behind.
		const targets = await lspDefinition(owner.root, owner.path, position.lineNumber, position.column, model.getValue());
		// clangd lists overloads and declarations in order of preference; the
		// first is what a Ctrl+click in an IDE lands on. All of them are
		// returned so Monaco paints the link underline and runs F12.
		return targets.map(target => ({
			uri: monaco.Uri.file(target.path),
			range: {
				startLineNumber: target.line,
				startColumn: target.column,
				endLineNumber: target.line,
				// clangd reports a point; a zero-width range paints nothing.
				endColumn: target.column + 1,
			},
		}));
	} catch (error) {
		notifyFailure(error);
		return null;
	}
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
		const contents = await hoverAt(owner.root, owner.path, position.lineNumber, position.column, model.getValue());
		return contents ? { contents: [{ value: contents }] } : null;
	} catch (error) {
		notifyFailure(error);
		return null;
	}
}

/**
 * Whether clangd is the right server for this file.
 *
 * Every opened buffer used to be pushed, so clangd parsed a `.proto` or a
 * `.conf` as C++ and its complaints landed as squiggles on a file it has no
 * business reading. Only the two languages whose providers are registered are
 * allowed through; anything else never reaches the bridge.
 */
function isCppFile(filePath: string): boolean {
	const language = languageForPath(filePath);
	return language === 'c' || language === 'cpp';
}

/** The file is on screen: clangd gets its content before the first click. */
export function trackDocument(root: string, filePath: string, text: string): void {
	if (!isCppFile(filePath)) {
		return;
	}
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
	if (!isCppFile(filePath)) {
		return;
	}
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
