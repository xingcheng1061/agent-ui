/**
 * Paths printed in terminal output, turned into something the code pane can
 * open.
 *
 * Deliberately free of xterm and React: mapping "a token on screen" to a
 * concrete file is where the edge cases live — relative paths, `:line:col`
 * suffixes, Windows separators, punctuation glued to the end, and paths that
 * belong to a project other than the terminal's own root.
 */

export interface PathToken {
	/** The path exactly as printed, without a `:line` suffix. */
	readonly text: string;
	/** 0-based column of the first character in the line. */
	readonly start: number;
	/** 0-based column just past the last character. */
	readonly end: number;
	readonly line?: number;
	readonly column?: number;
}

/** A path resolved to an absolute location, ready for the code pane. */
export interface TerminalTarget {
	/** Absolute path, using the separator style it was printed with. */
	readonly path: string;
	readonly line?: number;
	readonly column?: number;
	/**
	 * The screen printed a relative path, so `path` is a guess: it is only as
	 * good as the base it was joined to. Callers use this to verify the file
	 * exists before trusting it, and to fall back to a suffix search.
	 */
	readonly relative?: boolean;
}

/**
 * Splits on characters that cannot appear in a path on either platform, which
 * also keeps `(see foo.ts)` and `"foo.ts"` down to the path itself.
 */
const TOKEN = /[^\s"'`<>()[\]{}|]+/g;

const DRIVE = /^[A-Za-z]:/;

/**
 * `foo.ts:12`, `foo.ts:12:5` and `foo.ts:12-20`, but not `C:\foo.ts` — the
 * last two forms are what a diff or a review comment prints.
 */
const LINE_SUFFIX = /^(.*?):(\d+)(?:-(\d+)|:(\d+))?$/;

/** Trailing prose punctuation: `foo.ts,` `foo.ts.` `bar:` */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function isAbsolutePath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Every path-looking token on one rendered line.
 *
 * A token normally ends in a name with an extension, which is what keeps most
 * prose out. Extension-less names are far more often words (`and/or`) than
 * files, so they only qualify when the token is structured: `./x`, `../x`, or
 * at least two directory separators (`a/b/test_poi`). Bare one-word names stay
 * unclickable even with an extension of one letter, where `e.g` would be a
 * false positive.
 */
export function findPathTokens(line: string): PathToken[] {
	const tokens: PathToken[] = [];
	for (const match of line.matchAll(TOKEN)) {
		const raw = match[0];
		const start = match.index ?? 0;
		if (raw.length < 3 || raw.includes('://')) {
			continue;
		}
		let body = raw;
		let lineNumber: number | undefined;
		let column: number | undefined;
		const suffix = LINE_SUFFIX.exec(body);
		if (suffix?.[1]) {
			body = suffix[1];
			lineNumber = Number(suffix[2]);
			// Group 3 is a range end (`:12-20`), group 4 a column (`:12:5`).
			column = suffix[4] === undefined ? undefined : Number(suffix[4]);
		}
		const trimmed = body.replace(TRAILING_PUNCTUATION, '');
		if (!looksLikePath(trimmed)) {
			continue;
		}
		tokens.push({ text: trimmed, start, end: start + trimmed.length, line: lineNumber, column });
	}
	return tokens;
}

function looksLikePath(candidate: string): boolean {
	if (candidate.startsWith('~')) {
		// A home-relative path: only the server knows where that is.
		return false;
	}
	// `\p{L}\p{N}` rather than A-Z: paths routinely contain Chinese here.
	if (!/^[\p{L}\p{N}_.@+\-:/\\]+$/u.test(candidate)) {
		return false;
	}
	const segments = candidate.split(/[\\/]+/).filter(segment => segment.length > 0);
	const last = segments[segments.length - 1];
	if (!last || last === '.' || last === '..') {
		return false;
	}
	if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last)) {
		// A bare name without an extension is far more often prose (`e.g`,
		// `and/or`) than a file, so only structured paths qualify: `./x`,
		// `../x`, or at least two directory separators.
		const separators = (candidate.match(/[\\/]/g) ?? []).length;
		const prefixed = candidate.startsWith('./') || candidate.startsWith('../');
		if (!prefixed && separators < 2) {
			return false;
		}
		return true;
	}
	// Single-letter extensions (`main.c`) are a real thing, but only accept them
	// when the token also has a directory part, where `e.g` cannot be mistaken.
	const bare = segments.length === 1 && !isAbsolutePath(candidate);
	return !bare || /\.[A-Za-z][A-Za-z0-9]+$/.test(last);
}

/** Collapses `.` / `..` and unifies separators, keeping a drive letter. */
export function normalizePath(value: string): string {
	const windows = DRIVE.test(value) || value.includes('\\');
	const drive = DRIVE.exec(value)?.[0] ?? '';
	const rest = value.slice(drive.length).replace(/\\/g, '/');
	const segments: string[] = [];
	for (const segment of rest.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const separator = windows ? '\\' : '/';
	return `${drive}${separator}${segments.join(separator)}`;
}

/** `base` is the terminal's project root; `relative` may itself be absolute. */
export function joinPath(base: string, relative: string): string {
	return normalizePath(`${base.replace(/[\\/]+$/, '')}/${relative}`);
}

/**
 * `base` is where the shell is — `cd`-tracked, not the project root — because a
 * relative path on screen is relative to the directory the prompt shows.
 */
export function resolveTerminalTarget(token: PathToken, base: string): TerminalTarget {
	const absolute = isAbsolutePath(token.text);
	const path = absolute ? normalizePath(token.text) : joinPath(base, token.text);
	return { path, line: token.line, column: token.column, relative: !absolute };
}

/**
 * `absolute` as a path relative to `root`, or undefined when it is outside.
 *
 * Used to decide which project a clicked path belongs to and what to send the
 * server, which only accepts paths inside a known root.
 */
export function relativeToRoot(root: string, absolute: string): string | undefined {
	const rootPath = root.replace(/\\/g, '/').replace(/\/+$/, '');
	const targetPath = absolute.replace(/\\/g, '/').replace(/\/+$/, '');
	// Drive letters are case-insensitive; POSIX paths are not.
	const caseBlind = DRIVE.test(rootPath);
	const left = caseBlind ? rootPath.toLowerCase() : rootPath;
	const right = caseBlind ? targetPath.toLowerCase() : targetPath;
	if (!right.startsWith(`${left}/`)) {
		return undefined;
	}
	return targetPath.slice(left.length + 1);
}
