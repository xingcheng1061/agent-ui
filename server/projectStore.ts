import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = path.join(os.homedir(), '.agent-ui');
const STORE_FILE = path.join(STORE_DIR, 'projects.json');

function samePath(a: string, b: string): boolean {
	const left = path.resolve(a);
	const right = path.resolve(b);
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Roots the user added by hand; the CLI store stays the primary source. */
export async function readPersistedRoots(): Promise<readonly string[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).map(item => path.resolve(item));
		}
	} catch {
		// first run, or an unreadable store: treat as empty
	}
	return [];
}

export async function addPersistedRoot(root: string): Promise<readonly string[]> {
	const absolute = path.resolve(root);
	const current = [...await readPersistedRoots()];
	if (!current.some(item => samePath(item, absolute))) {
		current.push(absolute);
		await fs.mkdir(STORE_DIR, { recursive: true });
		await fs.writeFile(STORE_FILE, JSON.stringify(current, null, '\t'), 'utf8');
	}
	return current;
}

export async function removePersistedRoot(root: string): Promise<readonly string[]> {
	const remaining = (await readPersistedRoots()).filter(item => !samePath(item, root));
	await fs.mkdir(STORE_DIR, { recursive: true });
	await fs.writeFile(STORE_FILE, JSON.stringify(remaining, null, '\t'), 'utf8');
	return remaining;
}
