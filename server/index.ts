import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { preloadAgentState } from './agent/agentState.js';
import { requestPermissionFromBrowser } from './agent/permissionGateway.js';
import { createAgentServer, listRunningSessions } from './agent/router.js';
import { createAgentRuntime, disposeAgentRuntime } from './agent/runtime.js';
import {
	ACCESS_TOKEN,
	DEBUG,
	HOST,
	INTERNAL_TOKEN,
	MODELS,
	PORT,
	PROJECT_ROOT,
	isAuthorized,
	requestUrl,
	stamp,
} from './config.js';
import {
	changePassword,
	cookieFor,
	createSession,
	createUser,
	destroySession,
	ensureAdmin,
	preloadAuth,
	sanitize,
	tokenFrom,
	userCount,
	userForToken,
	verifyCredentials,
	type PublicUser,
} from './auth.js';
import { fsRouter } from './fsApi.js';
import { gitFileVersions, gitStatus } from './git.js';
import { BadRequestError, PathOutsideRootError, readStringQuery, resolveRoot, shouldIgnore } from './paths.js';
import { addPersistedRoot } from './projectStore.js';
import { invalidateProjectsCache, listProjects, slugFor } from './projects.js';
import { listAllSessions, readTranscriptById } from './sessions.js';
import {
	closeTerminal,
	createTerminal,
	createTerminalServer,
	disposeAllTerminals,
	listTerminals,
	preloadTerminals,
	renameTerminal,
} from './terminals.js';

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const app = express();
app.use(express.json({ limit: '16mb' }));

/**
 * Debug trail of what actually reached this process. A browser stuck on a cached
 * document looks exactly like a broken server from the outside; these lines are
 * what tells the two apart. Asset requests are skipped: they would drown it.
 */
if (DEBUG) {
	app.use((req, _res, next) => {
		if (!req.path.startsWith('/assets')) {
			console.log(`[${stamp()}][agent-ui:http] ${req.method} ${req.path}`);
		}
		next();
	});
}

/**
 * Called by the MCP approval child that `claude` spawns for
 * `--permission-prompt-tool` (see `agent/permissionPrompt.mjs`). It blocks until
 * the browser attached to that session answers.
 */
app.post('/internal/permission', async (req, res) => {
	const body = req.body as {
		token?: unknown;
		session?: unknown;
		toolName?: unknown;
		input?: unknown;
		toolUseId?: unknown;
	} | undefined;
	if (body?.token !== INTERNAL_TOKEN) {
		res.status(401).json({ behavior: 'deny', message: 'unauthorized' });
		return;
	}
	if (typeof body.session !== 'string' || typeof body.toolName !== 'string') {
		res.status(400).json({ behavior: 'deny', message: 'session and toolName are required' });
		return;
	}
	const decision = await requestPermissionFromBrowser(body.session, {
		toolName: body.toolName,
		input: body.input,
		toolUseId: typeof body.toolUseId === 'string' ? body.toolUseId : undefined,
	});
	res.json(decision);
});

// ---------------------------------------------------------------- auth routes

/** Current account, or 401. The UI calls this on boot to decide what to show. */
app.get('/api/auth/me', async (req, res) => {
	const user = await userForToken(tokenFrom(req));
	if (!user) {
		res.status(401).json({ error: 'Not signed in.' });
		return;
	}
	res.json({ user: sanitize(user) });
});

app.post('/api/auth/login', async (req, res) => {
	const body = req.body as { username?: unknown; password?: unknown } | undefined;
	const username = typeof body?.username === 'string' ? body.username : '';
	const password = typeof body?.password === 'string' ? body.password : '';
	const user = await verifyCredentials(username, password);
	if (!user) {
		res.status(401).json({ error: '用户名或密码错误。' });
		return;
	}
	const token = await createSession(user.id);
	res.setHeader('Set-Cookie', cookieFor(token, SESSION_MAX_AGE_SECONDS));
	res.json({ user: sanitize(user) });
});

app.post('/api/auth/logout', async (req, res) => {
	await destroySession(tokenFrom(req));
	res.setHeader('Set-Cookie', cookieFor('', 0));
	res.json({ ok: true });
});

