import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { MAX_FILE_SIZE } from './config.js';
import { BadRequestError, IGNORED_NAMES, readStringQuery, resolveRoot, shouldIgnore, toAbsolute, toRelative } from './paths.js';

export const fsRouter = Router();

/** One directory level; the client expands directories lazily. */
fsRouter.get('/list', async (req, res) => {
	const root = await resolveRoot(readStringQuery(req.query['root'], 'root'));
	const relative = readStringQuery(req.query['path'] ?? '', 'path');
	const absolute = toAbsolute(root, relative);
	const dirents = await fs.readdir(absolute, { withFileTypes: true });

	const entries = dirents
		.filter(dirent => !shouldIgnore(dirent.name))
		.map(dirent => ({
			name: dirent.name,
			path: toRelative(root, path.join(absolute, dirent.name)),
			type: dirent.isDirectory() ? 'dir' as const : 'file' as const,
		}))
		.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);

	res.json({ root, path: toRelative(root, absolute), entries });
});

/**
 * Path search for the `@` mention picker. Bounded by depth, scanned entries and
 * result count so a huge checkout cannot stall the request.
 */
fsRouter.get('/search', async (req, res) => {
	const root = await resolveRoot(readStringQuery(req.query['root'], 'root'));
	const query = readStringQuery(req.query['q'] ?? '', 'q').toLowerCase();
	const skip = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', 'coverage', '.cache']);
	const files: string[] = [];
	const dirs: string[] = [];
	let scanned = 0;
	const full = () => files.length >= 200 || dirs.length >= 100;

	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > 8 || scanned > 20000 || full()) {
			return;
		}
		const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			if (scanned++ > 20000 || full()) {
				return;
			}
			if (dirent.isDirectory()) {
				if (skip.has(dirent.name) || shouldIgnore(dirent.name)) {
					continue;
				}
				const relative = toRelative(root, path.join(directory, dirent.name));
				// A directory is a destination the tree can expand, not a file to
				// open, so it is collected separately instead of sharing `files`.
				if (!query || relative.toLowerCase().includes(query)) {
					dirs.push(relative);
				}
				await walk(path.join(directory, dirent.name), depth + 1);
			} else if (dirent.isFile()) {
				const relative = toRelative(root, path.join(directory, dirent.name));
				if (!query || relative.toLowerCase().includes(query)) {
					files.push(relative);
				}
			}
		}
	};

	await walk(root, 0);
	// Shorter paths first: `package.json` before `server/agent/package.json`.
	files.sort((a, b) => a.length - b.length || a.localeCompare(b));
	dirs.sort((a, b) => a.length - b.length || a.localeCompare(b));
	res.json({ files, dirs, truncated: full() });
});

fsRouter.get('/read', async (req, res) => {
	const root = await resolveRoot(readStringQuery(req.query['root'], 'root'));
	const relative = readStringQuery(req.query['path'], 'path');
	const absolute = toAbsolute(root, relative);
	const stat = await fs.stat(absolute);
	if (!stat.isFile()) {
		throw new BadRequestError(`Not a file: ${relative}`);
	}
	if (stat.size > MAX_FILE_SIZE) {
		res.status(413).json({ error: `File is larger than ${MAX_FILE_SIZE} bytes.` });
		return;
	}

	const contents = await fs.readFile(absolute);
	if (contents.includes(0)) {
		res.status(415).json({ error: 'Binary file cannot be opened in the editor.' });
		return;
	}

	res.json({ path: relative, content: contents.toString('utf8'), size: stat.size });
});

fsRouter.post('/write', async (req, res) => {
	const body: unknown = req.body;
	if (typeof body !== 'object' || body === null) {
		throw new BadRequestError('Expected a JSON body.');
	}
	const { root, path: relative, content } = body as { root?: unknown; path?: unknown; content?: unknown };
	if (typeof root !== 'string' || typeof relative !== 'string' || typeof content !== 'string') {
		throw new BadRequestError('`root`, `path` and `content` must be strings.');
	}

	const resolvedRoot = await resolveRoot(root);
	const absolute = toAbsolute(resolvedRoot, relative);
	const existing = await fs.stat(absolute).catch(() => undefined);
	if (existing && !existing.isFile()) {
		throw new BadRequestError(`Not a file: ${relative}`);
	}

	await fs.writeFile(absolute, content, 'utf8');
	res.json({ ok: true, path: relative });
});

/**
 * New file or directory from the tree.
 *
 * An existing entry is an error on purpose: the inline input is one mistyped
 * keystroke away from a file that already has content, and truncating it is
 * not something a "new file" action may do.
 */
