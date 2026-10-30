/**
 * Signals that a session is blocked on the user.
 *
 * An approval can sit for minutes while the browser tab is in the background,
 * and nothing in the chat stream says so from there. This module adds the three
 * channels the browser offers outside the page: a short sound, a system
 * notification, and a marked tab title.
 *
 * Everything is best effort. Audio needs one user gesture before it may play,
 * notifications need permission granted from a gesture, and the title marker is
 * only an affordance — a denied permission must never break the chat.
 */

const STORAGE_KEY = 'agentui.attention';

const listeners = new Set<(enabled: boolean) => void>();

function initial(): boolean {
	try {
		// On by default: a missed approval stalls the whole turn.
		return localStorage.getItem(STORAGE_KEY) !== 'off';
	} catch {
		return true;
	}
}

let enabled = initial();
let audio: AudioContext | undefined;
/** What the title was before it was marked; `undefined` while unmarked. */
let baseTitle: string | undefined;
/** The approval that already beeped, so a replayed one stays quiet. */
let lastRequestId: string | undefined;
let current: Notification | undefined;

export function attentionEnabled(): boolean {
	return enabled;
}

/** Subscribe to the on/off switch; returns an unsubscribe function. */
export function onAttentionChange(listener: (enabled: boolean) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Flips the switch.
 *
 * Must be called from a user gesture when turning it on: that is the only
 * moment the browser lets us create an audio context and ask for notification
 * permission, and without those the reminder would be silent.
 */
export async function setAttentionEnabled(next: boolean): Promise<void> {
	enabled = next;
	try {
		localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
	} catch {
		// Storage blocked: the choice just is not remembered.
	}
	if (next) {
		unlockAudio();
	} else {
		clearAttention();
	}
	for (const listener of listeners) {
		listener(next);
	}
	if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
		await Notification.requestPermission().catch(() => undefined);
	}
}

/**
 * Creates or resumes the audio context. Called on the first gesture after load
 * so a reminder can play later, when there is no gesture to piggyback on.
 */
export function unlockAudio(): void {
	if (typeof AudioContext === 'undefined') {
		return;
	}
	audio ??= new AudioContext();
	if (audio.state === 'suspended') {
		void audio.resume();
	}
}

for (const type of ['pointerdown', 'keydown'] as const) {
	window.addEventListener(type, unlockAudio, { once: true, passive: true });
}

/**
 * Asks for the user's attention.
 *
 * Nothing happens while the tab is visible and focused — the approval card is
 * already in front of them, and a beep there is just noise.
 */
export function requestAttention(input: {
	readonly title: string;
	readonly body: string;
	/**
	 * Identifies the request. A reattach replays the same approval, and that must
	 * not beep again — the user already has the card in front of them.
	 */
	readonly requestId?: string;
}): void {
	if (!enabled) {
		return;
	}
	if (input.requestId !== undefined) {
		if (lastRequestId === input.requestId) {
			return;
		}
		lastRequestId = input.requestId;
	}
	markTitle(input.title);
	if (!document.hidden && document.hasFocus()) {
		return;
	}
	beep();
	push(input);
}

/** Drops the title marker and any notification still on screen. */
export function clearAttention(): void {
	if (baseTitle !== undefined) {
		document.title = baseTitle;
		baseTitle = undefined;
	}
	lastRequestId = undefined;
	current?.close();
	current = undefined;
}

function markTitle(label: string): void {
	baseTitle ??= document.title;
	const marked = `● ${label} · ${baseTitle}`;
	if (document.title !== marked) {
		document.title = marked;
	}
}

/** Two short tones: audible over a quiet room, short enough to ignore. */
function beep(): void {
	const context = audio;
	if (!context) {
		return;
	}
	if (context.state === 'suspended') {
		void context.resume();
	}
	const start = context.currentTime;
	for (const [index, frequency] of [880, 1320].entries()) {
		const at = start + index * 0.18;
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		oscillator.type = 'sine';
		oscillator.frequency.value = frequency;
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start(at);
		oscillator.stop(at + 0.16);
	}
}

function push(input: { readonly title: string; readonly body: string }): void {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
		return;
	}
	try {
		current?.close();
		// `silent` because the beep above already carried the sound.
		const next = new Notification(input.title, { body: input.body, tag: 'agentui-attention', silent: true });
		next.onclick = () => {
			window.focus();
			next.close();
			clearAttention();
		};
		current = next;
	} catch {
		// Some browsers only allow notifications from a service worker; the
		// title marker and the beep still did their job.
	}
}
