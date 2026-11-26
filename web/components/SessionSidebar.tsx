import { useEffect, useMemo, useRef, useState } from 'react';
import { searchSessions, type GroupInfo, type OpenedProject, type ProjectInfo, type SessionEntry, type SessionMatch } from '../api';
import { t, useLang } from '../i18n';
import { ALL, ProjectFilter } from './ProjectFilter';
import { projectLabels } from '../projectNames';
import { SORT_MODES, sortModeLabel, type RailSortPrefs, type SortMode } from './railSortPrefs';

/**
 * When each conversation was last opened, so the rail can stop marking it.
 *
 * Kept in this browser on purpose: "read" is a property of the reader, not of
 * the transcript, and the server holds no per-user state to hang it on. The
 * `undefined` state means "never recorded" — the first run adopts whatever is
 * already listed instead of labelling every existing conversation as new.
 */
const SEEN_KEY = 'agentui.seen';

function readSeen(): Record<string, number> | undefined {
	try {
		const raw = localStorage.getItem(SEEN_KEY);
		if (!raw) {
			return undefined;
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const seen: Record<string, number> = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (typeof value === 'number') {
				seen[id] = value;
			}
		}
		return seen;
	} catch {
		return undefined;
	}
}

function writeSeen(seen: Record<string, number>): void {
	try {
		localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
	} catch {
		// Storage blocked or full: an extra dot is not worth failing a render.
	}
}

/**
 * How conversations that are not in a manual group are filed.
 *
 * `project` by default: a conversation belongs to the folder it runs in, and
 * that is the axis a person remembers. `time` is the old day-bucketed list,
 * kept for when "what was I doing yesterday" is the question.
 */
type Grouping = 'project' | 'time';
const GROUPING_KEY = 'agentui.railGrouping';

function readGrouping(): Grouping {
	try {
		return localStorage.getItem(GROUPING_KEY) === 'time' ? 'time' : 'project';
	} catch {
		return 'project';
	}
}

function writeGrouping(value: Grouping): void {
	try {
		localStorage.setItem(GROUPING_KEY, value);
	} catch {
		// The rail still works; it just forgets the choice.
	}
}

/**
 * Returns a comparator that orders by one of the three modes. `created` and
 * `updated` are descending (newest first), `name` is alphabetical.
 */
function sortBy<T>(mode: SortMode, nameOf: (item: T) => string, timeOf: (item: T) => { created: number; updated: number }): (a: T, b: T) => number {
	if (mode === 'name') {
		return (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' });
	}
	const field = mode === 'created' ? 'created' : 'updated';
	return (a, b) => timeOf(b)[field] - timeOf(a)[field];
}

/**
 * How project blocks are ordered: by their newest conversation, or by name.
 *
 * Time is the default because "what did I touch last" is the question a rail
 * answers most often; name is for people who navigate by remembering where the
 * project is rather than when it was used.
 */
type ProjectSort = 'time' | 'name';
const PROJECT_SORT_KEY = 'agentui.railProjectSort';

function readProjectSort(): ProjectSort {
	try {
		return localStorage.getItem(PROJECT_SORT_KEY) === 'name' ? 'name' : 'time';
	} catch {
		return 'time';
	}
}

function writeProjectSort(value: ProjectSort): void {
	try {
		localStorage.setItem(PROJECT_SORT_KEY, value);
	} catch {
		// Same as above: the rail still works, it just forgets.
	}
}

/** Marks the query inside a result snippet without using dangerouslySetInnerHTML. */
function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
	const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
	if (at < 0 || query.trim() === '') {
		return <>{text}</>;
	}
	return (
		<>
			{text.slice(0, at)}
			<mark>{text.slice(at, at + query.trim().length)}</mark>
			{text.slice(at + query.trim().length)}
		</>
	);
}

/** Three-way order picker shared by the rail's ordered lists. */
function SortPicker({ mode, onChange, label }: {
	readonly mode: SortMode;
	readonly onChange: (value: SortMode) => void;
	readonly label: string;
}) {
	const lang = useLang();
	return (
		<div className="rail-sort-picker" role="group" aria-label={`${label} · ${lang === 'zh' ? '排序' : 'Sort'}`}>
			{SORT_MODES.map(value => {
				const name = sortModeLabel(value)[lang];
				return (
					<button
						type="button"
						key={value}
						className={`rail-sort-item${mode === value ? ' active' : ''}`}
						title={`${label} · ${name}`}
						onClick={() => onChange(value)}
					>
						{name}
					</button>
				);
			})}
		</div>
	);
}

