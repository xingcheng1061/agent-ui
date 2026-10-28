import { useEffect, useRef, useState } from 'react';

interface SplitterProps {
	/** `x` drags horizontally (column split), `y` drags vertically (row split). */
	readonly axis: 'x' | 'y';
	/** Called with the pointer movement since the last event, in pixels. */
	readonly onResize: (delta: number) => void;
}

/**
 * Thin drag handle placed between two panes. The caller owns the size, so the
 * same component works for the sidebar, the chat/code split, the file tree and
 * the terminal height.
 */
export function Splitter({ axis, onResize }: SplitterProps) {
	const lastRef = useRef(0);
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		if (!dragging) {
			return;
		}
		const cursor = axis === 'x' ? 'col-resize' : 'row-resize';
		const previousCursor = document.body.style.cursor;
		const previousSelect = document.body.style.userSelect;
		document.body.style.cursor = cursor;
		document.body.style.userSelect = 'none';
		return () => {
			document.body.style.cursor = previousCursor;
			document.body.style.userSelect = previousSelect;
		};
	}, [dragging, axis]);

	return (
		<div
			className={`splitter ${axis}${dragging ? ' dragging' : ''}`}
			role="separator"
			aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
			onPointerDown={event => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				lastRef.current = axis === 'x' ? event.clientX : event.clientY;
				setDragging(true);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
					return;
				}
				const current = axis === 'x' ? event.clientX : event.clientY;
				const delta = current - lastRef.current;
				if (delta === 0) {
					return;
				}
				lastRef.current = current;
				onResize(delta);
			}}
			onPointerUp={event => {
				event.currentTarget.releasePointerCapture(event.pointerId);
				setDragging(false);
			}}
			onPointerCancel={() => setDragging(false)}
		/>
	);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Pane width/height that survives a reload. */
export function usePersistedSize(key: string, fallback: number): readonly [number, (next: number) => void] {
	const [value, setValue] = useState(() => {
		try {
			const raw = window.localStorage.getItem(key);
			const parsed = raw === null ? Number.NaN : Number(raw);
			return Number.isFinite(parsed) ? parsed : fallback;
		} catch {
			return fallback;
		}
	});

	const update = (next: number) => {
		setValue(next);
		try {
			window.localStorage.setItem(key, String(next));
		} catch {
			// Private mode / quota: the size just will not persist.
		}
	};

	return [value, update] as const;
}
