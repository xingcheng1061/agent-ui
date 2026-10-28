// Detached restart helper: the running server owns the CLI process that is
// executing this conversation, so it is killed from a separate process after a
// short delay, then a fresh server is started with its logs appended.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';

const delay = Number(process.env.AGENT_UI_RESTART_DELAY_MS ?? 15000);
await new Promise(resolve => setTimeout(resolve, delay));

function findListenerPid() {
	try {
		const out = execSync('netstat -ano', { encoding: 'utf8' });
		for (const line of out.split(/\r?\n/)) {
			if (line.includes(':4711') && line.includes('LISTENING')) {
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

const out = fs.openSync('server.log', 'a');
const err = fs.openSync('server.err.log', 'a');
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
	cwd: process.cwd(),
	detached: true,
	stdio: ['ignore', out, err],
	env: { ...process.env, AGENT_UI_DEBUG: process.env.AGENT_UI_DEBUG ?? '1' },
});
child.unref();
console.log('started server pid', child.pid);
