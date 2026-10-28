import fs from 'node:fs/promises';
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
	let scanned = 0;

	const walk = async (directory: string, depth: number): Promise<void> => {
		if (depth > 8 || scanned > 20000 || files.length >= 200) {
			return;
		}
		const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const dirent of dirents) {
			if (scanned++ > 20000 || files.length >= 200) {
				return;
			}
			if (dirent.isDirectory()) {
				if (skip.has(dirent.name) || shouldIgnore(dirent.name)) {
					continue;
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
	res.json({ files, truncated: files.length >= 200 });
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
