import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	DEBUG,
	DEFAULT_MODELS,
	EXPLICIT_MODELS,
	MODELS_TIMEOUT_MS,
	MODELS_TOKEN,
	MODELS_URL,
	stamp,
} from './config.js';
import type { ModelOption } from './agent/protocol.js';

/**
 * The picker's model list.
 *
 * `claude` itself only knows `sonnet` / `opus` / `haiku`; the real names come
 * from whatever gateway sits in front of it (tclaude's local gateway exposes
 * `GET /v1/models`). Hardcoding them means every new model needs a code change,
 * so they are discovered once at boot instead, with the aliases as a floor:
 *
 *   AGENT_UI_MODELS_URL → ANTHROPIC_BASE_URL → ~/.tclaude/daemon.json → cache
 *
 * `AGENT_UI_MODELS` still wins outright — an explicit list is a decision, and
 * silently appending discovered models to it would be the opposite of one.
 */

export interface ModelDiscoveryResult {
	readonly models: readonly ModelOption[];
	/** Where the list came from; printed in the boot banner so it is diagnosable. */
	readonly source: string;
}

/** One place that may know the real list. */
interface Candidate {
	readonly label: string;
	readonly load: () => Promise<readonly ModelOption[]>;
}

const TCLAUDE_DIR = path.join(os.homedir(), '.tclaude');
const DAEMON_FILE = path.join(TCLAUDE_DIR, 'daemon.json');
const CACHE_FILE = path.join(TCLAUDE_DIR, 'cache', 'gateway-models.json');

/** Deep enough for `{ gateway: { endpoints: { http: … } } }`, shallow enough to stay cheap. */
const MAX_WALK_DEPTH = 6;

/** Resolves the list the picker should show; never throws. */
export async function resolveModels(): Promise<ModelDiscoveryResult> {
	if (EXPLICIT_MODELS.length > 0) {
		return { models: EXPLICIT_MODELS.map(id => ({ id })), source: 'AGENT_UI_MODELS' };
	}
	const discovered = await discoverModels();
	if (!discovered) {
		return { models: DEFAULT_MODELS.map(id => ({ id })), source: 'built-in aliases (no gateway answered)' };
	}
	return { models: withAliases(discovered.models), source: discovered.source };
}

/**
 * Probes the known gateways and returns the first one that answers with a list.
 *
 * The probes run concurrently: the candidates are independent, and a serial
 * chain waits out the full timeout of every dead one on the way. Two phases
 * instead of one pool, because the cache file is read in microseconds and would
 * always beat a live gateway in a race — and a stale cache is exactly what this
 * is supposed to replace.
 */
export async function discoverModels(): Promise<ModelDiscoveryResult | undefined> {
	const live = await firstAnswer(await gatewayCandidates());
	return live ?? await readCache();
}

/** Every configured gateway, in trust order, as a probe. */
async function gatewayCandidates(): Promise<Candidate[]> {
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	const push = (label: string, raw: string) => {
		const endpoint = modelsEndpoint(raw);
		if (!endpoint || seen.has(endpoint)) {
			return;
		}
		seen.add(endpoint);
		candidates.push({ label, load: () => fetchModels(endpoint) });
	};

	push('AGENT_UI_MODELS_URL', MODELS_URL);
	push('ANTHROPIC_BASE_URL', process.env['ANTHROPIC_BASE_URL'] ?? '');
	for (const endpoint of await daemonEndpoints()) {
		push('tclaude daemon.json', endpoint);
	}
	return candidates;
}

/** Resolves with the first candidate that yields a non-empty list. */
async function firstAnswer(candidates: readonly Candidate[]): Promise<ModelDiscoveryResult | undefined> {
	if (candidates.length === 0) {
		return undefined;
	}
	return new Promise(resolve => {
		let settled = false;
		let remaining = candidates.length;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: ModelDiscoveryResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		// One budget for the whole phase: whichever probe answers first wins, and
		// a gateway that never answers costs the timeout, not four of them.
		timer = setTimeout(() => finish(undefined), MODELS_TIMEOUT_MS);
		timer.unref?.();

		for (const candidate of candidates) {
			void candidate.load()
				.then(models => {
					if (models.length > 0) {
						log(`models from ${candidate.label}: ${models.length}`);
						finish({ models, source: candidate.label });
					}
				})
				.catch(error => {
					log(`models probe ${candidate.label} failed: ${describe(error)}`);
				})
				.finally(() => {
					remaining -= 1;
					if (remaining === 0) {
						finish(undefined);
					}
				});
		}
	});
}

/**
 * The cache file is the last resort, deliberately: it may predate the gateway
 * that is running now (and stops working entirely when the gateway is replaced),
 * but it is still better than pretending three aliases are all that exists.
 */
