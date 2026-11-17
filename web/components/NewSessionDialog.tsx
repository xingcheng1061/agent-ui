import { useEffect, useRef, useState } from 'react';
import {
	addProject,
	browseDirectories,
	findDirectories,
	type BrowseResult,
	type DirectoryHit,
	type GroupInfo,
	type ProjectInfo,
} from '../api';
import { t } from '../i18n';

interface NewSessionDialogProps {
	readonly projects: readonly ProjectInfo[];
	readonly groups: readonly GroupInfo[];
	/**
	 * `browse` picks a folder to read instead of one to start in: no group, no
	 * conversation, and the folder is the only thing being chosen.
	 */
	readonly mode?: 'create' | 'browse';
	readonly onClose: () => void;
	/** `groupId` is applied once the conversation has an id of its own. */
	readonly onCreate: (root: string, groupId?: string) => Promise<void> | void;
}

export function NewSessionDialog({ projects, groups, mode = 'create', onClose, onCreate }: NewSessionDialogProps) {
	const browsing = mode === 'browse';
	const [tab, setTab] = useState<'projects' | 'browse'>('projects');
	// Chosen up front: a conversation can be filed while it is being created,
	// instead of having to send a message first and move it afterwards.
	const [groupId, setGroupId] = useState('');
	const [groupOpen, setGroupOpen] = useState(false);
	const groupPickerRef = useRef<HTMLDivElement | null>(null);
	const selectedGroup = groups.find(group => group.id === groupId);
	const [browse, setBrowse] = useState<BrowseResult | undefined>(undefined);
	const [pathInput, setPathInput] = useState('');
	const [projectQuery, setProjectQuery] = useState('');
	const [dirQuery, setDirQuery] = useState('');
	/** The query actually searched for — typing alone does not run a walk. */
	const [dirSearch, setDirSearch] = useState('');
	const [hits, setHits] = useState<readonly DirectoryHit[]>([]);
	const [hitsLoading, setHitsLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	/** Sequence so a slow answer cannot overwrite a newer search. */
	const searchSeq = useRef(0);

	const go = (target?: string) => {
		searchSeq.current += 1;
		setDirQuery('');
		setDirSearch('');
		setHits([]);
		setHitsLoading(false);
		browseDirectories(target)
			.then(result => {
				setBrowse(result);
				setPathInput(result.path);
				setError(undefined);
			})
			.catch(reason => setError(String(reason)));
	};

	useEffect(() => {
		if (tab === 'browse' && !browse) {
			go(undefined);
		}
	}, [tab, browse]);

	// A click outside the picker folds it away. `mousedown` and not `click`, for
	// the same reason as the rail's group menu: the click that closes would
	// otherwise land on whatever is underneath the menu that just vanished.
	useEffect(() => {
		if (!groupOpen) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			if (event.target instanceof Node && groupPickerRef.current?.contains(event.target)) {
				return;
			}
			setGroupOpen(false);
		};
		document.addEventListener('mousedown', onMouseDown, true);
		return () => document.removeEventListener('mousedown', onMouseDown, true);
	}, [groupOpen]);

	// The walk runs only when submitted: typing is cheap, walking a big tree is
	// not, so the box does not search on every keystroke.
	const searching = dirSearch !== '';
	const search = (raw: string) => {
		const query = raw.trim();
		const seq = searchSeq.current + 1;
		searchSeq.current = seq;
		if (query.length < 2) {
			setDirSearch('');
			setHits([]);
			setHitsLoading(false);
			return;
		}
		// A directory name should find a nested checkout, not only a child of
		// whichever directory is on screen — the server searches down from here.
		setDirSearch(query);
		setHitsLoading(true);
		findDirectories(browse?.path ?? '', query)
			.then(result => {
				if (searchSeq.current === seq) {
					setHits(result);
				}
			})
			.catch(() => {
				if (searchSeq.current === seq) {
					setHits([]);
				}
			})
			.finally(() => {
				if (searchSeq.current === seq) {
					setHitsLoading(false);
				}
			});
	};

	const create = async (root: string) => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			// Registering the folder is not optional: the file APIs resolve paths
			// against known project roots, so browsing one would open empty.
			await addProject(root);
			await onCreate(root, browsing || groupId === '' ? undefined : groupId);
		} catch (reason) {
			setError(String(reason));
			setBusy(false);
		}
	};

	const query = projectQuery.trim().toLowerCase();
	const visibleProjects = query === ''
		? projects
		: projects.filter(project => project.name.toLowerCase().includes(query) || project.cwd.toLowerCase().includes(query));

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={event => event.stopPropagation()}>
				<div className="modal-header">
					<span>{browsing ? t('打开项目') : t('新建会话')}</span>
					<button type="button" className="modal-close" onClick={onClose}>×</button>
				</div>

				<div className="modal-tabs">
					<button type="button" className={`modal-tab${tab === 'projects' ? ' active' : ''}`} onClick={() => setTab('projects')}>{t('已有项目')}</button>
					<button type="button" className={`modal-tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')}>{t('选择目录')}</button>
				</div>

				{!browsing && groups.length > 0 && (
					<div className="modal-group">
						<span className="modal-group-label">{t('会话组')}</span>
						<div className="modal-group-pick" ref={groupPickerRef}>
							<button
								type="button"
								className={`group-pick${selectedGroup ? ' set' : ''}${groupOpen ? ' open' : ''}`}
								title={t('新会话直接归到这个组，不用先聊一句')}
								aria-haspopup="listbox"
								aria-expanded={groupOpen}
								onClick={() => setGroupOpen(open => !open)}
								onKeyDown={event => {
									if (event.key === 'Escape' && groupOpen) {
										// Escape would otherwise close the whole dialog.
										event.stopPropagation();
										setGroupOpen(false);
									}
								}}
							>
								<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
									<path d="M1.5 2.5h11v3.5h-11z" />
									<path d="M1.5 8h11v3.5h-11z" />
								</svg>
								<span className="group-pick-name">{selectedGroup?.name ?? t('不分组')}</span>
								<span className="group-pick-caret">▾</span>
							</button>
							{groupOpen && (
								<div className="group-pick-menu" role="listbox">
									<button
										type="button"
										role="option"
										aria-selected={groupId === ''}
										className={`group-menu-item${groupId === '' ? ' active' : ''}`}
										onClick={() => {
											setGroupId('');
											setGroupOpen(false);
										}}
									>
										<span className="group-menu-label">{t('不分组')}</span>
										{groupId === '' && <span className="group-menu-check">✓</span>}
									</button>
									{groups.map(group => (
										<button
											key={group.id}
											type="button"
											role="option"
											aria-selected={groupId === group.id}
											className={`group-menu-item${groupId === group.id ? ' active' : ''}`}
											onClick={() => {
												setGroupId(group.id);
												setGroupOpen(false);
											}}
										>
											<span className="group-menu-label">{group.name}</span>
											{groupId === group.id && <span className="group-menu-check">✓</span>}
										</button>
									))}
								</div>
							)}
						</div>
					</div>
				)}

				{tab === 'projects' && (
					<>
						<input
							className="modal-search"
							value={projectQuery}
							onChange={event => setProjectQuery(event.target.value)}
							placeholder={t('搜索项目（名称或路径）')}
							spellCheck={false}
							autoFocus
						/>
						<div className="modal-list">
							{projects.length === 0 && <div className="rail-empty">{t('还没有项目，切到"选择目录"挑一个')}</div>}
							{projects.length > 0 && visibleProjects.length === 0 && (
								<div className="rail-empty">{t('没有匹配「{query}」的项目', { query: projectQuery.trim() })}</div>
							)}
							{visibleProjects.map(project => (
								<button
									type="button"
									key={project.id}
									className="modal-item"
									onClick={() => { void create(project.cwd); }}
									disabled={busy}
								>
									<span className="modal-item-name">{project.name}</span>
									<span className="modal-item-sub">{project.cwd}</span>
								</button>
							))}
						</div>
					</>
				)}

				{tab === 'browse' && (
					<div className="modal-browse">
						<div className="browse-path">
							<input
								value={pathInput}
								onChange={event => setPathInput(event.target.value)}
								onKeyDown={event => {
									if (event.key === 'Enter') {
										go(pathInput);
									}
								}}
								placeholder={t('输入绝对路径后回车')}
								spellCheck={false}
							/>
							<button type="button" className="toggle" onClick={() => go(pathInput)}>{t('前往')}</button>
						</div>

						<div className="browse-search">
							<input
								value={dirQuery}
								onChange={event => setDirQuery(event.target.value)}
								onKeyDown={event => {
									// Only a submitted query searches: Enter or the button.
									if (event.key === 'Enter') {
										search(dirQuery);
									}
								}}
								placeholder={t('搜索当前目录及其子目录（至少 2 个字）')}
								spellCheck={false}
							/>
							<button type="button" className="toggle" onClick={() => search(dirQuery)}>{t('搜索')}</button>
						</div>

						<div className="browse-roots">
							{(browse?.roots ?? []).map(root => (
								<button type="button" key={root} className="chip" onClick={() => go(root)}>{root}</button>
							))}
						</div>

						<div className="modal-list">
							{searching
								? (
									<>
										{hitsLoading && <div className="rail-empty">{t('搜索中…')}</div>}
										{!hitsLoading && hits.length === 0 && (
											<div className="rail-empty">
												{t('当前目录及子目录里没有匹配的目录；可以回到上层目录再搜')}
											</div>
										)}
										{hits.map(hit => (
											<button
												type="button"
												key={hit.path}
												className="modal-item dir"
												onClick={() => {
													setDirQuery('');
													go(hit.path);
												}}
											>
												<span className="modal-item-name">{hit.name}/</span>
												<span className="modal-item-sub">{hit.path}</span>
											</button>
										))}
									</>
								)
								: (
									<>
										{browse?.parent && (
											<button type="button" className="modal-item dir" onClick={() => go(browse.parent)}>
												<span className="modal-item-name">..</span>
												<span className="modal-item-sub">{browse.parent}</span>
											</button>
										)}
										{(browse?.directories ?? []).map(directory => (
											<button type="button" key={directory.path} className="modal-item dir" onClick={() => go(directory.path)}>
												<span className="modal-item-name">{directory.name}/</span>
											</button>
										))}
										{browse && browse.directories.length === 0 && <div className="rail-empty">{t('（没有子目录）')}</div>}
									</>
								)}
						</div>

						<div className="modal-footer">
							<span className="browse-current">{browse?.path ?? ''}</span>
							<button
								type="button"
								className="primary"
								disabled={!browse || busy}
								onClick={() => { if (browse) { void create(browse.path); } }}
							>
								{browsing ? t('打开这个目录') : t('在此目录新建会话')}
							</button>
						</div>
					</div>
				)}

				{error && <div className="modal-error">{error}</div>}
			</div>
		</div>
	);
}
