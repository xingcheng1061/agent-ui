import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createEntry, deleteEntry, listDirectory, searchFiles, type FileEntry } from '../api';

interface DirectoryState {
	readonly open: boolean;
	readonly loading: boolean;
	readonly entries?: readonly FileEntry[];
	readonly error?: string;
}

interface FileTreeProps {
	readonly root: string;
	readonly selectedPath: string | undefined;
	readonly onOpenFile: (filePath: string) => void;
	/** Called with the deleted path so the pane can close a tab underneath it. */
	readonly onPathDeleted?: (filePath: string) => void;
	/**
	 * Bumped when the listing should be re-read: a finished agent turn may have
	 * added or deleted files, and the tree only ever loads a directory once.
	 */
	readonly reloadToken?: number;
}

/** Parent of a POSIX-style relative path; `''` for a top-level entry. */
function parentOf(filePath: string): string {
	const cut = filePath.lastIndexOf('/');
	return cut === -1 ? '' : filePath.slice(0, cut);
}

/**
 * The project's files, one directory at a time.
 *
 * New file / new folder / delete live on a context menu, as in VS Code: the tree
 * is a dense list of clickable rows, and permanent actions do not belong on
 * something a stray click hits.
 */
export function FileTree({ root, selectedPath, onOpenFile, onPathDeleted, reloadToken = 0 }: FileTreeProps) {
	const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
	/** Right-click menu: where it opened, and on what (nothing = empty space). */
	const [menu, setMenu] = useState<{ x: number; y: number; directory: string; entry?: FileEntry } | undefined>(undefined);
	/** The inline name input, one at a time, like VS Code's explorer. */
	const [draft, setDraft] = useState<{ directory: string; type: 'file' | 'dir' } | undefined>(undefined);
	const [draftName, setDraftName] = useState('');
	const [actionError, setActionError] = useState<string | undefined>(undefined);
	/** Filter box: a flat list of matches instead of the tree. */
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<readonly string[]>([]);
	const [searching, setSearching] = useState(false);
	const trimmedQuery = query.trim();

	const load = useCallback(async (directory: string) => {
		setDirectories(previous => ({
			...previous,
			[directory]: { open: true, loading: true, entries: previous[directory]?.entries },
		}));
		try {
			const entries = await listDirectory(root, directory);
			setDirectories(previous => ({ ...previous, [directory]: { open: true, loading: false, entries } }));
		} catch (error) {
			setDirectories(previous => ({
				...previous,
				[directory]: { open: true, loading: false, entries: previous[directory]?.entries, error: String(error) },
			}));
		}
	}, [root]);

	const toggle = useCallback((entry: FileEntry) => {
		if (entry.type === 'file') {
			onOpenFile(entry.path);
			return;
		}
		const state = directories[entry.path];
		if (!state || !state.entries) {
			void load(entry.path);
			return;
		}
		setDirectories(previous => ({
			...previous,
			[entry.path]: { ...previous[entry.path], open: !previous[entry.path]?.open, loading: false },
		}));
	}, [directories, load, onOpenFile]);

	useEffect(() => {
		void load('');
	}, [load]);

	// Re-read what is on screen, keeping which directories are expanded. The
	// first run is the mount itself, which already loads the root.
	const firstTokenRef = useRef(true);
	useEffect(() => {
		if (firstTokenRef.current) {
			firstTokenRef.current = false;
			return;
		}
		for (const directory of Object.keys(directories)) {
			if (directories[directory]?.open) {
				void load(directory);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [reloadToken]);

	// Typing filters the whole project, not the level on screen: expanding
	// directories to find one file is the slow path, and the server already has
	// a bounded walk for the `@` picker.
	useEffect(() => {
		if (trimmedQuery === '') {
			setResults([]);
			setSearching(false);
			return;
		}
		let cancelled = false;
		setSearching(true);
		const timer = window.setTimeout(() => {
			searchFiles(root, trimmedQuery)
				.then(files => {
					if (!cancelled) {
						setResults(files);
						setSearching(false);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setResults([]);
						setSearching(false);
					}
				});
		}, 250);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [trimmedQuery, root]);

	// Any click outside the menu dismisses it; the menu itself stops propagation.
	useEffect(() => {
		if (!menu) {
			return;
		}
		const close = () => setMenu(undefined);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				close();
			}
		};
		window.addEventListener('click', close);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('click', close);
			window.removeEventListener('keydown', onKey);
		};
	}, [menu]);

	const openMenu = (event: MouseEvent, directory: string, entry?: FileEntry) => {
		event.preventDefault();
		event.stopPropagation();
		setActionError(undefined);
		setMenu({ x: event.clientX, y: event.clientY, directory, entry });
	};

	const startCreate = (directory: string, type: 'file' | 'dir') => {
		setMenu(undefined);
		setActionError(undefined);
		setDraft({ directory, type });
		setDraftName('');
		// Creating inside a collapsed directory: open it so the input is visible.
		if (!directories[directory]?.entries) {
			void load(directory);
		}
	};

	const submitDraft = async () => {
		const target = draft;
		if (!target) {
			return;
		}
		const name = draftName.trim();
		if (!name) {
			setDraft(undefined);
			return;
		}
		const entryPath = target.directory ? `${target.directory}/${name}` : name;
		try {
			await createEntry(root, entryPath, target.type);
			setDraft(undefined);
			setDraftName('');
			await load(target.directory);
			if (target.type === 'file') {
				onOpenFile(entryPath);
			}
		} catch (error) {
			setActionError(String(error));
		}
	};

	const remove = async (entry: FileEntry) => {
		setMenu(undefined);
		const what = entry.type === 'dir' ? '目录及其中的内容' : '文件';
		if (!window.confirm(`删除${what}「${entry.name}」？此操作不可撤销。`)) {
			return;
		}
		try {
			await deleteEntry(root, entry.path);
			onPathDeleted?.(entry.path);
			await load(parentOf(entry.path));
		} catch (error) {
			setActionError(String(error));
		}
	};

	const renderDirectory = (directory: string, depth: number): JSX.Element[] => {
		const state = directories[directory];
		const rows: JSX.Element[] = [];
		if (draft?.directory === directory) {
			rows.push(
				<div className="tree-row" key={`draft:${directory}`} style={{ paddingLeft: 8 + depth * 12 }}>
					<span className="tree-icon">{draft.type === 'dir' ? '▸' : '·'}</span>
					<input
						className="tree-input"
						autoFocus
						value={draftName}
						placeholder={draft.type === 'dir' ? '新目录名' : '新文件名'}
						spellCheck={false}
						onChange={event => setDraftName(event.target.value)}
						onKeyDown={event => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void submitDraft();
							}
							if (event.key === 'Escape') {
								event.stopPropagation();
								setDraft(undefined);
							}
						}}
						onBlur={() => setDraft(undefined)}
					/>
				</div>,
			);
		}
		if (state?.open && state.entries) {
			for (const entry of state.entries) {
				const isSelected = entry.type === 'file' && entry.path === selectedPath;
				rows.push(
					<div
						key={entry.path}
						className={`tree-row${isSelected ? ' selected' : ''}`}
						style={{ paddingLeft: 8 + depth * 12 }}
						onClick={() => toggle(entry)}
						onContextMenu={event => openMenu(event, entry.type === 'dir' ? entry.path : parentOf(entry.path), entry)}
						role="treeitem"
						aria-expanded={entry.type === 'dir' ? Boolean(directories[entry.path]?.open) : undefined}
						tabIndex={0}
						onKeyDown={event => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								toggle(entry);
							}
							if (event.key === 'Delete') {
								event.preventDefault();
								void remove(entry);
							}
						}}
					>
						<span className="tree-icon">
							{entry.type === 'dir' ? (directories[entry.path]?.open ? '▾' : '▸') : '·'}
						</span>
						<span className="tree-label">{entry.name}</span>
					</div>,
				);
				if (entry.type === 'dir') {
					rows.push(...renderDirectory(entry.path, depth + 1));
				}
			}
		}
		return rows;
	};

	const rootError = directories['']?.error;
	const rootLoading = directories['']?.loading;

	return (
		<div className="file-tree" role="tree" onContextMenu={event => openMenu(event, '')}>
			<div className="tree-search">
				<input
					value={query}
					onChange={event => setQuery(event.target.value)}
					onKeyDown={event => {
						// Enter opens the best match; Esc goes back to the tree.
						if (event.key === 'Enter' && results.length > 0) {
							onOpenFile(results[0]!);
						}
						if (event.key === 'Escape') {
							setQuery('');
						}
					}}
					placeholder="搜索文件"
					spellCheck={false}
				/>
			</div>
			{trimmedQuery === ''
				? (
					<>
						{rootLoading && <div className="tree-hint">loading…</div>}
						{rootError && <div className="tree-hint error">{rootError}</div>}
						{actionError && <div className="tree-hint error">{actionError}</div>}
						{renderDirectory('', 0)}
					</>
				)
				: (
					<>
						{searching && <div className="tree-hint">搜索中…</div>}
						{!searching && results.length === 0 && <div className="tree-hint">没有匹配「{trimmedQuery}」的文件</div>}
						{results.map(filePath => (
							<div
								key={filePath}
								className={`tree-row${filePath === selectedPath ? ' selected' : ''}`}
								style={{ paddingLeft: 8 }}
								title={filePath}
								onClick={() => onOpenFile(filePath)}
								role="treeitem"
								tabIndex={0}
								onKeyDown={event => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										onOpenFile(filePath);
									}
								}}
							>
								<span className="tree-icon">·</span>
								<span className="tree-label">{filePath}</span>
							</div>
						))}
					</>
				)}
			{menu && (
				<div
					className="tree-menu"
					style={{ left: menu.x, top: menu.y }}
					onClick={event => event.stopPropagation()}
					onContextMenu={event => event.preventDefault()}
				>
					<button type="button" onClick={() => startCreate(menu.directory, 'file')}>新建文件</button>
					<button type="button" onClick={() => startCreate(menu.directory, 'dir')}>新建文件夹</button>
					{menu.entry && (
						<>
							<div className="tree-menu-sep" />
							<button
								type="button"
								className="danger"
								onClick={() => {
									if (menu.entry) {
										void remove(menu.entry);
									}
								}}
							>
								删除「{menu.entry.name}」
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
