import { useCallback, useEffect, useState } from 'react';
import { runningSessions, stopRunningTask, type RunningTask } from '../api';
import { t } from '../i18n';

interface MonitorTask extends RunningTask {
	readonly sessionId: string;
	readonly root: string;
	readonly agent: string;
}

interface TaskMonitorProps {
	readonly onOpenSession: (sessionId: string) => void;
	/** Inline in the chat pane: no top-bar toggle, open by default. */
	readonly inline?: boolean;
}

function elapsed(since: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h`;
}

/**
 * Global view of background tasks and subagents across every live conversation.
 *
 * The per-chat task strip only shows the conversation on screen, which made a
 * long-running subagent in another tab effectively invisible. The server already
 * reports each session's running tasks through `/api/agents/running`; this panel
 * polls it, lets the user jump to the owning conversation, and offers a stop.
 *
 * The CLI cannot end one task in isolation (`TaskStop` is model-only), so the
 * stop button is explicit about what it actually does — interrupt the owning
 * turn, or kill its process — instead of pretending to have finer control.
 */
export function TaskMonitor({ onOpenSession, inline = false }: TaskMonitorProps) {
	const [tasks, setTasks] = useState<readonly MonitorTask[]>([]);
	const [open, setOpen] = useState(inline);
	const [busy, setBusy] = useState<string | undefined>(undefined);
	const [, setTick] = useState(0);
	// `setTick` keeps the elapsed-time labels moving between polls.

	const refresh = useCallback(async () => {
		try {
			const sessions = await runningSessions();
			const next: MonitorTask[] = [];
			for (const session of sessions) {
				for (const task of session.tasks) {
					next.push({ ...task, sessionId: session.sessionId, root: session.root, agent: session.agent });
				}
			}
			setTasks(next);
		} catch {
			// A transient failure must not wipe the last known state.
		}
	}, []);

	useEffect(() => {
		void refresh();
		const poll = window.setInterval(() => void refresh(), 2000);
		const timer = window.setInterval(() => setTick(value => value + 1), 1000);
		return () => {
			window.clearInterval(poll);
			window.clearInterval(timer);
		};
	}, [refresh]);

	const stop = async (task: MonitorTask, hard: boolean) => {
		setBusy(task.taskId);
		try {
			await stopRunningTask(task.taskId, hard);
			await refresh();
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<div className={`task-monitor${inline ? ' inline' : ''}`}>
			{!inline && (
				<button
					type="button"
					className={`toggle task-monitor-toggle${tasks.length > 0 ? ' active' : ''}`}
					title={t('后台任务与子 agent')}
					onClick={() => setOpen(value => !value)}
				>
					{t('任务')}{tasks.length > 0 ? ` (${tasks.length})` : ''}
				</button>
			)}
			{inline && !open && (
				<button type="button" className="task-monitor-inline-open" onClick={() => setOpen(true)}>
					{t('后台任务 / 子 agent')}{tasks.length > 0 ? ` (${tasks.length})` : ''}
				</button>
			)}
			{open && (
				<div className="task-monitor-panel">
					<div className="task-monitor-head">
						<strong>{t('后台任务 / 子 agent')}{tasks.length > 0 ? ` (${tasks.length})` : ''}</strong>
						<button type="button" className="link-btn" onClick={() => void refresh()}>{t('刷新')}</button>
						{inline && <button type="button" className="link-btn" onClick={() => setOpen(false)}>{t('收起')}</button>}
					</div>
					{tasks.length === 0
						? <div className="task-monitor-empty">{t('当前没有运行中的后台任务')}</div>
						: tasks.map(task => (
							<div key={task.taskId} className="task-monitor-row">
								<div className="task-monitor-main">
									<span className={`task-dot ${task.status}`} />
									<span className="task-monitor-desc" title={task.description ?? task.taskId}>
										{task.description ?? task.taskId}
									</span>
									<span className="task-monitor-meta">
										{task.subagentType ?? task.taskType ?? 'task'} · {elapsed(task.startedAt)}
									</span>
								</div>
								<div className="task-monitor-actions">
									<button
										type="button"
										className="chip"
										title={t('打开所属会话')}
										onClick={() => onOpenSession(task.sessionId)}
									>
										{t('定位')}
									</button>
									<button
										type="button"
										className="chip danger"
										disabled={busy === task.taskId}
										title={t('中断所属会话的当前轮次；后台子 agent 通常不受影响，轮次结束后也无效')}
										onClick={() => void stop(task, false)}
									>
										{t('中断轮次')}
									</button>
									<button
										type="button"
										className="chip danger"
										disabled={busy === task.taskId}
										title={t('结束所属会话的 CLI 进程：这是唯一能真正停掉后台任务的办法，但会丢失该会话的进程状态')}
										onClick={() => void stop(task, true)}
									>
										{t('停掉任务')}
									</button>
								</div>
							</div>
						))}
				</div>
			)}
		</div>
	);
}
