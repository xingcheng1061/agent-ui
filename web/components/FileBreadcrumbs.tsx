import { useEffect, useMemo, useRef, useState } from 'react';
import { listDirectory, type FileEntry } from '../api';
import { t } from '../i18n';

interface FileBreadcrumbsProps {
	readonly root: string;
	readonly path: string;
	readonly onOpenFile: (path: string) => void;
}

function baseName(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** Parent of a POSIX path; `''` for a top-level entry. */
function parentOf(filePath: string): string {
	const cut = filePath.lastIndexOf('/');
	return cut < 0 ? '' : filePath.slice(0, cut);
}

/**
 * Editor breadcrumbs, VS Code style: the full path is split into clickable
 * segments. Picking one opens a picker of that directory; folders drill deeper,
 * files open in the editor. VS Code's own control is not portable (it is wired
 * into the workbench's service container), so this uses this app's APIs.
 */
export function FileBreadcrumbs({ root, path, onOpenFile }: FileBreadcrumbsProps) {
	const [pickerDir, setPickerDir] = useState<string | undefined>(undefined);
	const [entries, setEntries] = useState<readonly FileEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const hostRef = useRef<HTMLDivElement | null>(null);

	const segments = useMemo(() => path.split('/').filter(Boolean), [path]);

	useEffect(() => {
		if (pickerDir === undefined) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		void listDirectory(root, pickerDir)
			.then(list => { if (!cancelled) setEntries(list); })
			.catch(() => { if (!cancelled) setEntries([]); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [root, pickerDir]);

	useEffect(() => {
		if (pickerDir === undefined) {
			return;
		}
		const onDown = (event: MouseEvent) => {
			if (event.target instanceof Node && !hostRef.current?.contains(event.target)) {
				setPickerDir(undefined);
			}
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setPickerDir(undefined);
			}
		};
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	}, [pickerDir]);

	const choose = (entry: FileEntry) => {
		if (entry.type === 'dir') {
			setPickerDir(entry.path);
			return;
		}
		setPickerDir(undefined);
		onOpenFile(entry.path);
	};

	const toggle = (dir: string) => setPickerDir(current => current === dir ? undefined : dir);

	return (
		<div className="breadcrumbs" ref={hostRef}>
			<div className="breadcrumb-path">
				<button
					type="button"
					className={`breadcrumb${pickerDir === '' ? ' active' : ''}`}
					title={`${root} — ${t('切换文件')}`}
					onClick={() => toggle('')}
				>
					{baseName(root)}
				</button>
				{segments.map((segment, index) => <Segment key={`${segment}:${index}`} segment={segment} index={index} segments={segments} path={path} root={root} pickerDir={pickerDir} toggle={toggle} />)}
			</div>
			{pickerDir !== undefined && (
				<div className="breadcrumb-picker">
					<div className="breadcrumb-picker-head" title={pickerDir === '' ? root : `${root}/${pickerDir}`}>
						<span className="breadcrumb-picker-dir">{pickerDir === '' ? baseName(root) : pickerDir}</span>
						{pickerDir !== '' && (
							<button type="button" className="link-btn" onClick={() => setPickerDir(parentOf(pickerDir))}>{t('上级')}</button>
						)}
					</div>
					{loading
						? <div className="breadcrumb-picker-empty">{t('读取中…')}</div>
						: entries.length === 0
							? <div className="breadcrumb-picker-empty">{t('这个目录是空的')}</div>
							: <div className="breadcrumb-picker-list">
								{entries.map(entry => (
									<button
										type="button"
										key={entry.path}
										className={`breadcrumb-entry${entry.type === 'dir' ? ' dir' : ''}${entry.path === path ? ' current' : ''}`}
										title={`${root}/${entry.path}`}
										onClick={() => choose(entry)}
									>
										<span className="breadcrumb-entry-icon">{entry.type === 'dir' ? '▸' : '·'}</span>
										<span>{baseName(entry.path)}</span>
									</button>
								))}
							</div>}
				</div>
			)}
		</div>
	);
}

function Segment({ segment, index, segments, path, root, pickerDir, toggle }: {
	readonly segment: string;
	readonly index: number;
	readonly segments: readonly string[];
	readonly path: string;
	readonly root: string;
	readonly pickerDir: string | undefined;
	readonly toggle: (dir: string) => void;
}) {
	const isFile = index === segments.length - 1;
	const dir = isFile ? parentOf(path) : segments.slice(0, index + 1).join('/');
	const absolute = `${root.replace(/\/+$/, '')}/${segments.slice(0, index + 1).join('/')}`;
	return (
		<span className="breadcrumb-part">
			<span className="breadcrumb-sep">›</span>
			<button
				type="button"
				className={`breadcrumb${isFile ? ' file' : ''}${pickerDir === dir ? ' active' : ''}`}
				title={`${absolute} — ${t('切换文件')}`}
				onClick={() => toggle(dir)}
			>
				{segment}
			</button>
		</span>
	);
}
