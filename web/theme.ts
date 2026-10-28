/**
 * Theme state. The dark palette is the CSS default; `light` overrides the same
 * custom properties, so every rule needs no per-theme branch.
 *
 * Components that cannot be themed through CSS (Monaco, xterm, shiki) subscribe
 * here and swap their own theme object.
 */

export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'agentui.theme';

const listeners = new Set<(theme: ThemeName) => void>();

function initial(): ThemeName {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'light' || stored === 'dark') {
			return stored;
		}
	} catch {
		// Storage blocked: fall through to the OS preference.
	}
	// First visit follows the OS; after that the explicit choice wins.
	return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

let theme: ThemeName = initial();

/** Applied immediately so the first paint is already in the right theme. */
document.documentElement.dataset.theme = theme;

export function getTheme(): ThemeName {
	return theme;
}

export function setTheme(next: ThemeName): void {
	if (next === theme) {
		return;
	}
	theme = next;
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// A rejected write only means the choice is not remembered.
	}
	for (const listener of listeners) {
		listener(next);
	}
}

export function toggleTheme(): ThemeName {
	const next: ThemeName = theme === 'dark' ? 'light' : 'dark';
	setTheme(next);
	return next;
}

/** Subscribe to theme changes; returns an unsubscribe function. */
export function onThemeChange(listener: (theme: ThemeName) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
