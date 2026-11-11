import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { terminalUrl } from '../api';
import { t } from '../i18n';
import { getTheme, onThemeChange, type ThemeName } from '../theme';
import { findPathTokens, resolveTerminalTarget, type TerminalTarget } from './terminalPaths';

/**
 * One live terminal screen per terminal id, owned outside React.
 *
 * A terminal used to be a component that opened its socket on mount and closed
 * it on unmount, which made the socket's lifetime the *panel's* lifetime. Since
 * the panel is keyed by project root, switching to a session in another project
 * tore the whole thing down: the screen was lost, the socket closed, and the
 * next attach replayed a snapshot — so the shell looked like it had restarted.
 *
 * The shell itself never cared (it lives on the server), so neither should the
 * socket: it stays open, the xterm instance keeps its scrollback, and the view
 * is only a slot that the host element is plugged into. Detaching and
 * re-attaching is a DOM move; nothing is renegotiated.
 *
 * The old behaviour is still available where it belongs: an explicit "close
 * terminal" disposes the session (`forgetTerminalSession`), and idle screens are
 * pruned by `MAX_IDLE_SESSIONS` so a long browser session cannot accumulate
 * xterm instances forever.
 */

export type TerminalState = 'connecting' | 'open' | 'closed';

interface ServerMessage {
	readonly type: 'output' | 'error' | 'exit' | 'snapshot' | 'cwd';
	readonly data?: string;
	readonly message?: string;
	readonly code?: number;
	/** Live shell directory, for the `cwd` message. */
	readonly cwd?: string;
}

/**
 * xterm has no palette switching, so both are declared here.
 *
 * `selectionBackground` is not optional: xterm's built-in default is white,
 * which on the light theme is the same colour as the background — selecting
 * text looked like nothing had happened. The values are VS Code's.
 */
const XTERM_THEMES: Record<ThemeName, {
	background: string;
	foreground: string;
	cursor: string;
	selectionBackground: string;
	selectionInactiveBackground: string;
}> = {
	dark: {
		background: '#181818',
		foreground: '#d4d4d4',
		cursor: '#aeafad',
		selectionBackground: '#264f78',
		selectionInactiveBackground: '#3a3d41',
	},
	light: {
		background: '#ffffff',
		foreground: '#24292f',
		cursor: '#044289',
		selectionBackground: '#add6ff',
		selectionInactiveBackground: '#e5ebf1',
	},
};

/** Silent retries before asking the user; covers transient blips. */
const AUTO_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/** Detached screens kept warm; the least recently used one goes first. */
const MAX_IDLE_SESSIONS = 8;

export interface TerminalSession {
	readonly id: string;
	readonly state: TerminalState;
	/** Appends the live screen to a slot and sizes it to that slot. */
	attach(slot: HTMLElement): void;
	/** Pulls the screen out of the DOM; socket, scrollback and size survive. */
	detach(slot: HTMLElement): void;
	fit(): void;
	watchState(listener: (state: TerminalState) => void): () => void;
	/** After the fallback overlay appeared: try again without a reload. */
	reconnect(): void;
	/**
	 * Where ctrl+click on a path goes. `root` is only the fallback base for
	 * relative paths — the shell's own reported cwd wins once it has one. Pass
	 * `undefined` as the handler when no code pane is showing the screen.
	 */
	setOpenTargetHandler(root: string, handler: ((target: TerminalTarget) => void) | undefined): void;
}

class LiveScreen implements TerminalSession {
	readonly id: string;
	lastUsed = Date.now();

	private readonly _host: HTMLDivElement;
	private readonly _term: XTerm;
	private readonly _fit: FitAddon;
	private readonly _listeners = new Set<(state: TerminalState) => void>();
	private readonly _onTheme: () => void;
	private _socket: WebSocket | undefined;
	private _retryTimer: number | undefined;
	private _retriesLeft = AUTO_RETRIES;
	private _state: TerminalState = 'connecting';
	/** `xterm.open` needs a laid-out parent, so it waits for the first attach. */
	private _opened = false;
	private _attached = 0;
	private _disposed = false;
	/**
	 * True while a snapshot is being parsed.
	 *
	 * A snapshot is a recording of output, and some of that output was a
	 * *query* (`ESC]11;?`, `ESC[6n`, `ESC[12$p`, …) that the program asked and
	 * had answered at the time. Feeding it back into a live terminal makes xterm
	 * answer again — and by now no program is reading, so the shell echoes the
	 * answer as if it had been typed, which is where the `10;rgb:d4d4/…` and
	 * `12;2$y` noise on every reconnect came from.
	 */
	private _replaying = false;
	/** Keystrokes typed during that window, flushed once the replay is done. */
	private _pendingInput = '';
	/** Size last reported to the server, so re-attaching does not re-signal it. */
	private _sentCols = 0;
	private _sentRows = 0;
	/** Set by the view: ctrl+click on a printed path opens it in the code pane. */
	private _openTarget: ((target: TerminalTarget) => void) | undefined;
	/** Fallback base for relative paths: the project the terminal belongs to. */
	private _openRoot = '';
	/**
	 * Where the shell says it is, reported by its prompt.
	 *
	 * `_openRoot` is where the shell was *started*, so after a `cd` a relative
	 * path on screen no longer means "relative to the project root" — this is
	 * what keeps ctrl+click pointing at the file the user is looking at.
	 */
	private _cwd = '';
	/** The insecure-context paste notice is worth saying once, not per keystroke. */
	private _pasteHintShown = false;