fsRouter.post('/create', async (req, res) => {
	const body: unknown = req.body;
	if (typeof body !== 'object' || body === null) {
		throw new BadRequestError('Expected a JSON body.');
	}
	const { root, path: relative, type } = body as { root?: unknown; path?: unknown; type?: unknown };
	if (typeof root !== 'string' || typeof relative !== 'string' || typeof type !== 'string') {
		throw new BadRequestError('`root`, `path` and `type` are required.');
	}
	if (type !== 'file' && type !== 'dir') {
		throw new BadRequestError('`type` must be "file" or "dir".');
	}

	const resolvedRoot = await resolveRoot(root);
	const absolute = toAbsolute(resolvedRoot, relative.trim());
	if (absolute === resolvedRoot) {
		throw new BadRequestError('The project root already exists.');
	}
	const parent = path.dirname(absolute);
	const parentStat = await fs.stat(parent).catch(() => undefined);
	if (!parentStat?.isDirectory()) {
		throw new BadRequestError(`目录不存在：${toRelative(resolvedRoot, parent)}`);
	}

	try {
		if (type === 'dir') {
			await fs.mkdir(absolute);
		} else {
			// `wx` fails instead of truncating, which is what the check above is for.
			await fs.writeFile(absolute, '', { encoding: 'utf8', flag: 'wx' });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			res.status(409).json({ error: `同名文件或目录已存在：${relative}` });
			return;
		}
		throw error;
	}

	res.json({ ok: true, path: toRelative(resolvedRoot, absolute), type });
});

/**
 * Rename or move one entry inside the root.
 *
 * `to` is a full relative path rather than just a name: the inline input edits
 * the last segment today, and a future "move to…" action sends another folder.
 * A directory cannot be renamed into its own subtree — `fs.rename` fails with
 * an opaque EINVAL there, so it is refused up front.
 */
fsRouter.post('/rename', async (req, res) => {
	const body: unknown = req.body;
	if (typeof body !== 'object' || body === null) {
		throw new BadRequestError('Expected a JSON body.');
	}
	const { root, from, to } = body as { root?: unknown; from?: unknown; to?: unknown };
	if (typeof root !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
		throw new BadRequestError('`root`, `from` and `to` must be strings.');
	}
	if (from.trim() === '' || to.trim() === '') {
		throw new BadRequestError('`from` and `to` are required.');
	}

	const resolvedRoot = await resolveRoot(root);
	const source = toAbsolute(resolvedRoot, from.trim());
	const target = toAbsolute(resolvedRoot, to.trim());
	if (source === resolvedRoot || target === resolvedRoot) {
		throw new BadRequestError('不能重命名项目根目录。');
	}
	if (source === target) {
		res.json({ ok: true, path: toRelative(resolvedRoot, target) });
		return;
	}
	if (target.startsWith(source + path.sep)) {
		throw new BadRequestError('不能把目录移动到它自己里面。');
	}

	const parent = path.dirname(target);
	const parentStat = await fs.stat(parent).catch(() => undefined);
	if (!parentStat?.isDirectory()) {
		throw new BadRequestError(`目录不存在：${toRelative(resolvedRoot, parent)}`);
	}
	// Renaming onto an existing name would silently replace it on some
	// platforms; the tree's inline input must not be a way to lose a file.
	const existing = await fs.stat(target).catch(() => undefined);
	if (existing) {
		res.status(409).json({ error: `同名文件或目录已存在：${toRelative(resolvedRoot, target)}` });
		return;
	}
	const stat = await fs.stat(source).catch(() => undefined);
	if (!stat) {
		res.status(404).json({ error: `不存在：${from}` });
		return;
	}

	await fs.rename(source, target);
	res.json({ ok: true, path: toRelative(resolvedRoot, target) });
});

/** Deletes one entry from the tree; a directory goes with everything inside it. */
fsRouter.delete('/delete', async (req, res) => {
	const body: unknown = req.body;
	if (typeof body !== 'object' || body === null) {
		throw new BadRequestError('Expected a JSON body.');
	}
	const { root, path: relative } = body as { root?: unknown; path?: unknown };
	if (typeof root !== 'string' || typeof relative !== 'string' || relative.trim() === '') {
		throw new BadRequestError('`root` and `path` are required.');
	}

	const resolvedRoot = await resolveRoot(root);
	const absolute = toAbsolute(resolvedRoot, relative.trim());
	// Deleting the root would take the whole project, sessions included.
	if (absolute === resolvedRoot) {
		throw new BadRequestError('不能删除项目根目录。');
	}

	const stat = await fs.stat(absolute).catch(() => undefined);
	if (!stat) {
		res.status(404).json({ error: `不存在：${relative}` });
		return;
	}
	// `rm` on a symlink removes the link, not what it points at.
	await fs.rm(absolute, { recursive: stat.isDirectory(), force: false });
	res.json({ ok: true });
});

