import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Everything the service persists by itself lives here. */
export const DATA_DIR = path.join(os.homedir(), '.agent-ui');

function fileFor(name: string): string {
	return path.join(DATA_DIR, name);
}

/** Reads a JSON document, returning `fallback` when missing or unreadable. */
export async function readJson<T>(name: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(fileFor(name), 'utf8')) as T;
	} catch {
		return fallback;
	}
}

/**
 * Atomic write: a temp file plus rename. A crash halfway through cannot leave a
 * truncated store behind, which matters because these files hold credentials.
 */
export async function writeJson(name: string, value: unknown): Promise<void> {
	const target = fileFor(name);
	const temp = `${target}.${process.pid}.tmp`;
	await fs.mkdir(DATA_DIR, { recursive: true });
	await fs.writeFile(temp, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
	await fs.rename(temp, target);
}

/**
 * A cached JSON document. Reads are synchronous after the first `load()`; writes
 * are chained so two quick updates cannot interleave and lose one.
 */
export class JsonStore<T> {
	private _value: T | undefined;
	private _writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly _name: string,
		private readonly _fallback: T,
	) { }

	async load(): Promise<T> {
		this._value = await readJson(this._name, this._fallback);
		return this._value;
	}

	/** Snapshot for synchronous callers; the fallback until {@link load} resolves. */
	get snapshot(): T {
		return this._value ?? this._fallback;
	}

	/**
	 * Clone-mutate-write. The mutator sees a private copy, so callers cannot
	 * corrupt the cached snapshot by holding on to a reference.
	 */
	async update(mutator: (draft: T) => void): Promise<T> {
		const draft = structuredClone(this.snapshot);
		mutator(draft);
		this._value = draft;
		this._writeChain = this._writeChain
			.then(() => writeJson(this._name, draft))
			.catch(error => {
				console.error(`[agent-ui] failed to persist ${this._name}:`, error);
			});
		await this._writeChain;
		return draft;
	}
}
