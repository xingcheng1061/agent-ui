import { useCallback, useEffect, useRef, useState } from 'react';
import {
	archiveGroup,
	archiveSession,
	createGroup,
	deleteGroup,
	deleteSession,
	deleteOpenedProject,
	fetchMe,
	joinGroup,
	leaveGroup,
	listGroups,
	listOpenedProjects,
	listProjects,
	listSessions,
	logout,
	renameGroup,
	renameSession,
	restartSession,
	runningSessions,
	setOpenedProjectArchived,
	touchOpenedProject,
	type GroupInfo,
	type OpenedProject,
	type MembershipResult,
	type ProjectInfo,
	type RestartOutcome,
	type SessionEntry,
	type SessionMatch,
} from './api';
import { AuthPage } from './components/AuthPage';
import { ChatPanel } from './components/ChatPanel';
import { GroupFilesDialog } from './components/GroupFilesDialog';
import { NewSessionDialog } from './components/NewSessionDialog';
import { PasswordDialog } from './components/PasswordDialog';
import { SessionSidebar } from './components/SessionSidebar';
import { Splitter, clamp, usePersistedSize } from './components/Splitter';
import { attentionEnabled, onAttentionChange, setAttentionEnabled } from './attention';
import { setLang, t, useLang } from './i18n';
import { getTheme, toggleTheme } from './theme';
import { Workspace } from './components/Workspace';
import { disposeAllTerminalSessions } from './components/terminalSessions';
import { readRailSortPrefs, writeRailSortPref, type RailSortPrefs, type SortMode } from './components/railSortPrefs';

