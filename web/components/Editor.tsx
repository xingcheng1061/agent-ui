import { useEffect, useRef } from 'react';
import { readFile, writeFile } from '../api';
import { languageForPath, modelUri, monaco } from '../monacoSetup';

interface EditorProps {
	readonly root: string;
	readonly filePath: string | undefined;
	readonly onDirtyChange: (dirty: boolean) => void;
	readonly onStatus: (message: string) => void;
}

export function Editor({ root, filePath, onDirtyChange, onStatus }: EditorProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const dirtySubscriptionRef = useRef<monaco.IDisposable | undefined>(undefined);
	const currentFileRef = useRef<string | undefined>(undefined);
	const onDirtyChangeRef = useRef(onDirtyChange);
	const onStatusRef = useRef(onStatus);

	onDirtyChangeRef.current = onDirtyChange;
	onStatusRef.current = onStatus;

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
			dirtySubscriptionRef.current = model.onDidChangeContent(() => onDirtyChangeRef.current(true));
			onDirtyChangeRef.current(false);
		})().catch(error => onStatusRef.current(String(error)));

		return () => {
			cancelled = true;
		};
	}, [filePath, root]);

	return <div className="editor-host" ref={containerRef} />;
}
