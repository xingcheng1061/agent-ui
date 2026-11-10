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
	/** Archived sessions keep their transcript but stay out of the default list. */
	readonly archived: boolean;
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
	/** A user message the CLI absorbed into a turn that was already running. */
	readonly queued?: boolean;
}

const TOKEN = new URLSearchParams(window.location.search).get('token') ?? '';

function withToken(url: string): string {
	if (!TOKEN) {
		return url;
	}
	return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	/**
	 * A string body with no content type goes out as `text/plain`, which
	 * `express.json()` ignores: the route then sees an empty body and silently
	 * uses its default. That is how every terminal ended up created in
	 * PROJECT_ROOT instead of the project actually on screen.
	 */
	const headers =
		typeof init?.body === 'string'
			? { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
			: init?.headers;
	// `same-origin` sends the session cookie; without it every call would 401.
	const response = await fetch(withToken(url), { credentials: 'same-origin', ...init, headers });
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
		// The API answers `{ error }`; without this the status bar printed the
		// JSON body itself (`Error: {"error":"..."}`), which reads like a crash.
		const detail = (error.body as { error?: unknown } | undefined)?.error;
		if (typeof detail === 'string') {
			error.message = detail;
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

/** Archived sessions come along so the rail can show and restore them. */
export async function listSessions(): Promise<readonly SessionEntry[]> {
	const result = await requestJson<{ sessions: SessionEntry[] }>('/api/sessions?includeArchived=1');
	return result.sessions;
}

export async function getTranscript(sessionId: string): Promise<readonly TranscriptItem[]> {
	const result = await requestJson<{ items: TranscriptItem[] }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
	return result.items;
}

/** An empty title restores the generated one. */
export async function renameSession(sessionId: string, title: string): Promise<void> {
	await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'PATCH',
		body: JSON.stringify({ title }),
	});
}

export async function archiveSession(sessionId: string, archived: boolean): Promise<void> {
	await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'PATCH',
		body: JSON.stringify({ archived }),
	});
}

/** Stops a running process server-side, then removes the transcript. */
export async function deleteSession(sessionId: string): Promise<void> {
	await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
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

export interface SearchResult {
	readonly files: readonly string[];
	readonly dirs: readonly string[];
}

/** Path search: files and directories are returned separately. */
export async function searchEntries(root: string, query: string): Promise<SearchResult> {
	return requestJson<SearchResult>(
		`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(query)}`,
	);
}

/** Path search for the `@` mention picker, which only wants files. */
export async function searchFiles(root: string, query: string): Promise<readonly string[]> {
	const result = await searchEntries(root, query);
	return result.files;
}

/** One slice of a file; a file that fits the editor limit arrives whole. */
export interface FileChunk {
	readonly path: string;
	readonly content: string;
	readonly size: number;
	/** Byte offset just past `content`; equals `size` once nothing is left. */
	readonly next: number;
	readonly eof: boolean;
	/** False for a file over the editor limit: it can be read, not written. */
	readonly editable: boolean;
}

/** `offset` continues paging a file that was too big for one response. */
export function readFile(root: string, filePath: string, offset = 0): Promise<FileChunk> {
	const query = `root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}${offset > 0 ? `&offset=${offset}` : ''}`;
	return requestJson(`/api/fs/read?${query}`);
}

export function writeFile(root: string, filePath: string, content: string): Promise<{ ok: boolean }> {
	return requestJson('/api/fs/write', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ root, path: filePath, content }),
	});
}

/** Where clangd says a symbol lives: absolute, 1-based on both axes. */
export interface DefinitionTarget {
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

/**
 * Hands clangd the buffer as the editor holds it, edits included.
 *
 * clangd answers about the text it was last given, so skipping this makes a
 * jump target point at the line the file had on disk — which is the line above
 * whatever was just typed.
 */
export function syncLspDocument(
	root: string,
	filePath: string,
	text: string,
): Promise<{ ok: boolean; diagnostics: readonly LspDiagnostic[] }> {
	return requestJson('/api/lsp/sync', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath, text }),
	});
}

export function closeLspDocument(root: string, filePath: string): Promise<{ ok: boolean }> {
	return requestJson('/api/lsp/close', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath }),
	});
}

/**
 * `text` is the buffer as the editor holds it. Sending it makes the answer
 * describe what is on screen right now, not the last debounced sync.
 */
export async function lspDefinition(
	root: string,
	filePath: string,
	line: number,
	column: number,
	text?: string,
): Promise<readonly DefinitionTarget[]> {
	const result = await requestJson<{ locations: DefinitionTarget[] }>('/api/lsp/definition', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath, line, column, text }),
	});
	return result.locations;
}

export async function lspHover(
	root: string,
	filePath: string,
	line: number,
	column: number,
	text?: string,
): Promise<string | undefined> {
	const result = await requestJson<{ contents?: string }>('/api/lsp/hover', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath, line, column, text }),
	});
	return result.contents;
}

/** A clangd diagnostic, translated to 1-based lines/columns for Monaco. */
export interface LspDiagnostic {
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;
	/** LSP severity: 1 error, 2 warning, 3 information, 4 hint. */
	readonly severity: number;
	readonly message: string;
	readonly source?: string;
}

export async function lspDiagnostics(root: string, filePath: string): Promise<readonly LspDiagnostic[]> {
	const result = await requestJson<{ diagnostics: LspDiagnostic[] }>('/api/lsp/diagnostics', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath }),
	});
	return result.diagnostics;
}

/**
 * Asks for the clangd process to be started now.
 *
 * Deliberately not awaited by callers: the server answers as soon as the start
 * is scheduled, because the handshake is exactly what we are hiding.
 */
export async function lspWarm(root: string): Promise<boolean> {
	const result = await requestJson<{ warming?: boolean }>('/api/lsp/warm', {
		method: 'POST',
		body: JSON.stringify({ root }),
	});
	return result.warming === true;
}

/** Relative 5-tuple token data, which is exactly Monaco's encoding. */
export async function lspSemanticTokens(
	root: string,
	filePath: string,
	text?: string,
): Promise<{ resultId?: string; data: readonly number[] }> {
	return requestJson('/api/lsp/semantic-tokens', {
		method: 'POST',
		body: JSON.stringify({ root, path: filePath, text }),
	});
}

/** Creates an empty file or a directory; an existing path is refused. */
export function createEntry(root: string, filePath: string, type: 'file' | 'dir'): Promise<{ ok: boolean }> {
	return requestJson('/api/fs/create', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ root, path: filePath, type }),
	});
}

/** Deletes a file, or a directory with everything inside it. */
export function deleteEntry(root: string, filePath: string): Promise<{ ok: boolean }> {
	return requestJson('/api/fs/delete', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ root, path: filePath }),
	});
}

/** Renames (or moves) an entry; `to` is a full path relative to the root. */
export function renameEntry(root: string, from: string, to: string): Promise<{ ok: boolean; path: string }> {
	return requestJson('/api/fs/rename', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ root, from, to }),
	});
}

export interface DirectoryHit {
	readonly name: string;
	readonly path: string;
}

/** Directories under `start` whose name matches; bounded server-side. */
export async function findDirectories(start: string, query: string): Promise<readonly DirectoryHit[]> {
	const result = await requestJson<{ directories: DirectoryHit[] }>(
		`/api/fs/find-dirs?path=${encodeURIComponent(start)}&q=${encodeURIComponent(query)}`,
	);
	return result.directories;
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
	/** Set while the process is blocked on an approval the user has not given. */
	readonly pendingTool?: string;
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
	/** Where the shell reported itself, once its prompt has spoken. */
	readonly cwd?: string;
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
