import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_LINE_COUNT_BYTES = 1024 * 1024;

/**
 * Argument-array form only: no shell, so paths cannot smuggle commands.
 *
 * `core.quotePath=false` is passed per invocation rather than written to the
 * repository's config: without it git renders non-ASCII paths as `"\344\270\255…"`,
 * which then failed every downstream step at once — the tree showed the escape
 * sequence, `fs.readFile` and `git show HEAD:<path>` both missed, so Monaco got
 * `original: ''` and painted the whole file as one green addition, and the
 * numstat keys never matched the status rows, leaving the +/- counts at zero.
 *
 * Quoting is not fully gone: a path containing a quote, a backslash or a newline
 * still gets C-style escaped, and this wrapper does not unquote it. Such paths
 * are rare enough to leave alone; add an unquote step here if one shows up.
 */
async function git(root: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		'git',
		['-C', root, '-c', 'core.quotePath=false', ...args],
		{ maxBuffer: MAX_BUFFER, windowsHide: true },
	);
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

	/** Resolved once: it is a subprocess, and both callers below need it. */
	const base = await repoRoot(root) ?? root;

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
		// `core.quotePath=false` unescapes non-ASCII names at the source; only a
		// path containing a quote / backslash / newline still arrives quoted, and
		// the quotes are all this strips (see the `git()` note on unquoting).
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
		// Paths from git are relative to the repository root, which is the session
		// root only when the project happens to *be* the repository.
		const counted = await Promise.all(pending.map(entry => countNewLines(path.join(base, entry.filePath))));
		pending.forEach((entry, index) => {
			const row = rows.find(candidate => candidate.filePath === entry.filePath);
			if (row) {
				row.insertions = counted[index]!.insertions;
			}
		});
	}

	// Display relative to the session root, so the list matches the file tree even
	// when the project is a subdirectory of the repository. `gitFileVersions`
	// accepts both conventions, so the click that follows still resolves.
	const prefix = toPosix(path.relative(base, root));
	const forDisplay = (filePath: string) => prefix && filePath.startsWith(`${prefix}/`)
		? filePath.slice(prefix.length + 1)
		: filePath;

	for (const row of rows) {
		files.push({
			path: forDisplay(row.filePath),
			status: row.status,
			insertions: row.insertions,
			deletions: row.deletions,
		});
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

/**
 * Repository root — the base every path `git status` prints is relative to.
 *
 * `git -C <subdir> status --porcelain` still answers `sub/deep/a.ts`, not
 * `deep/a.ts`, so joining those paths onto the session root doubled the prefix:
 * the working copy could not be read, and the diff showed a full file on the
 * left and nothing on the right — every line painted as deleted. Windows only
 * hid it while the project *was* the repository root.
 */
async function repoRoot(root: string): Promise<string | undefined> {
	try {
		const top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
		return top ? path.resolve(top) : undefined;
	} catch {
		return undefined;
	}
}

function toPosix(value: string): string {
	return value.split(path.sep).join('/');
}

/** Whether the worktree copy is gone by design (a deletion, not a read error). */
async function isDeletedInWorktree(base: string, filePath: string): Promise<boolean> {
	try {
		const status = await git(base, ['status', '--porcelain=v1', '--', filePath]);
		return /^( D|D |DD|AD)/.test(status);
	} catch {
		return false;
	}
}

/** HEAD version vs. working tree, both as text (binary detected via NUL). */
export async function gitFileVersions(root: string, filePath: string): Promise<GitFileVersions> {
	const base = await repoRoot(root) ?? root;
	// Two conventions reach this function: the changes list passes paths relative
	// to the repository root (that is what git printed), the file tree passes
	// paths relative to the session root. Trying both keeps either working.
	const candidates = path.isAbsolute(filePath)
		? [filePath]
		: [path.join(base, filePath), path.join(root, filePath)];

	let absolute: string | undefined;
	let modified: string | undefined;
	const problems: string[] = [];
	for (const candidate of new Set(candidates)) {
		try {
			modified = await fs.readFile(candidate, 'utf8');
			absolute = candidate;
			break;
		} catch (error) {
			problems.push(`${candidate}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
		}
	}

	/** Every way the caller's path could be spelled inside the repository. */
	const repoRelative = [...new Set([
		...(absolute ? [toPosix(path.relative(base, absolute))] : []),
		filePath,
		toPosix(path.relative(base, path.join(root, filePath))),
	])];

	if (modified === undefined) {
		// A deleted file legitimately has no working copy — that diff *is* "all
		// lines removed". Anything else is a path problem and must be reported:
		// swallowing it made the two indistinguishable, which is how every file
		// came to be painted as fully deleted.
		let deleted = false;
		for (const candidate of repoRelative) {
			if (await isDeletedInWorktree(base, candidate)) {
				deleted = true;
				break;
			}
		}
		if (!deleted) {
			throw new Error(`无法读取工作区文件 ${filePath}（尝试过 ${problems.join('；')}）`);
		}
	}

	let original: string | undefined;
	for (const candidate of repoRelative) {
		try {
			original = await git(root, ['show', `HEAD:${candidate}`]);
			break;
		} catch {
			// A wrong spelling, or an added/untracked file with no HEAD version.
		}
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
