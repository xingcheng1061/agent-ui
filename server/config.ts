import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Directory exposed by the service. Everything outside of it is rejected. */
export const PROJECT_ROOT = path.resolve(process.env.AGENT_UI_ROOT ?? process.cwd());

/** Loopback by default: this service proxies a real PTY, so never expose it unauthenticated. */
export const HOST = process.env.AGENT_UI_HOST ?? '127.0.0.1';

export const PORT = Number(process.env.AGENT_UI_PORT ?? 4711);

/** Optional shared secret. When set, every API request and WS handshake must present `?token=`. */
export const ACCESS_TOKEN = process.env.AGENT_UI_TOKEN ?? '';

/** Files larger than this are not opened in the editor. */
export const MAX_FILE_SIZE = 2 * 1024 * 1024;

/** Per-run secret used by the MCP approval child to reach `/internal/permission`. */
export const INTERNAL_TOKEN = randomUUID();

/** Models offered in the picker. `claude` maps these aliases to provider models. */
export const MODELS = (process.env['AGENT_UI_MODELS'] ?? 'sonnet,opus,haiku')
	.split(',')
	.map(model => model.trim())
	.filter(model => model.length > 0);

/** Permission modes the CLI accepts for `set_permission_mode`. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

/** Where the MCP approval child should call back. Loopback even when HOST is a wildcard. */
export const INTERNAL_ORIGIN = `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}`;

function durationFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	const parsed = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A disconnected client may still come back, so keep its process this long.
 * An hour by default: coming back to a session after a long break should feel
 * instant, and a running turn always outlives the timer anyway.
 */
export const REAP_DELAY_MS = durationFromEnv('AGENT_UI_REAP_MS', 60 * 60 * 1000);

/**
 * How long an approval card may sit unanswered before it is denied. An hour:
 * the user often walks away mid-turn, and the card is resolved immediately when
 * they send a new message instead (see the `user` command handler).
 */
export const PERMISSION_TIMEOUT_MS = durationFromEnv('AGENT_UI_PERMISSION_TIMEOUT_MS', 60 * 60 * 1000);

/** Grace period for the CLI to acknowledge an interrupt before a hard kill. */
export const INTERRUPT_GRACE_MS = durationFromEnv('AGENT_UI_INTERRUPT_GRACE_MS', 5000);

/** Verbose agent/event logging; set `AGENT_UI_DEBUG=1` to diagnose stalls. */
export const DEBUG = process.env['AGENT_UI_DEBUG'] === '1';

/** `[HH:MM:SS.mmm]` prefix so server and client logs can be correlated. */
export function stamp(): string {
	return new Date().toISOString().slice(11, 23);
}

export function isAuthorized(url: URL): boolean {
	if (!ACCESS_TOKEN) {
		return true;
	}
	return url.searchParams.get('token') === ACCESS_TOKEN;
}

export function requestUrl(reqUrl: string | undefined, host: string | undefined): URL {
	return new URL(reqUrl ?? '/', `http://${host ?? 'localhost'}`);
}
