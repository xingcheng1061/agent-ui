import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentClientCommand, AgentInfo, AgentServerEvent, AgentTaskUsage, ModelOption, QueuedMessage } from '../agentTypes';
import { getTranscript, reportClientLog, searchFiles, type TranscriptItem } from '../api';
import { clearAttention, requestAttention } from '../attention';
import { acquireAgentConnection, type AgentConnectionHandle } from './agentConnections';
import { CodeHighlight, guessLanguage } from './CodeHighlight';
import { deleteLiveTurn, pruneLiveTurns, readLiveTurn } from './liveTurnStore';
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

/** One multiple-choice question carried by an `AskUserQuestion` prompt. */
interface Question {
	readonly question: string;
	readonly header?: string;
	readonly options: readonly { readonly label: string; readonly description?: string }[];
	readonly multiSelect: boolean;
}

/**
 * The questions a `permission_request` is really carrying.
 *
 * `AskUserQuestion` declares its own permission as `ask`, so it travels the same
 * approval bridge as a shell command — even under `bypassPermissions`. It is not
 * asking for permission though, it is asking for an answer, so it must be
 * rendered as a question card instead of an allow/deny one; the answers go back
 * as the tool's `updatedInput`.
 */
function questionsOf(permission: PendingPermission | undefined): readonly Question[] {
	if (!permission || permission.toolName !== 'AskUserQuestion') {
		return [];
	}
	const input = permission.input;
	if (typeof input !== 'object' || input === null) {
		return [];
	}
	const raw = (input as { questions?: unknown }).questions;
	if (!Array.isArray(raw)) {
		return [];
	}
	const questions: Question[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const record = entry as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown };
		if (typeof record.question !== 'string') {
			continue;
		}
		const options: { label: string; description?: string }[] = [];
		if (Array.isArray(record.options)) {
			for (const candidate of record.options) {
				if (typeof candidate !== 'object' || candidate === null) {
					continue;
				}
				const option = candidate as { label?: unknown; description?: unknown };
				if (typeof option.label !== 'string') {
					continue;
				}
				options.push({
					label: option.label,
					description: typeof option.description === 'string' ? option.description : undefined,
				});
			}
		}
		questions.push({
			question: record.question,
			header: typeof record.header === 'string' ? record.header : undefined,
			options,
			multiSelect: record.multiSelect === true,
		});
	}
	return questions;
}

type Item =
	/** `queued` marks a message that was steered into a turn already running. */
	| { readonly kind: 'user'; readonly id: string; readonly text: string; readonly queued?: boolean }
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

/** The status enum `TaskUpdate` carries, which arrives in English. */
const TODO_STATUS_LABEL: Record<string, string> = {
	pending: '待处理',
	in_progress: '进行中',
	completed: '已完成',
	deleted: '已删除',
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

/**
 * Tools whose input is a file edit. They render as a diff instead of raw JSON:
 * `old_string` / `new_string` already describe one, and printing the arguments
 * made the agent's change unreadable.
 */
const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Tools that return a numbered listing of one file. */
const READ_TOOLS: ReadonlySet<string> = new Set(['Read']);

/** The agent asked the user something; the input holds the questions. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

/** Pattern searches: the answer is a list of hits, not JSON. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);

/** Todo lists and the task board. */
const TASK_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskOutput', 'TaskStop']);

/** Plan mode carries a markdown plan, which reads badly as escaped JSON. */
const PLAN_TOOLS: ReadonlySet<string> = new Set(['ExitPlanMode', 'EnterPlanMode']);

/**
 * Network tools. `WebSearch` answers with a hit list and `WebFetch` with the
 * page as markdown, neither of which survives a `<pre>` of the raw result.
 */
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

/** Cap per task so a chatty background shell cannot blow up the DOM. */
const MAX_TASK_LOG = 200_000;

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
				...(item.kind === 'user' && item.queued ? { queued: true } : {}),
			});
		}
	}
	return result;
}

