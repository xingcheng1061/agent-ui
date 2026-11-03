import { useEffect, useRef, useState } from 'react';
import { acquireTerminalSession, peekTerminalState, type TerminalSession, type TerminalState } from './terminalSessions';

/**
 * One terminal tab.
 *
 * Only a slot: the xterm instance and the socket live in `terminalSessions.ts`,
 * so unmounting this — switching to another project, closing the panel — no
 * longer closes the connection or loses the screen. See that file for why.
 */
export function TerminalView({ terminalId }: { readonly terminalId: string }) {
	const slotRef = useRef<HTMLDivElement | null>(null);
	const sessionRef = useRef<TerminalSession | undefined>(undefined);
	// Seeded from the pool: coming back to a live screen must not paint an
	// overlay first and hide it again on the next tick.
	const [state, setState] = useState<TerminalState>(() => peekTerminalState(terminalId));

	useEffect(() => {
		const slot = slotRef.current;
		if (!slot) {
			return;
		}
		const session = acquireTerminalSession(terminalId);
		sessionRef.current = session;
		session.attach(slot);
		const stopState = session.watchState(setState);
		const observer = new ResizeObserver(() => session.fit());
		observer.observe(slot);
		return () => {
			observer.disconnect();
			stopState();
			// Not a teardown: the screen and its socket go back to the pool.
			session.detach(slot);
			if (sessionRef.current === session) {
				sessionRef.current = undefined;
			}
		};
	}, [terminalId]);

	return (
		<div className="terminal-host">
			<div className="terminal-host-slot" ref={slotRef} />
			{state === 'closed' && (
				<div className="terminal-overlay">
					<span className="terminal-overlay-text">连接已断开，shell 仍在服务端运行</span>
					<button type="button" className="primary" onClick={() => sessionRef.current?.reconnect()}>
						重新连接
					</button>
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
