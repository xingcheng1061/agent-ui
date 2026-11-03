import { randomUUID } from 'node:crypto';
import type { Context, Plugin } from 'cordis';
import type { AgentDriver, AgentSession, AgentSessionOptions, PermissionDecision } from '../driver.js';
import type { AgentServerEvent } from '../protocol.js';

/**
 * Reference backend. It implements the whole {@link AgentSession} contract with
 * no external process, which makes it the smallest example of "a new agent is
 * just a cordis plugin" and a way to exercise the UI protocol without `claude`.
 */
class EchoSession implements AgentSession {
	readonly id = randomUUID();
	private _sessionId: string | undefined;
	private _model: string;
	private _permissionMode: string;
	private _timer: NodeJS.Timeout | undefined;
	private _interrupted = false;
	private _disposed = false;

	constructor(
		private readonly _options: AgentSessionOptions,
		private readonly _emit: (event: AgentServerEvent) => void,
	) {
		this._model = _options.model ?? 'echo-1';
		this._permissionMode = _options.permissionMode;
	}

	sendUserMessage(text: string): void {
		if (this._disposed) {
			return;
		}
		this._init();
		this._interrupted = false;
		this._emit({ type: 'status', status: 'requesting' });

		// Chunked on purpose: the browser's streaming path is part of the protocol.
		const chunks = text.match(/\s+|\S+/g) ?? [];
		let index = 0;
		const tick = () => {
			if (this._disposed || this._interrupted) {
				return;
			}
			if (index >= chunks.length) {
				this._emit({
					type: 'result',
					subtype: 'success',
					isError: false,
					text: `echo: ${text}`,
					numTurns: 1,
					sessionId: this._sessionId,
				});
				this._emit({ type: 'status', status: 'idle' });
				return;
			}
			this._emit({ type: 'assistant_delta', text: chunks[index++]! });
			this._timer = setTimeout(tick, 25);
		};
		tick();
	}

	interrupt(): void {
		if (this._disposed || this._interrupted) {
			return;
		}
		this._interrupted = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
		this._emit({ type: 'result', subtype: 'interrupted', isError: false, text: '已中断', sessionId: this._sessionId });
	}

	kill(): void {
		this.interrupt();
	}

	setModel(model: string): void {
		this._model = model;
		this._emit({ type: 'config', model });
	}

	setPermissionMode(mode: string): void {
		this._permissionMode = mode;
		this._emit({ type: 'config', permissionMode: mode });
	}

	resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
		return false;
	}

	hasPendingPermission(): boolean {
		return false;
	}

	cancelPendingPermissions(): void {
		// This backend never asks for approval.
	}

	dispose(): void {
		this._disposed = true;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _init(): void {
		if (this._sessionId) {
			return;
		}
		this._sessionId = this._options.resumeSessionId ?? randomUUID();
		this._emit({
			type: 'system',
			sessionId: this._sessionId,
			cwd: this._options.cwd,
			model: this._model,
			permissionMode: this._permissionMode,
			slashCommands: ['help'],
			skills: [],
			agents: [],
			models: [{ id: 'echo-1' }],
		});
	}
}

export function createEchoDriver(): AgentDriver {
	return {
		id: 'echo',
		name: 'Echo（演示）',
		description: '不调用任何模型，逐字回显输入，用来验证插件协议',
		models: [{ id: 'echo-1' }],
		permissionModes: ['default'],
		defaultModel: 'echo-1',
		defaultPermissionMode: 'default',
		supportsResume: true,
		createSession: (options, emit) => new EchoSession(options, emit),
	};
}

/** Cordis plugin: installs the demo backend into `ctx.agents`. */
export function echoAgentPlugin(): Plugin.Object<Context> {
	return {
		name: 'agent-ui:echo',
		inject: ['agents'],
		apply(ctx) {
			ctx.agents.register(createEchoDriver());
		},
	};
}
