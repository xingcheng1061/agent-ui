import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentClientCommand, AgentInfo, AgentServerEvent, AgentTaskUsage } from '../agentTypes';
import { agentUrl, getTranscript, reportClientLog, searchFiles, type TranscriptItem } from '../api';
import { CodeHighlight, guessLanguage } from './CodeHighlight';
import { deleteLiveTurn, pruneLiveTurns, readLiveTurn, writeLiveTurn } from './liveTurnStore';
import { Markdown } from './Markdown';

interface ToolResultInfo {
	readonly content: string;
	readonly isError: boolean;
}

/** A subagent or background task reported by the CLI. */
interface TaskState {
	readonly taskId: string;
	readonly toolUseId?: string;
	readonly status: string;
	readonly description?: string;
	readonly subagentType?: string;
	readonly taskType?: string;
	readonly usage?: AgentTaskUsage;
	readonly startedAt: number;
}

interface PendingPermission {
	readonly requestId: string;
	readonly toolName: string;
	readonly input: unknown;
	readonly toolUseId?: string;
}

type Item =
	| { readonly kind: 'user'; readonly id: string; readonly text: string }
	/** `messageId` is the API message the text belongs to, mirroring the jsonl. */
	| { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly parentToolUseId?: string; readonly messageId?: string }
	| {
		readonly kind: 'tool';
		readonly id: string;
		readonly name: string;
		readonly input: unknown;
		readonly parentToolUseId?: string;
		readonly result?: ToolResultInfo;
		readonly task?: TaskState;
	}
	| {
		readonly kind: 'result';
		readonly id: string;
		readonly text: string;
		readonly costUsd?: number;
		readonly durationMs?: number;
		readonly numTurns?: number;
		readonly isError: boolean;
		/** The turn was aborted by a user interrupt rather than failing. */
		readonly interrupted?: boolean;
	}
	| { readonly kind: 'error'; readonly id: string; readonly text: string };

interface ChatPanelProps {
	readonly root: string;
	readonly sessionId: string | undefined;
	/** Backend to connect to; changing it starts a new conversation. */
	readonly agent?: string;
	readonly onAgentChange?: (agent: string) => void;
	readonly onSessionStarted: (sessionId: string) => void;
	/** Fired when a turn finishes, so the code panel can refresh git state. */
	readonly onTurnEnd?: () => void;
}

const TASK_STATUS_LABEL: Record<string, string> = {
	running: '运行中',
	completed: '完成',
	failed: '失败',
	stopped: '已停止',
	error: '出错',
};

const STATUS_LABEL: Record<string, string> = {
	requesting: '生成中',
	idle: '空闲',
	compacting: '压缩上下文',
	compacted: '已压缩',
};

/**
 * Tool names that run a shell command. The CLI emits `Bash` on Unix-like shells
 * and `PowerShell` on Windows, so both need the dedicated command card.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Shell', 'sh']);

/** Cap per task so a chatty background shell cannot blow up the DOM. */
const MAX_TASK_LOG = 200_000;

/** Cap per session so a chatty turn cannot blow up IndexedDB. */
const MAX_LIVE_EVENTS = 4000;

/** How often the in-flight mirror is flushed to IndexedDB. */
const LIVE_FLUSH_MS = 250;

/** Fallback until the backend sends its advertised modes. */
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;

interface MenuEntry {
	readonly key: string;
	readonly label: string;
	readonly hint?: string;
	readonly run: () => void;
}

let counter = 0;
const nextId = () => `m${++counter}`;
const taskKey = (taskId: string) => `task:${taskId}`;

function toChatItems(items: readonly TranscriptItem[]): Item[] {
	const result: Item[] = [];
	for (const item of items) {
		if (item.kind === 'tool' && item.id && item.name) {
			result.push({
				kind: 'tool',
				id: item.id,
				name: item.name,
				input: item.input,
				result: item.result,
				parentToolUseId: item.parentToolUseId,
				// Subagent steps are stored per session; the badge travels with the
				// card so a reloaded transcript looks like the live one.
				task: item.task ? { ...item.task, startedAt: 0 } : undefined,
			});
		} else if (item.text) {
			result.push({
				kind: item.kind === 'user' || item.kind === 'thinking' ? item.kind : 'assistant',
				id: nextId(),
				text: item.text,
				messageId: item.messageId,
				parentToolUseId: item.parentToolUseId,
			});
		}
	}
	return result;
}

/**
 * Drops the replayed deltas of messages the jsonl already holds.
 *
 * The mirror records every event of the in-flight turn, including the messages
 * the CLI finished and persisted while the turn kept going. Replaying those on
 * top of the loaded history would print the same answer a second time; the
 * durable copy wins, and only the message still streaming is replayed.
 */
function dropDurableDeltas(
	events: readonly AgentServerEvent[],
	history: readonly TranscriptItem[],
): readonly AgentServerEvent[] {
	const durable = new Set<string>();
	for (const item of history) {
		if (item.messageId && (item.kind === 'assistant' || item.kind === 'thinking')) {
			durable.add(item.messageId);
		}
	}
	if (durable.size === 0) {
		return events;
	}
	return events.filter(event => {
		if (event.type !== 'assistant_delta' && event.type !== 'thinking_delta') {
			return true;
		}
		return !event.messageId || !durable.has(event.messageId);
	});
}

