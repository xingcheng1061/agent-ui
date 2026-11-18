import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { createEntry, deleteEntry, downloadFileUrl, listDirectory, renameEntry, searchEntries, uploadFile, type FileEntry } from '../api';
import { t } from '../i18n';
import { readExpandedDirs, writeExpandedDirs } from './workspaceState';

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

/** One file on its way to disk, with the path it should take in its directory. */
interface UploadItem {
	readonly file: File;
	readonly name: string;
}

/** A drag that carries files, as opposed to one dragging text or a row. */
function dragsFiles(event: DragEvent<HTMLElement>): boolean {
	return [...event.dataTransfer.types].includes('Files');
}

/**
 * Reads one dropped entry, descending into folders.
 *
 * `webkitGetAsEntry` is the only API that exposes a dropped folder as a tree —
 * `dataTransfer.files` flattens it to nothing — so a folder dragged from the
 * desktop keeps its shape, one upload per file.
 */
async function readDropEntry(entry: FileSystemEntry, prefix: string, out: UploadItem[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => {
			(entry as FileSystemFileEntry).file(resolve, reject);
		});
		out.push({ file, name: `${prefix}${entry.name}` });
		return;
	}
	if (!entry.isDirectory) {
		return;
	}
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	// `readEntries` answers a page at a time (about 100) and signals the end
	// with an empty batch, so it has to be driven in a loop.
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) {
			return;
		}
		for (const child of batch) {
			await readDropEntry(child, `${prefix}${entry.name}/`, out);
		}
	}
}

