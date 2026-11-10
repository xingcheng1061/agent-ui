import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectInfo, SessionEntry } from '../api';
import { projectLabels } from '../projectNames';

interface SessionSidebarProps {
	readonly projects: readonly ProjectInfo[];
	readonly sessions: readonly SessionEntry[];
	readonly activeSessionId: string | undefined;
	readonly onSelectSession: (session: SessionEntry) => void;
	readonly onNewSession: () => void;
	/** Empty title restores the generated one; the rail never sends that. */
	readonly onRenameSession: (session: SessionEntry, title: string) => void;
	readonly onArchiveSession: (session: SessionEntry, archived: boolean) => void;
	readonly onDeleteSession: (session: SessionEntry) => void;
	/**
	 * Sessions with a process still running, mapped to whether a turn is being
	 * answered right now. The chat socket only knows the conversation it is
	 * attached to, so this comes from the server's run registry.
	 */
	readonly running?: ReadonlyMap<string, boolean>;
	/**
	 * Session id → the tool it is blocked on, waiting for the user's decision.
	 *
	 * Also server-side: an approval raised by a conversation this page is not
	 * attached to still has to be visible here, or it waits unnoticed.
	 */
	readonly approvals?: ReadonlyMap<string, string>;
}

const ALL = 'all';

