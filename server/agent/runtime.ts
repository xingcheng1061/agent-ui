import { Context, type Plugin } from 'cordis';
import { AgentRegistry } from './driver.js';
import { claudeAgentPlugin, type ClaudeAgentOptions } from './plugins/claude.js';
import { echoAgentPlugin } from './plugins/echo.js';

export interface AgentRuntime {
	readonly ctx: Context;
	readonly registry: AgentRegistry;
}

export interface AgentRuntimeOptions {
	readonly defaultAgent?: string;
	readonly claude?: ClaudeAgentOptions;
	/**
	 * Additional backends. A third-party agent ships a cordis plugin that
	 * registers a driver on `ctx.agents`; nothing else in the server changes.
	 */
	readonly plugins?: readonly Plugin.Object<Context>[];
}

/**
 * Boots the plugin host. The order matters only for the fallback default:
 * plugins register in order, and the first one wins when neither the request
 * nor the persisted state names an agent.
 */
export async function createAgentRuntime(options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
	const ctx = new Context();
	const registry = new AgentRegistry();
	ctx.set('agents', registry);

	ctx.plugin(claudeAgentPlugin(options.claude));
	ctx.plugin(echoAgentPlugin());
	for (const plugin of options.plugins ?? []) {
		ctx.plugin(plugin);
	}

	await ctx.start();
	if (options.defaultAgent && registry.has(options.defaultAgent)) {
		registry.setDefault(options.defaultAgent);
	}
	return { ctx, registry };
}

export async function disposeAgentRuntime(runtime: AgentRuntime): Promise<void> {
	await runtime.ctx.stop();
}
