import type { Context } from 'cordis';
import type { AgentInfo, AgentServerEvent } from './protocol.js';

/**
 * The seam every backend agent implements. Everything above this layer (the
 * WebSocket router, session reaping, UI protocol) is agent-agnostic: a new
 * backend only has to translate its own runtime into these calls and events.
 *
 * Register an implementation through the cordis registry:
 *
 * ```ts
 * export const myAgentPlugin: Plugin.Object<Context> = {
 *   name: 'agent-ui:my-agent',
 *   inject: ['agents'],
 *   apply(ctx) { ctx.agents.register(driver); },
 * };
 * ```
 */
export interface PermissionDecision {
	readonly behavior: 'allow' | 'deny';
	readonly message?: string;
}

export interface PermissionPrompt {
	readonly toolName: string;
	readonly input: unknown;
	readonly toolUseId?: string;
}

export interface AgentSessionOptions {
	readonly cwd: string;
	readonly permissionMode: string;
	readonly model?: string;
	/** Backend-specific id from a previous session; ignored when unsupported. */
	readonly resumeSessionId?: string;
}

/** One running conversation. Implementations own whatever process/connection they need. */
export interface AgentSession {
	/** Stable internal id, used before the backend reports its own session id. */
	readonly id: string;
	sendUserMessage(text: string): void;
	/** Graceful stop; keeps the conversation alive when the backend can. */
	interrupt(): void;
	kill(reason?: string): void;
	setModel(model: string): void;
	setPermissionMode(mode: string): void;
	resolvePermission(requestId: string, decision: PermissionDecision): boolean;
	hasPendingPermission(): boolean;
	cancelPendingPermissions(reason: string): void;
	dispose(): void;
}

/**
 * Metadata the UI needs to render one backend: the model / permission-mode
 * pickers come from here instead of being hardcoded in the browser.
 */
export interface AgentDriver {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly models: readonly string[];
	readonly permissionModes: readonly string[];
	readonly defaultModel?: string;
	readonly defaultPermissionMode: string;
	readonly supportsResume: boolean;
	createSession(options: AgentSessionOptions, emit: (event: AgentServerEvent) => void): AgentSession;
}

/** Registry of installed agent backends; populated by cordis plugins. */
export class AgentRegistry {
	private readonly _drivers = new Map<string, AgentDriver>();
	private _defaultId: string | undefined;

	register(driver: AgentDriver): () => void {
		this._drivers.set(driver.id, driver);
		this._defaultId ??= driver.id;
		return () => {
			if (this._drivers.get(driver.id) === driver) {
				this._drivers.delete(driver.id);
				if (this._defaultId === driver.id) {
					this._defaultId = this._drivers.keys().next().value;
				}
			}
		};
	}

	has(id: string | undefined): boolean {
		return typeof id === 'string' && this._drivers.has(id);
	}

	get(id: string | undefined): AgentDriver | undefined {
		return typeof id === 'string' ? this._drivers.get(id) : undefined;
	}

	/** Falls back to the first registered driver. */
	require(id?: string): AgentDriver {
		const driver = this.get(id) ?? this.get(this._defaultId);
		if (!driver) {
			throw new Error('没有已注册的 agent 插件。');
		}
		return driver;
	}

	/** Wire representation, without the factory function. */
	list(): readonly AgentInfo[] {
		return [...this._drivers.values()].map(driver => ({
			id: driver.id,
			name: driver.name,
			description: driver.description,
			models: driver.models,
			permissionModes: driver.permissionModes,
			defaultModel: driver.defaultModel,
			defaultPermissionMode: driver.defaultPermissionMode,
			supportsResume: driver.supportsResume,
		}));
	}

	get defaultId(): string | undefined {
		return this._defaultId;
	}

	setDefault(id: string): void {
		if (this._drivers.has(id)) {
			this._defaultId = id;
		}
	}
}

declare module 'cordis' {
	interface Context {
		/** Agent backends installed by plugins. Available once the runtime starts. */
		agents: AgentRegistry;
	}
}