	constructor(id: string) {
		this.id = id;
		this._host = document.createElement('div');
		this._host.className = 'terminal-host-xterm';
		this._term = new XTerm({
			convertEol: true,
			cursorBlink: true,
			fontSize: 12,
			fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace',
			theme: XTERM_THEMES[getTheme()],
			scrollback: 5000,
		});
		this._fit = new FitAddon();
		this._term.loadAddon(this._fit);
		this._term.onData(data => this._type(data));
		// Ctrl+C / Ctrl+V are xterm's business only when it has nothing better to
		// do: without this hook it sends ^C and ^V to the shell and the browser's
		// own copy/paste never runs.
		this._term.attachCustomKeyEventHandler(event => this._handleKey(event));
		this._term.registerLinkProvider({
			provideLinks: (bufferLineNumber, callback) => callback(this._linksAt(bufferLineNumber)),
		});
		this._onTheme = onThemeChange(theme => {
			this._term.options.theme = XTERM_THEMES[theme];
		});
		this._connect();
	}

	get state(): TerminalState {
		return this._state;
	}

	get attached(): boolean {
		return this._attached > 0;
	}

	get disposed(): boolean {
		return this._disposed;
	}

	attach(slot: HTMLElement): void {
		if (this._disposed) {
			return;
		}
		this.lastUsed = Date.now();
		this._attached += 1;
		if (this._host.parentElement !== slot) {
			slot.appendChild(this._host);
		}
		if (this._opened) {
			// A detached xterm can skip rendering, so the visible cells may be
			// stale even though the buffer is complete: repaint from it.
			this._term.refresh(0, Math.max(0, this._term.rows - 1));
		} else {
			this._term.open(this._host);
			this._opened = true;
		}
		this.fit();
		if (this._state === 'open') {
			this._term.focus();
		}
	}

	detach(slot: HTMLElement): void {
		this._attached = Math.max(0, this._attached - 1);
		this.lastUsed = Date.now();
		if (this._host.parentElement === slot) {
			slot.removeChild(this._host);
		}
	}

	/**
	 * Re-measures against the slot. Skipped while detached on purpose: the PTY
	 * keeps the size it had when the screen was last visible, so a background
	 * build is not reflowed to a size nobody asked for.
	 */
	fit(): void {
		if (this._disposed || !this._opened || this._attached === 0) {
			return;
		}
		if (this._host.clientWidth === 0 || this._host.clientHeight === 0) {
			return;
		}
		try {
			this._fit.fit();
		} catch {
			// Mid-layout; the next ResizeObserver tick will do it.
		}
		this._sendResize();
	}

	watchState(listener: (state: TerminalState) => void): () => void {
		this._listeners.add(listener);
		listener(this._state);
		return () => this._listeners.delete(listener);
	}

	reconnect(): void {
		if (this._disposed || this._socket) {
			return;
		}
		if (this._retryTimer) {
			window.clearTimeout(this._retryTimer);
			this._retryTimer = undefined;
		}
		this._retriesLeft = AUTO_RETRIES;
		this._connect();
	}

	setOpenTargetHandler(root: string, handler: ((target: TerminalTarget) => void) | undefined): void {
		this._openRoot = root;
		this._openTarget = handler;
	}

