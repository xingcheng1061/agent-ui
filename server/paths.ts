import path from 'node:path';
import { getAllowedRoots, normalizeRoot } from './projects.js';

/**
 * Names never listed in the file tree, and never descended into by a search.
 *
 * Exported because the native `find` / PowerShell path has to prune exactly
 * the same directories; two lists would drift.
 */
export const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.cache']);

export class PathOutsideRootError extends Error {
	constructor(requested: string) {
		super(`Path is outside the project root: ${requested}`);
		this.name = 'PathOutsideRootError';
	}
}

export class BadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BadRequestError';
	}
}

/** Resolve a client-supplied root and refuse anything that is not a known project. */
export async function resolveRoot(requested: string): Promise<string> {
	const resolved = path.resolve(requested);
	const allowed = await getAllowedRoots();
	if (!allowed.has(normalizeRoot(resolved))) {
		throw new BadRequestError(`Unknown project root: ${requested}`);
	}
	return resolved;
}

/** Resolve a client-supplied path inside `root`, refusing any escape. */
export function toAbsolute(root: string, relativePath: string): string {
	const absolute = path.resolve(root, relativePath);
	const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
	if (absolute !== root && !absolute.startsWith(rootPrefix)) {
		throw new PathOutsideRootError(relativePath);
	}
	return absolute;
}

/** POSIX-style path relative to the root, which is what the client sends back. */
export function toRelative(root: string, absolutePath: string): string {
	return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function shouldIgnore(name: string): boolean {
	return IGNORED_NAMES.has(name);
}

export function readStringQuery(value: unknown, field: string): string {
	if (typeof value !== 'string') {
		throw new BadRequestError(`Missing string query parameter: ${field}`);
	}
	return value;
}
