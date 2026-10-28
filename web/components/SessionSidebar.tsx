import { useState } from 'react';
import type { ProjectInfo, SessionEntry } from '../api';

interface SessionSidebarProps {
	readonly projects: readonly ProjectInfo[];
	readonly sessions: readonly SessionEntry[];
	readonly activeSessionId: string | undefined;
	readonly onSelectSession: (session: SessionEntry) => void;
	readonly onNewSession: () => void;
}

const ALL = 'all';

/** Sessions first: one flat, time-ordered list; the project is a label on the row. */
export function SessionSidebar({
	projects,
	sessions,
	activeSessionId,
	onSelectSession,
	onNewSession,
}: SessionSidebarProps) {
	const [filter, setFilter] = useState<string>(ALL);

	if (projects.length === 0) {
		return (
			<div className="session-rail">
				<div className="rail-empty">
					没有找到项目。跑一次 claude 会话后，它的项目会自动出现在这里；
					也可以设置 <code>AGENT_UI_ROOTS</code> 手动指定。
				</div>
			</div>
		);
	}

	const visible = filter === ALL ? sessions : sessions.filter(session => session.projectId === filter);
	const projectName = (projectId: string) => projects.find(project => project.id === projectId)?.name ?? projectId;

	return (
		<div className="session-rail">
			<div className="rail-toolbar">
				<button type="button" className="rail-new" onClick={onNewSession}>
					＋ 新建会话
				</button>
				<select
					className="rail-select"
					value={filter}
					onChange={event => setFilter(event.target.value)}
					aria-label="按项目筛选"
				>
					<option value={ALL}>全部项目（{sessions.length}）</option>
					{projects.map(project => (
						<option key={project.id} value={project.id}>{project.name}（{project.sessionCount}）</option>
					))}
				</select>
			</div>

			{visible.length === 0 && <div className="rail-empty">这个项目还没有会话</div>}
			{bucketize(visible).map(bucket => (
				<div key={bucket.label}>
					<div className="bucket-title">{bucket.label}</div>
					{bucket.sessions.map(session => (
						<button
							type="button"
							key={session.id}
							className={`session-row${session.id === activeSessionId ? ' active' : ''}`}
							onClick={() => onSelectSession(session)}
							title={`${session.title}\n${session.cwd}`}
						>
							<span className="session-title">{session.title}</span>
							<span className="session-meta">
								<span className="session-project">{projectName(session.projectId)}</span>
								<span className="session-time">{formatTime(session.updatedAt)}</span>
							</span>
						</button>
					))}
				</div>
			))}
		</div>
	);
}

interface Bucket {
	readonly label: string;
	readonly sessions: readonly SessionEntry[];
}

function bucketize(sessions: readonly SessionEntry[]): readonly Bucket[] {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const todayStart = startOfToday.getTime();
	const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
	const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;

	const today: SessionEntry[] = [];
	const yesterday: SessionEntry[] = [];
	const thisWeek: SessionEntry[] = [];
	const older: SessionEntry[] = [];

	for (const session of sessions) {
		if (session.updatedAt >= todayStart) {
			today.push(session);
		} else if (session.updatedAt >= yesterdayStart) {
			yesterday.push(session);
		} else if (session.updatedAt >= weekStart) {
			thisWeek.push(session);
		} else {
			older.push(session);
		}
	}

	return [
		{ label: '今天', sessions: today },
		{ label: '昨天', sessions: yesterday },
		{ label: '本周', sessions: thisWeek },
		{ label: '更早', sessions: older },
	].filter(bucket => bucket.sessions.length > 0);
}

function formatTime(value: number): string {
	const minutes = Math.floor((Date.now() - value) / 60000);
	if (minutes < 1) {
		return 'now';
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	if (minutes < 60 * 24) {
		return `${Math.floor(minutes / 60)}h`;
	}
	const date = new Date(value);
	return `${date.getMonth() + 1}/${date.getDate()}`;
}
