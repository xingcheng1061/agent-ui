import { useCallback, useEffect, useState } from 'react';
import { closeTerminal, createTerminal, listTerminals, renameTerminal, type TerminalInfo } from '../api';
import { ChangesList } from './ChangesList';
import { DiffView } from './DiffView';
import { Editor } from './Editor';
import { FileTree } from './FileTree';
import { Splitter, clamp, usePersistedSize } from './Splitter';
import { TerminalView } from './Terminal';
import { forgetTerminalSession } from './terminalSessions';

interface WorkspaceProps {
	readonly root: string;
	/** Incremented when an agent turn ends, so git state is refetched. */
	readonly revision: number;
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

/**
 * Code side of a session: everything here is scoped to the session's project root.
 * Mount it with `key={root}` so switching project resets selection and terminal.
 */
export function Workspace({ root, revision }: WorkspaceProps) {
	const [leftTab, setLeftTab] = useState<'files' | 'changes'>('files');
	const [selectedFile, setSelectedFile] = useState<string | undefined>(undefined);
	const [diffPath, setDiffPath] = useState<string | undefined>(undefined);
	const [changeCount, setChangeCount] = useState(0);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState('');
	const [terminalOpen, setTerminalOpen] = useState(true);
	/** Rendered view of the open markdown file, as opposed to its source. */
	const [preview, setPreview] = useState(false);

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
	const previewable = selectedFile !== undefined && /\.(md|markdown)$/i.test(selectedFile);

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
				</div>

				{leftTab === 'files'
					? (
						<FileTree
							root={root}
							selectedPath={selectedFile}
							onOpenFile={filePath => {
								setSelectedFile(filePath);
								setDiffPath(undefined);
								// Another file starts as source; the toggle is per file.
								setPreview(false);
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
								setSelectedFile(undefined);
							}}
						/>
					)}
			</aside>

			<Splitter axis="x" onResize={delta => setTreeWidth(clamp(treeWidth + delta, 120, 520))} />

			<div className="code-pane">
				<div className="tabbar">
					{diffPath
						? <span className="tab">diff · {diffPath}</span>
						: selectedFile
							? <span className="tab">{selectedFile}{dirty ? ' ●' : ''}</span>
							: <span className="tab empty">选择左侧文件，或看"变更"</span>}
					<span className="spacer" />
					<span className={`status${status.startsWith('saved') ? ' ok' : ''}`}>{status}</span>
					{diffPath && <button type="button" className="toggle" onClick={() => setDiffPath(undefined)}>关闭 diff</button>}
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
					: selectedFile
						? (
							<Editor
								root={root}
								filePath={selectedFile}
								preview={preview && previewable}
								onDirtyChange={setDirty}
								onStatus={setStatus}
							/>
						)
						: <div className="placeholder">Ctrl+S 保存 · 终端在该项目根目录启动</div>}

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
							{activeTerminal && <TerminalView key={activeTerminal} terminalId={activeTerminal} />}
						</section>
					</>
				)}
			</div>
		</div>
	);
}
