import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createEntry, deleteEntry, listDirectory, renameEntry, searchEntries, type FileEntry } from '../api';
import { t } from '../i18n';

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
	/** Called after a rename so open tabs can follow the file. */
	readonly onPathRenamed?: (from: string, to: string) => void;
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
 * Writes to the clipboard from a click handler.
 *
 * The async API needs a secure context (https or localhost); this workbench is
 * commonly served over plain http on a LAN, where `navigator.clipboard` is
 * missing. The textarea fallback is the only thing that works there.
 */
async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement('textarea');
		area.value = text;
		area.style.position = 'fixed';
		area.style.top = '-1000px';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		document.execCommand('copy');
		area.remove();
	}
}

/**
 * The project's files, one directory at a time.
 *
 * New file / new folder / delete live on a context menu, as in VS Code: the tree
 * is a dense list of clickable rows, and permanent actions do not belong on
 * something a stray click hits.
 */
export function FileTree({ root, selectedPath, onOpenFile, onPathDeleted, onPathRenamed, reloadToken = 0 }: FileTreeProps) {
	const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
	/** Right-click menu: where it opened, and on what (nothing = empty space). */
	const [menu, setMenu] = useState<{ x: number; y: number; directory: string; entry?: FileEntry } | undefined>(undefined);
	/**
	 * The inline name input, one at a time, like VS Code's explorer. A rename
	 * reuses it with `rename` set, so both actions share the validation and the
	 * Enter/Escape handling.
	 */
	const [draft, setDraft] = useState<{ directory: string; type: 'file' | 'dir'; rename?: FileEntry } | undefined>(undefined);
	const [draftName, setDraftName] = useState('');
	const [actionError, setActionError] = useState<string | undefined>(undefined);
	/** Filter box: a flat list of matches instead of the tree. */
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<readonly string[]>([]);
	const [dirResults, setDirResults] = useState<readonly string[]>([]);
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
			setDirResults([]);
			setSearching(false);
			return;
		}
		let cancelled = false;
		setSearching(true);
		const timer = window.setTimeout(() => {
			searchEntries(root, trimmedQuery)
				.then(result => {
					if (!cancelled) {
						setResults(result.files);
						setDirResults(result.dirs);
						setSearching(false);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setResults([]);
						setDirResults([]);
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

	const startRename = (entry: FileEntry) => {
		setMenu(undefined);
		setActionError(undefined);
		setDraft({ directory: parentOf(entry.path), type: entry.type, rename: entry });
		setDraftName(entry.name);
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
		const parent = target.rename ? parentOf(target.rename.path) : target.directory;
		const nextPath = parent ? `${parent}/${name}` : name;
		try {
			if (target.rename) {
				if (nextPath === target.rename.path) {
					setDraft(undefined);
					return;
				}
				await renameEntry(root, target.rename.path, nextPath);
				setDraft(undefined);
				setDraftName('');
				// The pane keeps its tab on the old path otherwise, and the
				// editor would reopen a file that no longer exists.
				onPathRenamed?.(target.rename.path, nextPath);
				await load(parent);
				return;
			}
			await createEntry(root, nextPath, target.type);
			setDraft(undefined);
			setDraftName('');
			await load(parent);
			if (target.type === 'file') {
				onOpenFile(nextPath);
			}
		} catch (error) {
			setActionError(String(error));
		}
	};

	/**
	 * Expands every ancestor of a directory found by search, so the tree shows
	 * where it lives instead of clearing the query into nothing.
	 */
	const revealDirectory = async (directory: string) => {
		setQuery('');
		let current = '';
		for (const segment of directory.split('/')) {
			current = current ? `${current}/${segment}` : segment;
			await load(current);
		}
	};

	const remove = async (entry: FileEntry) => {
		setMenu(undefined);
		const what = entry.type === 'dir' ? t('目录及其中的内容') : t('文件');
		if (!window.confirm(t('删除{what}「{name}」？此操作不可撤销。', { what, name: entry.name }))) {
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

	const draftRow = (key: string, depth: number, icon: string, placeholder: string) => (
		<div className="tree-row" key={key} style={{ paddingLeft: 8 + depth * 12 }}>
			<span className="tree-icon">{icon}</span>
			<input
				className="tree-input"
				autoFocus
				value={draftName}
				placeholder={placeholder}
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
		</div>
	);

	const renderDirectory = (directory: string, depth: number): JSX.Element[] => {
		const state = directories[directory];
		const rows: JSX.Element[] = [];
		// A create input sits at the top of its directory; a rename input takes
		// the place of the row it renames (inside the loop below).
		if (draft?.directory === directory && !draft.rename) {
			rows.push(draftRow(
				`draft:${directory}`,
				depth,
				draft.type === 'dir' ? '▸' : '·',
				draft.type === 'dir' ? t('新目录名') : t('新文件名'),
			));
		}
		if (state?.open && state.entries) {
			for (const entry of state.entries) {
				if (draft?.rename?.path === entry.path) {
					// While a directory is being renamed its children stay hidden:
					// every path under it is about to change.
					rows.push(draftRow(`rename:${entry.path}`, depth, entry.type === 'dir' ? '▸' : '·', t('新名称')));
					continue;
				}
				const isSelected = entry.type === 'file' && entry.path === selectedPath;
				rows.push(
					<div
						key={entry.path}
						className={`tree-row${isSelected ? ' selected' : ''}`}
						style={{ paddingLeft: 8 + depth * 12 }}
						onClick={() => {
							// Dragging across a name is a copy gesture; opening the file
							// under the mouse would make it impossible to finish.
							if (window.getSelection()?.toString()) {
								return;
							}
							toggle(entry);
						}}
						onContextMenu={event => openMenu(event, entry.type === 'dir' ? entry.path : parentOf(entry.path), entry)}
						role="treeitem"
						aria-expanded={entry.type === 'dir' ? Boolean(directories[entry.path]?.open) : undefined}
						tabIndex={0}
						onKeyDown={event => {
							if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
								event.preventDefault();
								void copyText(entry.path);
								return;
							}
							// F2 is what the explorer uses for rename.
							if (event.key === 'F2') {
								event.preventDefault();
								startRename(entry);
								return;
							}
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
						// Enter takes the best match: a directory expands, a file opens.
						if (event.key === 'Enter') {
							if (dirResults.length > 0) {
								void revealDirectory(dirResults[0]!);
							} else if (results.length > 0) {
								onOpenFile(results[0]!);
							}
						}
						if (event.key === 'Escape') {
							setQuery('');
						}
					}}
					placeholder={t('搜索文件')}
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
						{searching && <div className="tree-hint">{t('搜索中…')}</div>}
						{!searching && results.length === 0 && dirResults.length === 0 && (
							<div className="tree-hint">{t('没有匹配「{query}」的文件或目录', { query: trimmedQuery })}</div>
						)}
						{dirResults.map(dirPath => (
							<div
								key={`dir:${dirPath}`}
								className="tree-row"
								style={{ paddingLeft: 8 }}
								title={dirPath}
								onClick={() => {
									if (!window.getSelection()?.toString()) {
										void revealDirectory(dirPath);
									}
								}}
								role="treeitem"
								tabIndex={0}
								onKeyDown={event => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										void revealDirectory(dirPath);
									}
								}}
							>
								<span className="tree-icon">▸</span>
								<span className="tree-label">{dirPath}/</span>
							</div>
						))}
						{results.map(filePath => (
							<div
								key={filePath}
								className={`tree-row${filePath === selectedPath ? ' selected' : ''}`}
								style={{ paddingLeft: 8 }}
								title={filePath}
								onClick={() => {
									if (window.getSelection()?.toString()) {
										return;
									}
									onOpenFile(filePath);
								}}
								onContextMenu={event => openMenu(event, parentOf(filePath), {
									name: filePath.split('/').pop() ?? filePath,
									path: filePath,
									type: 'file',
								})}
								role="treeitem"
								tabIndex={0}
								onKeyDown={event => {
									if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
										event.preventDefault();
										void copyText(filePath);
										return;
									}
									if (event.key === 'F2') {
										event.preventDefault();
										startRename({
											name: filePath.split('/').pop() ?? filePath,
											path: filePath,
											type: 'file',
										});
										return;
									}
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
					<button type="button" onClick={() => startCreate(menu.directory, 'file')}>{t('新建文件')}</button>
					<button type="button" onClick={() => startCreate(menu.directory, 'dir')}>{t('新建文件夹')}</button>
					{menu.entry && (
						<>
							<div className="tree-menu-sep" />
							<button type="button" onClick={() => startRename(menu.entry!)}>{t('重命名「{name}」', { name: menu.entry.name })}</button>
							<button type="button" onClick={() => { void copyText(menu.entry!.name); setMenu(undefined); }}>{t('复制文件名')}</button>
							<button type="button" onClick={() => { void copyText(menu.entry!.path); setMenu(undefined); }}>{t('复制路径')}</button>
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
								{t('删除「{name}」', { name: menu.entry.name })}
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