interface SessionSidebarProps {
	readonly projects: readonly ProjectInfo[];
	readonly sessions: readonly SessionEntry[];
	/** Groups are cross-project on purpose: they outlive any single workspace. */
	readonly groups: readonly GroupInfo[];
	readonly activeSessionId: string | undefined;
	readonly onSelectSession: (session: SessionEntry) => void;
	/** Opens a content-search hit and scrolls the chat to the matching message. */
	readonly onOpenMatch: (match: SessionMatch) => void;
	readonly onNewSession: () => void;
	/** Picks a folder to open for reading, without starting a conversation. */
	readonly onOpenProject: () => void;
	/**
	 * Folders opened for reading, persisted per account on the service.
	 *
	 * Kept separate from the sessions: a conversation list answers "what was I
	 * doing", this answers "what is open right now", and the two do not have to
	 * agree. Archived folders stay in the list for the archive toggle.
	 */
	readonly openedProjects: readonly OpenedProject[];
	readonly railSortPrefs: RailSortPrefs;
	readonly onRailSortChange: (key: keyof RailSortPrefs, value: SortMode) => void;
	/** The root being read right now, if any: highlights its row. */
	readonly openRoot: string | undefined;
	readonly onActivateProject: (root: string) => void;
	readonly onArchiveProject: (root: string, archived: boolean) => void;
	/** Removes the record entirely; the directory on disk is untouched. */
	readonly onDeleteProject: (root: string) => void;
	/** Empty title restores the generated one; the rail never sends that. */
	readonly onRenameSession: (session: SessionEntry, title: string) => void;
	readonly onArchiveSession: (session: SessionEntry, archived: boolean) => void;
	readonly onDeleteSession: (session: SessionEntry) => void;
	/** `undefined` takes the conversation out of whatever group holds it. */
	readonly onAssignGroup: (session: SessionEntry, groupId: string | undefined) => void;
	readonly onCreateGroup: (name: string, session?: SessionEntry) => void;
	readonly onRenameGroup: (group: GroupInfo, name: string) => void;
	/** Whole-group archive and restore; the members follow the group's flag. */
	readonly onArchiveGroup: (group: GroupInfo, archived: boolean) => void;
	readonly onDeleteGroup: (group: GroupInfo) => void;
	/** Opens the shared `memory.md` / `progress.md` editor for a group. */
	readonly onOpenGroupFiles: (group: GroupInfo) => void;
	/**
	 * Drops the conversation's process so the next message starts a new one.
	 *
	 * The only way to apply a changed system prompt (a group's shared files,
	 * for instance) to a conversation whose process is already running.
	 */
	readonly onRestartSession: (session: SessionEntry) => void;
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



/** Sessions first: one flat, time-ordered list; the project is a label on the row. */
export function SessionSidebar({
	projects,
	sessions,
	groups,
	activeSessionId,
	onSelectSession,
	onOpenMatch,
	onNewSession,
	onOpenProject,
	openedProjects,
	railSortPrefs,
	onRailSortChange,
	openRoot,
	onActivateProject,
	onArchiveProject,
	onDeleteProject,
	onRenameSession,
	onArchiveSession,
	onDeleteSession,
	onAssignGroup,
	onCreateGroup,
	onRenameGroup,
	onArchiveGroup,
	onDeleteGroup,
	onOpenGroupFiles,
	onRestartSession,
	running,
	approvals,
}: SessionSidebarProps) {
	const lang = useLang();
	const [filter, setFilter] = useState<string>(ALL);
	/**
	 * Archived conversations are hidden by default, not deleted: the CLI still
	 * has their transcript, and a restore must be one click away rather than an
	 * excursion into the filesystem.
	 */
	const [showArchived, setShowArchived] = useState(false);
	/**
	 * What the rail lists: conversations, or the folders that are open.
	 *
	 * One list used to do both, so looking at a repository meant opening (or
	 * creating) a conversation in it first.
	 */
	const [view, setView] = useState<'sessions' | 'projects'>('sessions');
	const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
	const [seen, setSeen] = useState<Record<string, number> | undefined>(readSeen);
	const [draftTitle, setDraftTitle] = useState('');
	const editorRef = useRef<HTMLInputElement | null>(null);
	// The pending edit, readable from the listeners below without re-binding
	// them on every keystroke.
	const renamingRef = useRef<SessionEntry | undefined>(undefined);
	const draftRef = useRef('');

	// Group state: which row's menu is open, the inline "new group" draft, and
	// which groups the user folded away. All three are rail-local: they describe
	// what is on screen, not anything the server knows.
	const [groupMenuFor, setGroupMenuFor] = useState<string | undefined>(undefined);
	const [newGroupName, setNewGroupName] = useState('');
	/** The rail's own "new group" field, independent of the per-row menu. */
	const [creatingGroup, setCreatingGroup] = useState(false);
	const [newGroupDraft, setNewGroupDraft] = useState('');
	/**
	 * Free-text filter over conversation titles, project names and group names.
	 *
	 * Titles alone would not be enough: the CLI names a conversation after its
	 * first prompt ("Add parser tests"), and a person usually remembers the
	 * project or the group, not that string.
	 */
	const [query, setQuery] = useState('');
	const searchRef = useRef<HTMLInputElement | null>(null);
	/**
	 * Message-body hits from the server, kept separate from the title filter:
	 * a title match is a conversation to open, a body match is a specific line
	 * to jump to. Empty while the query is short or the search is still running.
	 */
	const [contentMatches, setContentMatches] = useState<readonly SessionMatch[]>([]);
	const [searchingContent, setSearchingContent] = useState(false);
	/** Filter over the folders that are open; paths get long, so it earns one. */
	const [projectQuery, setProjectQuery] = useState('');
	const [renamingGroupId, setRenamingGroupId] = useState<string | undefined>(undefined);
	const [groupDraft, setGroupDraft] = useState('');
	/**
	 * Blocks the user folded, or `undefined` while the defaults apply.
	 *
	 * The default is "folded unless a conversation inside is running": a reload
	 * should show the shape of the rail, not last time's set of open folders.
	 * Once a block is clicked the choice lasts for this page.
	 */
	const [foldedBlocks, setFoldedBlocks] = useState<ReadonlySet<string> | undefined>(undefined);
	/** Projects by default; the choice survives a reload. */
	const [grouping, setGrouping] = useState<Grouping>(readGrouping);
	/** Order of the project blocks, independent of how sessions are grouped. */
	const [projectSort, setProjectSort] = useState<ProjectSort>(readProjectSort);

	/**
	 * Records the open conversation as read, and keeps it read while it grows.
	 *
	 * The first run adopts the list as the baseline: dots that were there on
	 * every row of a fresh browser would mean nothing.
	 */
	useEffect(() => {
		if (seen === undefined) {
			const baseline: Record<string, number> = {};
			for (const session of sessions) {
				baseline[session.id] = session.updatedAt;
			}
			setSeen(baseline);
			writeSeen(baseline);
			return;
		}
		const current = activeSessionId ? sessions.find(session => session.id === activeSessionId) : undefined;
		if (!current || (seen[current.id] ?? 0) >= current.updatedAt) {
			return;
		}
		const next = { ...seen, [current.id]: current.updatedAt };
		setSeen(next);
		writeSeen(next);
	}, [activeSessionId, sessions, seen]);

	/**
	 * A click anywhere else closes the menu.
	 *
	 * Closing on the click itself would fire before the item's own handler: the
	 * menu unmounts, the button disappears, and the click lands on nothing.
	 */
	useEffect(() => {
		if (groupMenuFor === undefined) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest('.group-menu, .session-action.group')) {
				return;
			}
			setGroupMenuFor(undefined);
			setNewGroupName('');
		};
		document.addEventListener('mousedown', onMouseDown, true);
		return () => document.removeEventListener('mousedown', onMouseDown, true);
	}, [groupMenuFor]);

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

	// Two checkouts can share a basename; the label carries the parent only then,
	// and the row's tooltip is the absolute path on top of that.
	//
	// Both live above the early return below: a hook after a conditional return
	// changes the hook count between renders, and React then refuses to render
	// the whole rail — which is what took the project filter down with it.
	// Path matches the folder name too, so one rule covers both.
	const [showArchivedProjects, setShowArchivedProjects] = useState(false);
	const { activeProjects, archivedProjects } = useMemo(() => ({
		activeProjects: openedProjects.filter(p => p.archivedAt === undefined),
		archivedProjects: openedProjects.filter(p => p.archivedAt !== undefined),
	}), [openedProjects]);
	const visibleOpenProjects = useMemo(() => {
		const needle = projectQuery.trim().toLowerCase();
		const source = showArchivedProjects ? archivedProjects : activeProjects;
		const shown = needle === ''
			? [...source]
			: source.filter(p => p.root.toLowerCase().includes(needle));
		return shown.sort(sortBy(
			railSortPrefs.projects,
			p => p.root.split(/[\\/]/).filter(Boolean).pop() ?? p.root,
			p => ({ created: p.addedAt, updated: p.openedAt }),
		));
	}, [activeProjects, archivedProjects, showArchivedProjects, projectQuery, railSortPrefs.projects]);

	const labels = useMemo(() => projectLabels(projects), [projects]);
	const projectById = useMemo(
		() => new Map(projects.map(project => [project.id, project] as const)),
		[projects],
	);

	if (projects.length === 0) {
		return (
			<div className="session-rail">
				<div className="rail-empty">
					{t('没有找到项目。跑一次 claude 会话后，它的项目会自动出现在这里；')}
					{' '}
					{t('也可以设置')} <code>AGENT_UI_ROOTS</code> {t('手动指定。')}
				</div>
			</div>
		);
	}

	const scoped = filter === ALL ? sessions : sessions.filter(session => session.projectId === filter);
	const activeSessions = scoped.filter(session => !session.archived);
	const archivedSessions = scoped.filter(session => session.archived);
	const archivedTotal = sessions.filter(session => session.archived).length;
	const projectName = (projectId: string) => labels.get(projectId) ?? projectId;

	const search = query.trim().toLowerCase();
	const searching = search !== '';
	/** Title *and* project name: the rail is cross-project, so both identify. */
	const matchesSession = (session: SessionEntry) => !searching
		|| `${session.title} ${projectName(session.projectId)}`.toLowerCase().includes(search);
	const matchesGroupName = (group: GroupInfo) => group.name.toLowerCase().includes(search);

	// Full-text search runs on the server because the message bodies live in
	// jsonl, not in this list. Debounced so typing does not scan every project
	// on every keystroke; an outdated reply is ignored by matching the query.
	useEffect(() => {
		const term = query.trim();
		if (term.length < 2) {
			setContentMatches([]);
			setSearchingContent(false);
			return;
		}
		setSearchingContent(true);
		const timer = window.setTimeout(() => {
			void searchSessions(term, showArchived)
				.then(matches => {
					if (query.trim() === term) {
						setContentMatches(matches);
					}
				})
				.catch(() => {
					if (query.trim() === term) {
						setContentMatches([]);
					}
				})
				.finally(() => {
					if (query.trim() === term) {
						setSearchingContent(false);
					}
				});
		}, 250);
		return () => window.clearTimeout(timer);
	}, [query, showArchived]);

	/**
	 * Ctrl+F is now dispatched centrally in App: the key belongs to whichever
	 * pane has focus (chat / terminal / editor / this rail), not always to us.
	 * Listen for the rail's signal instead of grabbing every Ctrl+F globally.
	 */
	useEffect(() => {
		const onFind = () => {
			searchRef.current?.focus();
			searchRef.current?.select();
		};
		window.addEventListener('agentui:find-rail', onFind);
		return () => window.removeEventListener('agentui:find-rail', onFind);
	}, []);

	const beginRename = (session: SessionEntry) => {
		renamingRef.current = session;
		draftRef.current = session.title;
		setRenamingId(session.id);
		setDraftTitle(session.title);
	};

	/**
	 * Manual groups first, then everything that is not in one — by project, or
	 * by date.
	 *
	 * A grouped conversation appears *only* under its group. Blocks are ordered
	 * by their newest conversation: a group created in March is not "above" a
	 * project touched a minute ago just because its id came first.
	 */
	const groupIds = new Set(groups.map(group => group.id));
	const membersOf = (group: GroupInfo) => sessions.filter(session => session.groupId === group.id);
	const activityOf = (group: GroupInfo) => membersOf(group).reduce(
		(newest, session) => Math.max(newest, session.updatedAt),
		group.createdAt,
	);
	const orderedGroups = [...groups].sort(sortBy(
		railSortPrefs.groups,
		group => group.name,
		group => ({ created: group.createdAt, updated: activityOf(group) }),
	));
	const groupBucket = (group: GroupInfo): Bucket | undefined => {
		// An archived group lists its archived members; an active one lists the
		// conversations that are still in the list.
		const archived = group.archivedAt !== undefined;
		const members = membersOf(group)
			.filter(session => session.archived === archived)
			.sort(sortBy(railSortPrefs.sessions, session => session.title, session => ({ created: session.createdAt, updated: session.updatedAt })));
		// A hit on the group name keeps the whole group visible; otherwise only
		// the conversations whose own text matches — searching "parser" should
		// not drag in every unrelated conversation that shares a group.
		const nameHit = matchesGroupName(group);
		const shown = searching && !nameHit ? members.filter(matchesSession) : members;
		// While searching, a group with nothing left in it is just noise.
		return !searching || nameHit || shown.length > 0
			? { label: group.name, group, sessions: shown }
			: undefined;
	};
	const groupBuckets = orderedGroups
		.filter(group => group.archivedAt === undefined)
		.map(groupBucket)
		.filter((bucket): bucket is Bucket => bucket !== undefined);

	// A group deleted in another tab leaves sessions pointing at nothing; they
	// fall back to the project/date buckets instead of disappearing from the rail.
	const ungrouped = activeSessions.filter(session =>
		(session.groupId === undefined || !groupIds.has(session.groupId)) && matchesSession(session));
	const applySessionSort = (list: readonly SessionEntry[]) => [...list].sort(
		sortBy(railSortPrefs.sessions, session => session.title, session => ({ created: session.createdAt, updated: session.updatedAt })),
	);
	const restBuckets = grouping === 'project'
		? projectBuckets(ungrouped, projectName, projectById, projectSort, railSortPrefs.sessions)
		: bucketize(applySessionSort(ungrouped));

	// Archived conversations keep the group they were archived with: a group is
	// archived and restored as a whole, so it has to come back as a whole too.
	const archivedGroupIds = new Set(orderedGroups
		.filter(group => group.archivedAt !== undefined)
		.map(group => group.id));
	const archivedGroupBuckets = orderedGroups
		.filter(group => group.archivedAt !== undefined)
		.map(groupBucket)
		.filter((bucket): bucket is Bucket => bucket !== undefined);
	const looseArchived = archivedSessions.filter(session =>
		(session.groupId === undefined || !archivedGroupIds.has(session.groupId)) && matchesSession(session));
	const archivedBuckets: readonly Bucket[] = showArchived
		? [
			...archivedGroupBuckets,
			...(looseArchived.length > 0
				? [{ label: t('已归档（{count}）', { count: looseArchived.length }), sessions: looseArchived }]
				: []),
		]
		: [];

	const buckets: readonly Bucket[] = [...groupBuckets, ...restBuckets, ...archivedBuckets];

	/** Fold state of one block: the user's choice, else "open only if running". */
	const isCollapsed = (bucket: Bucket): boolean => {
		const key = blockKey(bucket);
		if (key === undefined || searching) {
			return false;
		}
		if (foldedBlocks !== undefined) {
			return foldedBlocks.has(key);
		}
		// Open by default when something in it is working, and for the block the
		// conversation on screen lives in — a rail that hides the current row
		// answers nothing.
		return !bucket.sessions.some(session =>
			running?.has(session.id) === true || session.id === activeSessionId);
	};

	const toggleBlock = (bucket: Bucket) => {
		const key = blockKey(bucket);
		if (key === undefined) {
			return;
		}
		setFoldedBlocks(current => {
			// First click materialises the defaults, otherwise half the rail
			// would spring open.
			const next = new Set(current ?? buckets
				.map(candidate => (isCollapsed(candidate) ? blockKey(candidate) : undefined))
				.filter((value): value is string => value !== undefined));
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	/**
	 * Creates the group from the rail's own field.
	 *
	 * The Enter key and the button share this, so trimming and "an empty name
	 * means nothing" cannot drift between the two ways of submitting.
	 */
	const commitNewGroup = () => {
		const name = newGroupDraft.trim();
		if (name === '') {
			return;
		}
		setCreatingGroup(false);
		setNewGroupDraft('');
		onCreateGroup(name);
	};

	/** Group title row: fold, rename in place, open the shared files, delete. */
	const renderGroupTitle = (group: GroupInfo, count: number, collapsed: boolean, onToggle: () => void) => {
		const renaming = renamingGroupId === group.id;
		const archived = group.archivedAt !== undefined;
		return (
			<div className={`group-title${archived ? ' archived' : ''}`}>
				<button
					type="button"
					className={`group-fold${collapsed ? '' : ' open'}`}
					title={collapsed ? t('展开这个组') : t('收起这个组')}
					onClick={onToggle}
				>
					<Icon name="chevron" />
				</button>
				{renaming ? (
					<input
						className="session-rename group-rename"
						autoFocus
						value={groupDraft}
						onChange={event => setGroupDraft(event.target.value)}
						onKeyDown={event => {
							if (event.key === 'Enter') {
								event.preventDefault();
								const next = groupDraft.trim();
								setRenamingGroupId(undefined);
								if (next && next !== group.name) {
									onRenameGroup(group, next);
								}
							} else if (event.key === 'Escape') {
								event.preventDefault();
								setRenamingGroupId(undefined);
							}
						}}
						onBlur={() => setRenamingGroupId(undefined)}
					/>
				) : (
					<button
						type="button"
						className="group-name"
						title={t('双击重命名；组内会话共享记忆与进度文件')}
						onDoubleClick={() => {
							setGroupDraft(group.name);
							setRenamingGroupId(group.id);
						}}
					>
						{group.name}
					</button>
				)}
				<span className="group-count">{count}</span>
				<span className="group-actions">
					<button
						type="button"
						className="session-action"
						title={t('编辑共享的记忆 / 进度文件')}
						onClick={() => onOpenGroupFiles(group)}
					>
						<Icon name="files" />
					</button>
					<button
						type="button"
						className="session-action"
						title={t('重命名组')}
						onClick={() => {
							setGroupDraft(group.name);
							setRenamingGroupId(group.id);
						}}
					>
						<Icon name="rename" />
					</button>
					{/* Whole-group archive: the members move to the archived list with it. */}
					<button
						type="button"
						className="session-action"
						title={archived ? t('恢复整个组（成员一起回到列表）') : t('归档整个组（成员一起隐藏）')}
						onClick={() => onArchiveGroup(group, !archived)}
					>
						<Icon name={archived ? 'unarchive' : 'archive'} />
					</button>
					<button
						type="button"
						className="session-action danger"
						title={t('删除组（会话与记录都保留）')}
						onClick={() => onDeleteGroup(group)}
					>
						<Icon name="delete" />
					</button>
				</span>
			</div>
		);
	};

	/** Project block title: fold, and where the folder is. */
	const renderProjectTitle = (
		project: NonNullable<Bucket['project']>,
		count: number,
		collapsed: boolean,
		onToggle: () => void,
	) => (
		<div className="group-title project-title">
			<button
				type="button"
				className={`group-fold${collapsed ? '' : ' open'}`}
				title={collapsed ? t('展开这个项目') : t('收起这个项目')}
				onClick={onToggle}
			>
				<Icon name="chevron" />
			</button>
			<span className="group-name project-name" title={project.hint ?? project.label}>{project.label}</span>
			<span className="group-count">{count}</span>
		</div>
	);

	return (
		<div className="session-rail">
			<div className="rail-toolbar">
				<div className="rail-actions">
					<button type="button" className="rail-new" onClick={onNewSession}>
						{t('＋ 新建会话')}
					</button>
					<button
						type="button"
						className="rail-new rail-open"
						title={t('只看代码，不新建会话')}
						onClick={onOpenProject}
					>
						{t('打开项目')}
					</button>
				</div>
				<div className="rail-tabs" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={view === 'sessions'}
						className={`rail-tab${view === 'sessions' ? ' active' : ''}`}
						onClick={() => setView('sessions')}
					>
						{t('会话')}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === 'projects'}
						className={`rail-tab${view === 'projects' ? ' active' : ''}`}
						onClick={() => setView('projects')}
					>
						{t('项目')}{openedProjects.length > 0 ? `（${openedProjects.length}）` : ''}
					</button>
				</div>
				{view === 'sessions' && (
					<ProjectFilter
						projects={projects}
						labels={labels}
						value={filter}
						onChange={setFilter}
						sessionTotal={sessions.length}
					/>
				)}
				{view === 'sessions' && (
					<>
						<div className="rail-search">
							<input
								ref={searchRef}
								value={query}
								placeholder={t('搜索会话、组或消息内容（Ctrl+F）')}
								aria-label={t('搜索会话、组或消息内容')}
								onChange={event => setQuery(event.target.value)}
								onKeyDown={event => {
									if (event.key === 'Escape') {
										event.preventDefault();
										setQuery('');
										event.currentTarget.blur();
									}
								}}
							/>
							{query !== '' && (
								<button
									type="button"
									className="rail-search-clear"
									title={t('清除搜索')}
									onClick={() => {
										setQuery('');
										searchRef.current?.focus();
									}}
								>
									×
								</button>
							)}
						</div>
						<label className="rail-check" title={t('归档的会话仍保留记录，只是默认不在这里列出')}>
							<input
								type="checkbox"
								checked={showArchived}
								onChange={event => setShowArchived(event.target.checked)}
							/>
							{t('显示已归档')}{archivedTotal > 0 ? `（${archivedTotal}）` : ''}
						</label>
					</>
				)}
			</div>

			{/*
			 * The list scrolls on its own. A sticky toolbar overlapped the first
			 * row — clicks landed on the toolbar instead of the conversation —
			 * so the toolbar and the scroll area are siblings now.
			 */}
			{view === 'sessions' ? (
			<div className="rail-list">
				{searching && (
					<div className="content-search">
						<div className="content-search-head">
							<span>{searchingContent ? t('搜索消息内容…') : t('消息内容 · {count}', { count: contentMatches.length })}</span>
						</div>
						{contentMatches.map((match, index) => (
							<button
								type="button"
								key={`${match.sessionId}:${match.index}:${index}`}
								className="content-hit"
								title={`${match.snippet}\n${match.cwd}`}
								onClick={() => onOpenMatch(match)}
							>
								<span className="content-hit-meta">
									<span className="content-hit-kind">{match.kind}</span>
									<span className="content-hit-title">{match.title}</span>
									<span className="content-hit-project">{projectName(match.projectId)}</span>
								</span>
								<span className="content-hit-snippet"><Highlighted text={match.snippet} query={query} /></span>
							</button>
						))}
						{!searchingContent && contentMatches.length === 0 && (
							<div className="content-search-empty">{t('没有在消息内容里找到匹配')}</div>
						)}
					</div>
				)}
				{/*
				 * Groups are the one cross-project thing in the rail, and the only
				 * way to make one used to be a hover button on a conversation row
				 * followed by a text field inside its menu. The entry lives here
				 * instead: always visible, one click, and it says what a group is
				 * when there are none yet.
				 */}
				<div className="groups-head">
					<span className="groups-title">{t('会话')}</span>
					{/* What the conversations outside a manual group are filed by. */}
					<div className="rail-grouping" role="group" aria-label={t('其余会话的分组方式')}>
						<button
							type="button"
							className={`rail-grouping-item${grouping === 'project' ? ' active' : ''}`}
							title={t('按工作目录分组')}
							onClick={() => {
								setGrouping('project');
								writeGrouping('project');
							}}
						>
							{t('按项目')}
						</button>
						<button
							type="button"
							className={`rail-grouping-item${grouping === 'time' ? ' active' : ''}`}
							title={t('按最后活动时间分组（今天 / 昨天 / 本周 / 更早）')}
							onClick={() => {
								setGrouping('time');
								writeGrouping('time');
							}}
						>
							{t('按时间')}
						</button>
					</div>
					{/* Only project blocks have an order of their own: the date
					    buckets are already chronological by definition. */}
					{grouping === 'project' && (
						<button
							type="button"
							className="rail-sort"
							title={projectSort === 'time'
								? t('项目按最近活动排序，点击改为按名称')
								: t('项目按名称排序，点击改为按最近活动')}
							onClick={() => {
								const next: ProjectSort = projectSort === 'time' ? 'name' : 'time';
								setProjectSort(next);
								writeProjectSort(next);
							}}
						>
							{projectSort === 'time' ? t('时间') : t('名称')}
						</button>
					)}
					<button
						type="button"
						className="groups-new"
						title={t('把不同工作区的会话聚成一组，组内共享记忆与进度文件')}
						onClick={() => {
							setCreatingGroup(open => !open);
							setNewGroupDraft('');
						}}
					>
						+ {t('新建组')}
					</button>
				</div>
				<div className="rail-sort-row">
					<span className="rail-sort-label">{t('组')}</span>
					<SortPicker mode={railSortPrefs.groups} onChange={value => onRailSortChange('groups', value)} label={t('会话组')} />
					<span className="rail-sort-label">{t('会话')}</span>
					<SortPicker mode={railSortPrefs.sessions} onChange={value => onRailSortChange('sessions', value)} label={t('组内会话')} />
				</div>
				{creatingGroup ? (
					<div className="groups-create">
						<input
							autoFocus
							value={newGroupDraft}
							placeholder={t('组名，回车创建')}
							onChange={event => setNewGroupDraft(event.target.value)}
							onKeyDown={event => {
								if (event.key === 'Escape') {
									setCreatingGroup(false);
									return;
								}
								if (event.key === 'Enter') {
									event.preventDefault();
									commitNewGroup();
								}
							}}
						/>
						<button
							type="button"
							className="groups-confirm"
							disabled={newGroupDraft.trim() === ''}
							onClick={commitNewGroup}
						>
							{t('创建')}
						</button>
						<button
							type="button"
							className="groups-cancel"
							onClick={() => {
								setCreatingGroup(false);
								setNewGroupDraft('');
							}}
						>
							{t('取消')}
						</button>
					</div>
				) : groups.length === 0 && (
					<div className="rail-empty groups-empty">
						{t('还没有会话组。不同工作区的会话可以聚成一组，组内共享记忆与进度文件。')}
					</div>
				)}
				{searching && buckets.length === 0 && (
					<div className="rail-empty">{t('没有匹配「{query}」的会话或组', { query: query.trim() })}</div>
				)}
				{!searching && activeSessions.length === 0 && !showArchived && (
					<div className="rail-empty">{t('这个项目还没有会话')}</div>
				)}
				{buckets.map(bucket => {
					const collapsed = isCollapsed(bucket);
					const key = blockKey(bucket);
					return (
					<div
						key={key ?? bucket.label}
						className={`${bucket.group ? 'group-block' : bucket.project ? 'group-block project-block' : ''}${bucket.group?.archivedAt === undefined ? '' : ' archived'}`}
					>
						{bucket.group
							? renderGroupTitle(bucket.group, bucket.sessions.length, collapsed, () => toggleBlock(bucket))
							: bucket.project
								? renderProjectTitle(bucket.project, bucket.sessions.length, collapsed, () => toggleBlock(bucket))
								: <div className="bucket-title">{bucket.label}</div>}
						{bucket.group && bucket.group.archivedAt === undefined && !collapsed && bucket.sessions.length === 0 && (
							<div className="rail-empty group-empty">
								{t('这个组还没有会话，点会话行上的分组按钮加进来')}
							</div>
						)}
						{(collapsed ? [] : bucket.sessions).map(session => {
							const live = running?.get(session.id);
							const pendingTool = approvals?.get(session.id);
							const renaming = renamingId === session.id;
							// Unseen activity, not "a process exists": the two used to share
							// one dot, so a conversation that was read still looked new until
							// its shell was reaped an hour later.
							const unread = session.id !== activeSessionId
								&& session.updatedAt > (seen?.[session.id] ?? session.updatedAt);
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
												title={`${session.title}\n${session.cwd}${pendingTool ? `\n${t('等待审批：{tool}', { tool: pendingTool })}` : ''}${live === true ? `\n${t('正在回答')}` : live === false ? `\n${t('进程在运行，空闲')}` : ''}`}
											>
												<span className="session-title">
													{live === true
														? <i className="session-run" />
														: unread && <i className="session-unread" />}
													<span className="session-text">{session.title}</span>
													{pendingTool && <span className="session-badge">{t('待审批')}</span>}
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
													className={`session-action group${session.groupId ? ' assigned' : ''}`}
													title={session.groupId ? t('已在会话组里，点击调整') : t('加入会话组')}
													onClick={() => {
														setNewGroupName('');
														setGroupMenuFor(current => current === session.id ? undefined : session.id);
													}}
												>
													<Icon name="group" />
												</button>
												<button
													type="button"
													className="session-action"
													title={t('重命名（双击会话也可）')}
													onClick={() => beginRename(session)}
												>
													<Icon name="rename" />
												</button>
												<button
													type="button"
													className="session-action"
													title={t(session.archived ? '取消归档' : '归档（保留记录，从列表隐藏）')}
													onClick={() => onArchiveSession(session, !session.archived)}
													>
													<Icon name={session.archived ? 'unarchive' : 'archive'} />
													</button>
													<button
													type="button"
													className="session-action"
													title={t('重载会话进程（让新的系统提示生效）')}
													onClick={() => onRestartSession(session)}
													>
													<Icon name="restart" />
													</button>
													<button
													type="button"
													className="session-action danger"
													title={t('删除会话（同时删除记录文件，不可恢复）')}
													onClick={() => onDeleteSession(session)}
												>
													<Icon name="delete" />
												</button>
											</span>
											{groupMenuFor === session.id && (
												/*
												 * Outside `.session-actions` on purpose: that span
												 * swallows mousedown to keep the row from focusing
												 * itself, which would stop the new-group input from
												 * ever receiving a caret.
												 */
												<div
													className="group-menu"
													onClick={event => event.stopPropagation()}
													onDoubleClick={event => event.stopPropagation()}
												>
													{groups.map(group => (
														<button
															key={group.id}
															type="button"
															className={`group-menu-item${session.groupId === group.id ? ' active' : ''}`}
															onClick={() => {
																setGroupMenuFor(undefined);
																onAssignGroup(session, group.id);
															}}
														>
															<span className="group-menu-label">{group.name}</span>
															{session.groupId === group.id && <span className="group-menu-check">✓</span>}
														</button>
													))}
													{session.groupId !== undefined && (
														<button
															type="button"
															className="group-menu-item"
															onClick={() => {
																setGroupMenuFor(undefined);
																onAssignGroup(session, undefined);
															}}
														>
															{t('移出会话组')}
														</button>
													)}
													<div className="group-menu-new">
														<input
															value={newGroupName}
															placeholder={t('新组名，回车创建')}
															onChange={event => setNewGroupName(event.target.value)}
															onKeyDown={event => {
																if (event.key !== 'Enter') {
																	return;
																}
																event.preventDefault();
																const name = newGroupName.trim();
																if (!name) {
																	return;
																}
																setGroupMenuFor(undefined);
																setNewGroupName('');
																onCreateGroup(name, session);
															}}
														/>
													</div>
												</div>
											)}
										</>
									)}
								</div>
							);
						})}
					</div>
					);
				})}
			</div>
			) : (
				<>
					<div className="rail-sort-row">
						<span className="rail-sort-label">{t('项目')}</span>
						<SortPicker mode={railSortPrefs.projects} onChange={value => onRailSortChange('projects', value)} label={t('已打开的项目')} />
					</div>
					{archivedProjects.length > 0 && (
						<label className="rail-archive-toggle">
							<input
								type="checkbox"
								checked={showArchivedProjects}
								onChange={event => setShowArchivedProjects(event.target.checked)}
							/>
							{t('显示已归档项目')}（{archivedProjects.length}）
						</label>
					)}
					<div className="rail-search">
						<input
							value={projectQuery}
							placeholder={t('搜索已打开的项目（名称或路径）')}
							aria-label={t('搜索已打开的项目')}
							onChange={event => setProjectQuery(event.target.value)}
							onKeyDown={event => {
								if (event.key === 'Escape') {
									event.preventDefault();
									setProjectQuery('');
									event.currentTarget.blur();
								}
							}}
						/>
						{projectQuery !== '' && (
							<button
								type="button"
								className="rail-search-clear"
								title={t('清除搜索')}
								onClick={() => setProjectQuery('')}
							>
								×
							</button>
						)}
					</div>
					<div className="rail-list">
						{activeProjects.length === 0 && archivedProjects.length === 0 && (
							<div className="rail-empty">{t('还没有打开的项目，点上面的「打开项目」选一个目录')}</div>
						)}
						{visibleOpenProjects.length === 0 && (activeProjects.length > 0 || archivedProjects.length > 0) && (
							<div className="rail-empty">{t('没有匹配「{query}」的项目', { query: projectQuery.trim() })}</div>
						)}
						{visibleOpenProjects.map(project => {
							const root = project.root;
							const archived = project.archivedAt !== undefined;
							return (
								<div key={root} className={`rail-project${root === openRoot ? ' active' : ''}${archived ? ' archived' : ''}`} title={root}>
									<button type="button" className="rail-project-main" onClick={() => onActivateProject(root)}>
										<span className="rail-project-name">{root.split(/[\\/]/).filter(Boolean).pop() ?? root}</span>
										<span className="rail-project-path">{root}</span>
									</button>
									<button
										type="button"
										className="rail-project-action"
										title={archived ? t('恢复项目') : t('归档项目（从列表隐藏，可恢复）')}
										onClick={() => onArchiveProject(root, !archived)}
									>
										<Icon name={archived ? 'unarchive' : 'archive'} />
									</button>
									<button
										type="button"
										className="rail-project-action"
										title={t('彻底移除记录（磁盘上的文件不受影响）')}
										onClick={() => onDeleteProject(root)}
									>
										<Icon name="delete" />
									</button>
								</div>
							);
						})}
					</div>
				</>
			)}
		</div>
	);
}