app.post('/api/auth/password', async (req, res) => {
	const user = await userForToken(tokenFrom(req));
	if (!user) {
		res.status(401).json({ error: 'Not signed in.' });
		return;
	}
	const body = req.body as { current?: unknown; next?: unknown } | undefined;
	const current = typeof body?.current === 'string' ? body.current : '';
	const next = typeof body?.next === 'string' ? body.next : '';
	if (next.length < 6) {
		res.status(400).json({ error: '新密码至少 6 位。' });
		return;
	}
	if (!(await changePassword(user.id, current, next))) {
		res.status(403).json({ error: '当前密码不正确。' });
		return;
	}
	res.json({ ok: true });
});

/**
 * First-run bootstrap: only works while there is no account at all, so a
 * stranger cannot open an unattended instance and claim it.
 */
app.post('/api/auth/setup', async (req, res) => {
	if ((userCount()) > 0) {
		res.status(403).json({ error: '已经初始化过了。' });
		return;
	}
	const body = req.body as { username?: unknown; password?: unknown } | undefined;
	const username = typeof body?.username === 'string' ? body.username.trim() : '';
	const password = typeof body?.password === 'string' ? body.password : '';
	if (username.length === 0 || password.length < 6) {
		res.status(400).json({ error: '用户名不能为空，密码至少 6 位。' });
		return;
	}
	const user = await createUser(username, password, 'admin');
	if (!user) {
		res.status(400).json({ error: '创建账号失败。' });
		return;
	}
	const token = await createSession(user.id);
	res.setHeader('Set-Cookie', cookieFor(token, SESSION_MAX_AGE_SECONDS));
	res.json({ user: sanitize(user) });
});

/** Extra accounts; only an admin may create them. */
app.post('/api/auth/users', async (req, res) => {
	const current = await userForToken(tokenFrom(req));
	if (!current) {
		res.status(401).json({ error: 'Not signed in.' });
		return;
	}
	if (current.role !== 'admin') {
		res.status(403).json({ error: '只有管理员可以创建账号。' });
		return;
	}
	const body = req.body as { username?: unknown; password?: unknown; role?: unknown } | undefined;
	const username = typeof body?.username === 'string' ? body.username : '';
	const password = typeof body?.password === 'string' ? body.password : '';
	const role = body?.role === 'admin' ? 'admin' : 'user';
	if (password.length < 6) {
		res.status(400).json({ error: '密码至少 6 位。' });
		return;
	}
	const user = await createUser(username, password, role);
	if (!user) {
		res.status(409).json({ error: '用户名已存在。' });
		return;
	}
	res.json({ user: sanitize(user) });
});

// ------------------------------------------------- unauthenticated endpoints

// Liveness: must answer even before anyone signs in, and before the store has
// been initialized at all.
app.get('/api/health', (_req, res) => {
	res.json({ ok: true });
});

/**
 * Diagnostics posted by the browser. A closed socket alone cannot say whether
 * the user reloaded, the tab crashed or the network dropped; these lines can.
 * Fire-and-forget, so it stays open: a signed-out page still reports.
 */
app.post('/api/agent-log', (req, res) => {
	// Always recorded, not just under DEBUG: these are exactly the events needed
	// to explain a broken page after the fact, and there are only a handful.
	console.log(`[${stamp()}][agent-ui:client] ${JSON.stringify(req.body)}`);
	res.json({ ok: true });
});

app.get('/api/meta', async (_req, res) => {
	res.json({
		root: PROJECT_ROOT,
		name: path.basename(PROJECT_ROOT),
		platform: process.platform,
		authRequired: ACCESS_TOKEN !== '' || userCount() > 0,
	});
});

// ------------------------------------------------------------------ api guard
// Everything below requires a session (or the shared secret, when configured).
// It has to sit after the endpoints above: those must answer for anonymous
// callers too, otherwise a signed-out browser cannot even ask "am I signed in".

app.use('/api', async (req, res, next) => {
	const user = await userForToken(tokenFrom(req));
	if (user) {
		next();
		return;
	}
	// The shared secret still works for scripts and curl — but only when it is
	// actually configured. `isAuthorized` returns true for everyone while
	// `AGENT_UI_TOKEN` is empty, which would disable accounts entirely.
	if (ACCESS_TOKEN !== '' && isAuthorized(requestUrl(req.url, req.headers.host))) {
		next();
		return;
	}
	const setupRequired = userCount() === 0;
	res.status(401).json({
		error: setupRequired ? 'setup-required' : 'Not signed in.',
		setupRequired,
	});
});

// --------------------------------------------------------------- terminals

