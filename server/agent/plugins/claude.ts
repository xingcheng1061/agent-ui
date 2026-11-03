import type { Context, Plugin } from 'cordis';
import { MODELS, PERMISSION_MODES } from '../../config.js';
import type { AgentDriver } from '../driver.js';
import type { ModelOption } from '../protocol.js';
import { ClaudeCliSession } from '../claudeCliSession.js';

export interface ClaudeAgentOptions {
	/** Discovered at boot by `resolveModels()`; the env aliases are the fallback. */
	readonly models?: readonly ModelOption[];
	/** Passed to the CLI as `--model` when the user has no stored choice. */
	readonly defaultModel?: string;
	readonly defaultPermissionMode?: string;
}

export function createClaudeDriver(options: ClaudeAgentOptions = {}): AgentDriver {
	const models = options.models ?? MODELS.map(id => ({ id }));
	return {
		id: 'claude',
		name: 'Claude Code',
		description: '本机 claude CLI：工具调用、子代理、后台任务与交互式审批',
		models,
		permissionModes: PERMISSION_MODES,
		defaultModel: options.defaultModel,
		defaultPermissionMode: options.defaultPermissionMode ?? 'acceptEdits',
		supportsResume: true,
		createSession: (sessionOptions, emit) => new ClaudeCliSession(sessionOptions, emit),
	};
}

/** Cordis plugin: installs the Claude Code backend into `ctx.agents`. */
export function claudeAgentPlugin(options: ClaudeAgentOptions = {}): Plugin.Object<Context> {
	return {
		name: 'agent-ui:claude',
		inject: ['agents'],
		apply(ctx) {
			ctx.agents.register(createClaudeDriver(options));
		},
	};
}
