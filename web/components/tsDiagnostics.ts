/**
 * TypeScript / JavaScript squiggles, pulled from Monaco's own TS worker.
 *
 * Monaco ships a diagnostic publisher, but it only speaks for models the TS
 * mode created itself; the buffers here are made with `monaco.Uri.file()` and
 * handed to whichever editor is on screen, so nothing was ever published and
 * `.ts`/`.js` files only ever got syntax colouring. Pulling the diagnostics
 * explicitly makes the markers a function of the buffer, and reuses the same
 * marker pipeline the clangd side paints through.
 *
 * The built-in publisher is switched off in `monacoSetup`, so a problem is
 * reported once and not twice.
 */
import { monaco } from '../monacoSetup';

const OWNER = 'typescript-check';
/** Long enough that a burst of typing checks once, short enough to feel live. */
const CHECK_DELAY_MS = 600;
/** A generated bundle is not worth a language-service pass on every keystroke. */
const MAX_CHECKED_LENGTH = 2_000_000;

/**
 * Codes that are only ever "there is no `node_modules` in the browser".
 *
 * The TS worker resolves imports against the models it knows, so a package
 * import has nothing to resolve to and every `.tsx` file would open fully red.
 * Everything else — syntax, wrong members, bad arguments — still shows.
 */
const IGNORED_CODES = new Set([2307, 2792, 7016, 2688, 2503, 7026]);

/** TS category (warning 0, error 1, suggestion 2, message 3) -> marker severity. */
const MARKER_SEVERITY = [
	monaco.MarkerSeverity.Warning,
	monaco.MarkerSeverity.Error,
	monaco.MarkerSeverity.Info,
	monaco.MarkerSeverity.Hint,
] as const;

const CHECKED_LANGUAGES = new Set(['typescript', 'javascript']);

const timers = new Map<string, number>();
/** Models already wired to the change listener; a model outlives its editor. */
const watched = new Set<string>();
let installed = false;

function messageOf(diagnostic: monaco.languages.typescript.Diagnostic): string {
	const { messageText } = diagnostic;
	return typeof messageText === 'string' ? messageText : messageText.messageText;
}

function markerFor(
	model: monaco.editor.ITextModel,
	diagnostic: monaco.languages.typescript.Diagnostic,
): monaco.editor.IMarkerData {
	// `start`/`length` are offsets into the file; Monaco wants line/column pairs,
	// and the end of the range is where the underline has to stop.
	const length = model.getValueLength();
	const start = Math.min(Math.max(0, diagnostic.start ?? 0), length);
	const end = Math.min(Math.max(start, start + (diagnostic.length ?? 0)), length);
	const from = model.getPositionAt(start);
	const to = model.getPositionAt(end);
	return {
		severity: MARKER_SEVERITY[diagnostic.category] ?? monaco.MarkerSeverity.Error,
		message: messageOf(diagnostic),
		source: 'ts',
		startLineNumber: from.lineNumber,
		startColumn: from.column,
		endLineNumber: to.lineNumber,
		endColumn: to.column,
	};
}

async function check(model: monaco.editor.ITextModel): Promise<void> {
	if (model.isDisposed() || model.getValueLength() > MAX_CHECKED_LENGTH) {
		return;
	}
	try {
		const client = await monaco.languages.typescript.getTypeScriptWorker().then(worker => worker(model.uri));
		const [syntactic, semantic] = await Promise.all([
			client.getSyntacticDiagnostics(model.uri.toString()),
			client.getSemanticDiagnostics(model.uri.toString()),
		]);
		// Typing during the round trip: the answer describes the previous buffer,
		// and the model's own change listener will schedule another pass.
		if (model.isDisposed()) {
			return;
		}
		const markers = [...syntactic, ...semantic]
			.filter(diagnostic => !IGNORED_CODES.has(diagnostic.code))
			.map(diagnostic => markerFor(model, diagnostic));
		monaco.editor.setModelMarkers(model, OWNER, markers);
	} catch {
		// A worker that failed to start must not take the editor down with it.
	}
}

function schedule(model: monaco.editor.ITextModel): void {
	const key = model.uri.toString();
	window.clearTimeout(timers.get(key));
	timers.set(key, window.setTimeout(() => {
		timers.delete(key);
		void check(model);
	}, CHECK_DELAY_MS));
}

function watch(model: monaco.editor.ITextModel): void {
	if (!CHECKED_LANGUAGES.has(model.getLanguageId())) {
		return;
	}
	const key = model.uri.toString();
	if (!watched.has(key)) {
		watched.add(key);
		model.onDidChangeContent(() => schedule(model));
		model.onWillDispose(() => {
			watched.delete(key);
			window.clearTimeout(timers.get(key));
			timers.delete(key);
		});
	}
	schedule(model);
}

/** Idempotent: every new model is checked, and every existing one starts now. */
export function installTypeScriptDiagnostics(): void {
	if (installed) {
		return;
	}
	installed = true;
	monaco.editor.onDidCreateModel(watch);
	for (const model of monaco.editor.getModels()) {
		watch(model);
	}
}