export function ChatPanel({ root, sessionId, agent, onAgentChange, onSessionStarted, onTurnEnd }: ChatPanelProps) {
	const [items, setItems] = useState<readonly Item[]>([]);
	const [tasks, setTasks] = useState<readonly TaskState[]>([]);
	const [outputs, setOutputs] = useState<Readonly<Record<string, string>>>({});
	const [permission, setPermission] = useState<PendingPermission | undefined>(undefined);
	const [draft, setDraft] = useState('');
	const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
	const [meta, setMeta] = useState<{
		agent?: string;
		agentList?: readonly AgentInfo[];
		model?: string;
		sessionId?: string;
		permissionMode?: string;
		permissionModes?: readonly string[];
		slashCommands?: readonly string[];
		skills?: readonly string[];
		agents?: readonly string[];
		models?: readonly string[];
	}>({});
	const [status, setStatus] = useState('未连接');
	const [thinkingTokens, setThinkingTokens] = useState(0);
	const [streaming, setStreaming] = useState(false);
	/** Whether a CLI process is still backing this session; shown in the header. */
	const [backendLive, setBackendLive] = useState<boolean | undefined>(undefined);
	const [cursor, setCursor] = useState(0);
	const [fileMatches, setFileMatches] = useState<readonly string[]>([]);
	const [menuIndex, setMenuIndex] = useState(0);
	const [menuDismissed, setMenuDismissed] = useState(false);
	/** Explicit picker opened through `/model` or `/mode`. */
	const [picker, setPicker] = useState<'model' | 'mode' | undefined>(undefined);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);

	const socketRef = useRef<WebSocket | undefined>(undefined);
	const resumeIdRef = useRef<string | undefined>(sessionId);
	const loadedIdRef = useRef<string | undefined>(undefined);
	/** True while this panel is the one building the conversation it is showing. */
	const createdHereRef = useRef(false);
	/**
	 * What the server last reported about the process. It outranks the browser
	 * mirror, which can describe a turn that already ended.
	 */
	const serverBusyRef = useRef<boolean | undefined>(undefined);
	/** Mirrors `tasks` so the socket handler never reads a stale closure. */
	const tasksRef = useRef<readonly TaskState[]>([]);
	/** Tools the user chose to always allow for this session. */
	const autoAllowRef = useRef(new Set<string>());
	/** Streaming bubble ids, keyed by parent tool use id (`main` for the top level). */
	const streamRef = useRef(new Map<string, { assistant?: string; thinking?: string }>());
	const listRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	/** Timestamp of the last server event; used to spot a silent stall. */
	const lastEventRef = useRef(Date.now());
	const [stalled, setStalled] = useState(false);
	const stalledRef = useRef(false);
	const streamingRef = useRef(false);
	/** Messages waiting for the running turn, mirrored from the server. */
	const [queued, setQueued] = useState<readonly string[]>([]);
	/**
	 * Mirror of the in-flight turn, kept in IndexedDB. The CLI only appends to
	 * its jsonl once a message is finished, so this is the only durable copy of
	 * a turn that is still streaming.
	 */
	const liveEventsRef = useRef<AgentServerEvent[]>([]);
	const liveQueuedRef = useRef<readonly string[]>([]);
	const liveBusyRef = useRef(false);
	const liveDirtyRef = useRef(false);
	const liveSessionRef = useRef<string | undefined>(undefined);
	const onSessionStartedRef = useRef(onSessionStarted);
	const onTurnEndRef = useRef(onTurnEnd);

	onSessionStartedRef.current = onSessionStarted;
	onTurnEndRef.current = onTurnEnd;
	resumeIdRef.current = sessionId;
	streamingRef.current = streaming;

	const appendStream = (kind: 'assistant' | 'thinking', text: string, parentToolUseId?: string) => {
		const key = parentToolUseId ?? 'main';
		const slot = streamRef.current.get(key) ?? {};
		const slotKey = kind === 'assistant' ? 'assistant' : 'thinking';
		let id = slot[slotKey];
		if (!id) {
			id = nextId();
			slot[slotKey] = id;
			streamRef.current.set(key, slot);
		}
		const targetId = id;
		setItems(previous => {
			const existing = previous.find(item => item.id === targetId);
			if (existing && (existing.kind === 'assistant' || existing.kind === 'thinking')) {
				return previous.map(item => item.id === targetId && (item.kind === 'assistant' || item.kind === 'thinking')
					? { ...item, text: item.text + text }
					: item);
			}
			return [...previous, { kind, id: targetId, text, parentToolUseId }];
		});
	};

	/** A completed message closes the current bubble for that parent. */
	const closeStream = (parentToolUseId?: string) => {
		streamRef.current.set(parentToolUseId ?? 'main', {});
	};

	const resetTranscript = () => {
		tasksRef.current = [];
		streamRef.current.clear();
		autoAllowRef.current.clear();
		setItems([]);
		setTasks([]);
		setOutputs({});
		setPermission(undefined);
		setStreaming(false);
		setBackendLive(undefined);
		setQueued([]);
		setThinkingTokens(0);
		liveEventsRef.current = [];
		liveQueuedRef.current = [];
		liveBusyRef.current = false;
		liveSessionRef.current = undefined;
	};

	/**
	 * True once per tab. A refresh keeps `sessionStorage`, a new tab or a closed
	 * and reopened window does not — that is when the server has to resend the
	 * queue of the running turn.
	 */
	const freshPageRef = useRef<boolean | undefined>(undefined);
	if (freshPageRef.current === undefined) {
		let fresh = true;
		try {
			fresh = sessionStorage.getItem('agent-ui:tab') === null;
			sessionStorage.setItem('agent-ui:tab', '1');
		} catch {
			// Storage blocked: assume fresh, replaying is the safer default.
		}
		freshPageRef.current = fresh;
	}

	/**
	 * Live events are held until the jsonl history has been applied, so the final
	 * order is "everything up to this turn" + "this turn".
	 *
	 * The history loader arms this itself. Arming it from `session_state` was a
	 * race: when the transcript landed first, the buffer was armed with nothing
	 * left to flush it, and every later event — tool cards, subagent output —
	 * piled up invisibly for the rest of the session.
	 */
	const replayBuffer = useRef<AgentServerEvent[] | null>(null);
	const handleEventRef = useRef<(event: AgentServerEvent) => void>(() => undefined);

	/** Applies buffered replay events once the jsonl history is in place. */
	const flushReplay = (events: readonly AgentServerEvent[]) => {
		for (const event of events) {
			handleEventRef.current(event);
		}
	};

	// Load history when a different session is selected. A session we just
	// created ourselves is already in `items`, so its id is marked as loaded.
	useEffect(() => {
		if (!sessionId) {
			if (loadedIdRef.current !== undefined) {
				loadedIdRef.current = undefined;
				resetTranscript();
			}
			return;
		}
		if (loadedIdRef.current === sessionId) {
			return;
		}
		loadedIdRef.current = sessionId;
		resetTranscript();
		serverBusyRef.current = undefined;
		liveSessionRef.current = sessionId;
		void pruneLiveTurns();
		getTranscript(sessionId)
			.then(async transcript => {
				if (loadedIdRef.current !== sessionId) {
					return;
				}
				setItems(toChatItems(transcript));
				setStatus(`已载入 ${sessionId.slice(0, 8)}`);
				// Diagnostics: a transcript that renders empty is otherwise
				// indistinguishable from one that arrived empty.
				reportClientLog({
					event: 'transcript',
					session: sessionId,
					items: transcript.length,
					shape: transcript
						.slice(0, 14)
						.map(item => item.kind === 'tool' ? `${item.name}${item.parentToolUseId ? '*' : ''}` : item.kind)
						.join(','),
				});
				const buffered = replayBuffer.current;
				replayBuffer.current = null;
				if (buffered) {
					flushReplay(buffered);
				}
				// Then the browser's mirror of the turn that was streaming when
				// the page went away. Live deltas keep arriving after this, so the
				// two join without a gap and without overlap.
				const local = await readLiveTurn(sessionId);
				if (loadedIdRef.current !== sessionId || !local || local.events.length === 0) {
					return;
				}
				if (local.events[local.events.length - 1]?.type === 'result') {
					// The turn finished but the mirror was not deleted in time (the
					// tab died inside the flush window). The jsonl already has that
					// turn, so replaying it would duplicate it.
					void deleteLiveTurn(sessionId);
					return;
				}
				if (serverBusyRef.current === false) {
					// The server already said nothing is running. The mirror therefore
					// outlived its turn — the tab went away before `result` arrived —
					// and replaying it kept the spinner on forever.
					void deleteLiveTurn(sessionId);
					return;
				}
				for (const event of dropDurableDeltas(local.events, transcript)) {
					handleEventRef.current(event);
				}
				if (local.queued.length > 0) {
					setQueued(local.queued);
				}
				if (local.busy) {
					setStreaming(true);
				}
			})
			.catch(error => {
				reportClientLog({ event: 'transcript-error', session: sessionId, message: String(error) });
				const buffered = replayBuffer.current;
				replayBuffer.current = null;
				if (buffered && buffered.length > 0) {
					flushReplay(buffered);
				}
				setStatus(String(error));
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionId, root]);

	const sendRef = useRef<(command: AgentClientCommand) => void>(() => undefined);

	useEffect(() => {
		let disposed = false;
		let retryTimer: number | undefined;

		const upsertTask = (next: TaskState) => {
			const index = tasksRef.current.findIndex(task => task.taskId === next.taskId);
			const merged = index < 0
				? [...tasksRef.current, next]
				: tasksRef.current.map((task, position) => position === index ? { ...task, ...next } : task);
			tasksRef.current = merged;
			setTasks(merged);
			setItems(previous => previous.map(item => item.kind === 'tool' && item.id === (next.toolUseId ?? taskKey(next.taskId))
				? { ...item, task: next }
				: item));
		};

		const findTask = (taskId: string) => tasksRef.current.find(task => task.taskId === taskId);

		const handleEvent = (event: AgentServerEvent) => {
			switch (event.type) {
				case 'system':
					// Only a conversation this panel started itself may keep its live
					// bubbles: marking an adopted session as "loaded" meant picking it
					// later never rebuilt the transcript from the jsonl, so the panel
					// stayed on whatever fragments had streamed in.
					if (createdHereRef.current) {
						createdHereRef.current = false;
						loadedIdRef.current = event.sessionId;
					}
					onSessionStartedRef.current(event.sessionId);
					setMeta(previous => ({
						...previous,
						agent: event.agent ?? previous.agent,
						model: event.model ?? previous.model,
						sessionId: event.sessionId,
						permissionMode: event.permissionMode ?? previous.permissionMode,
						slashCommands: event.slashCommands ?? previous.slashCommands,
						skills: event.skills ?? previous.skills,
						agents: event.agents ?? previous.agents,
						models: event.models ?? previous.models,
					}));
					setStatus('就绪');
					return;
				case 'config':
					setMeta(previous => ({
						...previous,
						agent: event.agent ?? previous.agent,
						agentList: event.agents ?? previous.agentList,
						model: event.model ?? previous.model,
						permissionMode: event.permissionMode ?? previous.permissionMode,
						permissionModes: event.permissionModes ?? previous.permissionModes,
						models: event.models ?? previous.models,
					}));
					return;
				case 'session_state':
					// Buffering is the history loader's business; deciding it here raced
					// with the load and could swallow the whole event stream.
					serverBusyRef.current = event.live && event.busy === true;
					setBackendLive(event.live);
					setStreaming(serverBusyRef.current);
					if (!event.live) {
						setStatus('后台没有运行中的会话，发送消息即开始');
					}
					return;
				case 'queue':
					setQueued(event.items);
					return;
				case 'status':
					setStatus(STATUS_LABEL[event.status] ?? event.status);
					return;
				case 'thinking_tokens':
					setThinkingTokens(event.estimated);
					return;
				case 'assistant_delta':
					appendStream('assistant', event.text, event.parentToolUseId);
					return;
				case 'thinking_delta':
					appendStream('thinking', event.text, event.parentToolUseId);
					return;
				case 'tool_use': {
					closeStream(event.parentToolUseId);
					setItems(previous => {
						const index = previous.findIndex(item => item.id === event.id);
						if (index < 0) {
							return [...previous, {
								kind: 'tool',
								id: event.id,
								name: event.name,
								input: event.input,
								parentToolUseId: event.parentToolUseId,
							}];
						}
						// A `task_started` may already have created a card for this
						// id (background shells do that, with no input at all).
						// Merge the real tool call into it instead of adding a
						// duplicate with the same id.
						const existing = previous[index];
						if (existing?.kind !== 'tool') {
							return [...previous, {
								kind: 'tool',
								id: event.id,
								name: event.name,
								input: event.input,
								parentToolUseId: event.parentToolUseId,
							}];
						}
						const copy = [...previous];
						copy[index] = { ...existing, name: event.name, input: event.input };
						return copy;
					});
					return;
				}
				case 'tool_result':
					setItems(previous => previous.map(item => item.kind === 'tool' && item.id === event.toolUseId
						? { ...item, result: { content: event.content, isError: event.isError } }
						: item));
					return;
				case 'task_started': {
					const anchor = event.toolUseId ?? taskKey(event.taskId);
					const task: TaskState = {
						taskId: event.taskId,
						toolUseId: event.toolUseId,
						status: 'running',
						description: event.description,
						subagentType: event.subagentType,
						taskType: event.taskType,
						startedAt: Date.now(),
					};
					upsertTask(task);
					setItems(previous => previous.some(item => item.id === anchor)
						? previous
						: [...previous, {
							kind: 'tool',
							id: anchor,
							name: event.taskType === 'local_agent' ? 'Agent' : 'Task',
							input: { description: event.description, subagent_type: event.subagentType, prompt: event.prompt },
							task,
						}]);
					return;
				}
				case 'task_updated': {
					const existing = findTask(event.taskId);
					upsertTask({
						taskId: event.taskId,
						toolUseId: event.toolUseId ?? existing?.toolUseId,
						status: event.status,
						description: existing?.description,
						subagentType: existing?.subagentType,
						taskType: existing?.taskType,
						usage: existing?.usage,
						startedAt: existing?.startedAt ?? Date.now(),
					});
					return;
				}
				case 'task_progress': {
					const existing = findTask(event.taskId);
					upsertTask({
						taskId: event.taskId,
						toolUseId: event.toolUseId ?? existing?.toolUseId,
						status: existing?.status ?? 'running',
						// The progress line describes the current step, so it replaces
						// the original task description while the task runs.
						description: event.description ?? existing?.description,
						subagentType: existing?.subagentType,
						taskType: existing?.taskType,
						usage: event.usage ?? existing?.usage,
						startedAt: existing?.startedAt ?? Date.now(),
					});
					return;
				}
				case 'task_output':
					setOutputs(previous => {
						const merged = (previous[event.taskId] ?? '') + event.chunk;
						return { ...previous, [event.taskId]: merged.length > MAX_TASK_LOG ? merged.slice(-MAX_TASK_LOG) : merged };
					});
					return;
				case 'task_notification': {
					const anchor = event.toolUseId ?? taskKey(event.taskId);
					const existing = findTask(event.taskId);
					upsertTask({
						taskId: event.taskId,
						toolUseId: event.toolUseId,
						status: event.status,
						description: event.summary ?? existing?.description,
						subagentType: existing?.subagentType,
						taskType: existing?.taskType,
						usage: event.usage,
						startedAt: existing?.startedAt ?? Date.now(),
					});
					setItems(previous => previous.some(item => item.id === anchor)
						? previous
						: [...previous, {
							kind: 'tool',
							id: anchor,
							name: 'Task',
							input: { description: event.summary },
						}]);
					return;
				}
				case 'permission_request':
					if (autoAllowRef.current.has(event.toolName)) {
						sendRef.current({ type: 'permission_response', requestId: event.requestId, behavior: 'allow' });
						return;
					}
					setStatus(`等待审批：${event.toolName}`);
					setPermission({
						requestId: event.requestId,
						toolName: event.toolName,
						input: event.input,
						toolUseId: event.toolUseId,
					});
					return;
				case 'result': {
					closeStream();
					setStreaming(false);
					setThinkingTokens(0);
					// An interrupt also ends the turn with a result, but with
					// `error_during_execution`; that is a user action, not a failure.
					const interrupted = event.subtype === 'error_during_execution';
					const text = event.text ?? event.subtype ?? 'done';
					setItems(previous => {
						// The CLI repeats the finished answer in `result.text`. Printing
						// it again put the same paragraph in a second, scrollable box
						// under the message — and it disappeared on reload, because
						// history has no result card. Keep the footer, drop the echo.
						const last = [...previous].reverse().find(item => item.kind === 'assistant');
						const echo = last?.kind === 'assistant' && last.text.trim() === text.trim();
						return [...previous, {
							kind: 'result',
							id: nextId(),
							text: echo && !interrupted ? '' : text,
							costUsd: event.costUsd,
							durationMs: event.durationMs,
							numTurns: event.numTurns,
							isError: event.isError,
							interrupted,
						}];
					});
					onTurnEndRef.current?.();
					return;
				}
				case 'permission_cancelled':
					setPermission(undefined);
					setStatus('已取消审批');
					return;
				case 'error':
					setStreaming(false);
					setItems(previous => [...previous, { kind: 'error', id: nextId(), text: event.message }]);
					return;
				case 'exit':
					setStreaming(false);
					setPermission(undefined);
					setItems(previous => [...previous, {
						kind: 'error',
						id: nextId(),
						text: `agent 进程退出（code ${event.code ?? '?'}）${event.stderr ? `\n${event.stderr}` : ''}`,
					}]);
					return;
			}
		};

		const connect = () => {
			const socket = new WebSocket(agentUrl(root, agent));
			socketRef.current = socket;
			socket.addEventListener('open', () => {
				reportClientLog({ event: 'ws-open', session: loadedIdRef.current });
				// Handshake: adopt the process still running for this session, if
				// any. Without it the model/mode/command lists only appeared after
				// the next message was sent. `replay` asks for the in-flight turn.
				socket.send(JSON.stringify({
					type: 'attach',
					sessionId: resumeIdRef.current,
					replay: freshPageRef.current === true,
				}));
				if (!disposed) {
					setConnection('open');
					setStatus(previous => previous === '未连接' ? '就绪，等待输入' : previous);
				}
			});
			socket.addEventListener('close', event => {
				reportClientLog({
					event: 'ws-close',
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
					streaming: streamingRef.current,
					session: loadedIdRef.current,
				});
				if (disposed) {
					return;
				}
				setConnection('closed');
				setStreaming(false);
				retryTimer = window.setTimeout(connect, 1500);
			});
			socket.addEventListener('message', event => {
				let parsed: AgentServerEvent;				try {
					parsed = JSON.parse(String(event.data)) as AgentServerEvent;
				} catch {
					return;
				}
				lastEventRef.current = Date.now();
				if (stalledRef.current) {
					stalledRef.current = false;
					setStalled(false);
				}
				// Hold replayed events until the jsonl history has been applied,
				// otherwise the turn would appear before the conversation.
				if (replayBuffer.current !== null && parsed.type !== 'session_state') {
					replayBuffer.current.push(parsed);
					return;
				}
				handleEvent(parsed);
				recordLiveEvent(parsed);
			});
		};

		// Lets the transcript loader flush replayed events once history is ready.
		handleEventRef.current = handleEvent;

		connect();
		return () => {
			disposed = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
			socketRef.current?.close();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [root, agent]);

	useEffect(() => {
		const list = listRef.current;
		if (list && stickToBottomRef.current) {
			list.scrollTop = list.scrollHeight;
		}
	}, [items, permission]);

	// Diagnostics: what the transcript actually rendered as text. A blank or
	// "two thin lines" panel cannot be told apart from empty data by the DOM
	// alone, and this is the cheapest way to see which of the two it is.
	const reportedRenderRef = useRef(false);
	useEffect(() => {
		if (reportedRenderRef.current || items.length === 0) {
			return;
		}
		reportedRenderRef.current = true;
		const text = (listRef.current?.innerText ?? '').replace(/\s+/g, ' ');
		reportClientLog({
			event: 'render',
			items: items.length,
			head: text.slice(0, 200),
			tail: text.slice(-400),
		});
	}, [items]);

	// Records whether the page itself went away. A `ws-close` without a matching
	// `pagehide` means the tab crashed or the network dropped instead.
	useEffect(() => {
		const onPageHide = () => reportClientLog({ event: 'pagehide', visibility: document.visibilityState, streaming: streamingRef.current });
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') {
				reportClientLog({ event: 'visibility-hidden', streaming: streamingRef.current });
			}
		};
		window.addEventListener('pagehide', onPageHide);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.removeEventListener('pagehide', onPageHide);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}, []);

	// A turn that goes quiet for a minute is almost always a dead socket or a
	// stuck approval; say so instead of letting the spinner run forever.
	useEffect(() => {
		if (!streaming) {
			return;
		}
		const timer = window.setInterval(() => {
			if (!stalledRef.current && Date.now() - lastEventRef.current > 60_000) {
				stalledRef.current = true;
				setStalled(true);
			}
		}, 5000);
		return () => window.clearInterval(timer);
	}, [streaming]);

	// Keep "running for Ns" labels ticking while a task is in flight.
	const hasRunningTask = tasks.some(task => task.status === 'running');
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!hasRunningTask) {
			return;
		}
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasRunningTask]);

	/** Appends one server event to the IndexedDB mirror of the live turn. */
	const recordLiveEvent = (event: AgentServerEvent) => {
		if (event.type === 'session_state') {
			return;
		}
		if (event.type === 'queue') {
			liveQueuedRef.current = event.items;
			liveDirtyRef.current = true;
			return;
		}
		if (event.type === 'result') {
			// The turn is over: the jsonl owns it now, so the mirror goes away.
			// Keeping it would replay a turn that is already in the history.
			liveEventsRef.current = [];
			liveQueuedRef.current = [];
			liveBusyRef.current = false;
			liveDirtyRef.current = true;
			return;
		}
		liveEventsRef.current.push(event);
		if (liveEventsRef.current.length > MAX_LIVE_EVENTS) {
			liveEventsRef.current.shift();
		}
		liveDirtyRef.current = true;
	};

	// Batched writes: a stream pushes hundreds of deltas per second.
	useEffect(() => {
		const flush = () => {
			if (!liveDirtyRef.current) {
				return;
			}
			liveDirtyRef.current = false;
			const sessionId = liveSessionRef.current;
			if (!sessionId) {
				return;
			}
			if (liveEventsRef.current.length === 0) {
				void deleteLiveTurn(sessionId);
				return;
			}
			void writeLiveTurn({
				sessionId,
				events: liveEventsRef.current,
				queued: liveQueuedRef.current,
				busy: liveBusyRef.current,
				updatedAt: Date.now(),
			});
		};
		const timer = window.setInterval(flush, LIVE_FLUSH_MS);
		// A refresh or tab close is exactly when the mirror matters most.
		window.addEventListener('pagehide', flush);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener('pagehide', flush);
		};
	}, []);

	const send = (command: AgentClientCommand) => {
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(command));
		}
	};
	sendRef.current = send;

	const submitText = (text: string) => {
		// Sending while a turn runs is a queue, not an error: the CLI runs stdin
		// messages in order, and the server mirrors the queue back to the UI.
		// The one exception is a pending approval, which the server drops first.
		if (!text) {
			return;
		}
		streamRef.current.clear();
		setItems(previous => [...previous, { kind: 'user', id: nextId(), text }]);
		setPermission(undefined);
		setDraft('');
		setCursor(0);
		setPicker(undefined);
		setMenuDismissed(false);
		setStreaming(true);
		liveBusyRef.current = true;
		setThinkingTokens(0);
		lastEventRef.current = Date.now();
		stalledRef.current = false;
		setStalled(false);
		stickToBottomRef.current = true;
		// `newSession` is what makes "new conversation" mean it: the socket may
		// still be attached to the previous session, and without the flag the
		// backend continues that one instead of creating a session of its own.
		createdHereRef.current = resumeIdRef.current === undefined;
		send(resumeIdRef.current
			? { type: 'user', text, sessionId: resumeIdRef.current }
			: { type: 'user', text, newSession: true });
	};

	const submit = () => submitText(draft.trim());

	const answerPermission = (behavior: 'allow' | 'deny', always = false) => {
		if (!permission) {
			return;
		}
		if (behavior === 'allow' && always) {
			autoAllowRef.current.add(permission.toolName);
		}
		send({
			type: 'permission_response',
			requestId: permission.requestId,
			behavior,
			message: behavior === 'deny' ? '用户拒绝' : undefined,
		});
		setPermission(undefined);
		setStatus('就绪');
	};

	const runningTasks = tasks.filter(task => task.status === 'running').length;
	const parentOf = (item: Item) => 'parentToolUseId' in item ? item.parentToolUseId : undefined;
	// A step whose parent card is missing must not vanish: a subagent can report
	// steps for a tool call the transcript never recorded, and history keeps
	// children in their own files. Promote those to roots instead of dropping them.
	const cardIds = new Set(items.map(item => item.id));
	const roots = items.filter(item => {
		const parent = parentOf(item);
		return !parent || !cardIds.has(parent);
	});
	const childrenOf = (id: string) => items.filter(item => parentOf(item) === id);
	const outputOf = (taskId: string) => outputs[taskId];

	// What the agent is doing right now, derived from the tool call that has not
	// come back yet. Without this a long read/edit is invisible in the UI.
	const activeTool = streaming
		? [...items].reverse().find(item => item.kind === 'tool' && !item.result && !item.task)
		: undefined;
	const activity = activeTool && activeTool.kind === 'tool' ? activityLabel(activeTool) : undefined;

	// ---- `/` command and `@` mention menus -------------------------------------

	const beforeCursor = draft.slice(0, cursor);
	const slashQuery = /^\/([^\s/]*)$/.exec(beforeCursor)?.[1];
	const atMatch = /(^|\s)@([^\s@]*)$/.exec(beforeCursor);
	const atQuery = atMatch?.[2];

	// File paths come from the server; debounced so typing does not spam it.
	useEffect(() => {
		if (atQuery === undefined) {
			setFileMatches([]);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			searchFiles(root, atQuery)
				.then(files => { if (!cancelled) { setFileMatches(files); } })
				.catch(() => { if (!cancelled) { setFileMatches([]); } });
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [atQuery, root]);

	const commands = useMemo(() => {
		const skills = new Set(meta.skills ?? []);
		return [
			{ name: 'model', hint: '切换模型', action: 'model' as 'model' | 'mode' | undefined },
			{ name: 'mode', hint: '切换权限模式', action: 'mode' as 'model' | 'mode' | undefined },
			...(meta.slashCommands ?? []).map(name => ({
				name,
				hint: skills.has(name) ? 'skill' : 'command',
				action: undefined as 'model' | 'mode' | undefined,
			})),
		];
	}, [meta.slashCommands, meta.skills]);

	const modelOptions = useMemo(() => {
		const list = [meta.model, ...(meta.models ?? [])]
			.filter((value): value is string => typeof value === 'string' && value.length > 0);
		return [...new Set(list)];
	}, [meta.model, meta.models]);

	/** Advertised by the connected backend; the fallback keeps old servers usable. */
	const permissionModes: readonly string[] = meta.permissionModes ?? PERMISSION_MODES;

	/** Replaces the half-typed `@query` with the chosen path. */
	const applyMention = (file: string) => {
		const replaced = beforeCursor.replace(/@([^\s@]*)$/, `@${file} `);
		const next = replaced + draft.slice(cursor);
		setDraft(next);
		setCursor(replaced.length);
		setMenuDismissed(false);
		requestAnimationFrame(() => {
			const element = inputRef.current;
			if (element) {
				element.focus();
				element.setSelectionRange(replaced.length, replaced.length);
			}
		});
	};

	const menuEntries: readonly MenuEntry[] = (() => {
		if (picker === 'model') {
			return modelOptions.map(model => ({
				key: `m:${model}`,
				label: model,
				hint: model === meta.model ? '当前' : '模型',
				run: () => {
					send({ type: 'set_model', model });
					setPicker(undefined);
				},
			}));
		}
		if (picker === 'mode') {
			return permissionModes.map(mode => ({
				key: `p:${mode}`,
				label: mode,
				hint: mode === meta.permissionMode ? '当前' : '权限模式',
				run: () => {
					send({ type: 'set_permission_mode', mode });
					setPicker(undefined);
				},
			}));
		}
		if (menuDismissed) {
			return [];
		}
		if (slashQuery !== undefined) {
			return commands
				.filter(command => command.name.startsWith(slashQuery))
				.map(command => ({
					key: `c:${command.name}`,
					label: `/${command.name}`,
					hint: command.hint,
					run: () => {
						setMenuDismissed(true);
						if (command.action) {
							setPicker(command.action);
							setDraft('');
							setCursor(0);
						} else {
							submitText(`/${command.name}`);
						}
					},
				}));
		}
		if (atQuery !== undefined) {
			return fileMatches.map(file => ({
				key: `f:${file}`,
				label: `@${file}`,
				hint: '文件',
				run: () => applyMention(file),
			}));
		}
		return [];
	})();

	const activeIndex = menuEntries.length === 0 ? 0 : Math.min(menuIndex, menuEntries.length - 1);

	// A message starting with `/` is swallowed by the CLI as a slash command and
	// answered with nothing, which looks exactly like "it stopped replying".
	const leadingSlash = /^\/(\S*)/.exec(draft.trim())?.[1];
	const unknownSlash = leadingSlash !== undefined
		&& !commands.some(command => command.name === leadingSlash);

	// The send button only becomes a stop button when there is nothing to send
	// AND a turn is running. Idle with an empty box must still read 发送,
	// otherwise the UI looks like it is stuck mid-conversation.
	const canSend = draft.trim().length > 0;
	const stopping = streaming && !canSend;

	return (
		<section className="chat">
			<div className="chat-header">
				<span className={`dot ${connection}`} />
				<span className="chat-status">
					{activity ?? status}
					{!activity && meta.sessionId ? ` · ${meta.sessionId.slice(0, 8)}` : ''}
				</span>
				{activity && <span className="stat-pill accent">进行中</span>}
				{thinkingTokens > 0 && <span className="stat-pill">思考 {formatTokens(thinkingTokens)}</span>}
				{runningTasks > 0 && <span className="stat-pill accent">↳ {runningTasks} 个任务运行中</span>}
				{backendLive !== undefined && (
					<span
						className={`stat-pill${backendLive ? ' accent' : ''}`}
						title={backendLive ? '后台 agent 进程仍在运行，刷新不会丢' : '后台没有该会话的进程，下一条消息会新建'}
					>
						{backendLive ? '后台运行中' : '后台未运行'}
					</span>
				)}
				<span className="spacer" />
			</div>

			{tasks.length > 0 && (
				<div className="task-strip">
					{tasks.map(task => (
						<span key={task.taskId} className={`task-chip ${task.status}`} title={`${task.description ?? ''}\ntask ${task.taskId}`}>
							<span className={`task-dot ${task.status}`} />
							{task.subagentType ? `${task.subagentType} · ` : ''}
							{task.description ?? task.taskId}
							<span className="task-chip-meta">{taskMeta(task, now)}</span>
						</span>
					))}
				</div>
			)}

			<div
				className="chat-list"
				ref={listRef}
				onScroll={event => {
					const node = event.currentTarget;
					stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
				}}
			>
				{items.length === 0 && (
					<div className="chat-empty">输入任务，交给 agent 执行（文件改动可在"代码"页查看）</div>
				)}
				{roots.map((item, index) => (
					<ChatItemView
						key={item.id}
						item={item}
						childrenOf={childrenOf}
						outputOf={outputOf}
						live={streaming && index === roots.length - 1}
					/>
				))}
			</div>

			{permission && (
				<div className="permission-card">
					<div className="permission-head">
						<span className="permission-title">需要审批：{permission.toolName}</span>
						<span className="permission-hint">agent 正在等待你的决定</span>
					</div>
					<pre className="permission-input">{formatJson(permission.input)}</pre>
					<div className="permission-actions">
						<button type="button" className="primary" onClick={() => answerPermission('allow')}>允许</button>
						<button type="button" className="chip" onClick={() => answerPermission('allow', true)}>本会话总是允许 {permission.toolName}</button>
						<button type="button" className="chip danger" onClick={() => answerPermission('deny')}>拒绝</button>
					</div>
				</div>
			)}

			{queued.length > 0 && (
				<div className="queue-strip">
					<span className="queue-title">排队中 · {queued.length}</span>
					{queued.map((text, index) => (
						<span key={`${index}-${text}`} className="queue-item" title={text}>
							<span className="queue-index">{index + 1}</span>
							{truncateLine(text, 90)}
						</span>
					))}
					<span className="queue-hint">当前轮次结束后按顺序执行</span>
				</div>
			)}

			<div className="chat-composer">
				{menuEntries.length > 0 && (
					<div className="menu">
						{menuEntries.slice(0, 12).map((entry, index) => (
							<button
								type="button"
								key={entry.key}
								className={`menu-item${index === activeIndex ? ' active' : ''}`}
								onMouseEnter={() => setMenuIndex(index)}
								onMouseDown={event => {
									// Keep focus in the textarea so Enter still submits.
									event.preventDefault();
									entry.run();
								}}
							>
								<span className="menu-label">{entry.label}</span>
								{entry.hint && <span className="menu-hint">{entry.hint}</span>}
							</button>
						))}
					</div>
				)}
				<textarea
					ref={inputRef}
					value={draft}
					placeholder="描述任务；Enter 发送 / Shift+Enter 换行；/ 调命令，@ 引用文件"
					rows={3}
					onChange={event => {
						setDraft(event.target.value);
						setCursor(event.target.selectionStart ?? 0);
						setMenuDismissed(false);
					}}
					onSelect={event => setCursor(event.currentTarget.selectionStart ?? 0)}
					onKeyDown={event => {
						if (event.nativeEvent.isComposing) {
							return;
						}
						if (menuEntries.length > 0) {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								setMenuIndex((activeIndex + 1) % menuEntries.length);
								return;
							}
							if (event.key === 'ArrowUp') {
								event.preventDefault();
								setMenuIndex((activeIndex - 1 + menuEntries.length) % menuEntries.length);
								return;
							}
							if (event.key === 'Enter' || event.key === 'Tab') {
								event.preventDefault();
								menuEntries[activeIndex]?.run();
								return;
							}
							if (event.key === 'Escape') {
								event.preventDefault();
								setMenuDismissed(true);
								setPicker(undefined);
								return;
							}
						}
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				<div className="composer-actions">
					<span className="composer-hint">
						{permission
							? '等待审批… 也可以直接发送新消息，这会取消本次审批'
							: unknownSlash
								? `“/${leadingSlash}”不是已注册命令，agent 会把它当斜杠命令拦截并返回空内容`
								: stalled
									? '已超过 1 分钟没有新输出，可能卡住了（可点「停止」后重发）'
									: streaming
										? '正在执行，可停止或强制结束'
										: '/ 命令 · @ 文件 · Enter 发送'}
					</span>
					{streaming && <button type="button" className="chip danger" onClick={() => send({ type: 'kill' })}>强制结束</button>}
					<button
						type="button"
						className={stopping ? 'primary stop' : 'primary'}
						onClick={canSend ? submit : () => send({ type: 'interrupt' })}
						disabled={!canSend && !streaming}
					>
						{/*
						 * Four states, and only one of them is "stop":
						 *   idle   + no text   → 发送（disabled，没有可发送的内容）
						 *   idle   + text      → 发送
						 *   stream + no text   → 停止（中断当前轮）
						 *   stream + text      → 排队发送
						 */}
						{stopping ? '停止' : streaming && canSend ? '排队发送' : '发送'}
					</button>
				</div>
			</div>

			<div className="chat-toolbar">
				<select
					className="selector"
					value={meta.model ?? ''}
					title="模型（运行时切换，不会重启会话）"
					onChange={event => {
						if (event.target.value) {
							send({ type: 'set_model', model: event.target.value });
						}
					}}
				>
					{!meta.model && <option value="">model…</option>}
					{modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
				</select>
				<select
					className="selector"
					value={meta.permissionMode ?? permissionModes[0] ?? 'default'}
					title="权限模式（运行时切换）"
					onChange={event => send({ type: 'set_permission_mode', mode: event.target.value })}
				>
					{permissionModes.map(mode => <option key={mode} value={mode}>{mode}</option>)}
				</select>
				{(meta.agentList?.length ?? 0) > 1 && (
					<select
						className="selector"
						value={meta.agent ?? agent ?? ''}
						title="Agent 后端（切换会开始新会话）"
						onChange={event => {
							const next = event.target.value;
							if (next && next !== (meta.agent ?? agent)) {
								onAgentChange?.(next);
							}
						}}
					>
						{!meta.agent && <option value="">agent…</option>}
						{meta.agentList?.map(info => <option key={info.id} value={info.id}>{info.name}</option>)}
					</select>
				)}
				<span className="toolbar-label">Agent / 模型 / 权限模式</span>
			</div>
		</section>
	);
}

function ChatItemView({ item, childrenOf, outputOf, live = false }: {
	readonly item: Item;
	readonly childrenOf: (id: string) => readonly Item[];
	readonly outputOf: (taskId: string) => string | undefined;
	/** The bubble still receiving deltas; streamdown then repairs partial syntax. */
	readonly live?: boolean;
}) {
	switch (item.kind) {
		case 'user':
			return <div className="msg user">{item.text}</div>;
		case 'assistant':
			return (
				<div className="msg assistant rich">
					<Markdown text={item.text} streaming={live} />
				</div>
			);
		case 'thinking':
			return <ThinkingBlock text={item.text} live={live} />;
		case 'tool':
			// Shell calls get their own control: a collapsed one-liner that opens
			// into the full command plus its output. `PowerShell` is what the CLI
			// emits on Windows, so matching only `Bash` hid half of them.
			return SHELL_TOOLS.has(item.name)
				? <BashCard item={item} />
				: <ToolCard item={item} childrenOf={childrenOf} outputOf={outputOf} />;
		case 'result':
			return (
				<div className={`msg result${item.isError && !item.interrupted ? ' failed' : ''}${item.interrupted ? ' interrupted' : ''}`}>
					{(item.interrupted || item.text !== '') && (
						<div className="result-text">{item.interrupted ? '已中断本轮' : truncate(item.text, 600)}</div>
					)}
					<div className="result-meta">
						{item.numTurns !== undefined ? `${item.numTurns} 轮` : ''}
						{item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}
						{item.costUsd !== undefined ? ` · $${item.costUsd.toFixed(4)}` : ''}
					</div>
				</div>
			);
		case 'error':
			return <div className="msg error">{item.text}</div>;
	}
}

/**
 * Dedicated Bash card. Collapsed it is one line — `❯ <command>` plus a status —
 * expanded it shows the full command (copyable) and the command's output, both
 * syntax highlighted. It starts open and stays open: the output is the whole
 * point of the card, and folding it by default — after a reload, or the moment
 * the command finished — made it look as if nothing had been recorded.
 */
function BashCard({ item }: { readonly item: Extract<Item, { kind: 'tool' }> }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const command = typeof record['command'] === 'string' ? record['command'] : '';
	const description = typeof record['description'] === 'string' ? record['description'] : undefined;
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(true);
	const [copied, setCopied] = useState(false);
	const userToggled = useRef(false);
	const previousState = useRef(state);

	// Follow the run: expand when it starts and leave the output in place when it
	// ends. Collapsing exactly at that moment made a finished command look like
	// its result had disappeared the instant the turn wrapped up. A manual toggle
	// still hands control to the user for the rest of this card's life.
	useEffect(() => {
		const was = previousState.current;
		if (was === state) {
			return;
		}
		previousState.current = state;
		if (userToggled.current || state !== 'running') {
			return;
		}
		setOpen(true);
	}, [state]);

	const copy = () => {
		void navigator.clipboard.writeText(command)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => undefined);
	};

	const output = item.result ? truncate(item.result.content, 20000) : '';

	return (
		<div className={`bash-card ${state}`}>
			<button
				type="button"
				className="bash-head"
				aria-expanded={open}
				onClick={() => {
					userToggled.current = true;
					setOpen(value => !value);
				}}
				title={command}
			>
				<span className={`bash-arrow${open ? ' open' : ''}`} />
				<span className="bash-glyph">❯</span>
				<span className="bash-command">{command || '(没有命令内容)'}</span>
				<span className={`bash-status ${state}`}>
					{state === 'running' ? '运行中' : state === 'failed' ? '失败' : '完成'}
				</span>
			</button>

			{open && (
				<div className="bash-body">
					{description && <div className="bash-desc">{description}</div>}
					<div className="bash-block">
						<button type="button" className="bash-copy" onClick={copy}>{copied ? '已复制' : '复制'}</button>
						<CodeHighlight code={`$ ${command}`} language="bash" />
					</div>
					{item.result
						? (
							<div className={`bash-out${item.result.isError ? ' failed' : ''}`}>
								<CodeHighlight code={output} language={guessLanguage(output)} />
							</div>
						)
						: <div className="bash-pending">执行中…</div>}
				</div>
			)}
		</div>
	);
}

/**
 * A `Task` result is the subagent's final message, and the subagent's own
 * transcript replays that same message as its last step. Print it once, as the
 * markdown bubble, instead of twice.
 */
function isRepeatedAnswer(result: string, children: readonly Item[]): boolean {
	const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
	const target = normalize(result);
	return target !== '' && children.some(child => child.kind === 'assistant' && normalize(child.text) === target);
}

function ToolCard({ item, childrenOf, outputOf }: {
	readonly item: Extract<Item, { kind: 'tool' }>;
	readonly childrenOf: (id: string) => readonly Item[];
	readonly outputOf: (taskId: string) => string | undefined;
}) {
	const children = childrenOf(item.id);
	const task = item.task;
	const log = task ? outputOf(task.taskId) : undefined;
	const state = item.result?.isError ? 'failed' : task ? task.status : item.result ? 'done' : 'running';
	const nested = children.length > 0;
	const input = (item.input ?? {}) as Record<string, unknown>;
	const prompt = task && typeof input['prompt'] === 'string' ? input['prompt'] as string : undefined;
	// A subagent's result *is* its final message, which its own transcript replays
	// as the last step. Showing both printed the same report twice.
	const answer = item.result && !isRepeatedAnswer(item.result.content, children) ? item.result : undefined;
	/**
	 * A subagent card is the only place its steps exist, so fold it and the whole
	 * execution becomes invisible — which is exactly what a reload looked like.
	 * Plain tool calls still start closed; their one line already says it all.
	 */
	const [open, setOpen] = useState(nested || Boolean(task));
	const userToggled = useRef(false);

	useEffect(() => {
		if ((nested || task) && !userToggled.current) {
			setOpen(true);
		}
	}, [nested, task]);

	return (
		<details
			className={`tool-card ${state}`}
			open={open}
			onToggle={event => {
				const next = event.currentTarget.open;
				if (next === open) {
					return;
				}
				userToggled.current = true;
				setOpen(next);
			}}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-summary">{toolSummary(item.name, item.input)}</span>
				{task?.subagentType && <span className="tool-tag">{task.subagentType}</span>}
				{task && <span className={`tool-tag ${task.status}`}>{TASK_STATUS_LABEL[task.status] ?? task.status}{taskMeta(task) ? ` · ${taskMeta(task)}` : ''}</span>}
				{log && <span className="tool-tag">输出</span>}
				{nested && <span className="tool-tag">{children.length} 条</span>}
				{!item.result && !task && <span className="tool-tag running">运行中</span>}
			</summary>

			<div className="tool-body">
				{task ? (
					<div className="task-detail">
						<div className="kv"><span>task</span><code>{task.taskId}</code></div>
						{task.taskType && <div className="kv"><span>type</span><code>{task.taskType}</code></div>}
						{task.usage && (
							<div className="kv">
								<span>usage</span>
								<code>
									{task.usage.totalTokens !== undefined ? `${formatTokens(task.usage.totalTokens)} tokens` : ''}
									{task.usage.toolUses !== undefined ? ` · ${task.usage.toolUses} tools` : ''}
									{task.usage.durationMs !== undefined ? ` · ${(task.usage.durationMs / 1000).toFixed(1)}s` : ''}
								</code>
							</div>
						)}
					</div>
				) : null}

				{/* The steps belong above the answer. Rendering the final message first
				    made a subagent card read as "conclusion, then a pile of commands",
				    so the work that produced the numbers sat at the very bottom. */}
				{nested && (
					<div className="tool-nested">
						{children.map(child => <ChatItemView key={child.id} item={child} childrenOf={childrenOf} outputOf={outputOf} />)}
					</div>
				)}

				{log && <pre className="task-log">{log}</pre>}

				{task ? (
					prompt && (
						<details className="tool-prompt">
							<summary>提示词</summary>
							<pre className="tool-input">{prompt}</pre>
						</details>
					)
				) : (
					<pre className="tool-input">{formatJson(item.input)}</pre>
				)}

				{answer && (
					<pre className={`tool-result${answer.isError ? ' failed' : ''}`}>{truncate(answer.content, 6000)}</pre>
				)}
			</div>
		</details>
	);
}

/**
 * Collapsible reasoning block. Stays collapsed so long thinking cannot bury the
 * answer; the body is a fixed-height scroller, not an ever-growing page.
 */
function ThinkingBlock({ text, live }: { readonly text: string; readonly live?: boolean }) {
	const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
	return (
		<details className="msg thinking">
			<summary className="thinking-summary">
				{live && <span className="thinking-pulse" />}
				<span className="thinking-label">思考</span>
				<span className="thinking-preview">{preview}</span>
				<span className="thinking-count">{text.length} 字</span>
			</summary>
			<div className="thinking-body">{text}</div>
		</details>
	);
}

/** Human-readable one-liner for the tool call currently in flight. */
function activityLabel(item: Extract<Item, { kind: 'tool' }>): string {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : '';
	switch (item.name) {
		case 'Read':
			return `读取 ${text('file_path')}`;
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
		case 'NotebookEdit':
			return `改动 ${text('file_path') || text('notebook_path')}`;
		case 'Bash':
		case 'PowerShell':
		case 'Shell':
			return `执行 ${text('command').slice(0, 60)}`;
		case 'Grep':
			return `搜索 ${text('pattern')}`;
		case 'Glob':
			return `查找 ${text('pattern')}`;
		case 'Agent':
		case 'Task':
			return `子 agent：${text('description') || text('prompt')}`;
		case 'WebFetch':
			return `抓取 ${text('url')}`;
		case 'WebSearch':
			return `搜索 ${text('query')}`;
		default:
			return `调用 ${item.name}`;
	}
}

function taskMeta(task: TaskState, now: number = Date.now()): string {
	if (task.usage?.durationMs !== undefined) {
		return `${(task.usage.durationMs / 1000).toFixed(1)}s`;
	}
	if (task.status === 'running') {
		const seconds = Math.max(0, Math.round((now - task.startedAt) / 1000));
		return `${seconds}s`;
	}
	return '';
}

function toolSummary(name: string, input: unknown): string {
	const record = (input ?? {}) as Record<string, unknown>;
	const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : undefined;

	switch (name) {
		case 'Read':
			return text('file_path') ?? '';
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
		case 'NotebookEdit':
			return text('file_path') ?? text('notebook_path') ?? '';
		case 'Bash':
		case 'PowerShell':
		case 'Shell': {
			const command = text('command');
			// Fall back to the raw JSON: an unexpected shape should still show
			// something rather than an empty summary.
			return command
				? `$ ${truncateLine(command, 120)}`
				: truncateLine(formatJson(input).replace(/\s+/g, ' '), 100);
		}
		case 'Grep':
			return [text('pattern'), text('path')].filter(Boolean).join('  in  ');
		case 'Glob':
			return text('pattern') ?? '';
		case 'Agent':
		case 'Task':
			return [text('description'), text('subagent_type')].filter(Boolean).join(' · ');
		case 'WebFetch':
			return text('url') ?? '';
		case 'WebSearch':
			return text('query') ?? '';
		case 'TaskCreate':
		case 'TaskUpdate':
			return text('subject') ?? text('taskId') ?? '';
		case 'TaskOutput':
		case 'TaskStop':
			return text('task_id') ?? text('taskId') ?? '';
		case 'TodoWrite':
			return Array.isArray(record['todos']) ? `${record['todos'].length} 项` : '';
		default: {
			const json = formatJson(input).replace(/\s+/g, ' ');
			return truncateLine(json, 100);
		}
	}
}

function formatTokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function truncateLine(value: string, limit: number): string {
	const single = value.replace(/\s+/g, ' ').trim();
	return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more chars)` : value;
}
