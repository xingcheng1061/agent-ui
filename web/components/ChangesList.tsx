import { useEffect, useMemo, useRef, useState } from 'react';
import { gitStatus, type GitFileEntry, type GitStatus } from '../api';
import { t } from '../i18n';

interface ChangesListProps {
	readonly root: string;
	readonly activePath: string | undefined;
	/** Bumped by the parent whenever an agent turn ends, to refetch. */
	readonly revision: number;
	readonly onSelect: (filePath: string) => void;
	readonly onCountChange: (count: number) => void;
}

interface TreeNode {
	readonly name: string;
	/** Directory prefix for folders, repo-relative path for files. */
	readonly path: string;
	readonly type: 'dir' | 'file';
	readonly children: readonly TreeNode[];
	readonly status?: string;
	readonly insertions: number;
	readonly deletions: number;
}

/** Where the list is looking: this project's files, or the rest of the repo. */
type ChangeScope = 'root' | 'above' | 'all';

/** Every directory prefix of the given files, so they can start folded. */
function directoryPaths(files: readonly GitFileEntry[]): readonly string[] {
	const paths = new Set<string>();
	for (const file of files) {
		const segments = file.path.replace(/\\/g, '/').split('/').filter(segment => segment.length > 0);
		for (let index = 1; index < segments.length; index++) {
			paths.add(segments.slice(0, index).join('/'));
		}
	}
	return [...paths];
}

/** The directories that have to stay open for `filePath` to be visible. */
function ancestorsOf(filePath: string | undefined): readonly string[] {
	if (!filePath) {
		return [];
	}
	const segments = filePath.replace(/\\/g, '/').split('/');
	const ancestors: string[] = [];
	for (let index = 1; index < segments.length; index++) {
		ancestors.push(segments.slice(0, index).join('/'));
	}
	return ancestors;
}

/** Groups a flat file list into a directory tree, aggregating stats upwards. */
function buildTree(files: readonly GitFileEntry[]): readonly TreeNode[] {
	interface MutableNode {
		readonly name: string;
		readonly path: string;
		readonly type: 'dir' | 'file';
		readonly children: MutableNode[];
		readonly status?: string;
		insertions: number;
		deletions: number;
	}

	const roots: MutableNode[] = [];

	for (const file of files) {
		const segments = file.path.replace(/\\/g, '/').split('/').filter(segment => segment.length > 0);
		if (segments.length === 0) {
			continue;
		}
		let level = roots;
		const walked: string[] = [];
		for (const segment of segments.slice(0, -1)) {
			walked.push(segment);
			const path = walked.join('/');
			let node = level.find(candidate => candidate.type === 'dir' && candidate.path === path);
			if (!node) {
				node = { name: segment, path, type: 'dir', children: [], insertions: 0, deletions: 0 };
				level.push(node);
			}
			level = node.children;
		}
		level.push({
			name: segments[segments.length - 1]!,
			path: file.path,
			type: 'file',
			children: [],
			status: file.status,
			insertions: file.insertions,
			deletions: file.deletions,
		});
	}

	const finalize = (nodes: readonly MutableNode[]): readonly TreeNode[] => {
		const sorted = [...nodes].sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === 'dir' ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
		return sorted.map(node => {
			const children = finalize(node.children);
			return {
				name: node.name,
				path: node.path,
				type: node.type,
				status: node.status,
				children,
				insertions: node.insertions + children.reduce((sum, child) => sum + child.insertions, 0),
				deletions: node.deletions + children.reduce((sum, child) => sum + child.deletions, 0),
			};
		});
	};

	return finalize(roots);
}

