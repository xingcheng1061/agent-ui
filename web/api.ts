export interface FileEntry {
	readonly name: string;
	readonly path: string;
	readonly type: 'dir' | 'file';
}

export interface ProjectInfo {
	readonly id: string;
	readonly cwd: string;
	readonly name: string;
	readonly sessionCount: number;
	readonly lastActivity: number;
}

export interface SessionEntry {
	readonly id: string;
	readonly projectId: string;
	readonly cwd: string;
	readonly title: string;
	readonly updatedAt: number;
	readonly size: number;
}

export interface TranscriptItem {
	readonly kind: 'user' | 'assistant' | 'thinking' | 'tool';
	readonly text?: string;
	readonly id?: string;
	/** API message the text belongs to; used to avoid replaying it twice. */
	readonly messageId?: string;
	/** Set on a subagent's own steps: the tool call that spawned it. */
	readonly parentToolUseId?: string;
	readonly name?: string;
	readonly input?: unknown;
	readonly result?: { readonly content: string; readonly isError: boolean };
	/** Badge state of a subagent, replayed so its card keeps its identity. */
	readonly task?: { readonly taskId: string; readonly status: string; readonly description?: string; readonly subagentType?: string; readonly taskType?: string };
}

const TOKEN = new URLSearchParams(window.location.search).get('token') ?? '';

function withToken(url: string): string {
	if (!TOKEN) {
		return url;
	}
	return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	// `same-origin` sends the session cookie; without it every call would 401.
	const response = await fetch(withToken(url), { credentials: 'same-origin', ...init });
	if (!response.ok) {
		const text = await response.text();
		const error = new Error(text || `${response.status} ${response.statusText}`) as Error & {
			status: number;
			body?: unknown;
		};
		error.status = response.status;
		// The guard reports `setup-required` in the body, which the login page
		// needs to tell "signed out" apart from "never initialized".
		try {
			error.body = JSON.parse(text);
		} catch {
			// Not JSON; leave `body` undefined.
		}
		throw error;
	}
	return await response.json() as T;
}

export async function listProjects(): Promise<readonly ProjectInfo[]> {
	const result = await requestJson<{ projects: ProjectInfo[] }>('/api/projects');
	return result.projects;
}

export interface BrowseResult {
	readonly path: string;
	readonly parent?: string;
	readonly directories: readonly { readonly name: string; readonly path: string }[];
	readonly roots: readonly string[];
}

export async function browseDirectories(target?: string): Promise<BrowseResult> {
	const query = target ? `?path=${encodeURIComponent(target)}` : '';
	return requestJson<BrowseResult>(`/api/fs/browse${query}`);
}

/** Registers a directory so sessions can start in it; idempotent. */
export async function addProject(root: string): Promise<ProjectInfo> {
	const result = await requestJson<{ project: ProjectInfo }>('/api/projects', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path: root }),
	});
	return result.project;
}

export async function listSessions(): Promise<readonly SessionEntry[]> {
	const result = await requestJson<{ sessions: SessionEntry[] }>('/api/sessions');
	return result.sessions;
}

export async function getTranscript(sessionId: string): Promise<readonly TranscriptItem[]> {
	const result = await requestJson<{ items: TranscriptItem[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
	return result.items;
}

export async function listDirectory(root: string, directory: string): Promise<readonly FileEntry[]> {
	const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(directory)}`;
	const result = await requestJson<{ entries: FileEntry[] }>(`/api/fs/list?${query}`);
	return result.entries;
}

/**
 * Fire-and-forget diagnostics. `keepalive` matters: this often runs while the
 * page is going away, which is exactly the case we need to record.
 */
export function reportClientLog(payload: Readonly<Record<string, unknown>>): void {
	void fetch(withToken('/api/agent-log'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
		keepalive: true,
	}).catch(() => undefined);
}

/** Path search for the `@` mention picker. */
export async function searchFiles(root: string, query: string): Promise<readonly string[]> {
	const result = await requestJson<{ files: string[] }>(
		`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`,
	);
	return result.files;
}

export function readFile(root: string, filePath: string): Promise<{ path: string; content: string; size: number }> {
	return requestJson(`/api/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
}

export function writeFile(root: string, filePath: string, content: string): Promise<{ ok: boolean }> {
	return requestJson('/api/fs/write', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ root, path: filePath, content }),
	});
}

