/**
 * Builds the server half of the package into `dist/server`.
 *
 * Three things `tsc` alone does not do: start from a clean directory (a stale
 * `dist/server` would otherwise be published), copy the runtime scripts it does
 * not emit (`permissionPrompt.mjs`, resolved next to `claudeCliSession.js` via
 * `import.meta.url`) and make sure the CLI keeps its shebang.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server');
const OUT = path.join(ROOT, 'dist', 'server');

await rm(OUT, { recursive: true, force: true });

const tsc = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
	cwd: ROOT,
	stdio: 'inherit',
});
if (tsc.status !== 0) {
	process.exit(tsc.status ?? 1);
}

async function copyScripts(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const from = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await copyScripts(from);
			continue;
		}
		if (!entry.name.endsWith('.mjs')) {
			continue;
		}
		const to = path.join(OUT, path.relative(SRC, from));
		await mkdir(path.dirname(to), { recursive: true });
		await writeFile(to, await readFile(from));
	}
}

await copyScripts(SRC);

const cli = path.join(OUT, 'cli.js');
const source = await readFile(cli, 'utf8');
if (!source.startsWith('#!')) {
	await writeFile(cli, `#!/usr/bin/env node\n${source}`);
}

console.log('[build:server] dist/server ready');
