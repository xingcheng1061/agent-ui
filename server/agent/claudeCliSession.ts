import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEBUG, INTERRUPT_GRACE_MS, INTERNAL_ORIGIN, INTERNAL_TOKEN, MODELS, PERMISSION_TIMEOUT_MS, PROMPTING_MODES, stamp } from '../config.js';
import type { AgentSession, AgentSessionOptions, PermissionDecision, PermissionPrompt } from './driver.js';
import { bindPermissionHost } from './permissionGateway.js';
import type { AgentServerEvent, AgentTaskUsage } from './protocol.js';

export type ClaudeSessionOptions = AgentSessionOptions;

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly input?: unknown;
	readonly tool_use_id?: string;
	readonly is_error?: boolean;
	readonly content?: unknown;
}

interface CliMessage {
	readonly type: string;
	readonly subtype?: string;
	readonly session_id?: string;
	readonly model?: string;
	readonly cwd?: string;
	readonly tools?: readonly string[];
	readonly message?: { readonly id?: string; readonly content?: readonly ContentBlock[] };
	readonly event?: {
		readonly type?: string;
		readonly delta?: { readonly type?: string; readonly text?: string; readonly thinking?: string };
		/** Set on `message_start`: identifies the API message the deltas belong to. */
		readonly message?: { readonly id?: string };
	};
	/** Set on every event produced inside a subagent; the value is the spawning tool call. */
	readonly parent_tool_use_id?: string | null;
	readonly subagent_type?: string;
	readonly task_description?: string;
	readonly slash_commands?: readonly string[];
	readonly skills?: readonly string[];
	readonly agents?: readonly string[];
	readonly permissionMode?: string;
	/** `system` subtypes below. */
	readonly status?: string;
	readonly task_id?: string;
	readonly tool_use_id?: string;
	readonly description?: string;
	readonly task_type?: string;
	readonly prompt?: string;
	readonly output_file?: string;
	readonly summary?: string;
	readonly patch?: { readonly status?: string };
	readonly usage?: { readonly total_tokens?: number; readonly tool_uses?: number; readonly duration_ms?: number };
	readonly estimated_tokens?: number;
	readonly estimated_tokens_delta?: number;
	readonly is_error?: boolean;
	readonly result?: string;
	readonly total_cost_usd?: number;
	readonly duration_ms?: number;
	readonly num_turns?: number;
	readonly error?: string;
	readonly request_id?: string;
	readonly response?: { readonly subtype?: string; readonly request_id?: string };
}

interface ControlRequest {
	readonly type: 'control_request';
	readonly request_id: string;
	readonly request: { readonly subtype: string };
}

interface TailState {
	readonly file: string;
	offset: number;
	stopped: boolean;
	timer?: NodeJS.Timeout;
}

const MAX_STDERR_LINES = 40;

/** How often background-task output files are polled. */
const TAIL_INTERVAL_MS = 500;

/** The CLI tells us where a background shell writes, in the tool result text. */
const OUTPUT_FILE_PATTERN = /Output is being written to:\s*([^\r\n]+?\.output)/;

/**
 * Drives one long-lived `claude` process with JSONL in/out.
 *
 * The CLI keeps the conversation state itself, so multi-turn works without the
 * server holding any history: a user turn is one JSON line on stdin, and the
 * answer streams back on stdout.
 *
 * Three control channels are wired up on top of that stream:
 * - subagents/background tasks arrive as `system/task_*` events, and their
 *   content carries `parent_tool_use_id` so the UI can nest it;
 * - `interrupt` goes out as a `control_request`, keeping the session alive;
 * - approvals go out through an MCP server (`permissionPrompt.mjs`) registered
 *   with `--permission-prompt-tool`, which blocks until the browser answers.
 */
export class ClaudeCliSession implements AgentSession {
	readonly id = randomUUID();
	private readonly _child: ChildProcessWithoutNullStreams;
	private _stdoutBuffer = '';
	private _disposed = false;
	/** Parents (`''` for the main thread) whose finished message was already emitted. */
	private readonly _sawText = new Set<string>();
	private readonly _sawThinking = new Set<string>();
	/**
	 * API message currently streaming per parent. The CLI persists a finished
	 * message under the same id, which is what lets the browser recognise the
	 * deltas it must not draw twice after a reload.
	 */
	private readonly _messageIds = new Map<string, string>();
	private readonly _stderrLines: string[] = [];
	private readonly _pendingControl = new Map<string, (subtype: string) => void>();
	private readonly _pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
	/** Mirrors the CLI's current mode; it changes without a restart. */
	private _permissionMode: string;
	/** Whether this process was started with the MCP approval bridge. */
	private readonly _promptBridge: boolean;
	private readonly _taskIdByToolUse = new Map<string, string>();
	private readonly _tails = new Map<string, TailState>();
	private readonly _unbindPermissions: () => void;
	private _controlSeq = 0;
	private _permissionSeq = 0;