interface ActiveView {
	readonly root: string;
	readonly sessionId?: string;
	/** Backend for a new conversation; existing history comes from Claude's store. */
	readonly agent?: string;
	/**
	 * Code only: the project is open without a conversation.
	 *
	 * Reading a repository does not need a transcript, and going through "new
	 * conversation" just to see the files left an empty chat panel and a session
	 * in the rail that nobody asked for.
	 */
	readonly browse?: boolean;
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
			browse: parsed.browse === true ? true : undefined,
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
	/** Cross-project bundles of conversations; membership rides on the session. */
	const [groups, setGroups] = useState<readonly GroupInfo[]>([]);
	/** The group whose shared files are open in the editor dialog, if any. */
	const [groupFiles, setGroupFiles] = useState<GroupInfo | undefined>(undefined);
	const [active, setActive] = useState<ActiveView | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loaded, setLoaded] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	/** The same dialog picks a folder either to start in or to read. */
	const [dialogMode, setDialogMode] = useState<'create' | 'browse'>('create');
	/** Opened folders, from the service; one record per account, shared by tabs. */
	const [openedProjects, setOpenedProjects] = useState<readonly OpenedProject[]>([]);
	const [railSortPrefs, setRailSortPrefs] = useState<RailSortPrefs>(readRailSortPrefs);
	const setRailSort = (key: keyof RailSortPrefs, value: SortMode) => {
		setRailSortPrefs(current => {
			const next = { ...current, [key]: value };
			writeRailSortPref(key, value);
			return next;
		});
	};
	// A reload can land on a folder opened in another tab: adopt it so the
	// record exists on the service even if this tab refreshes before seeing it.
	useEffect(() => {
		if (active?.browse && !openedProjects.some(item => item.root === active.root)) {
			void touchOpenedProject(active.root)
				.then(setOpenedProjects)
				.catch(() => undefined);
		}
	}, [active, openedProjects]);
	const [passwordOpen, setPasswordOpen] = useState(false);
	/**
	 * One line of feedback for actions whose effect is not visible in the rail.
	 *
	 * Membership changes are exactly that: whether the conversation's process was
	 * restarted decides whether the group's shared files are live now or at its
	 * next turn, and nothing on screen would otherwise say which.
	 */
	const [toast, setToast] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (toast === undefined) {
			return;
		}
		const timer = window.setTimeout(() => setToast(undefined), 5000);
		return () => window.clearTimeout(timer);
	}, [toast]);
	const [revision, setRevision] = useState(0);
	/** A `path:line` clicked in a tool result, waiting for the code pane. */
	const [openRequest, setOpenRequest] = useState<{ readonly path: string; readonly line?: number; readonly token: number } | undefined>(undefined);
	// Subscribes the whole shell to the language switch; the copies themselves
	// re-render through their own `useLang`.
	const lang = useLang();
	/**
	 * Session id → a turn is being answered right now. Polled because a
	 * conversation can keep running in a tab that is not open here; its socket
	 * events never reach this page, so the server has to be asked.
	 */
	const [running, setRunning] = useState<ReadonlyMap<string, boolean>>(() => new Map());
	/** Full running snapshot, so a task panel jump can locate a brand-new session. */
	const runningRef = useRef<Awaited<ReturnType<typeof runningSessions>>>([]);
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
		const [nextProjects, nextSessions, nextGroups, nextOpened] = await Promise.all([
			listProjects(), listSessions(), listGroups(),
			listOpenedProjects().catch(() => [] as readonly OpenedProject[]),
		]);
		setProjects(nextProjects);
		setSessions(nextSessions);
		setGroups(nextGroups);
		setOpenedProjects(nextOpened);
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
			runningRef.current = list;
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

	/** Opened folders are per-account, so another tab's change must show up here. */
	useEffect(() => {
		if (auth.kind !== 'ready') {
			return;
		}
		const sync = () => void listOpenedProjects()
			.then(setOpenedProjects)
			.catch(() => undefined);
		const timer = window.setInterval(sync, 10_000);
		return () => window.clearInterval(timer);
	}, [auth.kind]);

	/** One-shot migration of the old browser-local list into the account store. */
	useEffect(() => {
		if (auth.kind !== 'ready') {
			return;
		}
		let roots: readonly string[] = [];
		try {
			const raw = localStorage.getItem('agentui.opened');
			const parsed: unknown = raw ? JSON.parse(raw) : undefined;
			if (Array.isArray(parsed)) {
				roots = parsed.filter((item): item is string => typeof item === 'string');
			}
		} catch {
			// Corrupt data: nothing worth migrating.
		}
		localStorage.removeItem('agentui.opened');
		localStorage.removeItem('agentui.openedAt');
		if (roots.length === 0) {
			return;
		}
		void (async () => {
			let migrated: readonly OpenedProject[] = [];
			for (const root of roots) {
				migrated = await touchOpenedProject(root);
			}
			setOpenedProjects(migrated);
		})().catch(() => undefined);
	}, [auth.kind]);

	/**
	 * One place decides who owns Ctrl+F. Which pane has focus determines which
	 * search box opens — the chat, the terminal, the editor, or the session rail.
	 * Monaco owns Ctrl+F inside its own widget, so a press there is left alone;
	 * text inputs are left alone too (typing 'f' must stay plain text).
	 */
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') {
				return;
			}
			const target = event.target;
			if (target instanceof HTMLElement) {
				// A real editor/input handles its own find or plain text.
				if (target.closest('.monaco-editor, input, textarea, [contenteditable="true"]')) {
					return;
				}
				if (target.closest('.terminal-host')) {
					event.preventDefault();
					window.dispatchEvent(new CustomEvent('agentui:find-terminal'));
					return;
				}
				if (target.closest('.terminal-panel')) {
					event.preventDefault();
					window.dispatchEvent(new CustomEvent('agentui:find-terminal'));
					return;
				}
				if (target.closest('.chat')) {
					event.preventDefault();
					window.dispatchEvent(new CustomEvent('agentui:find-chat'));
					return;
				}
				if (target.closest('.rail')) {
					event.preventDefault();
					window.dispatchEvent(new CustomEvent('agentui:find-rail'));
					return;
				}
			}
			// Focus on the shell/topbar: open the chat's find, the work area.
			event.preventDefault();
			window.dispatchEvent(new CustomEvent('agentui:find-chat'));
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, []);

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
	/**
	 * A content-search hit to scroll to after the target conversation opens.
	 * The token makes clicking the same hit twice act again.
	 */
	const [focusMatch, setFocusMatch] = useState<{ readonly match: SessionMatch; readonly token: number } | undefined>(undefined);

	const selectSession = (session: SessionEntry) => {
		setActive({ root: session.cwd, sessionId: session.id, agent: HISTORY_AGENT });
		setViewToken(value => value + 1);
	};

	/** Jumps from the global task panel to the conversation that owns a task. */
	const openTaskSession = async (sessionId: string) => {
		// A session whose turn is still running often has no jsonl file yet, so
		// it is missing from `sessions`. The running snapshot is polled on its
		// own clock and can lag the task panel by seconds — refresh it before
		// giving up, or "定位" silently does nothing.
		let session = sessions.find(entry => entry.id === sessionId);
		let running = runningRef.current.find(entry => entry.sessionId === sessionId);
		if (!session && !running) {
			await refreshRunning();
			session = sessions.find(entry => entry.id === sessionId);
			running = runningRef.current.find(entry => entry.sessionId === sessionId);
		}
		const root = session?.cwd ?? running?.root;
		if (!root) {
			setError(t('找不到该任务所属的会话'));
			return;
		}
		// Already on this conversation: remounting would reload the transcript
		// from disk and drop the queued user message and the in-flight text that
		// have not reached the jsonl yet. Just stay put.
		if (active?.sessionId === sessionId && active.root === root) {
			return;
		}
		setActive({ root, sessionId, agent: running?.agent ?? HISTORY_AGENT });
		setViewToken(value => value + 1);
	};

	// ChatFind (Ctrl+F inside the conversation) asks us to scroll to a hit. It
	// is always in the session on screen, so no navigation is needed.
	useEffect(() => {
		const onJump = (event: Event) => {
			const match = (event as CustomEvent<SessionMatch>).detail;
			setFocusMatch(current => ({ match, token: (current?.token ?? 0) + 1 }));
		};
		window.addEventListener('agentui:focus-match', onJump);
		return () => window.removeEventListener('agentui:focus-match', onJump);
	}, []);

	/** Opens the conversation behind a content-search hit and asks it to scroll. */
	const openMatch = (match: SessionMatch) => {
		const session = sessions.find(entry => entry.id === match.sessionId);
		if (session) {
			selectSession(session);
		} else {
			const running = runningRef.current.find(entry => entry.sessionId === match.sessionId);
			setActive(running
				? { root: running.root, sessionId: match.sessionId, agent: running.agent }
				: { root: match.cwd, sessionId: match.sessionId, agent: HISTORY_AGENT });
			setViewToken(value => value + 1);
		}
		setFocusMatch(current => ({ match, token: (current?.token ?? 0) + 1 }));
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

	/**
	 * Group chosen for the conversation about to be created.
	 *
	 * It cannot be applied here: a group is a list of session ids, and this
	 * conversation has none until its first message spawns the CLI. The value is
	 * held until `onSessionStarted` reports the id.
	 */
	const pendingGroupRef = useRef<string | undefined>(undefined);

	const startSession = async (root: string, groupId?: string) => {
		// A new session keeps the backend the user is currently working with.
		pendingGroupRef.current = groupId;
		setActive(current => ({ root, agent: current?.agent }));
		setViewToken(value => value + 1);
		setDialogOpen(false);
		await refresh();
	};

	/**
	 * Opens a project for reading only: code, git changes and a terminal, no
	 * conversation.
	 *
	 * The folder still goes through the dialog's `addProject` — the file APIs
	 * resolve paths against known project roots, so an unregistered directory
	 * would render an empty pane.
	 */
	const showProject = (root: string) => {
		setActive({ root, browse: true });
		setViewToken(value => value + 1);
	};

	const openProject = async (root: string) => {
		showProject(root);
		setDialogOpen(false);
		await touchOpenedProject(root).then(setOpenedProjects).catch(() => undefined);
	};

	/** Switches to a folder that is already open, without re-picking it. */
	const activateProject = async (root: string) => {
		showProject(root);
		await touchOpenedProject(root).then(setOpenedProjects).catch(() => undefined);
	};

	/**
	 * Archives a folder: it leaves the list but the record (and the disk files)
	 * stay, so it can be restored later.
	 */
	const archiveProject = async (root: string, archived: boolean) => {
		try {
			await setOpenedProjectArchived(root, archived);
			setOpenedProjects(current => current.map(item => item.root === root
				? { ...item, archivedAt: archived ? Date.now() : undefined }
				: item));
			if (archived && active?.browse && active.root === root) {
				setActive(undefined);
				setViewToken(value => value + 1);
			}
		} catch (reason) {
			setError(String(reason));
		}
	};

	/** Removes the record entirely; never touches the directory on disk. */
	const deleteProjectRecord = async (root: string) => {
		try {
			await deleteOpenedProject(root);
			setOpenedProjects(current => current.filter(item => item.root !== root));
			if (active?.browse && active.root === root) {
				setActive(undefined);
				setViewToken(value => value + 1);
			}
		} catch (reason) {
			setError(String(reason));
		}
	};

	const openDialog = (mode: 'create' | 'browse') => {
		setDialogMode(mode);
		setDialogOpen(true);
	};

	/**
	 * Group actions all rewrite `session-groups.json` and re-read the list.
	 *
	 * Where a row renders is decided by the session's own `groupId`, which comes
	 * back from the server, so the rail cannot move it locally and stay correct.
	 */
	const assignGroup = (session: SessionEntry, groupId: string | undefined) => {
		const current = session.groupId;
		const run: Promise<MembershipResult> = groupId === undefined
			? (current === undefined
				? Promise.resolve({ groups, restart: 'missing' as RestartOutcome })
				: leaveGroup(current, session.id))
			: joinGroup(groupId, session.id);
		void run
			.then(async result => {
				// Joining and leaving both change the injected system prompt, so the
				// outcome worth reporting is what happened to the process.
				setToast(membershipNote(result.restart, groupId !== undefined));
				await refresh();
			})
			.catch(reason => window.alert(t('调整会话组失败：{error}', { error: String(reason) })));
	};

	const restartSessionEntry = (session: SessionEntry) => {
		void restartSession(session.id)
			.then(outcome => {
				setToast(outcome === 'busy'
					? t('会话正在执行，现在不能重载；等这一轮结束再试')
					: t('会话进程已重载，下一条消息会带上最新的系统提示'));
			})
			.catch(reason => window.alert(t('重载会话进程失败：{error}', { error: String(reason) })));
	};

	const createGroupWith = (name: string, session?: SessionEntry) => {
		void createGroup(name)
			.then(async group => {
				if (session) {
					const joined = await joinGroup(group.id, session.id);
					setToast(membershipNote(joined.restart, true));
				}
				await refresh();
			})
			.catch(reason => window.alert(t('创建会话组失败：{error}', { error: String(reason) })));
	};

	const renameGroupEntry = (group: GroupInfo, name: string) => {
		void renameGroup(group.id, name)
			.then(() => refresh())
			.catch(reason => window.alert(t('重命名会话组失败：{error}', { error: String(reason) })));
	};

	/** Whole-group archive: the server flags the group, the members follow. */
	const archiveGroupEntry = (group: GroupInfo, archived: boolean) => {
		void archiveGroup(group.id, archived)
			.then(() => refresh())
			.catch(reason => window.alert(t('归档会话组失败：{error}', { error: String(reason) })));
	};

	const deleteGroupEntry = (group: GroupInfo) => {
		const confirmed = window.confirm(t(
			'删除会话组「{name}」？\n\n组里的会话和记录都保留，只是不再归组；共享的记忆与进度文件会一并删除。',
			{ name: group.name },
		));
		if (!confirmed) {
			return;
		}
		void deleteGroup(group.id)
			.then(async () => {
				setGroupFiles(current => current?.id === group.id ? undefined : current);
				await refresh();
			})
			.catch(reason => window.alert(t('删除会话组失败：{error}', { error: String(reason) })));
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
				<span className="topbar-title">
					{active?.browse
						? t('{project} · 仅浏览', { project: baseName(active.root) })
						: activeSession?.title ?? t('新会话')}
				</span>
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
					groups={groups}
					activeSessionId={active?.sessionId}
					onSelectSession={selectSession}
					onOpenMatch={openMatch}
					onNewSession={() => openDialog('create')}
					onOpenProject={() => openDialog('browse')}
					openedProjects={openedProjects}
					railSortPrefs={railSortPrefs}
					onRailSortChange={setRailSort}
					openRoot={active?.browse ? active.root : undefined}
					onActivateProject={activateProject}
					onArchiveProject={archiveProject}
					onDeleteProject={deleteProjectRecord}
					onRenameSession={renameSessionEntry}
					onArchiveSession={archiveSessionEntry}
					onDeleteSession={deleteSessionEntry}
					onAssignGroup={assignGroup}
					onCreateGroup={createGroupWith}
					onRenameGroup={renameGroupEntry}
					onArchiveGroup={archiveGroupEntry}
					onDeleteGroup={deleteGroupEntry}
					onOpenGroupFiles={setGroupFiles}
					onRestartSession={restartSessionEntry}
					running={running}
					approvals={approvals}
				/>
				<Splitter axis="x" onResize={delta => setRailWidth(clamp(railWidth + delta, 160, 520))} />

				<main
					className={`main${active && !active.browse ? ' split' : ''}`}
					style={active && !active.browse ? { gridTemplateColumns: `${chatWidth}px 5px 1fr` } : undefined}
				>
					{!active && <div className="placeholder">{t('还没有任何项目会话')}</div>}
					{active && !active.browse && (
						<>
							<ChatPanel
								key={`${active.root}:${active.agent ?? 'default'}:${viewToken}`}
								root={active.root}
								sessionId={active.sessionId}
								agent={active.agent}
								focusMatch={focusMatch?.match.sessionId === active.sessionId ? focusMatch : undefined}
								onOpenTaskSession={openTaskSession}
								onSessionStarted={sessionId => {
									setActive(current => current ? { ...current, sessionId } : current);
									// A group picked in the new-session dialog is applied as
									// soon as the id exists: membership needs an id, and the
									// rail would otherwise file the conversation as ungrouped.
									const group = pendingGroupRef.current;
									pendingGroupRef.current = undefined;
									if (group) {
										void joinGroup(group, sessionId)
											.then(async result => {
												setToast(membershipNote(result.restart, true));
												await refresh();
											})
											.catch(reason => window.alert(t('加入会话组失败：{error}', { error: String(reason) })));
									}
									void refresh().catch(() => undefined);
								}}
								onOpenPath={(path, line) => {
									// The token makes a second click on the same hit act again.
									setOpenRequest(current => ({ path, line, token: (current?.token ?? 0) + 1 }));
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
					</>
				)}
				{/*
				 * One Workspace for both browse and chat mode, kept at the same
				 * position in the tree. Previously the two modes rendered it in
				 * separate branches, so every switch unmounted it — tearing down
				 * the terminal view and losing its state — even when the project
				 * was the same. The pool kept the shell alive, but the pane reset.
				 */}
				{active && (
					<Workspace
						key={active.root}
						root={active.root}
						projects={projects}
						revision={revision}
						openRequest={openRequest}
					/>
				)}
			</main>
			</div>

			{dialogOpen && (
				<NewSessionDialog
					projects={projects}
					groups={groups}
					mode={dialogMode}
					onClose={() => setDialogOpen(false)}
					onCreate={dialogMode === 'browse' ? openProject : startSession}
				/>
			)}
			{passwordOpen && <PasswordDialog onClose={() => setPasswordOpen(false)} />}
			{groupFiles && <GroupFilesDialog group={groupFiles} onClose={() => setGroupFiles(undefined)} />}
			{toast !== undefined && <div className="toast" role="status">{toast}</div>}
		</div>
	);
}

function baseName(root: string): string {
	const parts = root.split(/[\\/]/).filter(part => part.length > 0);
	return parts.length > 0 ? parts[parts.length - 1] : root;
}

/**
 * What a membership change means for the conversation that was moved.
 *
 * The group's shared files ride on the system prompt, which only a fresh
 * process receives: `restarted` means the next message already carries them,
 * `busy` waits for the turn in flight to end, and `missing` had no process to
 * begin with, so the next message spawns one with the new prompt anyway.
 */
function membershipNote(outcome: RestartOutcome, joined: boolean): string {
	const subject = joined ? t('已加入会话组') : t('已移出会话组');
	if (outcome === 'busy') {
		return `${subject}；会话正在执行，这一轮结束后生效（也可以手动重载进程）`;
	}
	if (outcome === 'restarted') {
		return `${subject}，会话进程已重载，下一条消息就会带上新的共享文件`;
	}
	return `${subject}；当前没有运行中的进程，下一条消息会按新设置启动`;
}
