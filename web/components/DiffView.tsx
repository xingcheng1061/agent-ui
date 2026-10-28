import { useEffect, useRef, useState } from 'react';
import { gitFile } from '../api';
import { languageForPath, monaco } from '../monacoSetup';

interface DiffViewProps {
	readonly root: string;
	readonly filePath: string;
	readonly revision: number;
}

/** HEAD vs. working tree for one file, read-only. */
export function DiffView({ root, filePath, revision }: DiffViewProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [note, setNote] = useState('');

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		setNote('');
		const diffEditor = monaco.editor.createDiffEditor(container, {
			theme: 'vs-dark',
			automaticLayout: true,
			readOnly: true,
			renderSideBySide: true,
			ignoreTrimWhitespace: false,
			renderOverviewRuler: false,
			fontSize: 12,
		});

		let disposed = false;
		let originalModel: monaco.editor.ITextModel | undefined;
		let modifiedModel: monaco.editor.ITextModel | undefined;

		void (async () => {
			try {
				const versions = await gitFile(root, filePath);
				if (disposed) {
					return;
				}
				if (versions.binary) {
					setNote('二进制文件，不显示文本 diff');
					return;
				}
				const language = languageForPath(filePath);
				originalModel = monaco.editor.createModel(
					versions.original,
					language,
					monaco.Uri.parse(`diff-original:///${encodeURI(filePath)}`),
				);
				modifiedModel = monaco.editor.createModel(
					versions.modified,
					language,
					monaco.Uri.parse(`diff-modified:///${encodeURI(filePath)}`),
				);
				diffEditor.setModel({ original: originalModel, modified: modifiedModel });
			} catch (error) {
				if (!disposed) {
					setNote(String(error));
				}
			}
		})();

		return () => {
			disposed = true;
			diffEditor.setModel(null);
			originalModel?.dispose();
			modifiedModel?.dispose();
			diffEditor.dispose();
		};
	}, [root, filePath, revision]);

	return (
		<div className="diff-wrap">
			<div className="diff-labels">
				<span>HEAD</span>
				<span>工作区</span>
			</div>
			<div className="diff-host" ref={containerRef} />
			{note && <div className="diff-note">{note}</div>}
		</div>
	);
}
