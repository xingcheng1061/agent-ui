import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { closeTerminal, createTerminal, listTerminals, readFile, renameTerminal, type ProjectInfo, type TerminalInfo } from '../api';
import { ChangesList } from './ChangesList';
import { DiffView } from './DiffView';
import { Editor } from './Editor';
import { FileTree } from './FileTree';
import { Splitter, clamp, usePersistedSize } from './Splitter';
import { TerminalView } from './Terminal';
import { forgetTerminalSession } from './terminalSessions';
import { relativeToRoot, type TerminalTarget } from './terminalPaths';
import { readLeftTab, readOpenFile, writeLeftTab, writeOpenFile } from './workspaceState';

interface WorkspaceProps {
	readonly root: string;
	/** Every known project: a terminal link may point outside this one. */
	readonly projects: readonly ProjectInfo[];
	/** Incremented when an agent turn ends, so git state is refetched. */
	readonly revision: number;
}

/** The file on screen, and the project it belongs to. */
interface OpenFile {
	readonly root: string;
	readonly path: string;
	readonly line?: number;
	readonly column?: number;
}

/** The terminal a project lands on when nothing was remembered. */
const PREFERRED_TERMINAL_KEY = 'agentui.terminal.active';

/**
 * Terminal records are keyed by the root the server resolved, while the
 * workspace root arrives from a session cwd or the project picker: same folder,
 * different separator, trailing slash or drive-letter case.
 *
 * Comparing them with `===` made every reload look like "all my terminals
 * vanished" — the filter matched nothing, a fresh shell was created, and each
 * reload leaked one more orphaned terminal on the server.
 */
function sameRoot(left: string, right: string): boolean {
	const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
	const a = normalize(left);
	const b = normalize(right);
	if (a === b) {
		return true;
	}
	// Windows drive letters vary in case; POSIX paths are case-sensitive.
	return /^[a-zA-Z]:\//.test(a) && a.toLowerCase() === b.toLowerCase();
}

function baseName(root: string): string {
	const parts = root.split(/[\\/]/).filter(part => part.length > 0);
	return parts.length > 0 ? parts[parts.length - 1]! : root;
}

/**
 * Code side of a session: everything here is scoped to the session's project root.
 * Mount it with `key={root}` so switching project resets selection and terminal.
 */
