import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { getTheme, onThemeChange } from './theme';

const environment: monaco.Environment = {
	getWorker(_workerId: string, label: string): Worker {
		if (label === 'json') {
			return new jsonWorker();
		}
		if (label === 'css' || label === 'scss' || label === 'less') {
			return new cssWorker();
		}
		if (label === 'html' || label === 'handlebars' || label === 'razor') {
			return new htmlWorker();
		}
		if (label === 'typescript' || label === 'javascript') {
			return new tsWorker();
		}
		return new editorWorker();
	},
};

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = environment;

// Cross-file "go to definition" inside the TypeScript worker: models created for
// project files resolve their imports against each other without a language server.
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
	allowNonTsExtensions: true,
	target: monaco.languages.typescript.ScriptTarget.ESNext,
	module: monaco.languages.typescript.ModuleKind.ESNext,
	moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
	jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
	allowJs: true,
	checkJs: false,
	noEmit: true,
});

const EXTENSION_LANGUAGES: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	md: 'markdown',
	css: 'css',
	scss: 'scss',
	less: 'less',
	html: 'html',
	py: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	hpp: 'cpp',
	cs: 'csharp',
	sh: 'shell',
	bash: 'shell',
	ps1: 'powershell',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	sql: 'sql',
	xml: 'xml',
	svg: 'xml',
};

export function languageForPath(filePath: string): string {
	const dot = filePath.lastIndexOf('.');
	if (dot < 0) {
		return 'plaintext';
	}
	return EXTENSION_LANGUAGES[filePath.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}

/** `file:///E:/repo/src/a.ts` — stable identity for a model, and LSP-ready. */
export function modelUri(root: string, relativePath: string): monaco.Uri {
	const absolute = `${root.replace(/[\\/]+$/, '')}/${relativePath}`.replace(/\\/g, '/');
	return monaco.Uri.parse(`file:///${absolute.replace(/^\/+/, '')}`);
}

/** Monaco ships both palettes; `setTheme` repaints every live editor at once. */
export function applyMonacoTheme(theme: 'dark' | 'light'): void {
	monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
}

applyMonacoTheme(getTheme());
onThemeChange(applyMonacoTheme);

export { monaco };
