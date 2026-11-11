import { useEffect, useRef, useState } from 'react';
import { gitFile } from '../api';
import { languageForPath, monaco } from '../monacoSetup';
import { getTheme, onThemeChange, type ThemeName } from '../theme';
import { t } from '../i18n';

interface DiffViewProps {
	readonly root: string;
	readonly filePath: string;
	readonly revision: number;
}

/** The models currently in the diff, kept so a refresh can update them. */
interface DiffModels {
	readonly root: string;
	readonly filePath: string;
	readonly original: monaco.editor.ITextModel;
	readonly modified: monaco.editor.ITextModel;
}

/** HEAD vs. working tree for one file, read-only. */
export function DiffView({ root, filePath, revision }: DiffViewProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
	const modelsRef = useRef<DiffModels | null>(null);
	const [note, setNote] = useState('');
	/** Number of hunks; `goToDiff` walks them and 0 disables the buttons. */
	const [changeCount, setChangeCount] = useState(0);
	const [theme, setTheme] = useState<ThemeName>(getTheme);

	// Built once per file. `revision` is deliberately not a dependency: the
	// agent ends a turn after almost every message, and rebuilding the editor
	// there is what snapped the scroll position back to the top.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		setNote('');
		setChangeCount(0);
		modelsRef.current = null;
		const diffEditor = monaco.editor.createDiffEditor(container, {
			theme: getTheme() === 'light' ? 'agentui-light' : 'agentui-dark',
			automaticLayout: true,
			readOnly: true,
			renderSideBySide: true,
			ignoreTrimWhitespace: false,
			// Monaco draws its own change map on the right edge; it used to be
			// turned off here, which is why there was no overview at all.
			renderOverviewRuler: true,
			fontSize: 12,
		});
		diffRef.current = diffEditor;
		// The hunks are computed asynchronously; this is the only signal that
		// `getLineChanges()` is worth reading.
		const diffSubscription = diffEditor.onDidUpdateDiff(() => {
			setChangeCount(diffEditor.getLineChanges()?.length ?? 0);
		});

		let disposed = false;
		void (async () => {
			try {
				const versions = await gitFile(root, filePath);
				if (disposed) {
					return;
				}
				if (versions.binary) {
					setNote(t('二进制文件，不显示文本 diff'));
					return;
				}
				const language = languageForPath(filePath);
				const original = monaco.editor.createModel(
					versions.original,
					language,
					monaco.Uri.parse(`diff-original:///${encodeURI(filePath)}`),
				);
				const modified = monaco.editor.createModel(
					versions.modified,
					language,
					monaco.Uri.parse(`diff-modified:///${encodeURI(filePath)}`),
				);
				modelsRef.current = { root, filePath, original, modified };
				diffEditor.setModel({ original, modified });
			} catch (error) {
				if (!disposed) {
					setNote(String(error));
				}
			}
		})();

		return () => {
			disposed = true;
			diffSubscription.dispose();
			if (diffRef.current === diffEditor) {
				diffRef.current = null;
			}
			const models = modelsRef.current;
			modelsRef.current = null;
			diffEditor.setModel(null);
			models?.original.dispose();
			models?.modified.dispose();
			diffEditor.dispose();
		};
	}, [root, filePath]);

	// A finished agent turn refreshes the content in place. `setValue` keeps the
	// editor and its scroll position; only a shrinking file can clamp the view.
	useEffect(() => {
		const models = modelsRef.current;
		if (!models || models.root !== root || models.filePath !== filePath || revision === 0) {
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const versions = await gitFile(root, filePath);
				if (cancelled || versions.binary) {
					return;
				}
				models.original.setValue(versions.original);
				models.modified.setValue(versions.modified);
			} catch {
				// Keep the previous diff: a transient git error must not blank it.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [revision, root, filePath]);

	useEffect(() => onThemeChange(setTheme), []);

	// The diff editor follows the app theme like every other Monaco instance.
	useEffect(() => {
		monaco.editor.setTheme(theme === 'light' ? 'agentui-light' : 'agentui-dark');
	}, [theme]);

	/** Monaco owns the hunk list; `goToDiff` is its built-in walker. */
	const jump = (direction: 'next' | 'previous') => {
		diffRef.current?.goToDiff(direction);
	};

	return (
		<div className="diff-wrap">
			<div className="diff-labels">
				<span>HEAD</span>
				<span>{t('工作区')}</span>
				<span className="diff-actions">
					<span className="diff-count">{changeCount > 0 ? t('{count} 处变更', { count: changeCount }) : t('无变更')}</span>
					<button
						type="button"
						title={t('上一个变更')}
						disabled={changeCount === 0}
						onClick={() => jump('previous')}
					>↑</button>
					<button
						type="button"
						title={t('下一个变更')}
						disabled={changeCount === 0}
						onClick={() => jump('next')}
					>↓</button>
				</span>
			</div>
			<div className="diff-host" ref={containerRef} />
			{note && <div className="diff-note">{note}</div>}
		</div>
	);
}
