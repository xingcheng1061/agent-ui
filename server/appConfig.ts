/**
 * `~/.agent-ui/config.json`, read on every session listing.
 *
 * `autoArchive` roots still appear under "show archived" — they are only out of
 * the default list. `hide` roots never appear at all. Both default to empty, so
 * a missing file loads every session.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface AgentUiConfig {
	/** Session cwds under these roots are listed as archived. */
	readonly autoArchive: readonly string[];
	/** Session cwds under these roots are not listed at all. */
	readonly hide: readonly string[];
}

const CONFIG_PATH = path.join(os.homedir(), '.agent-ui', 'config.json');

/**
 * Cached by content, not by mtime: mtime granularity is coarser than the file
 * on some filesystems, so two edits inside the same tick looked identical and
 * the second one was ignored. The file is a few hundred bytes and this runs
 * once per session listing.
 */
let cache: { readonly raw: string; readonly value: AgentUiConfig } | undefined;

export async function readAgentUiConfig(): Promise<AgentUiConfig> {
	try {
		const raw = await fs.readFile(CONFIG_PATH, 'utf8');
		if (cache && cache.raw === raw) {
			return cache.value;
		}
		const value = normalize(JSON.parse(raw));
		cache = { raw, value };
		return value;
	} catch {
		// No file yet, unreadable or not JSON: everything is shown. Dropping the
		// cache matters here — the next edit has to be read, not remembered.
		cache = undefined;
		return { autoArchive: [], hide: [] };
	}
}

function normalize(raw: unknown): AgentUiConfig {
	const source = raw as { autoArchive?: unknown; hide?: unknown } | null;
	return { autoArchive: roots(source?.autoArchive), hide: roots(source?.hide) };
}

function roots(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
		.map(item => path.resolve(item.trim()));
}

/** True when `cwd` is one of the roots, or lives below one. */
export function underAnyRoot(cwd: string, roots: readonly string[]): boolean {
	if (roots.length === 0) {
		return false;
	}
	const target = path.resolve(cwd);
	return roots.some(root => target === root || target.startsWith(root + path.sep));
}
