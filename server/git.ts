import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_LINE_COUNT_BYTES = 1024 * 1024;

/** Argument-array form only: no shell, so paths cannot smuggle commands. */
async function git(root: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', ['-C', root, ...args], { maxBuffer: MAX_BUFFER, windowsHide: true });
	return stdout;
}

export interface GitFileEntry {
	readonly path: string;
	/** Two-char porcelain status, e.g. `M`, `A `, `??`, `R `. */
	readonly status: string;
	readonly insertions: number;
	readonly deletions: number;
}

export interface GitStatusResult {
	readonly isRepo: boolean;
	readonly branch?: string;
	readonly files: readonly GitFileEntry[];
}

export interface GitFileVersions {
	readonly original: string;
	readonly modified: string;
	readonly binary: boolean;
}

export async function gitStatus(root: string): Promise<GitStatusResult> {
	try {
		await git(root, ['rev-parse', '--is-inside-work-tree']);
	} catch {
		return { isRepo: false, files: [] };
	}

	let branch: string | undefined;
	try {
		branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	} catch {
		// empty repository: no commits yet
	}

	const counts = new Map<string, { insertions: number; deletions: number }>();
	try {
		for (const line of (await git(root, ['diff', '--numstat', 'HEAD'])).split('\n')) {
			const [insertions, deletions, file] = line.split('\t');
			if (file) {
				counts.set(file, { insertions: Number(insertions) || 0, deletions: Number(deletions) || 0 });
			}
		}
	} catch {
		// no HEAD yet
	}

	// `-uall` expands untracked directories into their files; the default
	// `-unormal` collapses them to a single `dir/` row, which hides the actual
	// changes from the diff picker.
	const files: GitFileEntry[] = [];
	const pending: { path: string; filePath: string }[] = [];
	const rows: { status: string; filePath: string; insertions: number; deletions: number }[] = [];
	for (const line of (await git(root, ['status', '--porcelain=v1', '-uall'])).split('\n')) {
		if (line.length < 4) {
			continue;
		}
		const status = line.slice(0, 2).trim();
		let filePath = line.slice(3).trim();
		const renamedAt = filePath.indexOf(' -> ');
		if (renamedAt >= 0) {
			filePath = filePath.slice(renamedAt + 4);
		}
		filePath = filePath.replace(/^"(.*)"$/, '$1');
		const count = counts.get(filePath);
		if (count) {
			rows.push({ status, filePath, insertions: count.insertions, deletions: count.deletions });
		} else if (status === '??') {
			// Untracked files have no HEAD version, so numstat ignores them.
			pending.push({ path: filePath, filePath });
			rows.push({ status, filePath, insertions: 0, deletions: 0 });
		} else {
			rows.push({ status, filePath, insertions: 0, deletions: 0 });
		}
	}

	if (pending.length > 0) {
		const counted = await Promise.all(pending.map(entry => countNewLines(path.join(root, entry.filePath))));
		pending.forEach((entry, index) => {
			const row = rows.find(candidate => candidate.filePath === entry.filePath);
			if (row) {
				row.insertions = counted[index]!.insertions;
			}
		});
	}

	for (const row of rows) {
		files.push({ path: row.filePath, status: row.status, insertions: row.insertions, deletions: row.deletions });
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return { isRepo: true, branch, files };
}

/** Line count of a new file; large or binary files report 0 rather than diffing. */
async function countNewLines(absolute: string): Promise<{ insertions: number; deletions: number }> {
	const buffer = await fs.readFile(absolute).catch(() => undefined);
	if (!buffer || buffer.length > MAX_LINE_COUNT_BYTES || buffer.includes(0)) {
		return { insertions: 0, deletions: 0 };
	}
	const text = buffer.toString('utf8');
	const trailing = text.endsWith('\n') ? 1 : 0;
	return { insertions: Math.max(0, text.split('\n').length - trailing), deletions: 0 };
}

/** HEAD version vs. working tree, both as text (binary detected via NUL). */
export async function gitFileVersions(root: string, filePath: string): Promise<GitFileVersions> {
	const absolute = path.join(root, filePath);
	const modified = await fs.readFile(absolute, 'utf8').catch(() => undefined);

	let original: string | undefined;
	try {
		original = await git(root, ['show', `HEAD:${filePath}`]);
	} catch {
		// added or untracked file: no HEAD version
	}

	if (modified?.includes('\u0000') || original?.includes('\u0000')) {
		return { original: '', modified: '', binary: true };
	}

	return {
		original: original ?? '',
		modified: modified ?? '',
		binary: false,
	};
}
