import { useEffect, useMemo, useState } from 'react';
import { gitStatus, type GitFileEntry, type GitStatus } from '../api';

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
	/** Folder paths the user folded shut; everything starts open. */
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
	/** Filter box: matches are shown flat, with their full path. */
	const [query, setQuery] = useState('');
	const trimmedQuery = query.trim().toLowerCase();

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
		if (!activePath) {
			return;
		}
		const segments = activePath.replace(/\\/g, '/').split('/');
		const ancestors: string[] = [];
		for (let index = 1; index < segments.length; index++) {
			ancestors.push(segments.slice(0, index).join('/'));
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

	const tree = useMemo(() => buildTree(status?.files ?? []), [status]);
	const matches = useMemo(
		() => (trimmedQuery === ''
			? []
			: (status?.files ?? []).filter(file => file.path.toLowerCase().includes(trimmedQuery))),
		[status, trimmedQuery],
	);

	if (error) {
		return <div className="rail-empty">{error}</div>;
	}
	if (!status) {
		return <div className="rail-empty">读取中…</div>;
	}
	if (!status.isRepo) {
		return <div className="rail-empty">这个目录不是 git 仓库</div>;
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
					{trimmedQuery === '' ? `${status.files.length} 个文件` : `${matches.length} / ${status.files.length} 个文件`}
				</span>
			</div>
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
				placeholder="过滤变更文件"
				spellCheck={false}
			/>
			{trimmedQuery !== ''
				? (
					<>
						{matches.length === 0 && <div className="rail-empty">没有匹配「{query.trim()}」的变更</div>}
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
						{status.files.length === 0 && <div className="rail-empty">工作区干净</div>}
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
								title={`${node.path}（${node.children.length} 项）`}
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
