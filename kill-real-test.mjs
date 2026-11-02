import { once } from 'node:events';
import WebSocket from 'ws';

const token = 'parity';
const url = `ws://127.0.0.1:4799/agent?token=${token}&root=${encodeURIComponent('e:/Codes_new/agent-ui')}&agent=claude`;
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
