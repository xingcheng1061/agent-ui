import { useEffect, useState } from 'react';
import { addProject, browseDirectories, type BrowseResult, type ProjectInfo } from '../api';

interface NewSessionDialogProps {
	readonly projects: readonly ProjectInfo[];
	readonly onClose: () => void;
	readonly onCreate: (root: string) => Promise<void> | void;
}

export function NewSessionDialog({ projects, onClose, onCreate }: NewSessionDialogProps) {
	const [tab, setTab] = useState<'projects' | 'browse'>('projects');
	const [browse, setBrowse] = useState<BrowseResult | undefined>(undefined);
	const [pathInput, setPathInput] = useState('');
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
					<div className="modal-list">
						{projects.length === 0 && <div className="rail-empty">还没有项目，切到"选择目录"挑一个</div>}
						{projects.map(project => (
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

						<div className="browse-roots">
							{(browse?.roots ?? []).map(root => (
								<button type="button" key={root} className="chip" onClick={() => go(root)}>{root}</button>
							))}
						</div>

						<div className="modal-list">
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
