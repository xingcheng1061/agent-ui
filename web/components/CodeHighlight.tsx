import { useEffect, useState } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';
import { getTheme, onThemeChange, type ThemeName } from '../theme';

/** Languages we ship grammars for; anything else renders as plain text. */
export type CodeLanguage = 'bash' | 'json' | 'diff' | 'text';

/** Both palettes are loaded once; the active one is picked per render. */
const THEMES: Record<ThemeName, string> = {
	dark: 'github-dark',
	light: 'github-light',
};

let highlighter: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
	// Created once and shared: each call re-uses the same engine and grammars.
	highlighter ??= createHighlighter({
		themes: [THEMES.dark, THEMES.light],
		// Only what the bash card needs; loading every shiki language would add
		// several megabytes to the bundle.
		langs: ['bash', 'json', 'diff'],
	});
	return highlighter;
}

/** Best-effort language guess for arbitrary command output. */
export function guessLanguage(text: string): CodeLanguage {
	const trimmed = text.trimStart();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			JSON.parse(trimmed);
			return 'json';
		} catch {
			// Not JSON after all.
		}
	}
	if (/^(diff --git|@@\s|--- |\+\+\+ )/m.test(text)) {
		return 'diff';
	}
	return 'text';
}

/** Lines that are almost certainly diagnostics, highlighted in plain-text mode. */
const ERROR_LINE = /\b(error|failed|failure|fatal|not found|no such file|traceback|exception|cannot|unable to|denied|refused)\b/i;

/**
 * Syntax-highlighted code block. Falls back to a plain `<pre>` until shiki has
 * loaded (and permanently if the grammar is unavailable), so text is never lost.
 */
export function CodeHighlight({ code, language }: { readonly code: string; readonly language: CodeLanguage }) {
	const [html, setHtml] = useState<string | undefined>(undefined);
	const [theme, setTheme] = useState<ThemeName>(getTheme);

	useEffect(() => onThemeChange(setTheme), []);

	useEffect(() => {
		if (language === 'text') {
			setHtml(undefined);
			return;
		}
		let cancelled = false;
		void getHighlighter()
			.then(highlighter => {
				if (cancelled) {
					return;
				}
				// shiki escapes the code itself, so this markup is safe to inject.
				setHtml(highlighter.codeToHtml(code, { lang: language, theme: THEMES[theme] }));
			})
			.catch(() => {
				if (!cancelled) {
					setHtml(undefined);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [code, language, theme]);

	if (html) {
		return <div className="code-highlight" dangerouslySetInnerHTML={{ __html: html }} />;
	}
	if (language !== 'text') {
		// Still loading: keep the raw text visible rather than flashing empty.
		return <pre className="code-highlight plain"><code>{code}</code></pre>;
	}
	return (
		<pre className="code-highlight plain">
			<code>
				{code.split('\n').map((line, index) => (
					<span key={index} className={ERROR_LINE.test(line) ? 'line error' : 'line'}>
						{line}
						{'\n'}
					</span>
				))}
			</code>
		</pre>
	);
}
