import { useCallback, useEffect, useState } from 'react';
import {
	archiveSession,
	deleteSession,
	fetchMe,
	listProjects,
	listSessions,
	logout,
	renameSession,
	runningSessions,
	type ProjectInfo,
	type SessionEntry,
} from './api';
import { AuthPage } from './components/AuthPage';
import { ChatPanel } from './components/ChatPanel';
import { NewSessionDialog } from './components/NewSessionDialog';
import { PasswordDialog } from './components/PasswordDialog';
import { SessionSidebar } from './components/SessionSidebar';
import { Splitter, clamp, usePersistedSize } from './components/Splitter';
import { attentionEnabled, onAttentionChange, setAttentionEnabled } from './attention';
import { setLang, t, useLang } from './i18n';
import { getTheme, toggleTheme } from './theme';
import { Workspace } from './components/Workspace';
import { disposeAllTerminalSessions } from './components/terminalSessions';

interface ActiveView {
	readonly root: string;
	readonly sessionId?: string;
	/** Backend for a new conversation; existing history comes from Claude's store. */
	readonly agent?: string;
}

/**
 * Transcripts and the session rail are read from `~/.claude/projects`, so a
 * session selected there is always backed by the Claude plugin.
 */
const HISTORY_AGENT = 'claude';

/** Where the open conversation is remembered, so a reload lands back on it. */
const ACTIVE_KEY = 'agentui.active';

function readActiveView(): ActiveView | undefined {
	try {
		const raw = localStorage.getItem(ACTIVE_KEY);
		if (!raw) {
			return undefined;
		}
		const parsed = JSON.parse(raw) as Partial<ActiveView>;
		if (typeof parsed.root !== 'string' || parsed.root === '') {
			return undefined;
		}
		return {
			root: parsed.root,
			sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
			agent: typeof parsed.agent === 'string' ? parsed.agent : undefined,
		};
	} catch {
		// Storage blocked: starting from the newest session is still fine.
		return undefined;
	}
}

/** `undefined` means "still checking"; everything else is a settled answer. */
type AuthState = { readonly kind: 'loading' }
	| { readonly kind: 'anonymous'; readonly setupRequired: boolean }
	| { readonly kind: 'ready'; readonly username: string; readonly role: string };

