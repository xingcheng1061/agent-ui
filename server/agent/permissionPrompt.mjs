/**
 * Minimal MCP stdio server that turns Claude Code's permission prompts into a
 * question for the browser.
 *
 * The CLI spawns this when it is started with
 * `--mcp-config <json> --permission-prompt-tool mcp__agentui__approval`.
 * Every tool call that needs approval becomes an MCP `tools/call`; we forward
 * it to the agent-ui server over loopback HTTP and block until the user clicks
 * Allow or Deny. The CLI expects the answer as JSON in the tool result:
 *
 *   { "behavior": "allow", "updatedInput": <original input> }
 *   { "behavior": "deny",  "message": "..." }
 *
 * `updatedInput` is mandatory for the allow branch — omitting it fails the
 * CLI's schema validation with `invalid_union`.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const ENDPOINT = process.env.AGENT_UI_PERMISSION_URL ?? '';
const TOKEN = process.env.AGENT_UI_PERMISSION_TOKEN ?? '';
const SESSION = process.env.AGENT_UI_PERMISSION_SESSION ?? '';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function ask(payload) {
	return new Promise((resolve) => {
		if (!ENDPOINT) {
			resolve({ behavior: 'deny', message: '审批通道未配置（缺少 AGENT_UI_PERMISSION_URL）。' });
			return;
		}
		let url;
		try {
			url = new URL(`${ENDPOINT}/internal/permission`);
		} catch {
			resolve({ behavior: 'deny', message: '审批通道地址无效。' });
			return;
		}
		const body = Buffer.from(JSON.stringify({ ...payload, token: TOKEN, session: SESSION }));
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const req = send({
			hostname: url.hostname,
			port: url.port,
			path: url.pathname,
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': body.length },
		}, response => {
			const chunks = [];
			response.setEncoding('utf8');
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => {
				try {
					const parsed = JSON.parse(chunks.join('') || '{}');
					resolve(parsed.behavior === 'allow'
						? { behavior: 'allow' }
						: { behavior: 'deny', message: typeof parsed.message === 'string' ? parsed.message : '用户拒绝。' });
				} catch {
					resolve({ behavior: 'deny', message: '审批通道返回了无法解析的内容。' });
				}
			});
		});
		req.on('error', error => resolve({ behavior: 'deny', message: `审批通道不可用：${error.message}` }));
		req.write(body);
		req.end();
	});
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
	buffer += chunk;
	let index = buffer.indexOf('\n');
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			void handle(line);
		}
		index = buffer.indexOf('\n');
	}
});
process.stdin.on('end', () => process.exit(0));

async function handle(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	switch (message.method) {
		case 'initialize':
			write({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'agentui-approval', version: '0.1.0' },
				},
			});
			return;

		case 'notifications/initialized':
			return;

		case 'tools/list':
			write({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					tools: [{
						name: 'approval',
						description: 'Ask the user whether a tool call may run.',
						inputSchema: {
							type: 'object',
							properties: {
								tool_name: { type: 'string' },
								input: { type: 'object' },
								tool_use_id: { type: 'string' },
							},
							required: ['tool_name', 'input'],
						},
					}],
				},
			});
			return;

		case 'tools/call': {
			const args = message.params?.arguments ?? {};
			const decision = await ask({
				toolName: typeof args.tool_name === 'string' ? args.tool_name : 'unknown',
				input: args.input ?? {},
				toolUseId: typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined,
			});
			const answer = decision.behavior === 'allow'
				? { behavior: 'allow', updatedInput: args.input ?? {} }
				: { behavior: 'deny', message: decision.message ?? '用户拒绝。' };
			write({
				jsonrpc: '2.0',
				id: message.id,
				result: { content: [{ type: 'text', text: JSON.stringify(answer) }] },
			});
			return;
		}

		default:
			if (message.id !== undefined) {
				write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
			}
	}
}