type IconName = 'rename' | 'archive' | 'unarchive' | 'delete' | 'group' | 'files' | 'restart' | 'chevron';

/** Inline so the rail has no icon-font dependency and inherits row color. */
function Icon({ name }: { readonly name: IconName }) {
	const paths: Record<IconName, readonly string[]> = {
		rename: ['M8.5 2.5l3 3L4 13H1v-3z', 'M7 4l3 3'],
		archive: ['M1.5 2.5h11v3h-11z', 'M3 5.5v6h8v-6', 'M5.5 8h3'],
		unarchive: ['M1.5 2.5h11v3h-11z', 'M3 5.5v6h8v-6', 'M5.5 8.5l1.5-1.5 1.5 1.5'],
		delete: ['M2.5 3.5h9', 'M5.5 3.5V2h3v1.5', 'M4 3.5l.6 8h4.8l.6-8'],
		// Two stacked panes: what the rail draws for a group heading.
		group: ['M1.5 2.5h11v3.5h-11z', 'M1.5 8h11v3.5h-11z'],
		files: ['M3 1.5h5l3 3v8H3z', 'M8 1.5v3h3', 'M5 6.5h4', 'M5 9h4'],
		restart: ['M13 8a5 5 0 1 1-1.7-3.8', 'M13 1.8v3.6h-3.6'],
		// Points right when folded, down when open (CSS rotates it).
		chevron: ['M5.5 3.5l4 3.5-4 3.5'],
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
	/** Set on a group bucket: its heading carries the group's own actions. */
	readonly group?: GroupInfo;
	/** Set on a project bucket in the default grouping: fold + name + count. */
	readonly project?: { readonly id: string; readonly label: string; readonly hint?: string };
}

/** Stable key of a foldable block, or `undefined` for a plain title. */
function blockKey(bucket: Bucket): string | undefined {
	if (bucket.group) {
		return `group:${bucket.group.id}`;
	}
	return bucket.project ? `project:${bucket.project.id}` : undefined;
}

/**
 * Conversations filed by the folder they run in, busiest project first.
 *
 * This is the rail's default shape: a conversation belongs to a working
 * directory, and the folder is what a person looks for. Ordering inside a
 * project and between projects is the same — most recent activity first.
 */
function projectBuckets(
	sessions: readonly SessionEntry[],
	nameOf: (projectId: string) => string,
	projectById: ReadonlyMap<string, ProjectInfo>,
	sort: ProjectSort,
	sessionSort: SortMode,
): readonly Bucket[] {
	const byProject = new Map<string, SessionEntry[]>();
	for (const session of sessions) {
		const members = byProject.get(session.projectId);
		if (members) {
			members.push(session);
		} else {
			byProject.set(session.projectId, [session]);
		}
	}
	const blocks = [...byProject.entries()].map(([projectId, members]): Bucket => {
		const sorted = [...members].sort(sortBy(sessionSort, session => session.title, session => ({ created: session.createdAt, updated: session.updatedAt })));
		return {
			label: nameOf(projectId),
			project: { id: projectId, label: nameOf(projectId), hint: projectById.get(projectId)?.cwd },
			sessions: sorted,
		};
	});
	// This orders the blocks; conversations inside each block follow the
	// separate three-way session sort. Numeric collation keeps `work2` before
	// `work10`, and `base` ignores case, like a file manager.
	return sort === 'name'
		? blocks.sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' }))
		: blocks.sort((left, right) => (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0));
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
		{ label: t('今天'), sessions: today },
		{ label: t('昨天'), sessions: yesterday },
		{ label: t('本周'), sessions: thisWeek },
		{ label: t('更早'), sessions: older },
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