export function App() {
	const [projects, setProjects] = useState<readonly ProjectInfo[]>([]);
	const [sessions, setSessions] = useState<readonly SessionEntry[]>([]);
	const [active, setActive] = useState<ActiveView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loaded, setLoaded] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);
	const [revision, setRevision] = useState(0);
	// Subscribes the whole shell to the language switch; the copies themselves
	// re-render through their own `useLang`.
	const lang = useLang();
	/**
	 * Session id → a turn is being answered right now. Polled because a
	 * conversation can keep running in a tab that is not open here; its socket
	 * events never reach this page, so the server has to be asked.
	 */
	const [running, setRunning] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	/**
	 * Session id → the tool it is blocked on, waiting for the user to decide.
	 * Polled with `running` for the same reason: the approval may belong to a
	 * conversation this tab is not attached to.
	 */
	const [approvals, setApprovals] = useState<ReadonlyMap<string, string>>(() => new Map());
	// The label has to follow the theme, so it lives in state rather than being
	// read once during render.
	const [theme, setThemeState] = useState(getTheme);
	// Approvals arrive from a background tab, so the reminder switch is part of
	// the shell rather than of the chat panel that happens to be open.
	const [attentionOn, setAttentionOn] = useState(attentionEnabled);
	const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

	useEffect(() => onAttentionChange(setAttentionOn), []);

	// Chat and code are side by side, so both widths are user controlled and
	// remembered across reloads.
	const [railWidth, setRailWidth] = usePersistedSize('agentui.size.rail', 280);
	const [chatWidth, setChatWidth] = usePersistedSize('agentui.size.chat', 520);

	// Remember the open conversation. Without this, a reload rebuilt the view from
	// the session list and lost both the selection and any unsent new session.
	useEffect(() => {
		if (!active) {
			return;
		}
		try {
			localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
		} catch {
			// Private mode: the conversation just is not remembered.
		}
	}, [active]);

	const refresh = useCallback(async () => {
		const [nextProjects, nextSessions] = await Promise.all([listProjects(), listSessions()]);
		setProjects(nextProjects);
		setSessions(nextSessions);
		setLoaded(true);
		setActive(current => {
			if (current) {
				return current;
			}
			// Reopen what the user was reading. Falling back to "newest file wins"
			// meant a reload silently jumped to whichever session the backend had
			// written to last — often one with no visible content at all.
			const remembered = readActiveView();
			if (remembered) {
				const alive = remembered.sessionId === undefined
					|| nextSessions.some(session => session.id === remembered.sessionId);
				// A vanished session id becomes a fresh conversation in the same
				// project rather than a dead reference.
				return alive ? remembered : { root: remembered.root, agent: remembered.agent };
			}
			// Archived conversations are still listed here; opening one by
			// default would look like the archive did nothing.
			const newest = nextSessions.find(session => !session.archived);
			if (newest) {
				return { root: newest.cwd, sessionId: newest.id, agent: HISTORY_AGENT };
			}
			const first = nextProjects[0];
			return first ? { root: first.cwd } : undefined;
		});
	}, []);

	/**
	 * Polls which conversations still have a process.
	 *
	 * Deliberately not driven by socket events: the point is to show runs in tabs
	 * this page is not attached to, and those events never arrive here.
	 */
	const refreshRunning = useCallback(async () => {
		try {
			const list = await runningSessions();
			setRunning(new Map(list.map(session => [session.sessionId, session.busy])));
			setApprovals(new Map(list.flatMap(session => session.pendingTool === undefined
				? []
				: [[session.sessionId, session.pendingTool] as const])));
		} catch {
			// A failed poll keeps the previous answer; the next one corrects it.
		}
	}, []);

	useEffect(() => {
		if (auth.kind !== 'ready') {
			return;
		}
		void refreshRunning();
		const timer = window.setInterval(() => void refreshRunning(), 3000);
		return () => window.clearInterval(timer);
	}, [auth.kind, refreshRunning]);

	// Resolve the session before anything else: every other call is 401 without it.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const user = await fetchMe();
			if (cancelled) {
				return;
			}
			if (user) {
				setAuth({ kind: 'ready', username: user.username, role: user.role });
				return;
			}
			// `fetchMe` swallows the status, so ask the guard directly: it answers
			// `setup-required` while no account exists.
			try {
				await listProjects();
				setAuth({ kind: 'anonymous', setupRequired: false });
			} catch (reason) {
				const body = (reason as { body?: { setupRequired?: boolean } })?.body;
				setAuth({ kind: 'anonymous', setupRequired: body?.setupRequired === true });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Only load data once signed in; otherwise the requests just 401.
	useEffect(() => {
		if (auth.kind !== 'ready') {
			return;
		}
		refresh().catch(reason => {
			setError(String(reason));
			setLoaded(true);
		});
	}, [auth.kind, refresh]);

	const activeSession = active?.sessionId ? sessions.find(session => session.id === active.sessionId) : undefined;

	/**
	 * A brand-new conversation gets its id before its transcript file exists, so
	 * the single refresh triggered by `onSessionStarted` can miss it. The rail
	 * then never lists the conversation and the topbar keeps saying “新会话”
	 * until the user presses 刷新 — which also made it impossible to switch back
	 * to a conversation that was still running. Retry until it shows up, then
	 * stop: a session that is really gone must not poll forever.
	 */
	const missingActiveSession = active?.sessionId !== undefined && activeSession === undefined;
	useEffect(() => {
		if (auth.kind !== 'ready' || !missingActiveSession) {
			return;
		}
		let attempts = 0;
		const timer = window.setInterval(() => {
			attempts += 1;
			void refresh().catch(() => undefined);
			if (attempts >= 15) {
				window.clearInterval(timer);
			}
		}, 2000);
		return () => window.clearInterval(timer);
	}, [auth.kind, missingActiveSession, refresh]);

	/**
	 * Escape closes whichever dialog is open.
	 *
	 * Both are rendered here, so one listener covers them and neither dialog has
	 * to install a global key handler. Clicking the backdrop already works; this
	 * is the keyboard half of the same expectation.
	 */
	useEffect(() => {
		if (!dialogOpen && !passwordOpen) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setDialogOpen(false);
				setPasswordOpen(false);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [dialogOpen, passwordOpen]);

	/**
	 * Bumped on every explicit navigation. The chat panel is keyed by it so that
	 * picking a session always rebuilds the transcript from the jsonl on disk,
	 * even when that session is already the open one — otherwise a panel holding
	 * only a live tail (or a stale selection) would never reload its history.
	 */
	const [viewToken, setViewToken] = useState(0);

	const selectSession = (session: SessionEntry) => {
		setActive({ root: session.cwd, sessionId: session.id, agent: HISTORY_AGENT });
		setViewToken(value => value + 1);
	};

	/**
	 * Rename, archive and delete all rewrite agent-ui's own metadata (or, for a
	 * delete, the transcript) rather than the CLI's view of the session, so the
	 * only thing to do afterwards is re-read the list.
	 */
	const renameSessionEntry = (session: SessionEntry, title: string) => {
		void renameSession(session.id, title)
			.then(() => refresh())
			.catch(reason => window.alert(t('重命名失败：{error}', { error: String(reason) })));
	};

	const archiveSessionEntry = (session: SessionEntry, archived: boolean) => {
		void archiveSession(session.id, archived)
			.then(() => refresh())
			.catch(reason => window.alert(t(archived ? '归档失败：{error}' : '取消归档失败：{error}', { error: String(reason) })));
	};

	const deleteSessionEntry = (session: SessionEntry) => {
		// Deleting a transcript cannot be undone, and the CLI will not regenerate it.
		const confirmed = window.confirm(t('删除会话「{title}」？\n\n记录文件会一并删除，无法恢复。', { title: session.title }));
		if (!confirmed) {
			return;
		}
		void deleteSession(session.id)
			.then(async () => {
				// The deleted conversation may be the one on screen; fall back to a
				// fresh conversation in the same project instead of a dead id.
				setActive(current => current?.sessionId === session.id ? { root: current.root, agent: current.agent } : current);
				await refresh();
			})
			.catch(reason => window.alert(t('删除失败：{error}', { error: String(reason) })));
	};

	const startSession = async (root: string) => {
		// A new session keeps the backend the user is currently working with.
		setActive(current => ({ root, agent: current?.agent }));
		setViewToken(value => value + 1);
		setDialogOpen(false);
		await refresh();
	};

	if (auth.kind === 'loading') {
		return <div className="boot">loading…</div>;
	}
	if (auth.kind === 'anonymous') {
		return <AuthPage setupRequired={auth.setupRequired} onDone={() => {
			// The session cookie is set; re-resolve to enter the app.
			void fetchMe().then(user => {
				if (user) {
					setAuth({ kind: 'ready', username: user.username, role: user.role });
				}
			});
		}} />;
	}
	if (!loaded) {
		return <div className="boot">loading…</div>;
	}
	if (error) {
		return <div className="boot-error">{t('无法连接后端：{error}', { error })}</div>;
	}

	return (
		<div className="app">
			<header className="topbar">
				<span className="topbar-title">{activeSession?.title ?? t('新会话')}</span>
				<span className="project-chip" title={active?.root ?? ''}>{active ? baseName(active.root) : '—'}</span>
				<span className="project-root">{active?.root ?? t('未选择项目')}</span>
				<span className="account-chip" title={`${auth.username} · ${auth.role}`}>
					{auth.username}
					<button type="button" className="link-btn" onClick={() => setPasswordOpen(true)}>{t('改密码')}</button>
					<button
						type="button"
						className="link-btn"
						onClick={() => {
							void logout().then(() => {
								// The terminal screens live outside React (a pool), so
								// unmounting the workspace is not enough to close them.
								disposeAllTerminalSessions();
								setAuth({ kind: 'anonymous', setupRequired: false });
							});
						}}
					>
						{t('退出')}
					</button>
				</span>
				<span className="spacer" />
				<button
					type="button"
					className="toggle"
					title={t('切换语言')}
					onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
				>
					{lang === 'zh' ? 'EN' : '中文'}
				</button>
				<button
					type="button"
					className="toggle"
					title={t('切换明亮 / 暗色主题')}
					onClick={() => setThemeState(toggleTheme())}
				>
					{theme === 'dark' ? t('明亮主题') : t('暗色主题')}
				</button>
				<button
					type="button"
					className="toggle"
					title={t('需要审批时用声音和系统通知提醒；开启会请求浏览器通知权限')}
					onClick={() => { void setAttentionEnabled(!attentionOn); }}
				>
					{attentionOn ? t('提醒：开') : t('提醒：关')}
				</button>
				<button type="button" className="toggle" onClick={() => { void refresh().catch(reason => setError(String(reason))); }}>{t('刷新')}</button>
			</header>

			<div className="body" style={{ gridTemplateColumns: `${railWidth}px 5px 1fr` }}>
				<SessionSidebar
					projects={projects}
					sessions={sessions}
					activeSessionId={active?.sessionId}
					onSelectSession={selectSession}
					onNewSession={() => setDialogOpen(true)}
					onRenameSession={renameSessionEntry}
					onArchiveSession={archiveSessionEntry}
					onDeleteSession={deleteSessionEntry}
					running={running}
					approvals={approvals}
				/>
				<Splitter axis="x" onResize={delta => setRailWidth(clamp(railWidth + delta, 160, 520))} />

				<main
					className={`main${active ? ' split' : ''}`}
					style={active ? { gridTemplateColumns: `${chatWidth}px 5px 1fr` } : undefined}
				>
					{!active && <div className="placeholder">{t('还没有任何项目会话')}</div>}
					{active && (
						<>
							<ChatPanel
								key={`${active.root}:${active.agent ?? 'default'}:${viewToken}`}
								root={active.root}
								sessionId={active.sessionId}
								agent={active.agent}
								onAgentChange={nextAgent => setActive({ root: active.root, agent: nextAgent })}
								onSessionStarted={sessionId => {
									setActive(current => current ? { ...current, sessionId } : current);
									void refresh().catch(() => undefined);
								}}
								onTurnEnd={() => {
									setRevision(value => value + 1);
									// A finished turn flips the sidebar's marker at once
									// instead of on the next poll tick, and may have left a
									// fresh ai-title behind, so the list gets re-read too.
									void refreshRunning();
									void refresh().catch(() => undefined);
								}}
							/>
							<Splitter axis="x" onResize={delta => setChatWidth(clamp(chatWidth + delta, 320, 1200))} />
							<Workspace key={active.root} root={active.root} projects={projects} revision={revision} />
						</>
					)}
				</main>
			</div>

			{dialogOpen && (
				<NewSessionDialog
					projects={projects}
					onClose={() => setDialogOpen(false)}
					onCreate={startSession}
				/>
			)}
			{passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} />}
		</div>
	);
}

function baseName(root: string): string {
	const parts = root.split(/[\\/]/).filter(part => part.length > 0);
	return parts.length > 0 ? parts[parts.length - 1] : root;
}