	/**
	 * Links on one row, recomputed on demand.
	 *
	 * xterm asks per visible row on every repaint, so this stays a plain regex
	 * pass; the expensive part — deciding which project owns the path — happens
	 * on click, in the workspace.
	 */
	private _linksAt(bufferLineNumber: number): ILink[] | undefined {
		// The live directory wins over the project root; without either there is
		// nothing to resolve a relative path against.
		const base = this._cwd || this._openRoot;
		if (!this._openTarget || !base) {
			return undefined;
		}
		const line = this._term.buffer.active.getLine(bufferLineNumber - 1);
		if (!line) {
			return undefined;
		}
		const text = line.translateToString(true);
		const tokens = findPathTokens(text);
		if (tokens.length === 0) {
			return undefined;
		}
		return tokens.map(token => ({
			range: {
				start: { x: token.start + 1, y: bufferLineNumber },
				end: { x: token.end, y: bufferLineNumber },
			},
			text: token.text,
			activate: (event: MouseEvent) => {
				// Same rule as VS Code: hover shows the target, ctrl+click opens it.
				if (!event.ctrlKey && !event.metaKey) {
					return;
				}
				// `base` is the directory the row was painted under, which is the one
				// the line was printed in. Resolving at click time instead would use
				// wherever the shell is *now* — wrong for anything above the prompt.
				this._openTarget?.(resolveTerminalTarget(token, base));
			},
		}));
	}

	/**
	 * Clipboard shortcuts, with VS Code's behaviour.
	 *
	 * Returning false means "xterm, do not touch this event": the browser's
	 * default is already prevented, because letting it run (devtools on
	 * Ctrl+Shift+C, for one) is worse than swallowing it.
	 */
	private _handleKey(event: KeyboardEvent): boolean {
		if (event.type !== 'keydown') {
			return true;
		}
		const key = event.key.toLowerCase();
		const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
		const primary = isMac ? event.metaKey : event.ctrlKey;
		const copyRequested = (primary && key === 'c' && this._term.hasSelection())
			|| (event.ctrlKey && event.shiftKey && key === 'c')
			|| (event.ctrlKey && event.key === 'Insert');
		if (copyRequested) {
			event.preventDefault();
			this._copySelection();
			return false;
		}
		const pasteRequested = (primary && key === 'v')
			|| (event.ctrlKey && event.shiftKey && key === 'v')
			|| (event.shiftKey && event.key === 'Insert');
		if (pasteRequested) {
			event.preventDefault();
			if (!navigator.clipboard?.readText) {
				// Reading the clipboard needs a secure context, and xterm would
				// swallow Ctrl+V as ^V anyway — say why instead of doing nothing.
				if (!this._pasteHintShown) {
					this._pasteHintShown = true;
					this._term.write('\r\n\x1b[90m' + t('[无法读取剪贴板：请通过 localhost 或 HTTPS 打开本页]') + '\x1b[0m\r\n');
				}
				return false;
			}
			this._pasteFromClipboard();
			return false;
		}
		return true;
	}

	private _copySelection(): void {
		const text = this._term.getSelection();
		if (text) {
			void writeClipboard(text);
		}
	}

	private _pasteFromClipboard(): void {
		void readClipboard().then(text => {
			if (!text || this._disposed) {
				return;
			}
			// `paste` wraps the text in bracketed-paste markers when the shell
			// asked for them, which is what keeps a multi-line paste from being
			// executed line by line as if it had been typed.
			this._term.paste(text);
		});
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		if (this._retryTimer) {
			window.clearTimeout(this._retryTimer);
			this._retryTimer = undefined;
		}
		this._onTheme();
		this._socket?.close();
		this._socket = undefined;
		this._host.remove();
		this._term.dispose();
		this._listeners.clear();
	}

	private _connect(): void {
		if (this._disposed) {
			return;
		}
		const socket = new WebSocket(terminalUrl(this.id));
		this._socket = socket;
		this._setState('connecting');
		socket.addEventListener('open', () => {
			if (this._socket !== socket) {
				return;
			}
			this._setState('open');
			this._retriesLeft = AUTO_RETRIES;
			// A new socket may land on a respawned PTY, so its size is unknown.
			this._sentCols = 0;
			this._sentRows = 0;
			this._sendResize();
			if (this._attached > 0) {
				this._term.focus();
			}
		});
		socket.addEventListener('message', event => this._onMessage(event));
		socket.addEventListener('close', () => {
			if (this._socket !== socket) {
				return;
			}
			this._socket = undefined;
			if (this._disposed) {
				return;
			}
			this._setState('closed');
			this._term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
			if (this._retriesLeft > 0) {
				this._retriesLeft -= 1;
				this._retryTimer = window.setTimeout(() => {
					this._retryTimer = undefined;
					this._connect();
				}, RETRY_DELAY_MS);
			}
		});
		socket.addEventListener('error', () => {
			// `close` always follows and owns the retry decision.
		});
	}

