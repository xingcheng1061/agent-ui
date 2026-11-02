import { useEffect, useRef, useState } from 'react';
import { readFile, writeFile } from '../api';
import { languageForPath, modelUri, monaco } from '../monacoSetup';
import { Markdown } from './Markdown';

interface EditorProps {
	readonly root: string;
	readonly filePath: string | undefined;
	/** Show the buffer rendered as markdown instead of the source text. */
	readonly preview?: boolean;
	readonly onDirtyChange: (dirty: boolean) => void;
	readonly onStatus: (message: string) => void;
}

export function Editor({ root, filePath, preview = false, onDirtyChange, onStatus }: EditorProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const dirtySubscriptionRef = useRef<monaco.IDisposable | undefined>(undefined);
	const currentFileRef = useRef<string | undefined>(undefined);
	const onDirtyChangeRef = useRef(onDirtyChange);
	const onStatusRef = useRef(onStatus);
	const previewRef = useRef(preview);
	const previewTimerRef = useRef<number | undefined>(undefined);
	const [previewText, setPreviewText] = useState('');

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
			dirtySubscriptionRef.current?.dispose();
			editor.getModel()?.dispose();
			editor.dispose();
			editorRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor || !filePath) {
			return;
		}
		let cancelled = false;
		currentFileRef.current = filePath;

		void (async () => {
			const uri = modelUri(root, filePath);
			let model = monaco.editor.getModel(uri);
			if (!model) {
				const { content } = await readFile(root, filePath);
				if (cancelled) {
					return;
				}
				model = monaco.editor.createModel(content, languageForPath(filePath), uri);
			}
			if (cancelled) {
				return;
			}
			editor.setModel(model);
			editor.focus();
			dirtySubscriptionRef.current?.dispose();
			dirtySubscriptionRef.current = model.onDidChangeContent(() => {
				onDirtyChangeRef.current(true);
				if (previewRef.current) {
					syncPreview(model);
				}
			});
			onDirtyChangeRef.current(false);
			if (previewRef.current) {
				setPreviewText(model.getValue());
			}
		})().catch(error => onStatusRef.current(String(error)));

		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filePath, root]);

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
