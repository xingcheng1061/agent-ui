import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { terminalUrl } from '../api';
import { getTheme, onThemeChange, type ThemeName } from '../theme';

interface ServerMessage {
	readonly type: 'output' | 'error' | 'exit' | 'snapshot';
	readonly data?: string;
	readonly message?: string;
	readonly code?: number;
}

/** xterm has no palette switching, so both are declared here. */
const XTERM_THEMES: Record<ThemeName, { background: string; foreground: string; cursor: string }> = {
	dark: { background: '#181818', foreground: '#d4d4d4', cursor: '#aeafad' },
	light: { background: '#ffffff', foreground: '#24292f', cursor: '#044289' },
};

/** Silent retries before asking the user; covers transient blips. */
const AUTO_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

/**
 * One terminal tab. The shell itself lives on the server, so this component is
 * only a view: it attaches by id, and on attach the server replays whatever was
 * printed while the tab was closed.
 *
 * Losing the socket does not lose the shell, so reconnecting is a local action:
 * the scrollback is kept, the snapshot is replayed, and typing resumes.
 */
export function TerminalView({ terminalId }: { readonly terminalId: string }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	/** Bumped to tear the socket down and build a new one. */
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		setState('connecting');
		const terminal = new XTerm({
			convertEol: true,
			cursorBlink: true,
			fontSize: 12,
			fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace',
			theme: XTERM_THEMES[getTheme()],
			scrollback: 5000,
		});
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(container);
		fitAddon.fit();

		let retriesLeft = AUTO_RETRIES;
		let retryTimer: number | undefined;
		let disposed = false;

		const connect = () => {
			if (disposed) {
				return;
			}
			const socket = new WebSocket(terminalUrl(terminalId));
			const send = (payload: unknown) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(payload));
				}
			};
			const resize = () => send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });

			socket.addEventListener('open', () => {
				setState('open');
				retriesLeft = AUTO_RETRIES;
				resize();
				terminal.focus();
			});
			socket.addEventListener('message', event => {
				let message: ServerMessage;
				try {
					message = JSON.parse(String(event.data)) as ServerMessage;
				} catch {
					return;
				}
				if (message.type === 'snapshot') {
					// Missed output: start from a clean screen, then replay it.
					terminal.reset();
					if (message.data) {
						terminal.write(message.data);
					}
				} else if (message.type === 'output' && typeof message.data === 'string') {
					terminal.write(message.data);
				} else if (message.type === 'error') {
					terminal.write(`\r\n\x1b[31m${message.message ?? 'terminal error'}\x1b[0m\r\n`);
				} else if (message.type === 'exit') {
					terminal.write(`\r\n\x1b[90m[process exited: ${message.code ?? '?'}]\x1b[0m\r\n`);
				}
			});
			socket.addEventListener('close', () => {
				if (disposed) {
					return;
				}
				setState('closed');
				terminal.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
				if (retriesLeft > 0) {
					retriesLeft -= 1;
					retryTimer = window.setTimeout(connect, RETRY_DELAY_MS);
				}
			});
			socket.addEventListener('error', () => {
				// `close` always follows and owns the retry decision.
			});

			const inputSubscription = terminal.onData(data => send({ type: 'input', data }));
			const observer = new ResizeObserver(() => {
				fitAddon.fit();
				resize();
			});
			observer.observe(container);

			cleanups.push(() => {
				window.clearTimeout(retryTimer);
				observer.disconnect();
				inputSubscription.dispose();
				socket.close();
			});
		};

		const cleanups: (() => void)[] = [];
		connect();

		const unsubscribe = onThemeChange(theme => {
			terminal.options.theme = XTERM_THEMES[theme];
		});

		return () => {
			disposed = true;
			unsubscribe();
			for (const cleanup of cleanups.splice(0)) {
				cleanup();
			}
			terminal.dispose();
		};
	}, [terminalId, attempt]);

	const reconnect = () => setAttempt(value => value + 1);

	return (
		<div className="terminal-host">
			<div className="terminal-host-xterm" ref={containerRef} />
			{state === 'closed' && (
				<div className="terminal-overlay">
					<span className="terminal-overlay-text">连接已断开，shell 仍在服务端运行</span>
					<button type="button" className="primary" onClick={reconnect}>重新连接</button>
				</div>
			)}
			{state === 'connecting' && (
				<div className="terminal-overlay subtle">
					<span className="terminal-overlay-text">连接中…</span>
				</div>
			)}
		</div>
	);
}
