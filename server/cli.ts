#!/usr/bin/env node
/**
 * `agent-ui` command — the entry point of the published package.
 *
 * Flags are translated into the environment variables the server already reads
 * *before* `./index.js` is imported: `config.ts` freezes them at module load,
 * so the order here is load-bearing.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Nearest `package.json` named `agent-ui`, so this works from `server/` and `dist/server/`. */
function readVersion(): string {
	let dir = HERE;
	for (let depth = 0; depth < 4; depth++) {
		const candidate = path.join(dir, 'package.json');
		if (existsSync(candidate)) {
			try {
				const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
				if (pkg.name === 'agent-ui' && pkg.version) {
					return pkg.version;
				}
			} catch {
				// Unreadable candidate: keep walking up.
			}
		}
		dir = path.dirname(dir);
	}
	return '0.0.0';
}

const HELP = `agent-ui ${readVersion()}

自托管的 coding agent Web 工作台。启动一个 Node 服务，用浏览器打开即可。

用法: agent-ui [选项]

选项:
  -p, --port <端口>    监听端口（默认 4711）
  -H, --host <地址>    监听地址（默认 127.0.0.1，故意只监听回环）
  -r, --root <目录>    项目根目录（默认当前目录）
  -h, --help           显示本帮助
  -v, --version        显示版本号

所有选项都等价于同名环境变量（AGENT_UI_PORT / AGENT_UI_HOST / AGENT_UI_ROOT），
其余配置项见 docs/operations.md。

首次启动后打开页面创建管理员账号；无界面部署可用
AGENT_UI_ADMIN_USER + AGENT_UI_ADMIN_PASSWORD 预置。
`;

function fail(message: string): never {
	console.error(`agent-ui: ${message}`);
	console.error('运行 agent-ui --help 查看用法。');
	process.exit(1);
}

const argv: readonly (string | undefined)[] = process.argv.slice(2);
const overrides: Record<string, string> = {};

for (let index = 0; index < argv.length; index++) {
	const arg = argv[index] ?? '';
	const separator = arg.startsWith('--') ? arg.indexOf('=') : -1;
	const flag = separator === -1 ? arg : arg.slice(0, separator);
	const inline = separator === -1 ? undefined : arg.slice(separator + 1);

	const takeValue = (): string => {
		if (inline !== undefined) {
			return inline;
		}
		const next = argv[++index];
		if (next === undefined || next.startsWith('-')) {
			fail(`${flag} 需要一个值`);
		}
		return next;
	};

	switch (flag) {
		case '-h':
		case '--help':
			console.log(HELP);
			process.exit(0);
		case '-v':
		case '--version':
			console.log(readVersion());
			process.exit(0);
		case '-p':
		case '--port':
			overrides['AGENT_UI_PORT'] = takeValue();
			break;
		case '-H':
		case '--host':
			overrides['AGENT_UI_HOST'] = takeValue();
			break;
		case '-r':
		case '--root':
			overrides['AGENT_UI_ROOT'] = path.resolve(takeValue());
			break;
		default:
			fail(`未知参数 ${arg}`);
	}
}

for (const [name, value] of Object.entries(overrides)) {
	process.env[name] = value;
}

await import('./index.js');
