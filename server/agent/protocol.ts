/** Token/tool accounting the CLI reports when a subagent or background task ends. */
export interface AgentTaskUsage {
	readonly totalTokens?: number;
	readonly toolUses?: number;
	readonly durationMs?: number;
}

/** One installed agent backend, advertised so the UI can build its pickers. */
export interface AgentInfo {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly models: readonly string[];
	readonly permissionModes: readonly string[];
	readonly defaultModel?: string;
	readonly defaultPermissionMode: string;
	readonly supportsResume: boolean;
}

/** Events pushed from the server to the browser over `WS /agent`. */
export type AgentServerEvent =
	| {
		readonly type: 'system';
		readonly sessionId: string;
		readonly agent?: string;
		readonly model?: string;
		readonly cwd?: string;
		readonly toolCount?: number;
		readonly permissionMode?: string;
		/** Names the backend accepts after `/` (built-ins plus skills). */
		readonly slashCommands?: readonly string[];
		/** Subset of `slashCommands` backed by a skill. */
		readonly skills?: readonly string[];
		/** Subagent types available to the backend's agent tool. */
		readonly agents?: readonly string[];
		/** Models offered by the picker. */
		readonly models?: readonly string[];
	}
	/** The backend confirmed a runtime config change, or the server pushed static config on connect. */
	| {
		readonly type: 'config';
		readonly model?: string;
		readonly permissionMode?: string;
		readonly models?: readonly string[];
		readonly permissionModes?: readonly string[];
		/** Backend the connection is routed to. */
		readonly agent?: string;
		/** All registered backends. */
		readonly agents?: readonly AgentInfo[];
	}
	/** Answer to `attach`: whether a live CLI process backs this session. */
	| { readonly type: 'session_state'; readonly live: boolean; readonly sessionId?: string; readonly busy?: boolean }
	/** Messages waiting for the running turn to finish, in order. */
	| { readonly type: 'queue'; readonly items: readonly string[] }
	/** Coarse turn state reported by the CLI: `requesting`, `idle`, `compacting`, … */
	| { readonly type: 'status'; readonly status: string }
	/** Live thinking budget, so the UI can show progress before any text arrives. */
	| { readonly type: 'thinking_tokens'; readonly estimated: number; readonly delta: number }
	/**
	 * `messageId` identifies the API message the delta belongs to. The CLI writes
	 * a finished message to its jsonl under the same id, so a client that replayed
	 * a turn can tell which deltas are already part of the durable history.
	 */
	| { readonly type: 'assistant_delta'; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| { readonly type: 'thinking_delta'; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown; readonly parentToolUseId?: string }
	| { readonly type: 'tool_result'; readonly toolUseId: string; readonly isError: boolean; readonly content: string; readonly parentToolUseId?: string }
	/** A subagent (`Agent`/`Task` tool) or background task started. */
	| {
		readonly type: 'task_started';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly description?: string;
		readonly subagentType?: string;
		readonly taskType?: string;
		readonly prompt?: string;
	}
	/** Intermediate state change of a running task. */
	| { readonly type: 'task_updated'; readonly taskId: string; readonly toolUseId?: string; readonly status: string }
	/** Live progress line of a running subagent. */
	| {
		readonly type: 'task_progress';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly description?: string;
		readonly usage?: AgentTaskUsage;
	}
	/** A chunk of a background task's output file, streamed while it runs. */
	| { readonly type: 'task_output'; readonly taskId: string; readonly file: string; readonly chunk: string }
	/** The matching end event; `status` is `completed`, `failed` or `stopped`. */
	| {
		readonly type: 'task_notification';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly status: string;
		readonly summary?: string;
		readonly outputFile?: string;
		readonly usage?: AgentTaskUsage;
	}
	/** The CLI blocked on `--permission-prompt-tool`; answer with `permission_response`. */
	| {
		readonly type: 'permission_request';
		readonly requestId: string;
		readonly toolName: string;
		readonly input: unknown;
		readonly toolUseId?: string;
	}
	| {
		readonly type: 'result';
		readonly subtype?: string;
		readonly isError: boolean;
		readonly text?: string;
		readonly costUsd?: number;
		readonly durationMs?: number;
		readonly numTurns?: number;
		readonly sessionId?: string;
	}
	/** A pending approval was dropped (e.g. the user sent a new message instead). */
	| { readonly type: 'permission_cancelled' }
	| { readonly type: 'error'; readonly message: string }
	| { readonly type: 'exit'; readonly code: number | null; readonly stderr?: string };

/** Commands sent from the browser. */
export type AgentClientCommand =
	/** Handshake on connect: adopt the running process for this session, if any. */
	| { readonly type: 'attach'; readonly sessionId?: string; readonly replay?: boolean }
	/**
	 * `sessionId` continues an existing CLI session (`--resume`) instead of
	 * starting a new one. `newSession` says "start one" even though this socket is
	 * still attached to an older process; without it the message would land in
	 * that older transcript and no session file would be created.
	 */
	| { readonly type: 'user'; readonly text: string; readonly sessionId?: string; readonly newSession?: boolean }
	/** Graceful stop: asks the CLI to abort the current turn, keeps the process alive. */
	| { readonly type: 'interrupt' }
	/** Hard stop: kills the process (used when a graceful stop does not land). */
	| { readonly type: 'kill' }
	/** Answer to a `permission_request`. */
	| { readonly type: 'permission_response'; readonly requestId: string; readonly behavior: 'allow' | 'deny'; readonly message?: string }
	/** Runtime switch through the CLI control channel; no process restart needed. */
	| { readonly type: 'set_model'; readonly model: string }
	| { readonly type: 'set_permission_mode'; readonly mode: string }
	| { readonly type: 'reset' };
