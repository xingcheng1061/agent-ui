import { useEffect, useState } from 'react';
import {
	addProject,
	browseDirectories,
	findDirectories,
	type BrowseResult,
	type DirectoryHit,
	type ProjectInfo,
} from '../api';

interface NewSessionDialogProps {
	readonly projects: readonly ProjectInfo[];
	readonly onClose: () => void;
	readonly onCreate: (root: string) => Promise<void> | void;
}

export function NewSessionDialog({ projects, onClose, onCreate }: NewSessionDialogProps) {
	const [tab, setTab] = useState<'projects' | 'browse'>('projects');
	const [browse, setBrowse] = useState<BrowseResult | undefined>(undefined);
	const [pathInput, setPathInput] = useState('');
	const [projectQuery, setProjectQuery] = useState('');
	const [dirQuery, setDirQuery] = useState('');
	const [hits, setHits] = useState<readonly DirectoryHit[]>([]);
	const [hitsLoading, setHitsLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState(false);

	const go = (target?: string) => {
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

	// Typing a directory name should find a nested checkout, not only a child of
	// whichever directory is on screen — the server walks down from here.
	const searchRoot = browse?.path ?? '';
	const searching = dirQuery.trim().length >= 2;
	useEffect(() => {
		const query = dirQuery.trim();
		if (query.length < 2) {
			setHits([]);
			setHitsLoading(false);
			return;
		}
		let cancelled = false;
		setHitsLoading(true);
		const timer = window.setTimeout(() => {
			findDirectories(searchRoot, query)
				.then(result => {
					if (!cancelled) {
						setHits(result);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setHits([]);
					}
				})
				.finally(() => {
					if (!cancelled) {
						setHitsLoading(false);
					}
				});
		}, 250);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [dirQuery, searchRoot]);

	const create = async (root: string) => {
		if (busy) {
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			await addProject(root);
			await onCreate(root);
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
					<span>新建会话</span>
					<button type="button" className="modal-close" onClick={onClose}>×</button>
				</div>

				<div className="modal-tabs">
					<button type="button" className={`modal-tab${tab === 'projects' ? ' active' : ''}`} onClick={() => setTab('projects')}>已有项目</button>
					<button type="button" className={`modal-tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')}>选择目录</button>
				</div>

				{tab === 'projects' && (
					<>
						<input
							className="modal-search"
							value={projectQuery}
							onChange={event => setProjectQuery(event.target.value)}
							placeholder="搜索项目（名称或路径）"
							spellCheck={false}
							autoFocus
						/>
						<div className="modal-list">
							{projects.length === 0 && <div className="rail-empty">还没有项目，切到"选择目录"挑一个</div>}
							{projects.length > 0 && visibleProjects.length === 0 && (
								<div className="rail-empty">没有匹配「{projectQuery.trim()}」的项目</div>
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
								placeholder="输入绝对路径后回车"
								spellCheck={false}
							/>
							<button type="button" className="toggle" onClick={() => go(pathInput)}>前往</button>
						</div>

						<div className="browse-search">
							<input
								value={dirQuery}
								onChange={event => setDirQuery(event.target.value)}
								onKeyDown={event => {
									// Enter takes the best match, like a quick-open box.
									if (event.key === 'Enter' && hits.length > 0) {
										setDirQuery('');
										go(hits[0]!.path);
									}
								}}
								placeholder="搜索当前目录及其子目录（至少 2 个字）"
								spellCheck={false}
							/>
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
										{hitsLoading && <div className="rail-empty">搜索中…</div>}
										{!hitsLoading && hits.length === 0 && (
											<div className="rail-empty">
												当前目录及子目录里没有匹配的目录；可以回到上层目录再搜
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
										{browse && browse.directories.length === 0 && <div className="rail-empty">（没有子目录）</div>}
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
								在此目录新建会话
							</button>
						</div>
					</div>
				)}

				{error && <div className="modal-error">{error}</div>}
			</div>
		</div>
	);
}