export function Workspace({ root, projects, revision }: WorkspaceProps) {
	const [leftTab, setLeftTab] = useState<'files' | 'changes'>(() => readLeftTab(root));
	const [opened, setOpened] = useState<OpenFile | undefined>(undefined);
	const [diffPath, setDiffPath] = useState<string | undefined>(undefined);
	const [changeCount, setChangeCount] = useState(0);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState('');
	const [terminalOpen, setTerminalOpen] = useState(true);
	/** Rendered view of the open markdown file, as opposed to its source. */
	const [preview, setPreview] = useState(false);
	/** Bumped to make the editor re-read the open file from disk. */
	const [reloadToken, setReloadToken] = useState(0);
	/** Read by effects that must not re-run when the dirty flag flips. */
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	const openedRef = useRef(opened);
	openedRef.current = opened;

	/** Only a file from this project highlights in the tree. */
	const selectedFile = opened && sameRoot(opened.root, root) ? opened.path : undefined;
	/** Stable per open, or the jump effect in the editor would re-run forever. */
	const reveal = useMemo(
		() => (opened?.line === undefined ? undefined : { line: opened.line, column: opened.column }),
		[opened],
	);

	useEffect(() => {
		writeLeftTab(root, leftTab);
	}, [root, leftTab]);

	// Reopen whatever this project had open. The panel is keyed by root, so the
	// selection used to be lost on every switch and every reload.
	useEffect(() => {
		const remembered = readOpenFile(root);
		if (!remembered) {
			return;
		}
		let cancelled = false;
		void readFile(root, remembered)
			.then(() => {
				if (!cancelled) {
					setOpened({ root, path: remembered });
				}
			})
			.catch(() => {
				// Gone since: forget it instead of opening an error tab.
				writeOpenFile(root, undefined);
			});
		return () => {
			cancelled = true;
		};
	}, [root]);

	// A finished turn may have rewritten the open file, and Monaco only sees the
	// disk through this token. Unsaved edits win over the agent's version.
	const firstRevisionRef = useRef(true);
	useEffect(() => {
		if (firstRevisionRef.current) {
			firstRevisionRef.current = false;
			return;
		}
		if (!openedRef.current || dirtyRef.current) {
			return;
		}
		setReloadToken(value => value + 1);
	}, [revision]);

	/**
	 * The tree loads a directory once, so a file the agent just created stayed
	 * invisible until the project was remounted. Bumped on every finished turn,
	 * and by the refresh button for the cases nobody signals.
	 */
	const [treeReload, setTreeReload] = useState(0);
	const treeRevisionRef = useRef(revision);
	useEffect(() => {
		if (treeRevisionRef.current === revision) {
			return;
		}
		treeRevisionRef.current = revision;
		setTreeReload(value => value + 1);
	}, [revision]);

	const reloadFile = () => {
		const target = openedRef.current;
		if (!target) {
			return;
		}
		if (dirtyRef.current && !window.confirm(`编辑器里有未保存的修改，重新加载会丢弃它们。\n\n${target.path}`)) {
			return;
		}
		setReloadToken(value => value + 1);
	};

	// Terminals are server-side objects, so this list survives a reload and the
	// shells keep running while their tab is closed.
	const [terminals, setTerminals] = useState<readonly TerminalInfo[]>([]);
	const [activeTerminal, setActiveTerminal] = useState<string | undefined>(undefined);

	const [treeWidth, setTreeWidth] = usePersistedSize('agentui.size.tree', 220);
	const [terminalHeight, setTerminalHeight] = usePersistedSize('agentui.size.terminal', 240);

	const reloadTerminals = useCallback(async () => {
		// Scoped to this project: the server remembers terminals of every root.
		const list = (await listTerminals()).filter(candidate => sameRoot(candidate.root, root));
		setTerminals(list);
		setActiveTerminal(current => {
			if (current && list.some(candidate => candidate.id === current)) {
				return current;
			}
			return list[0]?.id;
		});
	}, [root]);

	// First terminal for a project is created on demand; after that the list is
	// whatever the server holds.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const existing = await listTerminals();
			const remembered = localStorage.getItem(PREFERRED_TERMINAL_KEY) ?? undefined;
			if (cancelled) {
				return;
			}
			const usable = existing.filter(candidate => sameRoot(candidate.root, root));
			if (usable.length > 0) {
				setTerminals(usable);
				setActiveTerminal(usable.some(candidate => candidate.id === remembered) ? remembered : usable[0]!.id);
				return;
			}
			const created = await createTerminal(root);
			if (cancelled) {
				return;
			}
			setTerminals([created]);
			setActiveTerminal(created.id);
		})();
		return () => {
			cancelled = true;
		};
	}, [root]);

	useEffect(() => {
		if (activeTerminal) {
			localStorage.setItem(PREFERRED_TERMINAL_KEY, activeTerminal);
		}
	}, [activeTerminal]);

	const addTerminal = async () => {
		const created = await createTerminal(root);
		setTerminals(previous => [...previous, created]);
		setActiveTerminal(created.id);
	};

	const removeTerminal = async (id: string) => {
		await closeTerminal(id);
		// Closing a tab is the one case that really ends a screen: without this,
		// the pool would keep reconnecting to a terminal the server no longer has.
		forgetTerminalSession(id);
		await reloadTerminals();
	};

	const active = terminals.find(candidate => candidate.id === activeTerminal);
	const previewable = opened !== undefined && /\.(md|markdown)$/i.test(opened.path);

	/** Opens a file in the pane; `target.root` is not always this project. */
	const openFileFrom = (target: OpenFile) => {
		setOpened(target);
		setDiffPath(undefined);
		// Another file starts as source; the toggle is per file.
		setPreview(false);
		// Only a file of this project can be the one remembered for it.
		writeOpenFile(root, sameRoot(target.root, root) ? target.path : undefined);
	};

	/**
	 * A path clicked in the terminal.
	 *
	 * The screen prints whatever it likes — `ls` two directories up, an absolute
	 * path from another checkout — and the server only reads files under a known
	 * project, so the owning project has to be found before anything is opened.
	 */
	const openFromTerminal = (target: TerminalTarget) => {
		const owner = projects
			.map(project => project.cwd)
			.filter(candidate => relativeToRoot(candidate, target.path) !== undefined)
			// Nested projects: the deepest root containing the file wins.
			.sort((left, right) => right.length - left.length)[0];
		const relative = owner === undefined ? undefined : relativeToRoot(owner, target.path);
		if (owner === undefined || relative === undefined || relative === '') {
			setStatus(`不在任何已打开的项目里：${target.path}`);
			return;
		}
		openFileFrom({ root: owner, path: relative, line: target.line, column: target.column });
	};

	return (
		<div className="workspace" style={{ gridTemplateColumns: `${treeWidth}px 5px 1fr` }}>
			<aside className="file-pane">
				<div className="pane-tabs">
					<button
						type="button"
						className={`pane-tab${leftTab === 'files' ? ' active' : ''}`}
						onClick={() => setLeftTab('files')}
					>文件</button>
					<button
						type="button"
						className={`pane-tab${leftTab === 'changes' ? ' active' : ''}`}
						onClick={() => setLeftTab('changes')}
					>变更{changeCount > 0 ? ` ${changeCount}` : ''}</button>
					<button
						type="button"
						className="pane-tab icon"
						title="重新读取文件列表（agent 新建的文件会在每轮结束时自动出现）"
						onClick={() => setTreeReload(value => value + 1)}
					>↻</button>
				</div>

				{leftTab === 'files'
					? (
						<FileTree
							root={root}
							selectedPath={selectedFile}
							reloadToken={treeReload}
							onOpenFile={filePath => openFileFrom({ root, path: filePath })}
							onPathDeleted={deletedPath => {
								// The open file may be the deleted one, or live inside a
								// deleted directory: either way the tab has nothing to show.
								const current = openedRef.current;
								if (current && sameRoot(current.root, root)
									&& (current.path === deletedPath || current.path.startsWith(`${deletedPath}/`))) {
									setOpened(undefined);
									writeOpenFile(root, undefined);
								}
								if (diffPath === deletedPath || diffPath?.startsWith(`${deletedPath}/`)) {
									setDiffPath(undefined);
								}
							}}
						/>
					)
					: (
						<ChangesList
							root={root}
							activePath={diffPath}
							revision={revision}
							onCountChange={setChangeCount}
							onSelect={filePath => {
								setDiffPath(filePath);
								setOpened(undefined);
								// A diff is not a file to reopen: only a real editor tab is.
								writeOpenFile(root, undefined);
							}}
						/>
					)}
			</aside>

			<Splitter axis="x" onResize={delta => setTreeWidth(clamp(treeWidth + delta, 120, 520))} />

			<div className="code-pane">
				<div className="tabbar">
					{diffPath
						? <span className="tab">diff · {diffPath}</span>
						: opened
							? (
								<span className="tab">
									{sameRoot(opened.root, root) ? opened.path : `${baseName(opened.root)}/${opened.path}`}
									{dirty ? ' ●' : ''}
								</span>
							)
							: <span className="tab empty">选择左侧文件，或看"变更"</span>}
					<span className="spacer" />
					<span className={`status${status.startsWith('saved') ? ' ok' : ''}`}>{status}</span>
					{diffPath && <button type="button" className="toggle" onClick={() => setDiffPath(undefined)}>关闭 diff</button>}
					{opened && !diffPath && (
						<button
							type="button"
							className="toggle"
							title="从磁盘重新读取该文件（agent 改过会自动重载；有未保存修改时会先确认）"
							onClick={reloadFile}
						>
							重新加载
						</button>
					)}
					{previewable && (
						<button
							type="button"
							className={`toggle${preview ? ' active' : ''}`}
							title="渲染 Markdown，mermaid 代码块会画成图"
							onClick={() => setPreview(value => !value)}
						>
							{preview ? '源码' : '预览'}
						</button>
					)}
					<button type="button" className="toggle" onClick={() => setTerminalOpen(open => !open)}>
						{terminalOpen ? '隐藏终端' : '显示终端'}
					</button>
				</div>

				{diffPath
					? <DiffView root={root} filePath={diffPath} revision={revision} />
					: opened
						? (
							<Editor
								root={opened.root}
								filePath={opened.path}
								preview={preview && previewable}
								reloadToken={reloadToken}
								reveal={reveal}
								onDirtyChange={setDirty}
								onStatus={setStatus}
							/>
						)
						: <div className="placeholder">Ctrl+S 保存 · 终端在该项目根目录启动</div>}
			</div>

			{/*
			 * Deliberately outside `.code-pane`: the panel is a row of the workspace
			 * grid spanning all three columns, so the shell runs edge to edge under
			 * the file tree instead of stopping at the editor's left border. The
			 * session rail is a sibling of this grid and stays clear.
			 */}
			{terminalOpen && (
				<>
					<Splitter axis="y" onResize={delta => setTerminalHeight(clamp(terminalHeight - delta, 100, 720))} />
					<section className="terminal-panel" style={{ height: terminalHeight }}>
						<div className="terminal-tabs">
							{terminals.map(candidate => (
								<button
									type="button"
									key={candidate.id}
									className={`terminal-tab${candidate.id === activeTerminal ? ' active' : ''}`}
									onClick={() => setActiveTerminal(candidate.id)}
									onDoubleClick={() => {
										const next = window.prompt('终端名称', candidate.title);
										if (next && next.trim()) {
											void renameTerminal(candidate.id, next).then(updated => {
												if (updated) {
													void reloadTerminals();
												}
											});
										}
									}}
									title={`${candidate.title}\n${candidate.root}\n双击重命名`}
								>
									{candidate.title}
									<span
										className="terminal-tab-close"
										role="button"
										tabIndex={-1}
										onClick={event => {
											// Nested inside the tab button: stop the switch.
											event.stopPropagation();
											void removeTerminal(candidate.id);
										}}
									>×</span>
								</button>
							))}
							<button type="button" className="terminal-tab add" onClick={() => void addTerminal()} title="新建终端">+</button>
							<span className="spacer" />
							<span className="terminal-path">{active?.root ?? root}</span>
						</div>
						{activeTerminal && (
							<TerminalView
								key={activeTerminal}
								terminalId={activeTerminal}
								root={root}
								onOpenTarget={openFromTerminal}
							/>
						)}
					</section>
				</>
			)}
		</div>
	);
}
