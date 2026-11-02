/**
 * Detached restart helper for development.
 *
 * The running server owns the CLI process that is executing this conversation,
 * so it cannot restart itself: this script kills it from a separate process
 * after a delay, then starts a fresh one with its logs appended.
 *
 *	node scripts/restart.mjs
 *
 * Windows only (netstat/taskkill). `AGENT_UI_RESTART_DELAY_MS` and
 * `AGENT_UI_PORT` are honoured.
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.AGENT_UI_PORT ?? '4711';
const delay = Number(process.env.AGENT_UI_RESTART_DELAY_MS ?? 15000);

await new Promise(resolve => setTimeout(resolve, delay));

function findListenerPid() {
	try {
		const out = execSync('netstat -ano', { encoding: 'utf8' });
		for (const line of out.split(/\r?\n/)) {
			if (line.includes(`:${PORT}`) && line.includes('LISTENING')) {
				const pid = line.trim().split(/\s+/).pop();
				if (pid && /^\d+$/.test(pid)) {
					return pid;
				}
			}
		}
	} catch {
		// fall through
	}
	return undefined;
}

const pid = findListenerPid();
if (pid) {
	console.log('killing server pid', pid);
	try {
		execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
	} catch {
		// already gone
	}
}

await new Promise(resolve => setTimeout(resolve, 1500));

const out = fs.openSync(path.join(ROOT, 'server.log'), 'a');
const err = fs.openSync(path.join(ROOT, 'server.err.log'), 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
	cwd: ROOT,
	detached: true,
	stdio: ['ignore', out, err],
	env: { ...process.env, AGENT_UI_DEBUG: process.env.AGENT_UI_DEBUG ?? '1' },
});
child.unref();
console.log('started server pid', child.pid);
