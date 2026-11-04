import { useEffect, useRef, useState } from 'react';
import { readFile, writeFile } from '../api';
import { languageForPath, modelUri, monaco } from '../monacoSetup';
import { Markdown } from './Markdown';
import { readCursor, writeCursor } from './workspaceState';

interface EditorProps {
	readonly root: string;
	readonly filePath: string | undefined;
	/** Show the buffer rendered as markdown instead of the source text. */
	readonly preview?: boolean;
	/**
	 * Bumped to re-read the open file from disk.
	 *
	 * Monaco models are cached by URI, so without this the buffer kept whatever
	 * was on disk the first time the file was opened: everything the agent wrote
	 * afterwards stayed invisible. The workspace bumps it when a turn ends and
	 * from its reload button.
	 */
	readonly reloadToken?: number;
	/**
	 * Jump here after opening — the `path:line` of a link clicked in the
	 * terminal. Changing the object re-applies it, so callers keep it stable
	 * between renders.
	 */
	readonly reveal?: { readonly line: number; readonly column?: number };
	readonly onDirtyChange: (dirty: boolean) => void;
	readonly onStatus: (message: string) => void;
}

export function Editor({ root, filePath, preview = false, reloadToken = 0, reveal, onDirtyChange, onStatus }: EditorProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const dirtySubscriptionRef = useRef<monaco.IDisposable | undefined>(undefined);
	const cursorSubscriptionRef = useRef<monaco.IDisposable | undefined>(undefined);
	const currentFileRef = useRef<string | undefined>(undefined);
	const onDirtyChangeRef = useRef(onDirtyChange);
	const onStatusRef = useRef(onStatus);
	const previewRef = useRef(preview);
	const previewTimerRef = useRef<number | undefined>(undefined);
	/** Set while the buffer is being replaced from disk, so that is not "dirty". */
	const applyingRef = useRef(false);
	const saveCursorTimerRef = useRef<number | undefined>(undefined);
	const [previewText, setPreviewText] = useState('');
	/** Bumped once a file's model is on screen, so `reveal` can be applied. */
	const [loadedToken, setLoadedToken] = useState(0);

	onDirtyChangeRef.current = onDirtyChange;
	onStatusRef.current = onStatus;
	previewRef.current = preview;

	/**
	 * Diagrams are expensive to lay out, so the preview follows typing on a
	 * short delay rather than re-parsing markdown on every keystroke.
	 */
	const syncPreview = (model: monaco.editor.ITextModel) => {
		window.clearTimeout(previewTimerRef.current);
		previewTimerRef.current = window.setTimeout(() => setPreviewText(model.getValue()), 200);
	};

	const save = async () => {
		const editor = editorRef.current;
		const model = editor?.getModel();
		const target = currentFileRef.current;
		if (!editor || !model || !target) {
			return;
		}
		try {
			await writeFile(root, target, model.getValue());
			onDirtyChangeRef.current(false);
			onStatusRef.current(`saved ${target}`);
		} catch (error) {
			onStatusRef.current(String(error));
		}
	};

	/**
	 * Replaces the buffer with disk content.
	 *
	 * `keepView` is what separates the two callers: a reload of the file already
	 * on screen must not move the caret (that is the whole point of reloading
	 * under the user's cursor), while switching to another file has to leave the
	 * position alone so the caller can restore that file's own.
	 */
	const replaceContent = (
		editor: monaco.editor.IStandaloneCodeEditor,
		model: monaco.editor.ITextModel,
		content: string,
		keepView: boolean,
	) => {
		const position = editor.getPosition();
		const scrollTop = editor.getScrollTop();
		applyingRef.current = true;
		model.setValue(content);
		applyingRef.current = false;
		if (keepView) {
			if (position) {
				editor.setPosition({ lineNumber: Math.min(position.lineNumber, model.getLineCount()), column: position.column });
			}
			editor.setScrollTop(scrollTop);
		}
		onDirtyChangeRef.current(false);
		if (previewRef.current) {
			setPreviewText(content);
		}
	};

	const saveCursor = (editor: monaco.editor.IStandaloneCodeEditor) => {
		const file = currentFileRef.current;
		const position = editor.getPosition();
		if (!file || !position) {
			return;
		}
		writeCursor(root, file, { line: position.lineNumber, column: position.column, scrollTop: editor.getScrollTop() });
	};

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const editor = monaco.editor.create(container, {
			theme: 'vs-dark',
			automaticLayout: true,
			fontSize: 13,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			smoothScrolling: true,
			renderWhitespace: 'selection',
			tabSize: 4,
		});
		editorRef.current = editor;
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
			void save();
		});

		return () => {
			window.clearTimeout(previewTimerRef.current);
			window.clearTimeout(saveCursorTimerRef.current);
			dirtySubscriptionRef.current?.dispose();
			cursorSubscriptionRef.current?.dispose();
			editor.getModel()?.dispose();
			editor.dispose();
			editorRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Open a file: reuse its model when it exists, but never trust its content —
	// the previous read may be older than the file on disk.
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || !filePath) {
			return;
		}
		let cancelled = false;
		const target = filePath;
		currentFileRef.current = target;

		void (async () => {
			const uri = modelUri(root, target);
			const { content } = await readFile(root, target);
			if (cancelled) {
				return;
			}
			let model = monaco.editor.getModel(uri);
			if (!model) {
				model = monaco.editor.createModel(content, languageForPath(target), uri);
				editor.setModel(model);
				editor.focus();
			} else {
				editor.setModel(model);
				editor.focus();
				if (model.getValue() !== content) {
					replaceContent(editor, model, content, false);
				}
			}

			dirtySubscriptionRef.current?.dispose();
			dirtySubscriptionRef.current = model.onDidChangeContent(() => {
				if (applyingRef.current) {
					return;
				}
				onDirtyChangeRef.current(true);
				if (previewRef.current) {
					syncPreview(model);
				}
			});
			onDirtyChangeRef.current(false);

			// Where the caret was left last time; the panel is remounted on every
			// project switch and reload, so this cannot live in component state.
			const saved = readCursor(root, target);
			if (saved) {
				editor.setPosition({
					lineNumber: Math.min(Math.max(1, saved.line), model.getLineCount()),
					column: saved.column,
				});
				editor.setScrollTop(saved.scrollTop);
			} else {
				// A file whose model was already cached kept the caret of whichever
				// file was open before it.
				editor.setPosition({ lineNumber: 1, column: 1 });
				editor.setScrollTop(0);
			}

			cursorSubscriptionRef.current?.dispose();
			const scheduleSave = () => {
				window.clearTimeout(saveCursorTimerRef.current);
				saveCursorTimerRef.current = window.setTimeout(() => saveCursor(editor), 400);
			};
			const cursorSubscriptions = [
				editor.onDidChangeCursorPosition(scheduleSave),
				editor.onDidScrollChange(scheduleSave),
			];
			cursorSubscriptionRef.current = {
				dispose: () => {
					window.clearTimeout(saveCursorTimerRef.current);
					for (const subscription of cursorSubscriptions) {
						subscription.dispose();
					}
				},
			};

			setLoadedToken(value => value + 1);
			if (previewRef.current) {
				setPreviewText(model.getValue());
			}
		})().catch(error => onStatusRef.current(String(error)));

		return () => {
			cancelled = true;
			// Switching files is the last chance to record where the caret was.
			const editor = editorRef.current;
			if (editor && currentFileRef.current === target) {
				saveCursor(editor);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filePath, root]);

	// A `path:12` link: the file may already have been open, in which case the
	// effect above does not re-run, so the jump gets an effect of its own.
	useEffect(() => {
		if (!reveal || !filePath) {
			return;
		}
		const editor = editorRef.current;
		const model = editor?.getModel();
		if (!editor || !model || currentFileRef.current !== filePath) {
			return;
		}
		const line = Math.min(Math.max(1, reveal.line), model.getLineCount());
		editor.setPosition({ lineNumber: line, column: Math.max(1, reveal.column ?? 1) });
		editor.revealLineInCenter(line);
		editor.focus();
	}, [reveal, filePath, loadedToken]);

	// Disk → buffer for the file that is already open. The token is bumped when a
	// turn ends (the agent may have rewritten it) and by the reload button; a
	// dirty buffer is never replaced from here.
	useEffect(() => {
		if (reloadToken === 0) {
			return;
		}
		const editor = editorRef.current;
		const target = currentFileRef.current;
		if (!editor || !target) {
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const { content } = await readFile(root, target);
				if (cancelled) {
					return;
				}
				const model = editor.getModel();
				if (!model || model.getValue() === content) {
					return;
				}
				replaceContent(editor, model, content, true);
				onStatusRef.current(`已重新载入 ${target}`);
			} catch (error) {
				if (!cancelled) {
					onStatusRef.current(String(error));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [reloadToken]);

	// Entering the preview renders the buffer as it stands, unsaved edits included.
	useEffect(() => {
		if (!preview) {
			return;
		}
		const model = editorRef.current?.getModel();
		if (model) {
			setPreviewText(model.getValue());
		}
	}, [preview, filePath]);

	// Monaco measures its container, so it has to re-measure once the box is back.
	useEffect(() => {
		if (!preview) {
			editorRef.current?.layout();
		}
	}, [preview]);

	return (
		<>
			<div className={`editor-host${preview ? ' is-hidden' : ''}`} ref={containerRef} />
			{preview && (
				<div className="markdown-preview">
					<Markdown text={previewText} mermaid controls={false} />
				</div>
			)}
		</>
	);
}
