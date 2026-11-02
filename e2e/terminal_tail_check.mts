/**
 * Regression check for "a server restart wiped my terminals".
 *
 * The PTY cannot survive the process, so a recorded terminal is respawned when
 * a client attaches again — and the persisted tail has to be replayed into it.
 * This drives the real registry over a real WebSocket, disposes every terminal
 * (which is what a restart looks like to the store), reconnects, and asserts the
 * old output is still there.
 *
 *   $env:USERPROFILE = "$env:TEMP\agent-ui-tail"; npx tsx e2e/terminal_tail_check.mts
 *
 * USERPROFILE must point somewhere disposable: the check refuses to run against
 * the real ~/.agent-ui.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { DATA_DIR } from '../server/store.js';
import {
	createTerminal,
	createTerminalServer,
	disposeAllTerminals,
	preloadTerminals,
} from '../server/terminals.js';

const MARKER = 'PROBE-TAIL-' + Math.random().toString(36).slice(2, 8).toUpperCase();

function fail(message: string): never {
	console.error('FAIL ' + message);
	process.exit(1);
}

if (!DATA_DIR.startsWith(os.tmpdir())) {
	fail(`refusing to run against ${DATA_DIR}; point USERPROFILE at a temp dir`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ui-tail-'));
await preloadTerminals();
const info = await createTerminal(root);

const wss = createTerminalServer();
const httpServer = http.createServer((_request, response) => response.end('ok'));
httpServer.on('upgrade', (request, socket, head) => {
	wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request));
});
await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
const port = (httpServer.address() as { port: number }).port;

/** Collects everything the terminal socket sends. */
function connect(label: string) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/?id=${info.id}&root=${encodeURIComponent(root)}`);
	const messages: string[] = [];
	socket.on('message', raw => messages.push(String(raw)));
	socket.on('error', error => fail(`${label} socket error: ${String(error)}`));
	return { socket, messages, text: () => messages.join('\n') };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	fail(`timed out waiting for ${label}`);
}

const first = connect('first');
await waitFor(() => first.messages.some(message => message.includes('"snapshot"')), 'first snapshot');
first.socket.send(JSON.stringify({ type: 'input', data: `echo ${MARKER}\r` }));
await waitFor(() => first.text().includes(MARKER), 'echo output');
console.log('PASS  输入回显进入缓冲');
first.socket.close();

// What a restart does to the runtime, minus the new process.
await disposeAllTerminals();
await new Promise(resolve => setTimeout(resolve, 200));

const persisted = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'terminals.json'), 'utf8')) as {
	tails?: Record<string, string>;
};
assert.ok(persisted.tails?.[info.id]?.includes(MARKER), 'tail 没有落盘');
console.log('PASS  重启前输出已写入 terminals.json（' + String(persisted.tails?.[info.id]?.length) + ' 字节）');

const second = connect('second');
await waitFor(() => second.messages.some(message => message.includes('"snapshot"')), 'respawn snapshot', 30_000);
const replay = second.text();
assert.ok(replay.includes(MARKER), 'respawn 后没有回放旧输出');
console.log('PASS  respawn 后回放了重启前的输出');
assert.ok(replay.includes('后端已重启'), '没有提示这是重启后的新进程');
console.log('PASS  回放里带有「后端已重启」提示');

second.socket.close();
httpServer.close();
wss.close();
await disposeAllTerminals();
// The just-killed shell can still hold its cwd for a moment; temp dirs are
// cheap and the OS cleans them up.
await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
console.log('全部通过');
process.exit(0);
