import { math } from '@streamdown/math';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown, type Components, type DiagramPlugin, type MermaidErrorComponentProps } from 'streamdown';
import 'katex/dist/katex.min.css';
import 'streamdown/styles.css';
import { getTheme, onThemeChange, type ThemeName } from '../theme';

interface MarkdownProps {
	readonly text: string;
	/** While deltas are still arriving, let streamdown repair unfinished syntax. */
	readonly streaming?: boolean;
	/** Render ` ```mermaid ` fences as diagrams. Loads mermaid on demand. */
	readonly mermaid?: boolean;
	/** Off for document previews, where streamdown's per-block chrome is noise. */
	readonly controls?: boolean;
	/**
	 * Require Ctrl/Cmd + wheel to zoom a diagram; a plain wheel scrolls the
	 * surrounding pane. On in chat messages, where a diagram sits inline and
	 * would otherwise swallow every scroll. Full-screen diagrams keep both.
	 */
	readonly diagramZoomRequiresCtrl?: boolean;
}

/**
 * mermaid paints its own palette into the SVG instead of inheriting CSS,
 * so the app theme has to be handed over explicitly.
 */
function mermaidConfig(theme: ThemeName) {
	return {
		startOnLoad: false,
		theme: theme === 'light' ? 'default' : 'dark',
		securityLevel: 'strict',
		fontFamily: 'ui-sans-serif, system-ui, sans-serif',
	} as const;
}

/**
 * Markdown renderer for agent output.
 *
 * Wraps `streamdown` (Apache-2.0, https://github.com/vercel/streamdown) — a renderer
 * built for streaming LLM responses. Unlike plain react-markdown it repairs
 * unterminated constructs on every render, so a half-received ` ```ts ` fence or
 * `**bold` does not flash as raw text before closing.
 *
 * Math goes through `@streamdown/math` (KaTeX). Only `$$…$$` is treated as math,
 * block or inline; `$…$` stays off on purpose — agent output is full of shell
 * snippets like `$HOME` and prices such as `$5`, which would otherwise be
 * swallowed as formulas. LaTeX's `\(…\)` / `\[…\]` are not delimiters here and
 * come out as literal text.
 *
 * streamdown's `styles.css` only ships animations: the utilities it emits are
 * compiled by `web/tailwind.css` (mapped onto this app's theme tokens), and the
 * typography comes from the `.md` rules in `styles.css`, which outrank them.
 */
export function Markdown({ text, streaming = false, mermaid = false, controls, diagramZoomRequiresCtrl = false }: MarkdownProps) {
	const [diagram, setDiagram] = useState<DiagramPlugin | undefined>(undefined);
	const [theme, setTheme] = useState(getTheme);
	const hostRef = useRef<HTMLDivElement | null>(null);

	// streamdown's zoom container listens for `wheel` and zooms unconditionally,
	// so an inline diagram eats every scroll in the chat. In capture phase we can
	// stop that event before it reaches the container when Ctrl/Cmd is not held;
	// the browser then scrolls the chat as usual. With Ctrl/Cmd we let it through
	// so streamdown zooms. Full-screen diagrams don't set this flag.
	useEffect(() => {
		if (!diagramZoomRequiresCtrl) {
			return;
		}
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey) {
				return;
			}
			const target = event.target;
			if (target instanceof Node && (target instanceof Element ? target : target.parentElement)?.closest?.('[data-streamdown="mermaid"]')) {
				event.stopPropagation();
			}
		};
		host.addEventListener('wheel', onWheel, { capture: true });
		return () => host.removeEventListener('wheel', onWheel, { capture: true });
	}, [diagramZoomRequiresCtrl, diagram]);

	useEffect(() => {
		if (!mermaid) {
			return;
		}
		return onThemeChange(setTheme);
	}, [mermaid]);

	// mermaid is a megabyte of parser. Only the `.md` preview asks for it, and
	// only once such a file is open; until the chunk lands, fences stay code
	// blocks, which is also the fallback when loading fails.
	useEffect(() => {
		if (!mermaid) {
			return;
		}
		let cancelled = false;
		void import('@streamdown/mermaid')
			.then(({ createMermaidPlugin }) => {
				if (!cancelled) {
					// A new instance on theme change makes streamdown re-render
					// every diagram with the other palette.
					setDiagram(() => createMermaidPlugin({ config: mermaidConfig(theme) }));
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [mermaid, theme]);

	const plugins = useMemo(() => (diagram ? { math, mermaid: diagram } : { math }), [diagram]);
	const diagramOptions = useMemo(() => ({ errorComponent: MermaidFallback }), []);

	return (
		<div className="md" ref={hostRef}>
			<Streamdown
				mode={streaming ? 'streaming' : 'static'}
				parseIncompleteMarkdown
				className="md-body"
				components={markdownComponents}
				plugins={plugins}
				controls={controls}
				mermaid={diagram ? diagramOptions : undefined}
			>
				{text}
			</Streamdown>
		</div>
	);
}

/** Agent output constantly links to docs; never navigate the app away. */
const markdownComponents: Components = {
	// `node` is a hast node injected by the renderer; spreading it onto the
	// DOM element would emit a React warning.
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

/** A broken diagram must not blank the preview: show why, plus the source. */
function MermaidFallback({ chart, error }: MermaidErrorComponentProps) {
	return (
		<div className="mermaid-error">
			<p className="mermaid-error-note">{error}</p>
			<pre><code>{chart}</code></pre>
		</div>
	);
}
