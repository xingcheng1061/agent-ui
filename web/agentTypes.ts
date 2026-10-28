/** Mirror of `server/agent/protocol.ts` for the browser side. */

/** Token/tool accounting the CLI reports when a subagent or background task ends. */
export interface AgentTaskUsage {
	readonly totalTokens?: number;
	readonly toolUses?: number;
	readonly durationMs?: number;
}

/** One installed agent backend (mirror of the server's `AgentInfo`). */
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

export type AgentServerEvent =
	| {
		readonly type: 'system';
		readonly sessionId: string;
		readonly agent?: string;
		readonly model?: string;
		readonly cwd?: string;
		readonly toolCount?: number;
		readonly permissionMode?: string;
		readonly slashCommands?: readonly string[];
		readonly skills?: readonly string[];
		readonly agents?: readonly string[];
		readonly models?: readonly string[];
	}
	| {
		readonly type: 'config';
		readonly model?: string;
		readonly permissionMode?: string;
		readonly models?: readonly string[];
		readonly permissionModes?: readonly string[];
		readonly agent?: string;
		readonly agents?: readonly AgentInfo[];
	}
	| { readonly type: 'session_state'; readonly live: boolean; readonly sessionId?: string; readonly busy?: boolean }
	| { readonly type: 'queue'; readonly items: readonly string[] }
	| { readonly type: 'status'; readonly status: string }
	| { readonly type: 'thinking_tokens'; readonly estimated: number; readonly delta: number }
	/** `messageId` matches the id the CLI stored the finished message under. */
	| { readonly type: 'assistant_delta'; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| { readonly type: 'thinking_delta'; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown; readonly parentToolUseId?: string }
	| { readonly type: 'tool_result'; readonly toolUseId: string; readonly isError: boolean; readonly content: string; readonly parentToolUseId?: string }
	| {
		readonly type: 'task_started';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly description?: string;
		readonly subagentType?: string;
		readonly taskType?: string;
		readonly prompt?: string;
	}
	| { readonly type: 'task_updated'; readonly taskId: string; readonly toolUseId?: string; readonly status: string }
	| {
		readonly type: 'task_progress';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly description?: string;
		readonly usage?: AgentTaskUsage;
	}
	| { readonly type: 'task_output'; readonly taskId: string; readonly file: string; readonly chunk: string }
	| {
		readonly type: 'task_notification';
		readonly taskId: string;
		readonly toolUseId?: string;
		readonly status: string;
		readonly summary?: string;
		readonly outputFile?: string;
		readonly usage?: AgentTaskUsage;
	}
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
	| { readonly type: 'permission_cancelled' }
	| { readonly type: 'error'; readonly message: string }
	| { readonly type: 'exit'; readonly code: number | null; readonly stderr?: string };

export type AgentClientCommand =
	| { readonly type: 'attach'; readonly sessionId?: string; readonly replay?: boolean }
	/** `newSession` starts a fresh conversation instead of continuing the attached one. */
	| { readonly type: 'user'; readonly text: string; readonly sessionId?: string; readonly newSession?: boolean }
	| { readonly type: 'interrupt' }
	| { readonly type: 'kill' }
	| { readonly type: 'permission_response'; readonly requestId: string; readonly behavior: 'allow' | 'deny'; readonly message?: string }
	| { readonly type: 'set_model'; readonly model: string }
	| { readonly type: 'set_permission_mode'; readonly mode: string }
	| { readonly type: 'reset' };