/** Deep enough for a monorepo module, bounded so a huge tree cannot stall. */
const FIND_DIRS_MAX_DEPTH = 20;
/** Entries the in-process fallback may read before it gives up. */
const FIND_DIRS_MAX_SCANNED = 500_000;
const FIND_DIRS_MAX_RESULTS = 100;
/** Wall clock for the walk: an entry budget alone does not bound a slow disk. */
const FIND_DIRS_BUDGET_MS = 10_000;
/** A native search that has not answered by now is worse than the walk. */
const NATIVE_SEARCH_TIMEOUT_MS = 8_000;
const NATIVE_SEARCH_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Runs one search binary and returns its stdout.
 *
 * No shell: every argument is its own argv element, so a query containing
 * quotes or `;` cannot turn into a command.
 */
function runSearchCommand(
	file: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, [...args], {
			...options,
			timeout: NATIVE_SEARCH_TIMEOUT_MS,
			maxBuffer: NATIVE_SEARCH_MAX_BUFFER,
			windowsHide: true,
		}, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(stdout);
		});
	});
}

/** `find -ipath` matches a glob, so a literal `*`, `?` or `[` has to be escaped. */
function escapeFindGlob(query: string): string {
	return query.replace(/[*?[\\]/g, character => `\\${character}`);
}

/**
 * `find` on POSIX, PowerShell on Windows; `undefined` when neither can run.
 *
 * Results are absolute paths, and the caller re-applies the same filters the
 * walk uses — an over-eager native predicate can cost time, never correctness.
 */
async function nativeDirectorySearch(start: string, query: string, maxDepth: number): Promise<string[] | undefined> {
	try {
		if (process.platform === 'win32') {
			// The query travels in the environment, not inside the script: no
			// quoting rules, no interpolation, nothing to escape.
			//
			// `Get-ChildItem -Recurse` cannot prune, so the ignored directories
			// are filtered out of the result instead of being skipped: they still
			// cost a walk, but they no longer eat the result cap.
			const prunedPattern = [...IGNORED_NAMES]
				.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				.join('|');
			const script = [
				'$ErrorActionPreference = "SilentlyContinue"',
				'Get-ChildItem -LiteralPath $env:AGENT_UI_DIR_START -Directory -Recurse -Depth ([int]$env:AGENT_UI_DIR_DEPTH) |',
				`Where-Object { $_.FullName -notmatch '[\\\\/](?:${prunedPattern})[\\\\/]' } |`,
				'Where-Object { $_.FullName.IndexOf($env:AGENT_UI_DIR_QUERY, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |',
				'Select-Object -First 400 -ExpandProperty FullName',
			].join('\n');
			const stdout = await runSearchCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
				env: {
					...process.env,
					AGENT_UI_DIR_START: start,
					AGENT_UI_DIR_QUERY: query,
					AGENT_UI_DIR_DEPTH: String(maxDepth),
				},
			});
			return stdout.split(/\r?\n/).filter(line => line !== '');
		}
		// `.` and the search root as cwd: `-ipath` matches the printed path, and
		// matching the absolute one lets the root's own name match everything.
		const prunedNames = [...IGNORED_NAMES].filter(name => !name.startsWith('.'));
		const args = [
			'.',
			'-maxdepth', String(maxDepth),
			'(',
			// `.?*` and not `.*`: the latter also matches `.`, the start path
			// itself, so `-prune` would stop at the root and find nothing.
			'-name', '.?*',
			...prunedNames.flatMap(name => ['-o', '-name', name]),
			')',
			'-prune',
			'-o', '-type', 'd', '-ipath', `*${escapeFindGlob(query)}*`, '-print',
		];
		const stdout = await runSearchCommand('find', args, { cwd: start });
		return stdout
			.split('\n')
			.filter(line => line !== '' && line !== '.')
			.map(line => path.resolve(start, line));
	} catch {
		// No binary, an old `find` without `-ipath`, or a timeout: walk instead.
		return undefined;
	}
}