	private _onMessage(event: MessageEvent): void {
		let message: ServerMessage;
		try {
			message = JSON.parse(String(event.data)) as ServerMessage;
		} catch {
			return;
		}
		if (message.type === 'snapshot') {
			// A fresh attach: start from a clean screen, then replay. On a reconnect
			// this is also what stops the history from appearing twice.
			this._term.reset();
			this._replaying = true;
			const finish = () => {
				this._replaying = false;
				const pending = this._pendingInput;
				this._pendingInput = '';
				this._sendInput(pending);
			};
			// The callback runs once the bytes have been parsed, i.e. after every
			// query in them has been answered and (here) dropped.
			if (message.data) {
				this._term.write(message.data, finish);
			} else {
				finish();
			}
		} else if (message.type === 'output' && typeof message.data === 'string') {
			this._term.write(message.data);
		} else if (message.type === 'cwd' && typeof message.cwd === 'string' && message.cwd !== '') {
			this._cwd = message.cwd;
		} else if (message.type === 'error') {
			this._term.write(`\r\n\x1b[31m${message.message ?? 'terminal error'}\x1b[0m\r\n`);
		} else if (message.type === 'exit') {
			this._term.write(`\r\n\x1b[90m[process exited: ${message.code ?? '?'}]\x1b[0m\r\n`);
		}
	}

	/** Keyboard/paste input. Held back while a snapshot is being parsed. */
	private _type(data: string): void {
		if (this._replaying) {
			this._pendingInput += data;
			return;
		}
		this._sendInput(data);
	}

	private _sendInput(data: string): void {
		const socket = this._socket;
		if (!data || socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		socket.send(JSON.stringify({ type: 'input', data }));
	}

	private _sendResize(): void {
		const socket = this._socket;
		if (socket?.readyState !== WebSocket.OPEN) {
			return;
		}
		if (this._term.cols < 2 || this._term.rows < 2) {
			return;
		}
		// Re-attaching fits against the same slot, so the size usually did not
		// change; a redundant resize makes the shell redraw its prompt for
		// nothing (and some programs re-query the terminal when they get SIGWINCH).
		if (this._term.cols === this._sentCols && this._term.rows === this._sentRows) {
			return;
		}
		this._sentCols = this._term.cols;
		this._sentRows = this._term.rows;
		socket.send(JSON.stringify({ type: 'resize', cols: this._term.cols, rows: this._term.rows }));
	}

	private _setState(state: TerminalState): void {
		if (this._state === state) {
			return;
		}
		this._state = state;
		for (const listener of this._listeners) {
			listener(state);
		}
	}
}

/**
 * Clipboard writes need a secure context, which a self-hosted instance reached
 * over plain http on a LAN address does not have; `execCommand` still works
 * there, and this is the one place it is worth keeping.
 */
async function writeClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		return;
	} catch {
		// No API (insecure context) or the permission was denied.
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.top = '-1000px';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	try {
		document.execCommand('copy');
	} finally {
		area.remove();
	}
}

/** Empty when the browser refuses: paste then simply does nothing. */
async function readClipboard(): Promise<string> {
	try {
		return await navigator.clipboard.readText();
	} catch {
		return '';
	}
}

const screens = new Map<string, LiveScreen>();

/**
 * The screen for a terminal, created on first use.
 *
 * Every `attach` must be paired with a `detach`; the socket is shared, so a
 * second view of the same terminal (a re-render, a second panel) does not open
 * a second connection.
 */
export function acquireTerminalSession(id: string): TerminalSession {
	const existing = screens.get(id);
	if (existing && !existing.disposed) {
		existing.lastUsed = Date.now();
		return existing;
	}
	const created = new LiveScreen(id);
	screens.set(id, created);
	pruneIdleScreens();
	return created;
}

/** The terminal is gone for good (the tab was closed), so is its screen. */
export function forgetTerminalSession(id: string): void {
	const screen = screens.get(id);
	if (!screen) {
		return;
	}
	screens.delete(id);
	screen.dispose();
}

/**
 * The state of an already-known screen, without creating one.
 *
 * A view mounting for a screen that is still attached elsewhere (switching back
 * to a project) starts at `open` instead of painting "连接中…" for a frame.
 */
export function peekTerminalState(id: string): TerminalState {
	return screens.get(id)?.state ?? 'connecting';
}

/** Drops every screen, sockets included. Signing out is the one place for this. */
export function disposeAllTerminalSessions(): void {
	for (const screen of [...screens.values()]) {
		screen.dispose();
	}
	screens.clear();
}

/** Bounds how many detached screens stay warm. Never evicts a visible one. */
function pruneIdleScreens(): void {
	const idle = [...screens.values()].filter(screen => !screen.attached && !screen.disposed);
	if (idle.length <= MAX_IDLE_SESSIONS) {
		return;
	}
	idle.sort((left, right) => left.lastUsed - right.lastUsed);
	for (const screen of idle.slice(0, idle.length - MAX_IDLE_SESSIONS)) {
		screens.delete(screen.id);
		screen.dispose();
	}
}
