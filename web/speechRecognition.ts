/**
 * Dictation via the browser's Speech Recognition API.
 *
 * Chrome exposes it as `webkitSpeechRecognition` and the DOM typings do not
 * declare it, so the interface lives here. Recognition runs in the browser (or
 * the browser vendor's service); nothing is sent to this app's server.
 *
 * Only final results are handed to the caller — interim results are unstable
 * and writing them into a draft makes the text jump on every partial guess.
 */

interface SpeechRecognitionAlternativeLike {
	readonly transcript: string;
	readonly confidence: number;
}

interface SpeechRecognitionResultLike {
	readonly isFinal: boolean;
	readonly length: number;
	[index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
	readonly length: number;
	[index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
	readonly error: string;
	readonly message?: string;
}

interface SpeechRecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | undefined {
	const scope = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Whether this browser can dictate at all. */
export function speechSupported(): boolean {
	return recognitionCtor() !== undefined;
}

export type SpeechFailure =
	| { readonly kind: 'unsupported' }
	| { readonly kind: 'denied' }
	| { readonly kind: 'no-speech' }
	| { readonly kind: 'network' }
	| { readonly kind: 'other'; readonly detail: string };

export interface DictationHandlers {
	/** A completed utterance; safe to insert into the draft. */
	readonly onFinal: (text: string) => void;
	/** Listening ended for any reason (user stop, silence, error). */
	readonly onEnd: () => void;
	readonly onError: (failure: SpeechFailure) => void;
}

/**
 * Starts continuous zh-CN dictation. The returned handle stops it; calling
 * `stop` after the engine already ended is a no-op.
 */
export function startDictation(handlers: DictationHandlers): () => void {
	const Ctor = recognitionCtor();
	if (!Ctor) {
		handlers.onError({ kind: 'unsupported' });
		handlers.onEnd();
		return () => undefined;
	}

	const recognition = new Ctor();
	recognition.lang = 'zh-CN';
	recognition.continuous = true;
	recognition.interimResults = true;
	recognition.maxAlternatives = 1;

	// Results accumulate across events; dedupe by index so repeated words are
	// still inserted, but the same utterance is not handled twice.
	const handled = new Set<number>();
	let started = true;

	recognition.onresult = event => {
		for (let index = event.resultIndex; index < event.results.length; index += 1) {
			if (handled.has(index)) {
				continue;
			}
			const result = event.results[index];
			if (!result?.isFinal) {
				continue;
			}
			handled.add(index);
			const text = result[0]?.transcript?.trim();
			if (text) {
				handlers.onFinal(text);
			}
		}
	};

	recognition.onerror = event => {
		switch (event.error) {
			case 'not-allowed':
			case 'service-not-allowed':
				handlers.onError({ kind: 'denied' });
				break;
			case 'no-speech':
				handlers.onError({ kind: 'no-speech' });
				break;
			case 'network':
				handlers.onError({ kind: 'network' });
				break;
			default:
				handlers.onError({ kind: 'other', detail: event.error || event.message || 'unknown' });
		}
	};

	recognition.onend = () => {
		started = false;
		handlers.onEnd();
	};

	try {
		recognition.start();
	} catch {
		handlers.onError({ kind: 'denied' });
		handlers.onEnd();
		started = false;
	}

	return () => {
		if (started) {
			try {
				recognition.stop();
			} catch {
				// Already stopped by the engine; nothing to clean up.
			}
			started = false;
		}
	};
}