/**
 * Directory search for the project picker.
 *
 * Typing `agent` should find a nested checkout, not only a child of whichever
 * directory the picker happens to be showing, so this looks downwards from the
 * current one.
 *
 * Two strategies, one answer:
 *
 * 1. `find` on POSIX, PowerShell on Windows. They prune the ignored names
 *    before descending and need no `readdir` per directory, which is the
 *    difference between a fraction of a second and a stall on a tree with tens
 *    of thousands of directories.
 * 2. The in-process walk, breadth first, for a platform without the binary or
 *    a `find` too old for `-ipath`. Level by level on purpose: the budget is
 *    finite, and a depth-first walk spends all of it inside the first big
 *    subtree it enters — searching `~/mail` for `mmbizwxverify` (two levels
 *    down) came back empty that way.
 */
fsRouter.get('/find-dirs', async (req, res) => {
	const requested = typeof req.query['path'] === 'string' ? req.query['path'] : '';
	const start = requested ? path.resolve(requested) : os.homedir();
	const query = (typeof req.query['q'] === 'string' ? req.query.q : '').trim().toLowerCase();
	if (query.length < 2) {
		res.json({ path: start, directories: [], truncated: false });
		return;
	}

	const directories: { name: string; path: string }[] = [];
	const seen = new Set<string>();

	/**
	 * Adds one hit, re-checked against the rules the walk applies.
	 *
	 * The native tools match on the absolute path, which contains the search
	 * root too: searching under `~/mail` for `mail` would otherwise match every
	 * directory below it. Matching the relative path here keeps both strategies
	 * answering the same question.
	 */
	const add = (absolute: string): void => {
		if (directories.length >= FIND_DIRS_MAX_RESULTS) {
			return;
		}
		const name = path.basename(absolute);
		const relative = path.relative(start, absolute).split(path.sep).join('/');
		if (relative === '' || relative.startsWith('..') || seen.has(absolute)) {
			return;
		}
		// Hidden directories (`.git`, `.venv`, `.cache`, …) are never a project
		// root worth offering, and skipping them keeps the walk fast.
		if (relative.split('/').some(segment => segment.startsWith('.') || shouldIgnore(segment))) {
			return;
		}
		if (!relative.toLowerCase().includes(query) && !name.toLowerCase().includes(query)) {
			return;
		}
		seen.add(absolute);
		directories.push({ name, path: absolute });
	};

	// The directory on screen counts as a hit: "it is right here" is the most
	// common reason a search looks broken.
	if (path.basename(start).toLowerCase().includes(query)) {
		directories.push({ name: path.basename(start), path: start });
	}

	const native = await nativeDirectorySearch(start, query, FIND_DIRS_MAX_DEPTH);
	let truncated = false;
	if (native) {
		for (const entry of native) {
			add(entry);
		}
		truncated = directories.length >= FIND_DIRS_MAX_RESULTS;
	} else {
		let scanned = 0;
		const beganAt = Date.now();
		// A queue plus a head index: `shift()` on a level of a million entries is
		// the kind of quadratic cost that turns a bounded walk into a stall.
		const queue: { directory: string; depth: number }[] = [{ directory: start, depth: 0 }];
		for (let head = 0; head < queue.length; head += 1) {
			if (
				scanned > FIND_DIRS_MAX_SCANNED
				|| directories.length >= FIND_DIRS_MAX_RESULTS
				|| Date.now() - beganAt > FIND_DIRS_BUDGET_MS
			) {
				break;
			}
			const current = queue[head] as { directory: string; depth: number };
			if (current.depth > FIND_DIRS_MAX_DEPTH) {
				continue;
			}
			const dirents = await fs.readdir(current.directory, { withFileTypes: true }).catch(() => []);
			// Sorted so two searches of an unchanged tree agree on what came first.
			dirents.sort((a, b) => a.name.localeCompare(b.name));
			for (const dirent of dirents) {
				if (scanned++ > FIND_DIRS_MAX_SCANNED || directories.length >= FIND_DIRS_MAX_RESULTS) {
					break;
				}
				if (!dirent.isDirectory() || shouldIgnore(dirent.name) || dirent.name.startsWith('.')) {
					continue;
				}
				const absolute = path.join(current.directory, dirent.name);
				add(absolute);
				queue.push({ directory: absolute, depth: current.depth + 1 });
			}
		}
		truncated = directories.length >= FIND_DIRS_MAX_RESULTS
			|| scanned > FIND_DIRS_MAX_SCANNED
			|| Date.now() - beganAt > FIND_DIRS_BUDGET_MS;
	}

	// Prefix matches read as "the one I meant"; the rest by depth then name.
	const rank = (entry: { name: string }) => entry.name.toLowerCase().startsWith(query) ? 0 : 1;
	directories.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.name.localeCompare(b.name));
	res.json({ path: start, directories, truncated });
});
