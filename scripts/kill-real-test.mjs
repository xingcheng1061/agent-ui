/**
 * Manual check that `kill` really ends a running turn, over the real agent
 * WebSocket rather than through the UI.
 *
 * What it asserts: the `exit` event arrives quickly after `kill` (with the
 * CLI's own exit code and stderr), and the conversation can still be resumed
 * afterwards — the two regressions behind "silent stop/kill".
 *
 * Needs a server already running. Root and token default to the environment
 * the server was started with:
 *
 *	node scripts/kill-real-test.mjs --port 4711 [--root <dir>] [--token <t>] [--agent claude]
 */
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({
	options: {
		port: { type: 'string', default: process.env.AGENT_UI_PORT ?? '4711' },
		root: { type: 'string', default: process.env.AGENT_UI_ROOT ?? process.cwd() },
		token: { type: 'string', default: process.env.AGENT_UI_TOKEN ?? '' },
		agent: { type: 'string', default: 'claude' },
	},
});

const url = `ws://127.0.0.1:${values.port}/agent?${values.token ? `token=${encodeURIComponent(values.token)}&` : ''}root=${encodeURIComponent(values.root)}&agent=${values.agent}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const socket = new WebSocket(url);
const events = [];
socket.on('message', raw => {
	const event = JSON.parse(String(raw));
	events.push({ at: Date.now(), event });
	if (event.type === 'permission_request') {
		socket.send(JSON.stringify({ type: 'permission_response', requestId: event.requestId, behavior: 'allow' }));
	}
});
await once(socket, 'open');
const send = command => socket.send(JSON.stringify(command));

send({ type: 'attach' });
await delay(1200);
send({ type: 'set_permission_mode', mode: 'bypassPermissions' });
await delay(600);

const started = Date.now();
send({ type: 'user', text: '请用 Bash 运行 `sleep 20`，然后再说一句完成。' });
await delay(4000);
console.log('events before kill:', events.map(entry => entry.event.type).join(','));

send({ type: 'kill' });
const exitAt = Date.now();
await delay(4000);

const after = events.filter(entry => entry.at >= exitAt);
console.log('events after kill:', after.map(entry => `${entry.event.type}${entry.event.type === 'exit' ? `(code=${entry.event.code},stderr=${entry.event.stderr})` : ''}`).join(',') || '(none)');
console.log('kill took ms:', (after[0]?.at ?? 0) - exitAt);

// Can the conversation be resumed afterwards?
send({ type: 'user', text: '再说一句：resumed ok' });
await delay(6000);
const resumeResult = events.filter(entry => entry.at >= exitAt).some(entry => entry.event.type === 'result');
console.log('resume after kill produced a result:', resumeResult);

socket.close();
console.log('total events:', events.length, 'elapsed', Date.now() - started);