	constructor(
		private readonly _options: ClaudeSessionOptions,
		private readonly _emit: (event: AgentServerEvent) => void,
	) {
		this._permissionMode = _options.permissionMode;
		const args = [
			'--print',
			'--verbose',
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--include-partial-messages',
			'--permission-mode', _options.permissionMode,
		];
		// Opt in without actually skipping: the CLI otherwise refuses a *runtime*
		// switch to bypassPermissions ("the session was not launched with
		// --dangerously-skip-permissions"). The process still starts in whatever
		// safe mode was configured; only the UI can raise it.
		args.push('--allow-dangerously-skip-permissions');
		if (_options.model) {
			args.push('--model', _options.model);
		}
		if (_options.resumeSessionId) {
			args.push('--resume', _options.resumeSessionId);
		}

		// Approval prompts: the CLI spawns this MCP server and calls it whenever a
		// tool needs a decision. Only register it for modes that actually prompt —
		// with the tool present the CLI asks for *everything*, including edits that
		// `acceptEdits` is supposed to allow, and then blocks on our answer.
		const script = fileURLToPath(new URL('./permissionPrompt.mjs', import.meta.url));
		this._promptBridge = PROMPTING_MODES.has(_options.permissionMode);
		if (this._promptBridge) {
			args.push(
				'--mcp-config', JSON.stringify({ mcpServers: { agentui: { command: process.execPath, args: [script] } } }),
				'--permission-prompt-tool', 'mcp__agentui__approval',
			);
		}

		this._child = spawn(process.env['AGENT_UI_CLAUDE_BIN'] ?? 'claude', args, {
			cwd: _options.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				CLAUDE_CODE_ENTRYPOINT: 'agent-ui',
				AGENT_UI_PERMISSION_URL: INTERNAL_ORIGIN,
				AGENT_UI_PERMISSION_TOKEN: INTERNAL_TOKEN,
				AGENT_UI_PERMISSION_SESSION: this.id,
			},
			windowsHide: true,
		});

		this._child.stdout.setEncoding('utf8');
		this._child.stdout.on('data', chunk => this._onStdout(chunk));
		this._child.stderr.setEncoding('utf8');
		this._child.stderr.on('data', chunk => this._onStderr(chunk));

		this._child.on('error', error => {
			this._emit({ type: 'error', message: `无法启动 claude：${error.message}` });
		});

		this._child.on('close', code => {
			this._log(`exit code=${code} stderr=${this._stderrLines.slice(-4).join(' | ') || '(none)'}`);
			this._emit({ type: 'exit', code, stderr: this._stderrLines.slice(-8).join('\n') || undefined });
		});