async function readCache(): Promise<ModelDiscoveryResult | undefined> {
	const raw = await fs.readFile(CACHE_FILE, 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const models = optionsFromPayload(parsed);
	if (models.length === 0) {
		return undefined;
	}
	log(`models from the tclaude cache (possibly stale): ${models.length}`);
	return { models, source: 'tclaude gateway cache' };
}

async function fetchModels(endpoint: string): Promise<readonly ModelOption[]> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (MODELS_TOKEN) {
		headers['authorization'] = `Bearer ${MODELS_TOKEN}`;
	}
	const response = await fetch(endpoint, {
		headers,
		signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return optionsFromPayload(await response.json());
}

/** `http://host:port`, `…/v1` and `…/v1/models` all become the models endpoint. */
function modelsEndpoint(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined;
	}
	const pathname = url.pathname.replace(/\/+$/, '');
	if (pathname.endsWith('/models')) {
		return url.toString();
	}
	url.pathname = pathname.endsWith('/v1') ? `${pathname}/models` : `${pathname}/v1/models`;
	return url.toString();
}

/**
 * URLs (and bare ports) recorded by the tclaude daemon.
 *
 * The file's exact shape is an implementation detail of the gateway, so it is
 * walked rather than destructured: any http(s) URL in it is a candidate, and a
 * `port` key becomes `http://127.0.0.1:<port>`. A structural change upstream
 * therefore degrades to "no candidate", not to "crash on boot".
 */
async function daemonEndpoints(): Promise<readonly string[]> {
	const raw = await fs.readFile(DAEMON_FILE, 'utf8').catch(() => undefined);
	if (raw === undefined) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	const urls: string[] = [];
	const ports: number[] = [];
	walk(parsed, (key, value) => {
		if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
			urls.push(value);
			return;
		}
		if (/^(port|gatewayPort)$/i.test(key)) {
			const port = Number(value);
			if (Number.isInteger(port) && port > 0 && port < 65536) {
				ports.push(port);
			}
		}
	});
	for (const port of ports) {
		urls.push(`http://127.0.0.1:${port}`);
	}
	return urls;
}

function walk(node: unknown, visit: (key: string, value: string | number) => void, depth = 0): void {
	if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') {
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			walk(item, visit, depth + 1);
		}
		return;
	}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (typeof value === 'string' || typeof value === 'number') {
			visit(key, value);
		} else {
			walk(value, visit, depth + 1);
		}
	}
}

/**
 * Model entries out of either shape the gateways use: OpenAI's
 * `{ data: [{ id, display_name }] }` or tclaude's cached `{ models: [{ id }] }`
 * (a bare array of strings works too).
 *
 * The id is kept verbatim — `claude-opus-4-7[1m]` is what `--model` takes — and
 * `display_name` becomes the picker's label when it differs.
 */
function optionsFromPayload(payload: unknown): readonly ModelOption[] {
	const options: ModelOption[] = [];
	const seen = new Set<string>();
	for (const entry of payloadList(payload)) {
		const option = optionOf(entry);
		if (!option || seen.has(option.id)) {
			continue;
		}
		seen.add(option.id);
		options.push(option);
	}
	return options;
}

function optionOf(entry: unknown): ModelOption | undefined {
	if (typeof entry === 'string') {
		const id = entry.trim();
		return id ? { id } : undefined;
	}
	if (!entry || typeof entry !== 'object') {
		return undefined;
	}
	const record = entry as Record<string, unknown>;
	const id = firstString(record, ['id', 'name', 'model']);
	if (id === undefined) {
		return undefined;
	}
	const label = firstString(record, ['display_name', 'displayName', 'label', 'title']);
	return label !== undefined && label !== id ? { id, label } : { id };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function payloadList(payload: unknown): readonly unknown[] {
	if (Array.isArray(payload)) {
		return payload;
	}
	if (!payload || typeof payload !== 'object') {
		return [];
	}
	const record = payload as Record<string, unknown>;
	for (const key of ['data', 'models']) {
		const value = record[key];
		if (Array.isArray(value)) {
			return value;
		}
		if (value && typeof value === 'object') {
			// `{ data: { models: [...] } }`
			const nested = (value as Record<string, unknown>)['models'];
			if (Array.isArray(nested)) {
				return nested;
			}
		}
	}
	return [];
}

/** Gateway order first (it mirrors `/model`), then the aliases it does not list. */
function withAliases(discovered: readonly ModelOption[]): readonly ModelOption[] {
	const listed = new Set(discovered.map(option => option.id));
	return [...discovered, ...DEFAULT_MODELS.filter(id => !listed.has(id)).map(id => ({ id }))];
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
	if (DEBUG) {
		console.log(`[${stamp()}][agent-ui] ${message}`);
	}
}
