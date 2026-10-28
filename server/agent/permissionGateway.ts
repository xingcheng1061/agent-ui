/**
 * Bridges the CLI's permission prompt (an MCP tool call handled by
 * `permissionPrompt.mjs`) to the browser attached to that session.
 *
 * The MCP process is a child of `claude`, so it cannot hold a reference to the
 * WebSocket. It posts to `/internal/permission` instead, which lands here and
 * resolves through the owning session.
 */

import type { PermissionDecision, PermissionPrompt } from './driver.js';

export type { PermissionDecision, PermissionPrompt };

interface PermissionHost {
	readonly id: string;
	/** Ask the browser; resolves once it answers, or with a denial on timeout. */
	requestPermission(prompt: PermissionPrompt): Promise<PermissionDecision>;
}

const hosts = new Map<string, PermissionHost>();

export function bindPermissionHost(host: PermissionHost): () => void {
	hosts.set(host.id, host);
	return () => {
		if (hosts.get(host.id) === host) {
			hosts.delete(host.id);
		}
	};
}

export async function requestPermissionFromBrowser(sessionId: string, prompt: PermissionPrompt): Promise<PermissionDecision> {
	const host = hosts.get(sessionId);
	if (!host) {
		return { behavior: 'deny', message: '该会话已断开，无法审批。' };
	}
	return host.requestPermission(prompt);
}