/** Highest `seq` in a batch, so a replay can skip whatever is already applied. */
function maxSeqOf(events: readonly AgentServerEvent[] | null | undefined): number {
	let max = 0;
	for (const event of events ?? []) {
		if (typeof event.seq === 'number' && event.seq > max) {
			max = event.seq;
		}
	}
	return max;
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
	/** Picks per question (text → labels); an array because answers can be multi-select. */
	const [answerPicks, setAnswerPicks] = useState<Readonly<Record<string, readonly string[]>>>({});
	/** Free-form reply, which the CLI accepts instead of a structured option. */
	const [freeform, setFreeform] = useState('');
	const questions = questionsOf(permission);

	// A new request means new questions: drop the previous picks.
	useEffect(() => {
		setAnswerPicks({});
		setFreeform('');
	}, [permission?.requestId]);
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
		models?: readonly ModelOption[];
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

	/**
	 * Borrowed from the connection pool, not owned here: switching conversation
	 * must not cut a stream that is still running. See `agentConnections.ts`.
	 */
	const connectionRef = useRef<AgentConnectionHandle | undefined>(undefined);
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
	/** Set between a stop click and the turn actually ending, so the click shows. */
	const [stopRequested, setStopRequested] = useState(false);
	const streamingRef = useRef(false);
	/** Messages waiting for the running turn, mirrored from the server. */
	const [queued, setQueued] = useState<readonly QueuedMessage[]>([]);
	/** Last queue snapshot, so a shrinking queue can tell what started running. */
	const queuedRef = useRef<readonly QueuedMessage[]>([]);
	/**
	 * Queue entries that already have a user bubble — everything this page sent
	 * itself. Consumed one by one when the queue shrinks, so a reload (where the
	 * bubbles were never created here) prints them and a normal send does not
	 * print them twice.
	 */
	const queueShownRef = useRef<string[]>([]);

	/** Takes one matching entry off the "already on screen" list. */
	const consumeQueueShown = (text: string): boolean => {
		const index = queueShownRef.current.indexOf(text);
		if (index < 0) {
			return false;
		}
		queueShownRef.current.splice(index, 1);
		return true;
	};
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
		clearAttention();
		setStreaming(false);
		setBackendLive(undefined);
		setQueued([]);
		queuedRef.current = [];
		queueShownRef.current = [];
		setThinkingTokens(0);
	};

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
				// Everything up to `seenSeq` is on screen already; the mirror is a
				// superset (the pooled connection keeps recording while history loads).
				const seenSeq = maxSeqOf(buffered);
				// Then the mirror of the turn that was streaming when the page went away
				// or another conversation was open. The connection's own buffer is a beat
				// newer than IndexedDB, so it wins when it has anything.
				const liveSnapshot = connectionRef.current?.snapshot();
				const local = liveSnapshot && liveSnapshot.events.length > 0 ? liveSnapshot : await readLiveTurn(sessionId);
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
					if (typeof event.seq === 'number' && event.seq <= seenSeq) {
						continue;
					}
					handleEventRef.current(event);
				}
				if (local.queued.length > 0) {
					setQueued(local.queued);
					// The mirror is the baseline the next snapshot is compared with;
					// without it the first shrink would replay nothing.
					queuedRef.current = local.queued;
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
				case 'queue': {
					const previous = queuedRef.current;
					queuedRef.current = event.items;
					setQueued(event.items);
					// A message leaves the queue because its turn started. When this page
					// did not send it itself — a reload while the queue was already
					// there — no other event would ever show it as a user bubble, so the
					// transcript would read as if the agent answered nothing.
					const waiting = event.items.map(item => item.text);
					for (const item of previous) {
						if (waiting.includes(item.text) || consumeQueueShown(item.text)) {
							continue;
						}
						setItems(items => [...items, { kind: 'user', id: nextId(), text: item.text }]);
					}
					return;
				}
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
					setStatus(event.toolName === 'AskUserQuestion' ? '等待你回答问题' : `等待审批：${event.toolName}`);
					setPermission({
						requestId: event.requestId,
						toolName: event.toolName,
						input: event.input,
						toolUseId: event.toolUseId,
					});
					// The CLI is blocked until this is answered, so reach the user
					// even when the tab is in the background.
					requestAttention({
						title: '需要审批',
						body: `${event.toolName} 正在等待你的决定`,
						requestId: event.requestId,
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
					clearAttention();
					return;
				case 'error':
					setStreaming(false);
					setItems(previous => [...previous, { kind: 'error', id: nextId(), text: event.message }]);
					return;
				case 'exit':
					setStreaming(false);
					setPermission(undefined);
					clearAttention();
					setItems(previous => [...previous, {
						kind: 'error',
						id: nextId(),
						text: `agent 进程退出（code ${event.code ?? '?'}）${event.stderr ? `\n${event.stderr}` : ''}`,
					}]);
					return;
			}
		};

		// The socket lives in the pool, keyed by conversation: leaving this panel
		// no longer closes it, so a turn that is still running keeps streaming
		// into this connection and the IndexedDB mirror. Coming back re-renders
		// from that snapshot — the server keeps no buffer to replay from.
		const connection = acquireAgentConnection(root, agent, resumeIdRef.current);
		connectionRef.current = connection;
		const stopState = connection.watchState(state => {
			if (disposed) {
				return;
			}
			setConnection(state);
			if (state === 'closed') {
				setStreaming(false);
			}
			if (state === 'open') {
				setStatus(previous => previous === '未连接' ? '就绪，等待输入' : previous);
			}
		});
		const stopEvents = connection.listen(parsed => {
			if (disposed) {
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
		});

		// Lets the transcript loader flush replayed events once history is ready.
		handleEventRef.current = handleEvent;

		return () => {
			disposed = true;
			stopEvents();
			stopState();
			connection.release();
			if (connectionRef.current === connection) {
				connectionRef.current = undefined;
			}
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

	// The turn ended (or never started): the stop request has been answered.
	useEffect(() => {
		if (!streaming) {
			setStopRequested(false);
		}
	}, [streaming]);

	// ...and if nothing answers it, drop the notice rather than leave it lying.
	useEffect(() => {
		if (!stopRequested) {
			return;
		}
		const timer = window.setTimeout(() => setStopRequested(false), 10_000);
		return () => window.clearTimeout(timer);
	}, [stopRequested]);

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

	const send = (command: AgentClientCommand) => {
		connectionRef.current?.send(command);
	};
	sendRef.current = send;

	// A conversation started here gets its id from `system`; the pooled
	// connection has to follow it, or a later reattach would resume the wrong one.
	useEffect(() => {
		connectionRef.current?.follow(sessionId);
	}, [sessionId]);

	const submitText = (text: string, immediate = false) => {
		// Sending while a turn runs is a queue, not an error: the server holds it
		// and writes it to stdin once the turn ends, so it becomes a turn of its
		// own and the transcript keeps a user entry for it. `immediate` steers it
		// into the running turn instead, which the CLI only records as an
		// attachment — hence the default.
		if (!text) {
			return;
		}
		streamRef.current.clear();
		setItems(previous => [...previous, { kind: 'user', id: nextId(), text }]);
		if (streamingRef.current && !immediate) {
			// This one joins the queue and already has its bubble.
			queueShownRef.current.push(text);
		}
		// Sending a message drops a pending approval on the server side.
		setPermission(undefined);
		clearAttention();
		setDraft('');
		setCursor(0);
		setPicker(undefined);
		setMenuDismissed(false);
		setStreaming(true);
		connectionRef.current?.markBusy();
		setThinkingTokens(0);
		lastEventRef.current = Date.now();
		stalledRef.current = false;
		setStalled(false);
		setStopRequested(false);
		stickToBottomRef.current = true;
		// `newSession` is what makes "new conversation" mean it: the socket may
		// still be attached to the previous session, and without the flag the
		// backend continues that one instead of creating a session of its own.
		createdHereRef.current = resumeIdRef.current === undefined;
		const target = resumeIdRef.current;
		send(target
			? { type: 'user', text, sessionId: target, ...(immediate ? { immediate: true } : {}) }
			: { type: 'user', text, newSession: true, ...(immediate ? { immediate: true } : {}) });
	};

	/** "Send now" on a queued message: steer it into the running turn. */
	const promoteQueued = (id: string) => {
		const target = stopTargetId();
		send(target ? { type: 'promote', id, sessionId: target } : { type: 'promote', id });
	};

	const submit = () => submitText(draft.trim());

	/**
	 * Which session a stop/kill click is aimed at. The server's default target is
	 * whatever this socket spawned, which is empty after a reattach; naming the
	 * session lets it find the live process anyway instead of doing nothing.
	 */
	const stopTargetId = () => meta.sessionId ?? resumeIdRef.current;

	/**
	 * Sends a stop and makes the click visible. A dropped socket used to swallow
	 * it silently, which read as "the button is broken".
	 */
	const requestStop = (kind: 'interrupt' | 'kill') => {
		const target = connectionRef.current;
		if (target?.state !== 'open') {
			setStatus('连接已断开，正在重连…');
			return;
		}
		setStopRequested(true);
		target.send({ type: kind, sessionId: stopTargetId() });
	};

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
		clearAttention();
	};

	/** Answers a question card. The CLI takes them back as the tool's input. */
	const submitAnswers = () => {
		if (!permission) {
			return;
		}
		const answers: Record<string, string> = {};
		for (const question of questions) {
			const picked = answerPicks[question.question];
			if (picked && picked.length > 0) {
				// Its output schema says "question text → answer string", with
				// multi-select answers comma-separated.
				answers[question.question] = picked.join(', ');
			}
		}
		const input = typeof permission.input === 'object' && permission.input !== null
			? permission.input as Record<string, unknown>
			: {};
		const text = freeform.trim();
		if (Object.keys(answers).length === 0 && text === '') {
			setStatus('先选一个选项，或直接输入回答');
			return;
		}
		send({
			type: 'permission_response',
			requestId: permission.requestId,
			behavior: 'allow',
			updatedInput: { ...input, answers, ...(text ? { response: text } : {}) },
		});
		setPermission(undefined);
		setStatus('就绪');
		clearAttention();
	};

	/** Declining a question prints "User declined to answer questions" for the model. */
	const skipQuestions = () => {
		if (!permission) {
			return;
		}
		send({
			type: 'permission_response',
			requestId: permission.requestId,
			behavior: 'deny',
			message: '用户跳过了这些问题。',
		});
		setPermission(undefined);
		setStatus('已跳过');
		clearAttention();
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
		const options = [...(meta.models ?? [])];
		// A backend can run a model its own catalogue does not list (a resumed
		// session, an env default); without an entry the select would render blank.
		if (meta.model && !options.some(option => option.id === meta.model)) {
			options.unshift({ id: meta.model });
		}
		return options;
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
			return modelOptions.map(option => ({
				key: `m:${option.id}`,
				label: option.label ?? option.id,
				// A label that hides the id still leaves the id worth seeing: it is
				// what gets sent to the backend.
				hint: option.id === meta.model ? '当前' : option.label ? option.id : '模型',
				run: () => {
					send({ type: 'set_model', model: option.id });
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

			{permission && (questions.length > 0
				? (
					<div className="permission-card question-card">
						<div className="permission-head">
							<span className="permission-title question-title-head">需要你回答</span>
							<span className="permission-hint">agent 正在等这几个问题的答案</span>
						</div>
						{questions.map(question => {
							const picked = answerPicks[question.question] ?? [];
							return (
								<div className="question" key={question.question}>
									<div className="question-title">
										{question.header && <span className="question-header">{question.header}</span>}
										<span>{question.question}</span>
										{question.multiSelect && <span className="question-multi">可多选</span>}
									</div>
									<div className="question-options">
										{question.options.map(option => (
											<button
												type="button"
												key={option.label}
												className={`question-option${picked.includes(option.label) ? ' active' : ''}`}
												title={option.description}
												onClick={() => setAnswerPicks(previous => {
													const current = previous[question.question] ?? [];
													const next = question.multiSelect
														? (current.includes(option.label)
															? current.filter(label => label !== option.label)
															: [...current, option.label])
														: [option.label];
													return { ...previous, [question.question]: next };
												})}
											>
												<span className="question-option-label">{option.label}</span>
												{option.description && <span className="question-option-desc">{option.description}</span>}
											</button>
										))}
									</div>
								</div>
							);
						})}
						<input
							className="question-freeform"
							placeholder="也可以直接输入回答（自由文本，回车提交）"
							value={freeform}
							onChange={event => setFreeform(event.target.value)}
							onKeyDown={event => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault();
									submitAnswers();
								}
							}}
						/>
						<div className="permission-actions">
							<button type="button" className="primary" onClick={submitAnswers}>提交答案</button>
							<button type="button" className="chip" onClick={skipQuestions}>跳过</button>
						</div>
					</div>
				)
				: (
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
				))}

			{queued.length > 0 && (
				<div className="queue-strip">
					<span className="queue-title">排队中 · {queued.length}</span>
					{queued.map((item, index) => (
						<span key={item.id} className="queue-item" title={item.text}>
							<span className="queue-index">{index + 1}</span>
							{truncateLine(item.text, 90)}
							<button
								type="button"
								className="queue-now"
								title="不等这一轮结束，直接插进当前执行过程"
								onClick={() => promoteQueued(item.id)}
							>
								立即发送
							</button>
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
								: stopRequested
									? '已请求停止，等待当前轮收尾…'
									: stalled
										? '已超过 1 分钟没有新输出，可能卡住了（可点「停止」后重发）'
										: streaming
											? '正在执行，可停止或强制结束'
											: '/ 命令 · @ 文件 · Enter 发送'}
					</span>
					{streaming && <button type="button" className="chip danger" onClick={() => requestStop('kill')}>强制结束</button>}
					{streaming && canSend && (
						<button type="button" className="chip" onClick={() => submitText(draft.trim(), true)}>
							立即发送
						</button>
					)}
					<button
						type="button"
						className={stopping ? 'primary stop' : 'primary'}
						onClick={canSend ? submit : () => requestStop('interrupt')}
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
					{modelOptions.map(option => (
						<option key={option.id} value={option.id} title={option.id}>{option.label ?? option.id}</option>
					))}
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
			// A message steered into a running turn is worth marking: it was never a
			// turn of its own, so it explains an answer that arrived all at once.
			return (
				<div className={`msg user${item.queued ? ' queued' : ''}`}>
					{item.queued && <span className="msg-tag" title="本轮执行中插入，未单独成轮">插话</span>}
					{item.text}
				</div>
			);
		case 'assistant':
			return (
				<div className="msg assistant rich">
					<Markdown text={item.text} streaming={live} />
				</div>
			);
		case 'thinking':
			return <ThinkingBlock text={item.text} live={live} />;
		case 'tool':
			return toolCardFor(item, childrenOf, outputOf);
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

/** One rendered line of a file change. */
interface DiffLine {
	readonly kind: 'context' | 'add' | 'remove';
	readonly text: string;
}

/** Past this the card is a wall of text; the rest is folded into a count. */
const MAX_DIFF_LINES = 300;

/** LCS line diff, bounded so a whole-file write cannot freeze the panel. */
function lineDiff(before: string, after: string): readonly DiffLine[] {
	const split = (value: string) => value === ''
		? []
		: value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
	const left = split(before);
	const right = split(after);
	if (left.length * right.length > 160_000) {
		return [
			...left.map(text => ({ kind: 'remove' as const, text })),
			...right.map(text => ({ kind: 'add' as const, text })),
		];
	}
	const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			table[i][j] = left[i] === right[j]
				? table[i + 1][j + 1] + 1
				: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			lines.push({ kind: 'context', text: left[i] });
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			lines.push({ kind: 'remove', text: left[i] });
			i++;
		} else {
			lines.push({ kind: 'add', text: right[j] });
			j++;
		}
	}
	while (i < left.length) {
		lines.push({ kind: 'remove', text: left[i] });
		i++;
	}
	while (j < right.length) {
		lines.push({ kind: 'add', text: right[j] });
		j++;
	}
	return lines;
}

/** The before/after text a file-editing tool described, in its own words. */
function changeOf(name: string, record: Record<string, unknown>): { before: string; after: string } {
	const text = (value: unknown) => typeof value === 'string' ? value : '';
	if (name === 'Write') {
		return { before: '', after: text(record['content']) };
	}
	if (name === 'NotebookEdit') {
		return { before: '', after: text(record['new_source']) };
	}
	if (name === 'MultiEdit') {
		const edits = Array.isArray(record['edits']) ? record['edits'] as readonly Record<string, unknown>[] : [];
		return {
			before: edits.map(edit => text(edit['old_string'])).filter(Boolean).join('\n'),
			after: edits.map(edit => text(edit['new_string'])).filter(Boolean).join('\n'),
		};
	}
	return { before: text(record['old_string']), after: text(record['new_string']) };
}

/** CLI failures arrive wrapped in `<tool_use_error>`; the tag is not the message. */
function toolErrorText(value: string): string {
	return value.replace(/<\/?tool_use_error>/g, '').trim();
}

/**
 * The last two segments of a path: the full one is noise in a narrow rail, the
 * file name is the part worth reading.
 */
function shortPath(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/**
 * A file read. The CLI answers with `<line>\t<text>` lines, which is a code
 * listing rather than a blob of prose: the numbers get their own column and the
 * card starts closed, so a 200-line read cannot bury the conversation.
 */
function ReadCard({ item }: { readonly item: Extract<Item, { kind: 'tool' }> }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const path = typeof record['file_path'] === 'string' ? record['file_path'] as string : '';
	const content = item.result?.content ?? '';
	const failed = item.result?.isError === true;
	const rows = !failed && content !== ''
		? content.replace(/\r\n/g, '\n').split('\n')
			.map(line => {
				const numbered = /^(\d+)\t(.*)$/.exec(line);
				return numbered
					? { number: numbered[1], text: numbered[2] }
					: { number: '', text: line };
			})
			.filter(row => row.number !== '' || row.text.trim() !== '')
		: [];
	const state = failed ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(false);
	return (
		<details
			className={`tool-card read-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-file" title={path}>{shortPath(path) || '文件'}</span>
				{rows.length > 0 && <span className="tool-tag">{rows.length} 行</span>}
				{!item.result && <span className="tool-tag running">运行中</span>}
			</summary>
			<div className="tool-body">
				{failed && <pre className="tool-result failed">{truncate(toolErrorText(content), 2000)}</pre>}
				{rows.length > 0 && (
					<pre className="read-code">
						{rows.map((row, index) => (
							<span key={index} className="read-line">
								<span className="read-number">{row.number || ' '}</span>{row.text}
							</span>
						))}
					</pre>
				)}
				{/* Not every read answers with `number<TAB>text`: a binary or image
				    file comes back as a one-line placeholder, which the numbered
				    renderer filtered away and left the card looking empty. */}
				{!failed && rows.length === 0 && content.trim() !== '' && (
					<pre className="tool-result">{truncate(content, 4000)}</pre>
				)}
			</div>
		</details>
	);
}

/**
 * A file edit rendered as a diff.
 *
 * `old_string`/`new_string` already describe one, so the card shows removed
 * lines in red and added ones in green instead of dumping the arguments as
 * JSON — which is what made an Edit look like a wall of escaped quotes.
 */
function FileChangeCard({ item }: { readonly item: Extract<Item, { kind: 'tool' }> }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const path = typeof record['file_path'] === 'string'
		? record['file_path'] as string
		: typeof record['notebook_path'] === 'string' ? record['notebook_path'] as string : '';
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const { before, after } = changeOf(item.name, record);
	const lines = lineDiff(before, after);
	const added = lines.filter(line => line.kind === 'add').length;
	const removed = lines.filter(line => line.kind === 'remove').length;
	const [open, setOpen] = useState(true);
	const shown = lines.slice(0, MAX_DIFF_LINES);
	const hidden = lines.length - shown.length;
	const label = shortPath(path);
	return (
		<details
			className={`tool-card edit-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-file" title={path}>{label || '文件'}</span>
				<span className="diff-stat">
					<span className="added">+{added}</span>
					<span className="removed">−{removed}</span>
				</span>
				{!item.result && <span className="tool-tag running">运行中</span>}
			</summary>
			<div className="tool-body">
				{lines.length === 0
					? <pre className="tool-input">{formatJson(item.input)}</pre>
					: (
						<pre className="edit-diff">
							{shown.map((line, index) => (
								<span key={index} className={`diff-line ${line.kind}`}>
									<span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}</span>{line.text}
								</span>
							))}
						</pre>
					)}
				{hidden > 0 && <div className="diff-more">还有 {hidden} 行未显示</div>}
				{/* A successful edit only ever answers with boilerplate ("The file …
				    has been updated successfully"), which the diff already says;
				    only a failure carries something worth reading. */}
				{item.result?.isError && (
					<div className="edit-note failed">{truncateLine(toolErrorText(item.result.content), 300)}</div>
				)}
			</div>
		</details>
	);
}

type ToolItem = Extract<Item, { kind: 'tool' }>;

/**
 * One card per tool family.
 *
 * Anything unrecognised still falls back to `ToolCard`, which now keeps the raw
 * arguments behind a disclosure — expanding a card used to mean reading JSON.
 */
function toolCardFor(
	item: ToolItem,
	childrenOf: (id: string) => readonly Item[],
	outputOf: (taskId: string) => string | undefined,
) {
	// Shell calls get their own control: `PowerShell` is what the CLI emits on
	// Windows, so matching only `Bash` hid half of them.
	if (SHELL_TOOLS.has(item.name)) {
		return <BashCard item={item} />;
	}
	if (FILE_CHANGE_TOOLS.has(item.name)) {
		return <FileChangeCard item={item} />;
	}
	if (READ_TOOLS.has(item.name)) {
		return <ReadCard item={item} />;
	}
	if (QUESTION_TOOLS.has(item.name)) {
		return <QuestionCard item={item} />;
	}
	if (SEARCH_TOOLS.has(item.name)) {
		return <SearchCard item={item} />;
	}
	if (WEB_TOOLS.has(item.name)) {
		return <WebCard item={item} />;
	}
	if (TASK_TOOLS.has(item.name)) {
		return <TaskToolCard item={item} />;
	}
	if (PLAN_TOOLS.has(item.name)) {
		return <PlanCard item={item} />;
	}
	return <ToolCard item={item} childrenOf={childrenOf} outputOf={outputOf} />;
}

interface AskedOption {
	readonly label: string;
	readonly description?: string;
}

interface AskedQuestion {
	readonly question: string;
	readonly header?: string;
	readonly multiSelect: boolean;
	readonly options: readonly AskedOption[];
}

/** The `questions` array an AskUserQuestion call carries. */
function askedQuestions(record: Record<string, unknown>): readonly AskedQuestion[] {
	const raw = record['questions'];
	if (!Array.isArray(raw)) {
		return [];
	}
	const asked: AskedQuestion[] = [];
	for (const entry of raw as readonly Record<string, unknown>[]) {
		if (typeof entry['question'] !== 'string') {
			continue;
		}
		const options: AskedOption[] = [];
		if (Array.isArray(entry['options'])) {
			for (const option of entry['options'] as readonly Record<string, unknown>[]) {
				if (typeof option['label'] === 'string') {
					options.push({
						label: option['label'],
						description: typeof option['description'] === 'string' ? option['description'] : undefined,
					});
				}
			}
		}
		asked.push({
			question: entry['question'],
			header: typeof entry['header'] === 'string' ? entry['header'] : undefined,
			multiSelect: entry['multiSelect'] === true,
			options,
		});
	}
	return asked;
}

/**
 * Answers come back as prose: `Your questions have been answered: "Q"="A", …`.
 * There is no structured field, so the quoted pairs are what can be trusted.
 */
function answersOf(text: string): ReadonlyMap<string, string> {
	const answers = new Map<string, string>();
	for (const match of text.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)) {
		answers.set(match[1], match[2]);
	}
	return answers;
}

/**
 * An answered question round. The live card (permission prompt) has its buttons;
 * this is the record of it, so the chosen options are marked instead.
 */
function QuestionCard({ item }: { readonly item: ToolItem }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const asked = askedQuestions(record);
	const answers = answersOf(item.result?.content ?? '');
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(false);
	const picked = (question: AskedQuestion, label: string) => {
		const answer = answers.get(question.question);
		return answer !== undefined
			&& answer.split(/[,，]\s*/).some(part => part.trim() === label);
	};
	return (
		<details
			className={`tool-card question-result ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">提问</span>
				<span className="tool-file">{asked.length} 个问题</span>
				<span className="tool-tag">{answers.size > 0 ? `已回答 ${answers.size}` : '未回答'}</span>
			</summary>
			<div className="tool-body">
				{asked.map(question => (
					<div className="question" key={question.question}>
						<div className="question-title">
							{question.header && <span className="question-header">{question.header}</span>}
							<span>{question.question}</span>
							{question.multiSelect && <span className="question-multi">可多选</span>}
						</div>
						<div className="question-options">
							{question.options.map(option => (
								<span
									key={option.label}
									className={`question-option${picked(question, option.label) ? ' active' : ''}`}
								>
									<span className="question-option-label">{option.label}</span>
									{option.description && <span className="question-option-desc">{option.description}</span>}
								</span>
							))}
						</div>
						{answers.get(question.question) && (
							<div className="question-answer">答：{answers.get(question.question)}</div>
						)}
					</div>
				))}
				{item.result?.isError && (
					<div className="edit-note failed">{truncateLine(toolErrorText(item.result.content), 300)}</div>
				)}
			</div>
		</details>
	);
}

/** Grep / Glob: the query plus the hits it produced. */
function SearchCard({ item }: { readonly item: ToolItem }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const pattern = typeof record['pattern'] === 'string' ? record['pattern'] as string : '';
	const scope = typeof record['path'] === 'string' ? record['path'] as string : '';
	const output = item.result?.content ?? '';
	const lines = item.result?.isError || output === ''
		? []
		: output.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '');
	const shown = lines.slice(0, 60);
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(false);
	return (
		<details
			className={`tool-card search-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-file" title={scope}>{pattern || '搜索'}</span>
				{lines.length > 0 && <span className="tool-tag">{lines.length} 行</span>}
				{!item.result && <span className="tool-tag running">运行中</span>}
			</summary>
			<div className="tool-body">
				{item.result?.isError
					? <pre className="tool-result failed">{truncate(toolErrorText(output), 2000)}</pre>
					: shown.length > 0 && (
						<pre className="search-result">
							{shown.map((line, index) => <span key={index} className="search-line">{line}</span>)}
						</pre>
					)}
				{lines.length > shown.length && <div className="diff-more">还有 {lines.length - shown.length} 行未显示</div>}
			</div>
		</details>
	);
}

/**
 * WebFetch / WebSearch. A hit list and a page's markdown both arrive as one
 * blob; rendering the blob in a `<pre>` threw away the only thing that made
 * either readable — the line breaks and the markdown itself.
 */
function WebCard({ item }: { readonly item: ToolItem }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const search = item.name === 'WebSearch';
	const key = search ? 'query' : 'url';
	const target = typeof record[key] === 'string' ? record[key] as string : '';
	const output = item.result?.content ?? '';
	const lines = item.result?.isError || output === ''
		? []
		: output.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '');
	const shown = lines.slice(0, 60);
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(false);
	return (
		<details
			className={`tool-card web-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-file" title={target}>{truncateLine(target, 90) || (search ? '搜索' : '页面')}</span>
				{!item.result && <span className="tool-tag running">运行中</span>}
			</summary>
			<div className="tool-body">
				{item.result?.isError
					? <pre className="tool-result failed">{truncate(toolErrorText(output), 2000)}</pre>
					: !item.result
						? <div className="tool-pending">执行中…</div>
						: search
							? (
								<>
									<pre className="search-result">
										{shown.map((line, index) => <span key={index} className="search-line">{line}</span>)}
									</pre>
									{lines.length > shown.length && <div className="diff-more">还有 {lines.length - shown.length} 行未显示</div>}
								</>
							)
							/* The fetched page is already markdown; the card caps its
							   height so a long article cannot push the rest away. */
							: <div className="web-body"><Markdown text={truncate(output, 20000)} /></div>}
			</div>
		</details>
	);
}

/** TodoWrite / Task* : the list or the single task a step touched. */
function TaskToolCard({ item }: { readonly item: ToolItem }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const state = item.result?.isError ? 'failed' : item.result ? 'done' : 'running';
	const [open, setOpen] = useState(item.name === 'TodoWrite');
	const mark = (status: unknown) => status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';

	const todos = Array.isArray(record['todos']) ? record['todos'] as readonly Record<string, unknown>[] : [];
	const rows: { mark: string; text: string }[] = todos.map(todo => ({
		mark: mark(todo['status']),
		text: typeof todo['content'] === 'string' ? todo['content'] as string : '',
	}));

	if (rows.length === 0) {
		// TaskCreate carries subject/description, TaskUpdate only ids and a status.
		const field = (key: string) => typeof record[key] === 'string' ? record[key] as string : '';
		const status = TODO_STATUS_LABEL[field('status')] ?? field('status');
		const subject = [field('subject'), field('description'), field('task_id') || field('taskId'), status]
			.filter(Boolean);
		if (subject.length > 0) {
			rows.push({ mark: '', text: subject.join(' · ') });
		}
	}
	const done = rows.filter(row => row.mark === '✓').length;
	// TodoWrite and TaskCreate answer with boilerplate ("Todos have been
	// modified successfully"), but TaskOutput answers with the log the user
	// asked for and TaskStop with the reason it could not stop.
	const output = item.result && !item.result.isError ? item.result.content.trim() : '';
	const showOutput = output !== '' && (item.name === 'TaskOutput' || item.name === 'TaskStop');
	return (
		<details
			className={`tool-card task-tool-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name}</span>
				<span className="tool-file">{item.name === 'TodoWrite' ? `${done}/${rows.length} 完成` : rows[0]?.text ?? ''}</span>
			</summary>
			<div className="tool-body">
				{rows.map((row, index) => (
					<div key={index} className="task-line">
						<span className="task-mark">{row.mark}</span>{row.text}
					</div>
				))}
				{showOutput && <pre className="task-log">{truncate(output, 4000)}</pre>}
				{item.result?.isError && (
					<div className="edit-note failed">{truncateLine(toolErrorText(item.result.content), 300)}</div>
				)}
			</div>
		</details>
	);
}

/** EnterPlanMode / ExitPlanMode: the plan is markdown, not escaped JSON. */
function PlanCard({ item }: { readonly item: ToolItem }) {
	const record = (item.input ?? {}) as Record<string, unknown>;
	const plan = typeof record['plan'] === 'string' ? record['plan'] as string : '';
	const result = item.result;
	const state = result?.isError ? 'failed' : result ? 'done' : 'running';
	const [open, setOpen] = useState(false);
	// `ExitPlanMode` answers with the approval or the rejection, which is the
	// only part of the card the user can act on — and it used to be dropped.
	// `EnterPlanMode` carries no arguments at all, so printing its input only
	// ever produced a bare `{}`.
	const note = result ? truncateLine(result.content, 300) : '';
	const extra = Object.keys(record).filter(key => key !== 'plan');
	return (
		<details
			className={`tool-card plan-card ${state}`}
			open={open}
			onToggle={event => setOpen(event.currentTarget.open)}
		>
			<summary className="tool-head">
				<span className={`tool-dot ${state}`} />
				<span className="tool-name">{item.name === 'ExitPlanMode' ? '提交计划' : '进入计划模式'}</span>
				<span className="tool-file">{plan === '' ? '' : `${plan.split('\n').length} 行`}</span>
				{!result && <span className="tool-tag running">运行中</span>}
			</summary>
			<div className="tool-body">
				{plan !== '' && <div className="plan-body"><Markdown text={plan} /></div>}
				{note !== '' && <div className={`edit-note${result?.isError ? ' failed' : ''}`}>{note}</div>}
				{plan === '' && note === '' && <div className="tool-pending">等待确认…</div>}
				{extra.length > 0 && (
					<details className="tool-raw">
						<summary>原始参数</summary>
						<pre className="tool-input">{formatJson(item.input)}</pre>
					</details>
				)}
			</div>
		</details>
	);
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
					// The arguments of an unrecognised tool stay available, but one
					// more click away: expanding the card should show what the tool
					// produced, not a JSON document.
					<details className="tool-raw">
						<summary>原始参数</summary>
						<pre className="tool-input">{formatJson(item.input)}</pre>
					</details>
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

/**
 * The task tools disagree on their parameter name (`taskId` for TaskUpdate,
 * `task_id` for TaskOutput/TaskStop), so read whichever one is present.
 */
function taskId(record: Record<string, unknown>): string {
	for (const key of ['taskId', 'task_id']) {
		if (typeof record[key] === 'string') {
			return record[key] as string;
		}
	}
	return '';
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
		case 'AskUserQuestion':
			return '向你提问';
		case 'TodoWrite':
			return '更新任务清单';
		case 'TaskCreate':
			return `新建任务：${text('subject')}`;
		case 'TaskUpdate':
			return `更新任务 ${taskId(record)}`;
		case 'TaskOutput':
			return `读取任务输出 ${taskId(record)}`;
		case 'TaskStop':
			return `停止任务 ${taskId(record)}`;
		case 'ExitPlanMode':
			return '提交计划';
		case 'EnterPlanMode':
			return '进入计划模式';
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
