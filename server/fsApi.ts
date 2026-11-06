import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { MAX_FILE_SIZE } from './config.js';
import { BadRequestError, readStringQuery, resolveRoot, shouldIgnore, toAbsolute, toRelative } from './paths.js';

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

/**
 * Directory search for the project picker.
 *
 * Typing `agent` should find a nested checkout, not only a child of whichever
 * directory the picker happens to be showing, so this walks downwards from the
 * current one. Bounded like the file search: depth, scanned entries, results.
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
	let scanned = 0;
	/** Deep enough for a monorepo module, bounded so a huge tree cannot stall. */
	const MAX_DEPTH = 20;
	const MAX_SCANNED = 100_000;
	const MAX_RESULTS = 100;

	// The directory on screen counts as a hit: "it is right here" is the most
	// common reason a search looks broken.
	if (path.basename(start).toLowerCase().includes(query)) {
		directories.push({ name: path.basename(start), path: start });
	}

	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || scanned > MAX_SCANNED || directories.length >= MAX_RESULTS) {
			return;
		}
		const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			if (scanned++ > MAX_SCANNED || directories.length >= MAX_RESULTS) {
				return;
			}
			// Hidden directories (`.git`, `.venv`, `.cache`, …) are never a
			// project root worth offering, and skipping them keeps the walk fast.
			if (!dirent.isDirectory() || shouldIgnore(dirent.name) || dirent.name.startsWith('.')) {
				continue;
			}
			const absolute = path.join(directory, dirent.name);
			// Match the path relative to the search root, so `services/foo`
			// finds a nested folder and not only a direct child by that name.
			const relative = path.relative(start, absolute).split(path.sep).join('/');
			if (relative.toLowerCase().includes(query) || dirent.name.toLowerCase().includes(query)) {
				directories.push({ name: dirent.name, path: absolute });
			}
			await walk(absolute, depth + 1);
		}
	};

	await walk(start, 0);
	// Prefix matches read as "the one I meant"; the rest by depth then name.
	const rank = (entry: { name: string }) => entry.name.toLowerCase().startsWith(query) ? 0 : 1;
	directories.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.name.localeCompare(b.name));
	res.json({ path: start, directories, truncated: directories.length >= MAX_RESULTS });
});
