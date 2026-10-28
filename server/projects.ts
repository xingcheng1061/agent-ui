import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPersistedRoots } from './projectStore.js';

export interface ProjectInfo {
	/** Directory name inside the CLI store; also the folder holding its sessions. */
	readonly id: string;
	readonly cwd: string;
	readonly name: string;
	readonly sessionCount: number;
	readonly lastActivity: number;
}

const CACHE_MS = 5000;
let cache: { readonly at: number; readonly projects: readonly ProjectInfo[] } | undefined;

export function projectsDir(): string {
	return process.env['AGENT_UI_CLAUDE_PROJECTS'] ?? path.join(os.homedir(), '.claude', 'projects');
}

/** The CLI slugifies the cwd by replacing every non-alphanumeric char with `-`. */
export function slugFor(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function invalidateProjectsCache(): void {
	cache = undefined;
}

export function normalizeRoot(root: string): string {
	const resolved = path.resolve(root);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Extra roots that have no sessions yet, e.g. a fresh checkout. `;` or `,` separated. */
export function extraRoots(): readonly string[] {
	const raw = process.env['AGENT_UI_ROOTS'] ?? '';
	return raw.split(/[;,]/).map(item => item.trim()).filter(item => item.length > 0).map(item => path.resolve(item));
}

async function readCwdFromTranscript(filePath: string): Promise<string | undefined> {
	const handle = await fs.open(filePath, 'r').catch(() => undefined);
	if (!handle) {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(32 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
			if (!line.startsWith('{')) {
				continue;
			}
			try {
				const parsed = JSON.parse(line) as { cwd?: unknown };
				if (typeof parsed.cwd === 'string' && parsed.cwd) {
					return parsed.cwd;
				}
			} catch {
				// truncated last line, ignore
			}
		}
	} finally {
		await handle.close();
	}
	return undefined;
}

export async function listProjects(): Promise<readonly ProjectInfo[]> {
	if (cache && Date.now() - cache.at < CACHE_MS) {
		return cache.projects;
	}

	const byRoot = new Map<string, ProjectInfo>();
	const root = projectsDir();
	const directories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

	for (const directory of directories) {
		if (!directory.isDirectory()) {
			continue;
		}
		const directoryPath = path.join(root, directory.name);
		const files = (await fs.readdir(directoryPath).catch(() => [])).filter(file => file.endsWith('.jsonl'));
		if (files.length === 0) {
			continue;
		}

		let lastActivity = 0;
		for (const file of files) {
			const stat = await fs.stat(path.join(directoryPath, file)).catch(() => undefined);
			lastActivity = Math.max(lastActivity, stat?.mtimeMs ?? 0);
		}

		const newest = await Promise.all(files.map(async file => {
			const stat = await fs.stat(path.join(directoryPath, file)).catch(() => undefined);
			return { file, mtime: stat?.mtimeMs ?? 0 };
		}));
		newest.sort((a, b) => b.mtime - a.mtime);

		let cwd: string | undefined;
		for (const candidate of newest.slice(0, 3)) {
			cwd = await readCwdFromTranscript(path.join(directoryPath, candidate.file));
			if (cwd) {
				break;
			}
		}
		if (!cwd) {
			continue;
		}

		byRoot.set(normalizeRoot(cwd), {
			id: directory.name,
			cwd,
			name: path.basename(cwd),
			sessionCount: files.length,
			lastActivity,
		});
	}

	// Roots added by hand (the folder picker) and roots from the environment.
	const manual = [...extraRoots(), ...await readPersistedRoots()];
	for (const extra of manual) {
		const key = normalizeRoot(extra);
		if (!byRoot.has(key)) {
			byRoot.set(key, {
				id: slugFor(extra),
				cwd: extra,
				name: path.basename(extra),
				sessionCount: 0,
				lastActivity: 0,
			});
		}
	}

	const projects = [...byRoot.values()].sort((a, b) => b.lastActivity - a.lastActivity);
	cache = { at: Date.now(), projects };
	return projects;
}

export async function getAllowedRoots(): Promise<ReadonlySet<string>> {
	const projects = await listProjects();
	const roots = new Set<string>(projects.map(project => normalizeRoot(project.cwd)));
	for (const extra of [...extraRoots(), ...await readPersistedRoots()]) {
		roots.add(normalizeRoot(extra));
	}
	return roots;
}