/** Sessions first: one flat, time-ordered list; the project is a label on the row. */
export function SessionSidebar({
	projects,
	sessions,
	activeSessionId,
	onSelectSession,
	onNewSession,
	onRenameSession,
	onArchiveSession,
	onDeleteSession,
	running,
	approvals,
}: SessionSidebarProps) {
	const [filter, setFilter] = useState<string>(ALL);
	/**
	 * Archived conversations are hidden by default, not deleted: the CLI still
	 * has their transcript, and a restore must be one click away rather than an
	 * excursion into the filesystem.
	 */
	const [showArchived, setShowArchived] = useState(false);
	const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
	const [draftTitle, setDraftTitle] = useState('');
	const editorRef = useRef<HTMLInputElement | null>(null);
	// The pending edit, readable from the listeners below without re-binding
	// them on every keystroke.
	const renamingRef = useRef<SessionEntry | undefined>(undefined);
	const draftRef = useRef('');

	const commitRename = () => {
		const session = renamingRef.current;
		const next = draftRef.current.trim();
		renamingRef.current = undefined;
		setRenamingId(undefined);
		if (session && next && next !== session.title) {
			onRenameSession(session, next);
		}
	};

	/**
	 * Focus is granted on a later tick on purpose. The rename button is removed
	 * in the same commit that inserts the input, and the browser restores focus
	 * to the body afterwards — an `autoFocus` here lost focus (and the editor
	 * closed itself) about a quarter second after it opened.
	 */
	useEffect(() => {
		if (renamingId === undefined) {
			return;
		}
		const timer = window.setTimeout(() => {
			editorRef.current?.focus();
			editorRef.current?.select();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [renamingId]);

	/**
	 * Commits on a click outside the editor instead of on blur.
	 *
	 * Blur is not a reliable signal here: the browser can move focus on its own
	 * while the row re-renders, and treating that as "the user finished" closed
	 * the editor before anything could be typed.
	 */
	useEffect(() => {
		if (renamingId === undefined) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Node && editorRef.current?.contains(target)) {
				return;
			}
			commitRename();
		};
		document.addEventListener('mousedown', onMouseDown, true);
		return () => document.removeEventListener('mousedown', onMouseDown, true);
		// `commitRename` reads refs only, so the first closure stays correct.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [renamingId]);

	if (projects.length === 0) {
		return (
			<div className="session-rail">
				<div className="rail-empty">
					没有找到项目。跑一次 claude 会话后，它的项目会自动出现在这里；
					也可以设置 <code>AGENT_UI_ROOTS</code> 手动指定。
				</div>
			</div>
		);
	}

	const scoped = filter === ALL ? sessions : sessions.filter(session => session.projectId === filter);
	const activeSessions = scoped.filter(session => !session.archived);
	const archivedSessions = scoped.filter(session => session.archived);
	const archivedTotal = sessions.filter(session => session.archived).length;
	// Two checkouts can share a basename; the label carries the parent only then,
	// and the row's tooltip is the absolute path on top of that.
	const labels = useMemo(() => projectLabels(projects), [projects]);
	const projectById = useMemo(
		() => new Map(projects.map(project => [project.id, project] as const)),
		[projects],
	);
	const projectName = (projectId: string) => labels.get(projectId) ?? projectId;

	const beginRename = (session: SessionEntry) => {
		renamingRef.current = session;
		draftRef.current = session.title;
		setRenamingId(session.id);
		setDraftTitle(session.title);
	};

	const buckets = [
		...bucketize(activeSessions),
		...(showArchived && archivedSessions.length > 0
			? [{ label: `已归档（${archivedSessions.length}）`, sessions: archivedSessions }]
			: []),
	];

	return (
		<div className="session-rail">
			<div className="rail-toolbar">
				<button type="button" className="rail-new" onClick={onNewSession}>
					＋ 新建会话
				</button>
				<select
					className="rail-select"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					aria-label="按项目筛选"
				>
					<option value={ALL}>全部项目（{sessions.length}）</option>
					{projects.map(project => (
						<option key={project.id} value={project.id}>{labels.get(project.id) ?? project.name}（{project.sessionCount}）</option>
					))}
				</select>
				<label className="rail-check" title="归档的会话仍保留记录，只是默认不在这里列出">
					<input
						type="checkbox"
						checked={showArchived}
						onChange={event => setShowArchived(event.target.checked)}
					/>
					显示已归档{archivedTotal > 0 ? `（${archivedTotal}）` : ''}
				</label>
			</div>

			{/*
			 * The list scrolls on its own. A sticky toolbar overlapped the first
			 * row — clicks landed on the toolbar instead of the conversation —
			 * so the toolbar and the scroll area are siblings now.
			 */}
			<div className="rail-list">
				{activeSessions.length === 0 && !showArchived && <div className="rail-empty">这个项目还没有会话</div>}
				{buckets.map(bucket => (
					<div key={bucket.label}>
						<div className="bucket-title">{bucket.label}</div>
						{bucket.sessions.map(session => {
							const live = running?.get(session.id);
							const pendingTool = approvals?.get(session.id);
							const renaming = renamingId === session.id;
							return (
								<div
									key={session.id}
									className={`session-row${session.id === activeSessionId ? ' active' : ''}${session.archived ? ' archived' : ''}`}
									// The whole row selects, not only the label: a click in the
									// empty area to the right used to do nothing.
									onClick={() => onSelectSession(session)}
									onDoubleClick={() => beginRename(session)}
								>
									{renaming ? (
										<input
											ref={editorRef}
											className="session-rename"
											value={draftTitle}
											// Selecting the row would remount the chat panel
											// mid-rename, so the editor keeps its own events.
											onClick={event => event.stopPropagation()}
											onDoubleClick={event => event.stopPropagation()}
											onChange={event => {
												draftRef.current = event.target.value;
												setDraftTitle(event.target.value);
											}}
											onKeyDown={event => {
												if (event.key === 'Enter') {
													event.preventDefault();
													commitRename();
												} else if (event.key === 'Escape') {
													event.preventDefault();
													renamingRef.current = undefined;
													setRenamingId(undefined);
												}
											}}
										/>
									) : (
										<>
											<button
												type="button"
												className="session-pick"
												title={`${session.title}\n${session.cwd}${pendingTool ? `\n等待审批：${pendingTool}` : ''}${live === true ? '\n正在回答' : live === false ? '\n进程在运行，空闲' : ''}`}
											>
												<span className="session-title">
													{live !== undefined && <i className={`session-run${live ? ' busy' : ''}`} />}
													<span className="session-text">{session.title}</span>
													{pendingTool && <span className="session-badge">待审批</span>}
												</span>
												<span className="session-meta">
													<span className="session-project" title={projectById.get(session.projectId)?.cwd}>{projectName(session.projectId)}</span>
													<span className="session-time">{formatTime(session.updatedAt)}</span>
												</span>
											</button>
											<span
												className="session-actions"
												// Acting on a row must not also select it: a rename would
												// remount the chat, and a delete would flash the dead one.
												onClick={event => event.stopPropagation()}
												onDoubleClick={event => event.stopPropagation()}
												// The button is unmounted as the editor appears; if the
												// mousedown had focused it, the browser would hand focus
												// to the body and the fresh input would blur itself closed.
												onMouseDown={event => event.preventDefault()}
											>
												<button
													type="button"
													className="session-action"
													title="重命名（双击会话也可）"
													onClick={() => beginRename(session)}
												>
													<Icon name="rename" />
												</button>
												<button
													type="button"
													className="session-action"
													title={session.archived ? '取消归档' : '归档（保留记录，从列表隐藏）'}
													onClick={() => onArchiveSession(session, !session.archived)}
												>
													<Icon name={session.archived ? 'unarchive' : 'archive'} />
												</button>
												<button
													type="button"
													className="session-action danger"
													title="删除会话（同时删除记录文件，不可恢复）"
													onClick={() => onDeleteSession(session)}
												>
													<Icon name="delete" />
												</button>
											</span>
										</>
									)}
								</div>
							);
						})}
					</div>
				))}
			</div>
		</div>
	);
}

type IconName = 'rename' | 'archive' | 'unarchive' | 'delete';

/** Inline so the rail has no icon-font dependency and inherits row color. */
function Icon({ name }: { readonly name: IconName }) {
	const paths: Record<IconName, readonly string[]> = {
		rename: ['M8.5 2.5l3 3L4 13H1v-3z', 'M7 4l3 3'],
		archive: ['M1.5 2.5h11v3h-11z', 'M3 5.5v6h8v-6', 'M5.5 8h3'],
		unarchive: ['M1.5 2.5h11v3h-11z', 'M3 5.5v6h8v-6', 'M5.5 8.5l1.5-1.5 1.5 1.5'],
		delete: ['M2.5 3.5h9', 'M5.5 3.5V2h3v1.5', 'M4 3.5l.6 8h4.8l.6-8'],
	};
	return (
		<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{paths[name].map(path => <path key={path} d={path} />)}
		</svg>
	);
}

interface Bucket {
	readonly label: string;
	readonly sessions: readonly SessionEntry[];
}

function bucketize(sessions: readonly SessionEntry[]): readonly Bucket[] {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const todayStart = startOfToday.getTime();
	const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
	const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

	const today: SessionEntry[] = [];
	const yesterday: SessionEntry[] = [];
	const thisWeek: SessionEntry[] = [];
	const older: SessionEntry[] = [];

	for (const session of sessions) {
		if (session.updatedAt >= todayStart) {
			today.push(session);
		} else if (session.updatedAt >= yesterdayStart) {
			yesterday.push(session);
		} else if (session.updatedAt >= weekStart) {
			thisWeek.push(session);
		} else {
			older.push(session);
		}
	}

	return [
		{ label: '今天', sessions: today },
		{ label: '昨天', sessions: yesterday },
		{ label: '本周', sessions: thisWeek },
		{ label: '更早', sessions: older },
	].filter(bucket => bucket.sessions.length > 0);
}

function formatTime(value: number): string {
	const minutes = Math.floor((Date.now() - value) / 60000);
	if (minutes < 1) {
		return 'now';
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	if (minutes < 60 * 24) {
		return `${Math.floor(minutes / 60)}h`;
	}
	const date = new Date(value);
	return `${date.getMonth() + 1}/${date.getDate()}`;
}