export function ChangesList({ root, activePath, revision, onSelect, onCountChange }: ChangesListProps) {
	const [status, setStatus] = useState<GitStatus | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	/**
	 * Folded folders. Everything starts folded: a monorepo change set expanded
	 * to the file is a wall of rows, and the shape of the change matters more
	 * than its contents until a folder is opened on purpose.
	 */
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	/** Which part of the repository is listed. */
	const [scope, setScope] = useState<ChangeScope>('root');
	/** Filter box: matches are shown flat, with their full path. */
	const [query, setQuery] = useState('');
	const trimmedQuery = query.trim().toLowerCase();
	// Read by the fetch effect, which must not depend on the selection.
	const activePathRef = useRef(activePath);
	activePathRef.current = activePath;
	/** Folders already folded once, so a refetch does not undo an open folder. */
	const knownDirsRef = useRef<ReadonlySet<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		gitStatus(root)
			.then(result => {
				if (cancelled) {
					return;
				}
				setStatus(result);
				setError(undefined);
				onCountChange(result.files.length);
				// The open file keeps its ancestors unfolded; everything else starts
				// shut. Only folders seen for the first time are folded, so the turn
				// that just ended does not close what the user opened.
				const unfolded = new Set(ancestorsOf(activePathRef.current));
				const directories = directoryPaths(result.files);
				const fresh = directories.filter(directory => !knownDirsRef.current.has(directory) && !unfolded.has(directory));
				knownDirsRef.current = new Set([...knownDirsRef.current, ...directories]);
				setFolded(previous => {
					const next = new Set(previous);
					for (const directory of fresh) {
						next.add(directory);
					}
					return next;
				});
			})
			.catch(reason => {
				if (!cancelled) {
					setError(String(reason));
				}
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [root, revision]);

	// Keep the selected file reachable: unfold its ancestors.
	useEffect(() => {
		const ancestors = ancestorsOf(activePath);
		if (ancestors.length === 0) {
			return;
		}
		setFolded(previous => {
			const next = new Set(previous);
			let changed = false;
			for (const ancestor of ancestors) {
				if (next.delete(ancestor)) {
					changed = true;
				}
			}
			return changed ? next : previous;
		});
	}, [activePath]);

	const allFiles = useMemo(() => status?.files ?? [], [status]);
	const insideFiles = useMemo(() => allFiles.filter(file => (file.scope ?? 'root') === 'root'), [allFiles]);
	const aboveFiles = useMemo(() => allFiles.filter(file => file.scope === 'above'), [allFiles]);
	// The default is the project itself: a repository that also holds other
	// checkouts used to fill this list with changes nobody here had made.
	const scopedFiles = scope === 'above' ? aboveFiles : scope === 'all' ? allFiles : insideFiles;
	const tree = useMemo(() => buildTree(scopedFiles), [scopedFiles]);
	const matches = useMemo(
		() => (trimmedQuery === ''
			? []
			: scopedFiles.filter(file => file.path.toLowerCase().includes(trimmedQuery))),
		[scopedFiles, trimmedQuery],
	);

	if (error) {
		return <div className="rail-empty">{error}</div>;
	}
	if (!status) {
		return <div className="rail-empty">{t('读取中…')}</div>;
	}
	if (!status.isRepo) {
		return <div className="rail-empty">{t('这个目录不是 git 仓库')}</div>;
	}

	const toggle = (path: string) => {
		setFolded(previous => {
			const next = new Set(previous);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	return (
		<div className="change-list">
			<div className="change-branch">
				<span>{status.branch || '(no commits yet)'}</span>
				<span className="change-count">
					{trimmedQuery === '' ? t('{count} 个文件', { count: scopedFiles.length }) : t('{matched} / {total} 个文件', { matched: matches.length, total: scopedFiles.length })}
				</span>
			</div>
			{aboveFiles.length > 0 && (
				<div className="change-scope">
					<button
						type="button"
						className={`chip${scope === 'root' ? ' active' : ''}`}
						title={t('只看这个项目目录里的变更')}
						onClick={() => setScope('root')}
					>
						{t('本项目 {count}', { count: insideFiles.length })}
					</button>
					<button
						type="button"
						className={`chip${scope === 'above' ? ' active' : ''}`}
						title={t('仓库里其它目录的变更（不在本项目内）')}
						onClick={() => setScope('above')}
					>
						{t('上层 {count}', { count: aboveFiles.length })}
					</button>
					<button
						type="button"
						className={`chip${scope === 'all' ? ' active' : ''}`}
						title={t('整个仓库的变更')}
						onClick={() => setScope('all')}
					>
						{t('全部 {count}', { count: allFiles.length })}
					</button>
				</div>
			)}
			<input
				className="change-search"
				value={query}
				onChange={event => setQuery(event.target.value)}
				onKeyDown={event => {
					if (event.key === 'Escape') {
						setQuery('');
					}
					// Enter jumps to the first match, like a quick filter.
					if (event.key === 'Enter' && matches.length > 0) {
						onSelect(matches[0]!.path);
					}
				}}
				placeholder={t('过滤变更文件')}
				spellCheck={false}
			/>
			{trimmedQuery !== ''
				? (
					<>
						{matches.length === 0 && <div className="rail-empty">{t('没有匹配「{query}」的变更', { query: query.trim() })}</div>}
						{matches.map(file => (
							<button
								type="button"
								key={file.path}
								className={`change-row${file.path === activePath ? ' active' : ''}`}
								style={{ paddingLeft: 6 }}
								onClick={() => onSelect(file.path)}
								title={file.path}
							>
								<span className={`change-status ${statusClass(file.status)}`}>{file.status}</span>
								<span className="change-path">{file.path}</span>
								<span className="change-stat">
									{file.insertions > 0 && <span className="add">+{file.insertions}</span>}
									{file.deletions > 0 && <span className="del">-{file.deletions}</span>}
								</span>
							</button>
						))}
					</>
				)
				: (
					<>
						{scopedFiles.length === 0 && (
							<div className="rail-empty">
								{allFiles.length === 0 ? t('工作区干净') : t('这个范围里没有变更')}
							</div>
						)}
						<TreeRows
							nodes={tree}
							depth={0}
							folded={folded}
							activePath={activePath}
							onToggle={toggle}
							onSelect={onSelect}
						/>
					</>
				)}
		</div>
	);
}

function TreeRows({ nodes, depth, folded, activePath, onToggle, onSelect }: {
	readonly nodes: readonly TreeNode[];
	readonly depth: number;
	readonly folded: ReadonlySet<string>;
	readonly activePath: string | undefined;
	readonly onToggle: (path: string) => void;
	readonly onSelect: (filePath: string) => void;
}) {
	return (
		<>
			{nodes.map(node => {
				if (node.type === 'dir') {
					const isFolded = folded.has(node.path);
					return (
						<div key={node.path}>
							<button
								type="button"
								className="change-row dir"
								style={{ paddingLeft: 6 + depth * 11 }}
								onClick={() => onToggle(node.path)}
								title={t('{path}（{count} 项）', { path: node.path, count: node.children.length })}
							>
								<span className="change-arrow">{isFolded ? '▸' : '▾'}</span>
								<span className="change-path">{node.name}</span>
								<span className="change-stat">
									{node.insertions > 0 && <span className="add">+{node.insertions}</span>}
									{node.deletions > 0 && <span className="del">-{node.deletions}</span>}
								</span>
							</button>
							{!isFolded && (
								<TreeRows
									nodes={node.children}
									depth={depth + 1}
									folded={folded}
									activePath={activePath}
									onToggle={onToggle}
									onSelect={onSelect}
								/>
							)}
						</div>
					);
				}

				return (
					<button
						type="button"
						key={node.path}
						className={`change-row${node.path === activePath ? ' active' : ''}`}
						style={{ paddingLeft: 6 + depth * 11 }}
						onClick={() => onSelect(node.path)}
						title={node.path}
					>
						<span className={`change-status ${statusClass(node.status ?? '')}`}>{node.status}</span>
						<span className="change-path">{node.name}</span>
						<span className="change-stat">
							{node.insertions > 0 && <span className="add">+{node.insertions}</span>}
							{node.deletions > 0 && <span className="del">-{node.deletions}</span>}
						</span>
					</button>
				);
			})}
		</>
	);
}

function statusClass(status: string): string {
	if (status.includes('?')) {
		return 'untracked';
	}
	if (status.includes('D')) {
		return 'deleted';
	}
	if (status.includes('A')) {
		return 'added';
	}
	if (status.includes('R')) {
		return 'renamed';
	}
	return 'modified';
}