		this._unbindPermissions = bindPermissionHost(this);
	}

	sendUserMessage(text: string): void {
		this._sawText.clear();
		this._sawThinking.clear();
		this._messageIds.clear();
		this._write({
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text }] },
		});
	}

	/**
	 * Graceful stop: the CLI acknowledges with a `control_response` and ends the
	 * turn, so the session (and its history) survives. Falls back to a hard kill
	 * when the CLI does not answer within {@link INTERRUPT_GRACE_MS}.
	 */
	interrupt(): void {
		if (this._disposed) {
			return;
		}
		const requestId = `ctrl_${++this._controlSeq}`;
		const timer = setTimeout(() => {
			this._pendingControl.delete(requestId);
			this.kill('interrupt-timeout');
		}, INTERRUPT_GRACE_MS);
		timer.unref?.();
		this._pendingControl.set(requestId, () => clearTimeout(timer));
		this._write({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
	}

	/** Runtime model switch; the CLI replies with a `control_response`. */
	setModel(model: string): void {
		this._request({ subtype: 'set_model', model }, subtype => {
			if (subtype === 'success') {
				this._emit({ type: 'config', model });
			}
		});
	}

	/** Runtime permission-mode switch (`default` / `acceptEdits` / `plan` / `bypassPermissions`). */
	setPermissionMode(mode: string): void {
		this._request({ subtype: 'set_permission_mode', mode }, subtype => {
			if (subtype !== 'success') {
				return;
			}
			this._permissionMode = mode;
			this._emit({ type: 'config', permissionMode: mode });
			if (PROMPTING_MODES.has(mode) && !this._promptBridge) {
				// The CLI only routes approvals through our MCP tool when it was
				// registered at spawn time, so a late switch cannot enable it.
				this._emit({
					type: 'error',
					message: `已切到 ${mode}，但当前进程启动时没挂审批通道，工具调用会被直接拒绝。新开一个会话即可启用交互式审批。`,
				});
			}
		});
	}

	private _request(request: { readonly subtype: string } & Record<string, unknown>, onResponse: (subtype: string) => void): void {
		if (this._disposed) {
			return;
		}
		const requestId = `rc_${++this._controlSeq}`;
		this._pendingControl.set(requestId, onResponse);
		this._write({ type: 'control_request', request_id: requestId, request });
	}

	/** Hard stop; the next turn has to start a fresh process. */
	kill(reason = 'kill'): void {
		if (this._disposed) {
			return;
		}
		this._log(`kill (${reason})`);
		this._child.kill();
	}

	/** Called by the router when the browser answers a `permission_request`. */
	resolvePermission(requestId: string, decision: PermissionDecision): boolean {
		const pending = this._pendingPermissions.get(requestId);
		if (!pending) {
			return false;
		}
		this._pendingPermissions.delete(requestId);
		pending(decision);
		return true;
	}

	/** Whether the CLI is currently blocked waiting for an approval. */
	hasPendingPermission(): boolean {
		return this._pendingPermissions.size > 0;
	}

	/**
	 * Drops approvals nobody answered. The CLI is blocked on the MCP call, so it
	 * has to be released before a new user message can be processed.
	 */
	cancelPendingPermissions(reason: string): void {
		if (this._pendingPermissions.size === 0) {
			return;
		}
		this._log(`cancel ${this._pendingPermissions.size} pending approval(s)`);
		for (const settle of [...this._pendingPermissions.values()]) {
			settle({ behavior: 'deny', message: reason });
		}
		this._pendingPermissions.clear();
	}

	/** Asks the browser and blocks the CLI until it answers. */
	async requestPermission(prompt: PermissionPrompt): Promise<PermissionDecision> {
		if (this._disposed) {
			return { behavior: 'deny', message: 'agent 进程已结束。' };
		}
		const requestId = `perm_${++this._permissionSeq}`;
		this._emit({
			type: 'permission_request',
			requestId,
			toolName: prompt.toolName,
			input: prompt.input,
			toolUseId: prompt.toolUseId,
		});
		return new Promise<PermissionDecision>(resolve => {
			const timer = setTimeout(() => {
				this._pendingPermissions.delete(requestId);
				this._log('permission timeout -> deny');
				resolve({ behavior: 'deny', message: '审批超时。' });
			}, PERMISSION_TIMEOUT_MS);
			timer.unref?.();
			this._pendingPermissions.set(requestId, decision => {
				clearTimeout(timer);
				resolve(decision);
			});
		});
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._unbindPermissions();
		for (const settle of this._pendingControl.values()) {
			settle('cancelled');
		}
		this._pendingControl.clear();
		for (const pending of this._pendingPermissions.values()) {
			pending({ behavior: 'deny', message: '会话已关闭。' });
		}
		this._pendingPermissions.clear();
		for (const taskId of [...this._tails.keys()]) {
			this._stopTail(taskId);
		}
		this._child.stdout.removeAllListeners();
		this._child.stderr.removeAllListeners();
		this._child.kill();
	}

	private _log(message: string): void {
		if (DEBUG) {
			console.log(`[${stamp()}][agent-ui:${this.id.slice(0, 8)}] ${message}`);
		}
	}

	private _write(payload: object | ControlRequest): void {
		if (this._disposed || !this._child.stdin.writable) {
			this._emit({ type: 'error', message: 'agent 进程已结束，请重新开始会话。' });
			return;
		}
		this._child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private _onStderr(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}
			this._stderrLines.push(trimmed);
			if (this._stderrLines.length > MAX_STDERR_LINES) {
				this._stderrLines.shift();
			}
		}
	}

	private _onStdout(chunk: string): void {
		this._stdoutBuffer += chunk;
		let newlineIndex = this._stdoutBuffer.indexOf('\n');
		while (newlineIndex >= 0) {
			const line = this._stdoutBuffer.slice(0, newlineIndex).trim();
			this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);
			if (line) {
				this._handleLine(line);
			}
			newlineIndex = this._stdoutBuffer.indexOf('\n');
		}
	}

	private _handleLine(line: string): void {
		let message: CliMessage;
		try {
			message = JSON.parse(line) as CliMessage;
		} catch {
			return;
		}

		const parent = message.parent_tool_use_id ?? undefined;

		switch (message.type) {
			case 'system':
				this._handleSystem(message);
				return;

			case 'stream_event': {
				const event = message.event;
				if (event?.type === 'message_start') {
					const id = event.message?.id;
					if (id) {
						this._messageIds.set(parent ?? '', id);
					}
					return;
				}
				if (event?.type !== 'content_block_delta') {
					return;
				}
				const delta = event.delta;
				const messageId = this._messageIds.get(parent ?? '');
				if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
					this._sawText.add(parent ?? '');
					this._emit({ type: 'assistant_delta', text: delta.text, parentToolUseId: parent, messageId });
				} else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
					this._sawThinking.add(parent ?? '');
					this._emit({ type: 'thinking_delta', text: delta.thinking, parentToolUseId: parent, messageId });
				}
				return;
			}

			case 'assistant': {
				// Without partial-message support the CLI only sends the finished
				// message; fall back to its text so the UI is never blank.
				const messageId = message.message?.id;
				for (const block of message.message?.content ?? []) {
					if (block.type === 'text' && typeof block.text === 'string') {
						if (!this._sawText.has(parent ?? '')) {
							this._emit({ type: 'assistant_delta', text: block.text, parentToolUseId: parent, messageId });
						}
					} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
						if (!this._sawThinking.has(parent ?? '')) {
							this._emit({ type: 'thinking_delta', text: block.thinking, parentToolUseId: parent, messageId });
						}
					} else if (block.type === 'tool_use' && block.id && block.name) {
						this._emit({ type: 'tool_use', id: block.id, name: block.name, input: block.input, parentToolUseId: parent });
					}
				}
				return;
			}

			case 'user': {
				for (const block of message.message?.content ?? []) {
					if (block.type === 'tool_result' && block.tool_use_id) {
						const content = stringifyToolResult(block.content);
						this._emit({
							type: 'tool_result',
							toolUseId: block.tool_use_id,
							isError: block.is_error === true,
							content,
							parentToolUseId: parent,
						});
						this._maybeTail(block.tool_use_id, content);
					}
				}
				return;
			}

			case 'control_response': {
				const requestId = message.response?.request_id ?? message.request_id;
				const settle = requestId ? this._pendingControl.get(requestId) : undefined;
				if (requestId) {
					this._pendingControl.delete(requestId);
				}
				settle?.(message.response?.subtype ?? 'unknown');
				return;
			}

			case 'result':
				this._emit({
					type: 'result',
					subtype: message.subtype,
					isError: message.is_error === true || message.subtype === 'error',
					text: message.result,
					costUsd: message.total_cost_usd,
					durationMs: message.duration_ms,
					numTurns: message.num_turns,
					sessionId: message.session_id,
				});
				return;

			case 'error':
				this._emit({ type: 'error', message: message.error ?? 'unknown agent error' });
				return;

			default:
				return;
		}
	}

	private _handleSystem(message: CliMessage): void {
		switch (message.subtype) {
			case 'init':
				this._permissionMode = message.permissionMode ?? this._permissionMode;
				this._emit({
					type: 'system',
					sessionId: message.session_id ?? this.id,
					model: message.model,
					cwd: message.cwd ?? this._options.cwd,
					toolCount: message.tools?.length,
					permissionMode: this._permissionMode,
					slashCommands: message.slash_commands,
					skills: message.skills,
					agents: message.agents,
					models: MODELS,
				});
				return;

			case 'status':
				// The CLI reports mode changes here too (e.g. after
				// `set_permission_mode`); mirror them so the UI never misses a switch.
				if (message.permissionMode) {
					this._permissionMode = message.permissionMode;
					this._emit({ type: 'config', permissionMode: message.permissionMode });
				}
				this._emit({ type: 'status', status: message.status ?? 'unknown' });
				return;

			case 'thinking_tokens':
				this._emit({
					type: 'thinking_tokens',
					estimated: message.estimated_tokens ?? 0,
					delta: message.estimated_tokens_delta ?? 0,
				});
				return;

			case 'task_started':
				if (message.task_id) {
					if (message.tool_use_id) {
						this._taskIdByToolUse.set(message.tool_use_id, message.task_id);
					}
					this._emit({
						type: 'task_started',
						taskId: message.task_id,
						toolUseId: message.tool_use_id,
						description: message.description ?? message.task_description,
						subagentType: message.subagent_type,
						taskType: message.task_type,
						prompt: message.prompt,
					});
				}
				return;

			case 'task_progress':
				if (message.task_id) {
					this._emit({
						type: 'task_progress',
						taskId: message.task_id,
						toolUseId: message.tool_use_id,
						description: message.description,
						usage: toTaskUsage(message.usage),
					});
				}
				return;

			case 'task_updated':
				if (message.task_id) {
					this._emit({
						type: 'task_updated',
						taskId: message.task_id,
						toolUseId: message.tool_use_id,
						status: message.patch?.status ?? 'unknown',
					});
					if (message.patch?.status && message.patch.status !== 'running') {
						this._drainTail(message.task_id);
					}
				}
				return;

			case 'task_notification':
				if (message.task_id) {
					this._emit({
						type: 'task_notification',
						taskId: message.task_id,
						toolUseId: message.tool_use_id,
						status: message.status ?? 'unknown',
						summary: message.summary,
						outputFile: message.output_file || undefined,
						usage: toTaskUsage(message.usage),
					});
					if (message.output_file) {
						this._startTail(message.task_id, message.output_file);
					}
					this._drainTail(message.task_id);
				}
				return;

			case 'compact_boundary':
				this._emit({ type: 'status', status: 'compacted' });
				return;

			default:
				return;
		}
	}

	/**
	 * Background shells write to a file the CLI names in the tool result, so the
	 * UI can stream the log live instead of waiting for the model to read it.
	 */
	private _maybeTail(toolUseId: string, content: string): void {
		const match = OUTPUT_FILE_PATTERN.exec(content);
		if (!match) {
			return;
		}
		const file = match[1]!.trim().replace(/^["']|["']$/g, '');
		const taskId = this._taskIdByToolUse.get(toolUseId) ?? toolUseId;
		this._startTail(taskId, file);
	}

	private _startTail(taskId: string, file: string): void {
		if (this._disposed || this._tails.has(taskId)) {
			return;
		}
		const state: TailState = { file, offset: 0, stopped: false };
		this._tails.set(taskId, state);
		const tick = async () => {
			if (state.stopped) {
				return;
			}
			await this._readTail(taskId, state);
			if (!state.stopped) {
				state.timer = setTimeout(() => void tick(), TAIL_INTERVAL_MS);
			}
		};
		state.timer = setTimeout(() => void tick(), 150);
	}

	private async _readTail(taskId: string, state: TailState): Promise<void> {
		let handle;
		try {
			handle = await open(state.file, 'r');
			const info = await handle.stat();
			if (info.size > state.offset) {
				const length = info.size - state.offset;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, state.offset);
				state.offset = info.size;
				this._emit({ type: 'task_output', taskId, file: state.file, chunk: buffer.toString('utf8') });
			}
		} catch {
			// The file may not exist yet; keep polling until the task ends.
		} finally {
			await handle?.close();
		}
	}

	/** Reads whatever is left, then stops polling. */
	private _drainTail(taskId: string): void {
		const state = this._tails.get(taskId);
		if (!state) {
			return;
		}
		setTimeout(() => {
			void this._readTail(taskId, state).finally(() => this._stopTail(taskId));
		}, TAIL_INTERVAL_MS);
	}

	private _stopTail(taskId: string): void {
		const state = this._tails.get(taskId);
		if (!state) {
			return;
		}
		state.stopped = true;
		if (state.timer) {
			clearTimeout(state.timer);
		}
		this._tails.delete(taskId);
	}
}

function toTaskUsage(usage: CliMessage['usage']): AgentTaskUsage | undefined {
	if (!usage) {
		return undefined;
	}
	return {
		totalTokens: usage.total_tokens,
		toolUses: usage.tool_uses,
		durationMs: usage.duration_ms,
	};
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const item of content) {
			if (typeof item === 'string') {
				parts.push(item);
			} else if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
				parts.push((item as { text: string }).text);
			} else {
				parts.push(JSON.stringify(item));
			}
		}
		return parts.join('\n');
	}
	return content === undefined ? '' : JSON.stringify(content);
}
