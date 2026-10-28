import { math } from '@streamdown/math';
import { Streamdown, type Components } from 'streamdown';
import 'katex/dist/katex.min.css';
import 'streamdown/styles.css';

interface MarkdownProps {
	readonly text: string;
	/** While deltas are still arriving, let streamdown repair unfinished syntax. */
	readonly streaming?: boolean;
}

/**
 * Markdown renderer for agent output.
 *
 * Wraps `streamdown` (MIT, https://github.com/vercel/streamdown) — a renderer
 * built for streaming LLM responses. Unlike plain react-markdown it repairs
 * unterminated constructs on every render, so a half-received ` ```ts ` fence or
 * `**bold` does not flash as raw text before closing.
 *
 * Math goes through `@streamdown/math` (KaTeX). Only `$$…$$` / `\[…\]` are
 * treated as math; single `$…$` stays off on purpose — agent output is full of
 * shell snippets like `$HOME` and prices such as `$5`, which would otherwise be
 * swallowed as formulas.
 *
 * streamdown's `styles.css` only ships animations, so all typography comes from
 * the `.md` rules in `styles.css` to match the app theme.
 */
export function Markdown({ text, streaming = false }: MarkdownProps) {
	return (
		<div className="md">
			<Streamdown
				mode={streaming ? 'streaming' : 'static'}
				parseIncompleteMarkdown
				className="md-body"
				components={markdownComponents}
				plugins={{ math }}
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
