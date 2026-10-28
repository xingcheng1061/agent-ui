import { useCallback, useEffect, useState } from 'react';
import { listDirectory, type FileEntry } from '../api';

interface DirectoryState {
	readonly open: boolean;
	readonly loading: boolean;
	readonly entries?: readonly FileEntry[];
	readonly error?: string;
}

interface FileTreeProps {
	readonly root: string;
	readonly selectedPath: string | undefined;
	readonly onOpenFile: (filePath: string) => void;
}

export function FileTree({ root, selectedPath, onOpenFile }: FileTreeProps) {
	const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});

	const load = useCallback(async (directory: string) => {
		setDirectories(previous => ({
			...previous,
			[directory]: { open: true, loading: true, entries: previous[directory]?.entries },
		}));
		try {
			const entries = await listDirectory(root, directory);
			setDirectories(previous => ({ ...previous, [directory]: { open: true, loading: false, entries } }));
		} catch (error) {
			setDirectories(previous => ({
				...previous,
				[directory]: { open: true, loading: false, entries: previous[directory]?.entries, error: String(error) },
			}));
		}
	}, [root]);

	const toggle = useCallback((entry: FileEntry) => {
		if (entry.type === 'file') {
			onOpenFile(entry.path);
			return;
		}
		const state = directories[entry.path];
		if (!state || !state.entries) {
			void load(entry.path);
			return;
		}
		setDirectories(previous => ({
			...previous,
			[entry.path]: { ...previous[entry.path], open: !previous[entry.path]?.open, loading: false },
		}));
	}, [directories, load, onOpenFile]);

	useEffect(() => {
		void load('');
	}, [load]);

	const renderDirectory = (directory: string, depth: number): JSX.Element[] => {
		const state = directories[directory];
		if (!state?.open || !state.entries) {
			return [];
		}
		return state.entries.flatMap(entry => {
			const isSelected = entry.type === 'file' && entry.path === selectedPath;
			const row = (
				<div
					key={entry.path}
					className={`tree-row${isSelected ? ' selected' : ''}`}
					style={{ paddingLeft: 8 + depth * 12 }}
					onClick={() => toggle(entry)}
					role="treeitem"
					aria-expanded={entry.type === 'dir' ? state.open : undefined}
					tabIndex={0}
					onKeyDown={event => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							toggle(entry);
						}
					}}
				>
					<span className="tree-icon">{entry.type === 'dir' ? (directories[entry.path]?.open ? '▾' : '▸') : '·'}</span>
					<span className="tree-label">{entry.name}</span>
				</div>
			);
			return entry.type === 'dir' ? [row, ...renderDirectory(entry.path, depth + 1)] : [row];
		});
	};

	const rootError = directories['']?.error;
	const rootLoading = directories['']?.loading;

	return (
		<div className="file-tree" role="tree">
			{rootLoading && <div className="tree-hint">loading…</div>}
			{rootError && <div className="tree-hint error">{rootError}</div>}
			{renderDirectory('', 0)}
		</div>
	);
}