export interface GitFileEntry {
	readonly path: string;
	readonly status: string;
	readonly insertions: number;
	readonly deletions: number;
}

export interface GitStatus {
	readonly isRepo: boolean;
	readonly branch?: string;
	readonly files: readonly GitFileEntry[];
}

export function gitStatus(root: string): Promise<GitStatus> {
	return requestJson<GitStatus>(`/api/git/status?root=${encodeURIComponent(root)}`);
}

export function gitFile(root: string, filePath: string): Promise<{ original: string; modified: string; binary: boolean }> {
	return requestJson(`/api/git/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`);
}

function socketUrl(pathname: string, query: Record<string, string>): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const params = new URLSearchParams(query);
	return withToken(`${protocol}//${window.location.host}${pathname}?${params.toString()}`);
}

/** Terminals are addressed by id: the shell lives on the server, not the tab. */
export function terminalUrl(id: string): string {
	return socketUrl('/terminal', { id });
}

export function agentUrl(root: string, agent?: string): string {
	const params: Record<string, string> = { root };
	if (agent) {
		params.agent = agent;
	}
	return socketUrl('/agent', params);
}

// ------------------------------------------------------------------- auth

export interface PublicUser {
	readonly id: string;
	readonly username: string;
	readonly role: 'admin' | 'user';
	readonly createdAt: number;
}

/** Throws with `{ status }` so the caller can tell "signed out" from "broken". */
async function authRequest(pathname: string, body?: unknown): Promise<unknown> {
	const response = await fetch(withToken(pathname), {
		method: body === undefined ? 'GET' : 'POST',
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		credentials: 'same-origin',
	});
	if (!response.ok) {
		const error = new Error(`request failed: ${response.status}`) as Error & { status: number; body: unknown };
		error.status = response.status;
		error.body = await response.json().catch(() => undefined);
		throw error;
	}
	return response.json();
}

export async function fetchMe(): Promise<PublicUser | undefined> {
	try {
		const result = await authRequest('/api/auth/me') as { user: PublicUser };
		return result.user;
	} catch {
		return undefined;
	}
}

export async function login(username: string, password: string): Promise<PublicUser> {
	const result = await authRequest('/api/auth/login', { username, password }) as { user: PublicUser };
	return result.user;
}

export async function setupAdmin(username: string, password: string): Promise<PublicUser> {
	const result = await authRequest('/api/auth/setup', { username, password }) as { user: PublicUser };
	return result.user;
}

export async function logout(): Promise<void> {
	await authRequest('/api/auth/logout', {}).catch(() => undefined);
}

export async function changePassword(current: string, next: string): Promise<void> {
	await authRequest('/api/auth/password', { current, next });
}

// ------------------------------------------------------------ agent sessions

/** One conversation that still has a process, even if no tab is showing it. */
export interface RunningSession {
	readonly sessionId: string;
	readonly root: string;
	readonly agent: string;
	readonly busy: boolean;
	readonly permissionMode?: string;
}

export async function runningSessions(): Promise<readonly RunningSession[]> {
	const result = await requestJson<{ sessions: RunningSession[] }>('/api/agents/running');
	return result.sessions;
}

// --------------------------------------------------------------- terminals

export interface TerminalInfo {
	readonly id: string;
	readonly root: string;
	readonly title: string;
	readonly createdAt: number;
}

export async function listTerminals(): Promise<readonly TerminalInfo[]> {
	const result = await requestJson<{ terminals: TerminalInfo[] }>('/api/terminals');
	return result.terminals;
}

export async function createTerminal(root: string, title?: string): Promise<TerminalInfo> {
	const result = await requestJson<{ terminal: TerminalInfo }>('/api/terminals', {
		method: 'POST',
		body: JSON.stringify({ root, title }),
	});
	return result.terminal;
}

export async function renameTerminal(id: string, title: string): Promise<TerminalInfo | undefined> {
	try {
		const result = await requestJson<{ terminal: TerminalInfo }>(`/api/terminals/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			body: JSON.stringify({ title }),
		});
		return result.terminal;
	} catch {
		return undefined;
	}
}

export async function closeTerminal(id: string): Promise<void> {
	await requestJson(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
}
