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

/**
 * Aliases the `claude` CLI maps to provider models on its own: the built-in
 * fallback, and what the picker showed before the gateway list was discovered.
 */
export const DEFAULT_MODELS: readonly string[] = ['sonnet', 'opus', 'haiku'];

/** `AGENT_UI_MODELS`, parsed. Empty when it is unset (discovery then decides). */
export const EXPLICIT_MODELS: readonly string[] = (process.env['AGENT_UI_MODELS'] ?? '')
	.split(',')
	.map(model => model.trim())
	.filter(model => model.length > 0);

/**
 * Model list handed to the picker.
 *
 * `AGENT_UI_MODELS` is a decision, not a hint: when it is set the list is used
 * verbatim and nothing is discovered (`resolveModels()` in `server/models.ts`).
 * Otherwise the boot-time discovery merges the gateway's list with
 * `DEFAULT_MODELS`; this value is only the last resort for a driver that was
 * registered without an explicit list.
 */
export const MODELS: readonly string[] = EXPLICIT_MODELS.length > 0 ? EXPLICIT_MODELS : DEFAULT_MODELS;

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
 * Explicit model-list source. Accepts a base URL (`http://host:port`,
 * `http://host:port/v1`) or the full endpoint; `server/models.ts` fills in the
 * rest. Empty means "only the built-in candidates".
 */
export const MODELS_URL = process.env['AGENT_UI_MODELS_URL'] ?? '';

/** Bearer token for `MODELS_URL`, for gateways that do require one. */
export const MODELS_TOKEN = process.env['AGENT_UI_MODELS_TOKEN'] ?? '';

/**
 * Upper bound on boot-time model discovery.
 *
 * The candidates are probed concurrently, so this is the whole wait rather than
 * a per-request budget: one dead `ANTHROPIC_BASE_URL` must not push the UI's
 * start behind a 3s-per-candidate chain.
 */
export const MODELS_TIMEOUT_MS = durationFromEnv('AGENT_UI_MODELS_TIMEOUT_MS', 3000);

/**
 * A disconnected client may still come back, so keep its process this long.
 * An hour by default: coming back to a session after a long break should feel
 * instant, and a running turn always outlives the timer anyway.
 */
export const REAP_DELAY_MS = durationFromEnv('AGENT_UI_REAP_MS', 60 * 60 * 1000);

/**
 * How long an approval card may sit unanswered before it is denied.
 *
 * A day, not an hour: the user routinely walks away mid-turn (lunch, a meeting,
 * overnight) and coming back to "the agent denied everything and moved on" is
 * worse than a process that idles until it is stopped. The card is also resolved
 * immediately when the user sends a new message instead (see the `user` command
 * handler), and the process is killed with the session, so nothing leaks.
 */
export const PERMISSION_TIMEOUT_MS = durationFromEnv('AGENT_UI_PERMISSION_TIMEOUT_MS', 24 * 60 * 60 * 1000);

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
