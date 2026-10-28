import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STORE_DIR = path.join(os.homedir(), '.agent-ui');
const STORE_FILE = path.join(STORE_DIR, 'agent-state.json');

/** Backend / model / permission-mode the user picked. */
export interface AgentChoice {
	readonly agent?: string;
	readonly model?: string;
	readonly permissionMode?: string;
}

export interface AgentState {
	/** Backend selection plus legacy global model/mode. */
	default: AgentChoice;
	/**
	 * Model/mode defaults per backend. Kept separate so picking an Echo model
	 * cannot leak into the next Claude session (and vice versa).
	 */
	defaults: Record<string, AgentChoice>;
	/** Per backend session id, so each conversation keeps its own choice. */
	sessions: Record<string, AgentChoice>;
}

const EMPTY: AgentState = { default: {}, defaults: {}, sessions: {} };

let state: AgentState | undefined;
let loading: Promise<AgentState> | undefined;
/** Writes are chained so two quick switches cannot interleave. */
let writeChain: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toChoice(value: unknown): AgentChoice {
	if (!isRecord(value)) {
		return {};
	}
	const choice: { agent?: string; model?: string; permissionMode?: string } = {};
	if (typeof value['agent'] === 'string' && value['agent']) {
		choice.agent = value['agent'];
	}
	if (typeof value['model'] === 'string' && value['model']) {
		choice.model = value['model'];
	}
	if (typeof value['permissionMode'] === 'string' && value['permissionMode']) {
		choice.permissionMode = value['permissionMode'];
	}
	return choice;
}

function parse(raw: unknown): AgentState {
	const sessions: Record<string, AgentChoice> = {};
	const defaults: Record<string, AgentChoice> = {};
	let fallback: AgentChoice = {};
	if (isRecord(raw)) {
		const legacy = toChoice(raw['default']);
		fallback = { agent: legacy.agent };
		// Before plugins existed the store only knew Claude, so its model/mode
		// belong there; keeping them global would leak into other backends.
		if (legacy.model !== undefined || legacy.permissionMode !== undefined) {
			defaults['claude'] = { model: legacy.model, permissionMode: legacy.permissionMode };
		}
		const rawDefaults = raw['defaults'];
		if (isRecord(rawDefaults)) {
			for (const [agentId, choice] of Object.entries(rawDefaults)) {
				if (agentId) {
					defaults[agentId] = toChoice(choice);
				}
			}
		}
		const rawSessions = raw['sessions'];
		if (isRecord(rawSessions)) {
			for (const [id, choice] of Object.entries(rawSessions)) {
				if (id) {
					sessions[id] = toChoice(choice);
				}
			}
		}
	}
	return { default: fallback, defaults, sessions };
}

function load(): Promise<AgentState> {
	if (state) {
		return Promise.resolve(state);
	}
	if (!loading) {
		loading = (async () => {
			let loaded: AgentState;
			try {
				loaded = parse(JSON.parse(await fs.readFile(STORE_FILE, 'utf8')));
			} catch {
				// First run or an unreadable store: start empty.
				loaded = { default: {}, defaults: {}, sessions: {} };
			}
			state = loaded;
			return loaded;
		})();
	}
	return loading;
}

/** Loads the store up front so the synchronous spawn path can read it. */
export async function preloadAgentState(): Promise<AgentState> {
	return load();
}

/** Snapshot for synchronous callers; empty until {@link preloadAgentState} resolves. */
export function currentAgentState(): AgentState {
	return state ?? EMPTY;
}

function write(): void {
	const snapshot = JSON.stringify(state ?? EMPTY, null, '\t');
	writeChain = writeChain
		.then(async () => {
			await fs.mkdir(STORE_DIR, { recursive: true });
			await fs.writeFile(STORE_FILE, snapshot, 'utf8');
		})
		.catch(error => console.error('[agent-ui] failed to persist agent state:', error));
}

function merge(base: AgentChoice | undefined, patch: AgentChoice): AgentChoice {
	return { ...base, ...patch };
}

/**
 * Records a choice the user just made: it becomes the session's value and the
 * default for sessions started later.
 */
export async function rememberChoice(sessionId: string | undefined, patch: AgentChoice): Promise<void> {
	const stored = await load();
	stored.default = merge(stored.default, patch);
	if (sessionId) {
		stored.sessions[sessionId] = merge(stored.sessions[sessionId], patch);
	}
	write();
}

/** Remembers a model/mode default for one backend only. */
export async function rememberDefault(agentId: string, patch: Omit<AgentChoice, 'agent'>): Promise<void> {
	const stored = await load();
	stored.defaults[agentId] = merge(stored.defaults[agentId], patch);
	write();
}

/** Binds a choice to one session without touching the global default. */
export async function rememberSessionChoice(sessionId: string | undefined, patch: AgentChoice): Promise<void> {
	if (!sessionId || (patch.agent === undefined && patch.model === undefined && patch.permissionMode === undefined)) {
		return;
	}
	const stored = await load();
	stored.sessions[sessionId] = merge(stored.sessions[sessionId], patch);
	write();
}

/**
 * What a session should run with: its own choice wins, then the backend's
 * default, then the legacy global default.
 */
export function choiceForSession(sessionId: string | undefined, agentId?: string): AgentChoice {
	const stored = currentAgentState();
	const session = sessionId ? stored.sessions[sessionId] : undefined;
	const base = agentId ? (stored.defaults[agentId] ?? {}) : stored.default;
	return merge(base, session ?? {});
}

/**
 * Only the session's own record, without the global default. Used to detect a
 * resume request that belongs to a different agent backend.
 */
export function sessionChoice(sessionId: string | undefined): AgentChoice {
	return (sessionId ? currentAgentState().sessions[sessionId] : undefined) ?? {};
}