app.get('/api/terminals', async (_req, res) => {
	res.json({ terminals: await listTerminals() });
});

app.post('/api/terminals', async (req, res) => {
	const body = req.body as { root?: unknown; title?: unknown } | undefined;
	const requested = typeof body?.root === 'string' && body.root.trim() ? body.root.trim() : PROJECT_ROOT;
	// Falling back is right for a stale tab, but silently replacing the root hid a
	// real bug for weeks: a request without `Content-Type` arrived bodyless, so
	// every terminal was created in PROJECT_ROOT. Say something when it happens.
	const root = await resolveRoot(requested).catch(error => {
		console.warn(`[agent-ui] terminal root rejected (${requested}), using ${PROJECT_ROOT}:`, error instanceof Error ? error.message : error);
		return PROJECT_ROOT;
	});
	const title = typeof body?.title === 'string' ? body.title : undefined;
	res.json({ terminal: await createTerminal(root, title) });
});

app.patch('/api/terminals/:id', async (req, res) => {
	const body = req.body as { title?: unknown } | undefined;
	const title = typeof body?.title === 'string' ? body.title : '';
	const updated = await renameTerminal(req.params.id, title);
	if (!updated) {
		res.status(404).json({ error: '终端不存在。' });
		return;
	}
	res.json({ terminal: updated });
});

app.delete('/api/terminals/:id', async (req, res) => {
	await closeTerminal(req.params.id);
	res.json({ ok: true });
});

/**
 * Conversations that still have a process behind them.
 *
 * The chat socket only knows the conversation it is attached to, so without
 * this the sidebar cannot tell "still answering in a tab I am not looking at"
 * from "finished an hour ago".
 */
app.get('/api/agents/running', async (_req, res) => {
	res.json({ sessions: listRunningSessions() });
});

/** Projects are derived from the CLI's own session store, so nothing needs registering. */
app.get('/api/projects', async (_req, res) => {
	res.json({ projects: await listProjects() });
});

/** Register a directory the CLI has never seen, so new sessions can start in it. */
app.post('/api/projects', async (req, res) => {
	const body = req.body as { path?: unknown } | undefined;
	if (typeof body?.path !== 'string' || body.path.trim().length === 0) {
		throw new BadRequestError('`path` is required.');
	}
	const absolute = path.resolve(body.path.trim());
	const stat = await fs.stat(absolute).catch(() => undefined);
	if (!stat) {
		res.status(404).json({ error: `目录不存在：${absolute}` });
		return;
	}
	if (!stat.isDirectory()) {
		throw new BadRequestError('Not a directory.');
	}

	await addPersistedRoot(absolute);
	invalidateProjectsCache();
	res.json({
		project: {
			id: slugFor(absolute),
			cwd: absolute,
			name: path.basename(absolute),
			sessionCount: 0,
			lastActivity: Date.now(),
		},
	});
});

/** What the agent changed: working tree vs. HEAD. */
app.get('/api/git/status', async (req, res) => {
	const root = await resolveRoot(readStringQuery(req.query['root'], 'root'));
	res.json(await gitStatus(root));
});

app.get('/api/git/file', async (req, res) => {
	const root = await resolveRoot(readStringQuery(req.query['root'], 'root'));
	const filePath = readStringQuery(req.query['path'], 'path');
	res.json(await gitFileVersions(root, filePath));
});