/** Everything a drop carries, folders flattened into relative names. */
async function droppedItems(transfer: DataTransfer): Promise<UploadItem[]> {
	const entries = [...transfer.items]
		.filter(item => item.kind === 'file')
		.map(item => item.webkitGetAsEntry?.() ?? null)
		.filter((entry): entry is FileSystemEntry => entry !== null);
	if (entries.length === 0) {
		return [...transfer.files].map(file => ({ file, name: file.name }));
	}
	const out: UploadItem[] = [];
	for (const entry of entries) {
		await readDropEntry(entry, '', out);
	}
	return out;
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
	/**
	 * Seeded from storage: the directories that were open come back, marked
	 * loading. The panel is remounted on every project switch and every reload,
	 * so the tree used to collapse to the top level while the open file was still
	 * remembered — the two halves of "where I was" disagreed.
	 */
	const [directories, setDirectories] = useState<Record<string, DirectoryState>>(() => {
		const restored: Record<string, DirectoryState> = {};
		for (const directory of readExpandedDirs(root)) {
			restored[directory] = { open: true, loading: true };
		}
		return restored;
	});
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
	/** The walk hit its budget: the list below is not the whole answer. */
	const [truncated, setTruncated] = useState(false);
	/** Upload progress: how many of `total` files have been written. */
	const [uploading, setUploading] = useState<{ done: number; total: number } | undefined>(undefined);
	/** Directory highlighted under a drag: `''` is the project root. */
	const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);
	const trimmedQuery = query.trim();
	/**
	 * The query the tree is actually searched for.
	 *
	 * Separate from `query` because the walk is a real filesystem traversal: it
	 * must run when the user says so, not on every keystroke of a half-typed
	 * path. See `submitSearch`.
	 */
	const [submitted, setSubmitted] = useState('');

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

	// First paint: the root plus whatever was expanded last time.
	useEffect(() => {
		const open = Object.keys(directories).filter(directory => directories[directory]?.open);
		if (open.length === 0) {
			void load('');
			return;
		}
		for (const directory of open) {
			void load(directory);
		}
		// Mount only: later reads are driven by clicks and `reloadToken`.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [load]);

	// Remembered so coming back to this project shows the same tree.
	useEffect(() => {
		writeExpandedDirs(root, Object.keys(directories).filter(directory => directories[directory]?.open));
	}, [directories, root]);

	// A file opened from elsewhere (chat, terminal, the remembered tab) has to
	// have its folders expanded, or the highlight sits inside a closed branch.
	useEffect(() => {
		if (!selectedPath) {
			return;
		}
		const missing: string[] = [];
		let directory = parentOf(selectedPath);
		while (directory !== '' && !directories[directory]?.open) {
			missing.unshift(directory);
			directory = parentOf(directory);
		}
		for (const path of missing) {
			void load(path);
		}
		// `directories` is deliberately not a dependency: this runs when the
		// selection changes, and loading flips those entries itself.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedPath, root]);

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
		if (submitted === '') {
			setResults([]);
			setDirResults([]);
			setTruncated(false);
			setSearching(false);
			return;
		}
		let cancelled = false;
		setSearching(true);
		searchEntries(root, submitted, true)
			.then(result => {
				if (!cancelled) {
					setResults(result.files);
					setDirResults(result.dirs);
					setTruncated(result.truncated === true);
					setSearching(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setResults([]);
					setDirResults([]);
					setTruncated(false);
					setSearching(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [submitted, root]);

	/**
	 * Searches for what is in the box right now.
	 *
	 * Deliberately not tied to `onChange`: each search is a bounded but real
	 * directory walk, and firing it per keystroke spends disk on prefixes nobody
	 * asked about ("cpp", "cpp-", "cpp-d"). Enter and the button are the two
	 * ways in, and pressing Enter again on an unchanged query opens the best hit.
	 */
	const submitSearch = () => {
		setSubmitted(trimmedQuery);
	};

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

	/** Writes one file, asking before it replaces a file that is already there. */
	const uploadOne = async (directory: string, item: UploadItem): Promise<void> => {
		const target = directory === '' ? item.name : `${directory}/${item.name}`;
		try {
			await uploadFile(root, target, item.file);
		} catch (error) {
			if ((error as { status?: number }).status !== 409) {
				throw error;
			}
			if (!window.confirm(t('「{path}」已存在，覆盖吗？', { path: target }))) {
				return;
			}
			await uploadFile(root, target, item.file, true);
		}
	};

	/** Uploads a batch into one directory, then re-reads what is on screen. */
	const uploadInto = async (directory: string, items: readonly UploadItem[]): Promise<void> => {
		if (items.length === 0) {
			return;
		}
		setActionError(undefined);
		setUploading({ done: 0, total: items.length });
		let done = 0;
		try {
			for (const item of items) {
				await uploadOne(directory, item);
				done += 1;
				setUploading({ done, total: items.length });
			}
		} catch (error) {
			setActionError(String(error));
		} finally {
			setUploading(undefined);
			// Files that did land are on disk either way, and a dropped folder may
			// have created directories that were not open yet.
			await load(directory).catch(() => undefined);
		}
	};

	/** The menu's upload entries: a file picker, optionally for a whole folder. */
	const pickUpload = (directory: string, folder: boolean) => {
		setMenu(undefined);
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = !folder;
		if (folder) {
			// Non-standard, but every browser that can drop a folder has it.
			input.webkitdirectory = true;
		}
		input.addEventListener('change', () => {
			const items = [...(input.files ?? [])].map(file => ({
				file,
				// A folder pick reports the entire path in `webkitRelativePath`.
				name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
			}));
			void uploadInto(directory, items);
		});
		input.click();
	};

	/** Download is a navigation: the browser owns the save dialog and progress. */
	const download = (entry: FileEntry) => {
		setMenu(undefined);
		const link = document.createElement('a');
		link.href = downloadFileUrl(root, entry.path);
		link.download = entry.name;
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	/** A drop on a folder row, or on the empty space, which is the root. */
	const dropOn = (directory: string) => (event: DragEvent<HTMLDivElement>) => {
		if (!dragsFiles(event)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setDropTarget(undefined);
		void droppedItems(event.dataTransfer).then(items => uploadInto(directory, items));
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
				/** The folder this row stands for when something is dropped on it. */
				const dropDir = entry.type === 'dir' ? entry.path : parentOf(entry.path);
				const isDropTarget = entry.type === 'dir' && dropTarget === entry.path;
				rows.push(
					<div
						key={entry.path}
						className={`tree-row${isSelected ? ' selected' : ''}${isDropTarget ? ' drop-target' : ''}`}
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
						// A row is a drop target for its own folder: the folder itself
						// for a directory, the one containing it for a file — so a file
						// dropped next to another lands beside it, not at the root.
						onDragOver={event => {
							if (!dragsFiles(event)) {
								return;
							}
							event.preventDefault();
							event.stopPropagation();
							event.dataTransfer.dropEffect = 'copy';
							setDropTarget(dropDir);
						}}
						onDragLeave={event => {
							event.stopPropagation();
							setDropTarget(current => (current === dropDir ? undefined : current));
						}}
						onDrop={dropOn(dropDir)}
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
		<div
			className={`file-tree${dropTarget === '' ? ' drop-target' : ''}`}
			role="tree"
			onContextMenu={event => openMenu(event, '')}
			// Dropping on the empty space files into the project root; a folder row
			// handles its own drop and stops the event before it gets here.
			onDragOver={event => {
				if (!dragsFiles(event)) {
					return;
				}
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
				setDropTarget(current => current ?? '');
			}}
			onDragLeave={event => {
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
					return;
				}
				setDropTarget(undefined);
			}}
			onDrop={dropOn('')}
		>
			<div className="tree-search">
				<input
					value={query}
					onChange={event => {
						const next = event.target.value;
						setQuery(next);
						// An empty box leaves search mode at once: showing hits for a
						// query that is no longer on screen reads as a bug.
						if (next.trim() === '') {
							setSubmitted('');
						}
					}}
					onKeyDown={event => {
						if (event.key === 'Enter') {
							event.preventDefault();
							// The first Enter searches; a second one on an unchanged query
							// takes the best hit — a directory expands, a file opens.
							if (trimmedQuery !== submitted) {
								submitSearch();
								return;
							}
							if (dirResults.length > 0) {
								void revealDirectory(dirResults[0]!);
							} else if (results.length > 0) {
								onOpenFile(results[0]!);
							}
						}
						if (event.key === 'Escape') {
							setQuery('');
							setSubmitted('');
						}
					}}
					placeholder={t('搜索文件或目录，回车')}
					spellCheck={false}
				/>
				<button
					type="button"
					className="tree-search-go"
					title={t('搜索（回车）')}
					onClick={submitSearch}
				>
					<svg
						viewBox="0 0 14 14"
						width="12"
						height="12"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="6" cy="6" r="4" />
						<path d="M9 9l3 3" />
					</svg>
				</button>
			</div>
			{uploading && (
				<div className="tree-hint">
					{t('正在上传 {done}/{total}…', { done: uploading.done, total: uploading.total })}
				</div>
			)}
			{submitted === ''
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
							<div className="tree-hint">{t('没有匹配「{query}」的文件或目录', { query: submitted })}</div>
						)}
						{!searching && truncated && (results.length > 0 || dirResults.length > 0) && (
							<div className="tree-hint">
								{t('结果不完整，只列出了前 {count} 项（目录太大或路径太深）', { count: results.length + dirResults.length })}
							</div>
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
					{/* Upload lands in the folder whose menu this is: the row's own
					    folder for a file, the folder itself for a directory. */}
					<button type="button" onClick={() => pickUpload(menu.directory, false)}>{t('上传文件…')}</button>
					<button type="button" onClick={() => pickUpload(menu.directory, true)}>{t('上传文件夹…')}</button>
					{menu.entry && (
						<>
							<div className="tree-menu-sep" />
							<button type="button" onClick={() => startRename(menu.entry!)}>{t('重命名「{name}」', { name: menu.entry.name })}</button>
							<button type="button" onClick={() => { void copyText(menu.entry!.name); setMenu(undefined); }}>{t('复制文件名')}</button>
							<button type="button" onClick={() => { void copyText(menu.entry!.path); setMenu(undefined); }}>{t('复制路径')}</button>
							{menu.entry.type === 'file' && (
								<button type="button" onClick={() => download(menu.entry!)}>{t('下载「{name}」', { name: menu.entry.name })}</button>
							)}
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
