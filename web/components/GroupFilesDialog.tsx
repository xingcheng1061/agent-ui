import { useEffect, useState } from 'react';
import { readGroupFile, writeGroupFile, type GroupFileName, type GroupInfo } from '../api';
import { t } from '../i18n';

interface GroupFilesDialogProps {
	readonly group: GroupInfo;
	readonly onClose: () => void;
}

const TABS: readonly { readonly name: GroupFileName; readonly label: string; readonly hint: string }[] = [
	{
		name: 'memory',
		label: '共享记忆',
		hint: '结论、约定、决策。组内每个会话启动时都会被指向这个文件，人也可以在这里直接改。',
	},
	{
		name: 'progress',
		label: '进度',
		hint: '做到哪了、下一步做什么、卡在哪。会话之间交接工作靠它。',
	},
];

/**
 * The editor for a group's two shared files.
 *
 * These files are the whole point of a group being cross-project: no checkout
 * owns them, so they live in `~/.agent-ui/groups/<id>/` and are handed to each
 * member conversation as paths in its system prompt. Editing them here is the
 * same as the agent editing them with its file tools.
 */
export function GroupFilesDialog({ group, onClose }: GroupFilesDialogProps) {
	const [active, setActive] = useState<GroupFileName>('memory');
	const [texts, setTexts] = useState<Record<GroupFileName, string>>({ memory: '', progress: '' });
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState('');
	/** Which tab's content differs from disk, so "saved" cannot lie. */
	const [dirty, setDirty] = useState<ReadonlySet<GroupFileName>>(() => new Set());

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		Promise.all([readGroupFile(group.id, 'memory'), readGroupFile(group.id, 'progress')])
			.then(([memory, progress]) => {
				if (cancelled) {
					return;
				}
				setTexts({ memory, progress });
				setLoading(false);
			})
			.catch(error => {
				if (!cancelled) {
					setStatus(String(error));
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [group.id]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	const save = async () => {
		setSaving(true);
		try {
			// Every tab is written, not just the visible one: switching tabs must
			// not silently drop the other file's edits.
			for (const name of ['memory', 'progress'] as const) {
				if (!dirty.has(name)) {
					continue;
				}
				await writeGroupFile(group.id, name, texts[name]);
			}
			setDirty(new Set());
			setStatus(t('已保存'));
		} catch (error) {
			setStatus(String(error));
		} finally {
			setSaving(false);
		}
	};

	const tab = TABS.find(candidate => candidate.name === active) ?? TABS[0]!;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal group-files" onClick={event => event.stopPropagation()}>
				<div className="modal-header">
					<strong>{group.name}</strong>
					<button type="button" className="modal-close" onClick={onClose} title={t('关闭（Esc）')}>×</button>
				</div>
				<div className="modal-tabs">
					{TABS.map(candidate => (
						<button
							key={candidate.name}
							type="button"
							className={`modal-tab${candidate.name === active ? ' active' : ''}`}
							onClick={() => setActive(candidate.name)}
						>
							{candidate.label}
							{dirty.has(candidate.name) ? ' ●' : ''}
						</button>
					))}
				</div>
				<p className="group-files-hint">
					{t(tab.hint)}
				</p>
				<textarea
					className="group-files-text"
					value={texts[tab.name]}
					disabled={loading}
					spellCheck={false}
					onChange={event => {
						const value = event.target.value;
						const name = tab.name;
						setTexts(current => ({ ...current, [name]: value }));
						setDirty(current => new Set(current).add(name));
					}}
					onKeyDown={event => {
						if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
							event.preventDefault();
							void save();
						}
					}}
				/>
				<div className="group-files-foot">
					<span className="group-files-path">
						{`~/.agent-ui/groups/${group.id.slice(0, 8)}/${tab.name}.md`}
					</span>
					<span className="spacer" />
					<span className="status">{loading ? t('载入中…') : status}</span>
					<button type="button" className="toggle" onClick={() => void save()} disabled={loading || saving}>
						{saving ? t('保存中…') : t('保存')}
					</button>
				</div>
			</div>
		</div>
	);
}