/** Directory picker for the new-session dialog; only directories are listed. */
app.get('/api/fs/browse', async (req, res) => {
	const requested = typeof req.query['path'] === 'string' ? req.query['path'] : '';
	const target = requested ? path.resolve(requested) : os.homedir();
	const dirents = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
	const directories = dirents
		.filter(dirent => dirent.isDirectory() && !shouldIgnore(dirent.name))
		.map(dirent => ({ name: dirent.name, path: path.join(target, dirent.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	const parent = path.dirname(target);

	res.json({
		path: target,
		parent: parent === target ? undefined : parent,
		directories,
		roots: await systemRoots(),
	});
});

async function systemRoots(): Promise<readonly string[]> {
	if (process.platform !== 'win32') {
		return ['/'];
	}
	const roots: string[] = [];
	for (let code = 65; code <= 90; code++) {
		const drive = `${String.fromCharCode(code)}:\\`;
		if (await fs.access(drive).then(() => true).catch(() => false)) {
			roots.push(drive);
		}
	}
	return roots;
}

/** Sessions are the primary axis of the UI; each one carries the cwd it belongs to. */
app.get('/api/sessions', async (_req, res) => {
	res.json({ sessions: await listAllSessions() });
});

app.get('/api/sessions/:id', async (req, res) => {
	res.json({ items: await readTranscriptById(req.params.id) });
});

app.use('/api/fs', fsRouter);

const webDist = path.join(process.cwd(), 'dist', 'web');
if (existsSync(path.join(webDist, 'index.html'))) {
	app.use(express.static(webDist));
	app.use((req, res, next) => {
		if (req.method !== 'GET' || req.path.startsWith('/api')) {
			next();
			return;
		}
		res.sendFile(path.join(webDist, 'index.html'));
	});
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
	const status = error instanceof PathOutsideRootError ? 403
		: error instanceof BadRequestError ? 400
			: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404
				: 500;
	const message = error instanceof Error ? error.message : String(error);
	if (status >= 500) {
		console.error('[agent-ui]', error);
	}
	res.status(status).json({ error: message });
});

const server = http.createServer(app);
const terminalServer = createTerminalServer();
// Boot the cordis host first: agent backends are plugins and must be installed
// before a socket can name one.
const persisted = await preloadAgentState();
const agents = await createAgentRuntime({
	defaultAgent: persisted.default.agent,
	claude: {
		models: MODELS,
		defaultModel: process.env['AGENT_UI_MODEL'],
		defaultPermissionMode: process.env['AGENT_UI_PERMISSION_MODE'] ?? 'acceptEdits',
	},
});
const agentServer = createAgentServer({ registry: agents.registry });

// Auth and terminal state are read from disk before the first request lands.
await Promise.all([preloadAuth(), preloadTerminals()]);
// No prune here: on boot every recorded terminal has no shell yet, and those
// are exactly the ones that get respawned (with their persisted output) when a
// client attaches again. Pruning at startup is what made a dev-server restart
// look like "all my terminals disappeared".

// Scripted setup: `AGENT_UI_ADMIN_USER` + `AGENT_UI_ADMIN_PASSWORD` create (or
// reset) an admin account on boot, so an instance can be provisioned headlessly.
const adminUser = process.env['AGENT_UI_ADMIN_USER'];
const adminPassword = process.env['AGENT_UI_ADMIN_PASSWORD'];
if (adminUser && adminPassword) {
	await ensureAdmin(adminUser, adminPassword);
}

server.on('upgrade', (req, socket, head) => {
	const url = requestUrl(req.url, req.headers.host);
	void (async () => {
		const user = await userForToken(tokenFrom({ headers: req.headers, url: req.url }));
		const tokenOk = ACCESS_TOKEN !== '' && isAuthorized(url);
		if (!user && !tokenOk) {
			if (DEBUG) {
				console.log(`[${stamp()}][agent-ui:http] upgrade rejected ${url.pathname} (not signed in)`);
			}
			socket.destroy();
			return;
		}
		if (url.pathname === '/terminal') {
			terminalServer.handleUpgrade(req, socket, head, socket => {
				terminalServer.emit('connection', socket, req);
			});
			return;
		}
		if (url.pathname === '/agent') {
			agentServer.handleUpgrade(req, socket, head, socket => {
				agentServer.emit('connection', socket, req);
			});
			return;
		}
		socket.destroy();
	})();
});

const shutdown = () => {
	// Terminals flush their last screen before their shells are killed, so the
	// next process can respawn them with their output intact.
	void disposeAllTerminals()
		.catch(error => console.error('[agent-ui] terminal shutdown failed:', error))
		.finally(() => {
			terminalServer.close();
			agentServer.close();
			void disposeAgentRuntime(agents)
				.catch(error => console.error('[agent-ui] agent runtime shutdown failed:', error))
				.finally(() => server.close(() => process.exit(0)));
		});
	setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
	const accounts = userCount();
	console.log(`\n  agent-ui server: http://${HOST}:${PORT}`);
	console.log(`  root:           ${PROJECT_ROOT}`);
	console.log(`  auth:           ${ACCESS_TOKEN ? 'token required (?token=…)' : accounts > 0 ? `${accounts} account(s)` : 'uninitialized — open the UI to create an admin'}`);
	if (!existsSync(path.join(webDist, 'index.html'))) {
		console.log(`  web:            dev mode → run "npm run dev:web" and open http://127.0.0.1:4712\n`);
	}
});
