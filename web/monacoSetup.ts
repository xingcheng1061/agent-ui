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
const COMPILER_OPTIONS: monaco.languages.typescript.CompilerOptions = {
	allowNonTsExtensions: true,
	target: monaco.languages.typescript.ScriptTarget.ESNext,
	module: monaco.languages.typescript.ModuleKind.ESNext,
	moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
	jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
	allowJs: true,
	// `.js` gets the same treatment as `.ts`; with `checkJs` off it had syntax
	// colouring and nothing else, so a typo in a plain script looked clean.
	checkJs: true,
	noEmit: true,
};

monaco.languages.typescript.typescriptDefaults.setCompilerOptions(COMPILER_OPTIONS);
monaco.languages.typescript.javascriptDefaults.setCompilerOptions(COMPILER_OPTIONS);

// Squiggles come from `components/tsDiagnostics`, which pulls the diagnostics
// for the buffer on screen. Leaving Monaco's own publisher on paints a second
// copy of every problem, so it is switched off here rather than filtered later.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
	noSemanticValidation: true,
	noSyntaxValidation: true,
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
	noSemanticValidation: true,
	noSyntaxValidation: true,
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
	// `.cc` is the common one in Bazel/CMake trees; without it the file opened
	// as plaintext, so the clangd providers never attached.
	cc: 'cpp',
	cxx: 'cpp',
	hh: 'cpp',
	hpp: 'cpp',
	hxx: 'cpp',
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

/**
 * Semantic-token colours, close to VS Code's Dark+/Light+ palettes: without
 * them a semantic token falls back to the default foreground, so clangd's
 * answers arrive but a function name looks like every other identifier.
 * Monaco matches semantic tokens by their type name.
 */
const DARK_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'namespace', foreground: '4EC9B0' },
	{ token: 'type', foreground: '4EC9B0' },
	{ token: 'class', foreground: '4EC9B0' },
	{ token: 'struct', foreground: '4EC9B0' },
	{ token: 'enum', foreground: '4EC9B0' },
	{ token: 'enumMember', foreground: '4FC1FF' },
	{ token: 'typeParameter', foreground: '4EC9B0' },
	{ token: 'interface', foreground: '4EC9B0' },
	{ token: 'function', foreground: 'DCDCAA' },
	{ token: 'method', foreground: 'DCDCAA' },
	{ token: 'macro', foreground: 'BD93F9' },
	{ token: 'variable', foreground: '9CDCFE' },
	{ token: 'parameter', foreground: '9CDCFE' },
	{ token: 'property', foreground: '9CDCFE' },
	{ token: 'keyword', foreground: '569CD6' },
	{ token: 'comment', foreground: '6A9955' },
	{ token: 'string', foreground: 'CE9178' },
	{ token: 'number', foreground: 'B5CEA8' },
	{ token: 'operator', foreground: 'D4D4D4' },
];

const LIGHT_RULES: monaco.editor.ITokenThemeRule[] = [
	{ token: 'namespace', foreground: '267F99' },
	{ token: 'type', foreground: '267F99' },
	{ token: 'class', foreground: '267F99' },
	{ token: 'struct', foreground: '267F99' },
	{ token: 'enum', foreground: '267F99' },
	{ token: 'enumMember', foreground: '0070C1' },
	{ token: 'typeParameter', foreground: '267F99' },
	{ token: 'interface', foreground: '267F99' },
	{ token: 'function', foreground: '795E26' },
	{ token: 'method', foreground: '795E26' },
	{ token: 'macro', foreground: '0000FF' },
	{ token: 'variable', foreground: '001080' },
	{ token: 'parameter', foreground: '001080' },
	{ token: 'property', foreground: '001080' },
	{ token: 'keyword', foreground: '0000FF' },
	{ token: 'comment', foreground: '008000' },
	{ token: 'string', foreground: 'A31515' },
	{ token: 'number', foreground: '098658' },
	{ token: 'operator', foreground: '000000' },
];

monaco.editor.defineTheme('agentui-dark', { base: 'vs-dark', inherit: true, rules: DARK_RULES, colors: {} });
monaco.editor.defineTheme('agentui-light', { base: 'vs', inherit: true, rules: LIGHT_RULES, colors: {} });

/** Monaco ships both palettes; `setTheme` repaints every live editor at once. */
export function applyMonacoTheme(theme: 'dark' | 'light'): void {
	monaco.editor.setTheme(theme === 'light' ? 'agentui-light' : 'agentui-dark');
}

applyMonacoTheme(getTheme());
onThemeChange(applyMonacoTheme);

export { monaco };
