import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_ORIGIN = process.env.AGENT_UI_ORIGIN ?? 'http://127.0.0.1:4711';

export default defineConfig({
	root: 'web',
	plugins: [react()],
	server: {
		port: 4712,
		strictPort: true,
		proxy: {
			'/api': { target: SERVER_ORIGIN, changeOrigin: true },
			'/pty': { target: SERVER_ORIGIN.replace(/^http/, 'ws'), ws: true },
			'/agent': { target: SERVER_ORIGIN.replace(/^http/, 'ws'), ws: true },
		},
	},
	worker: { format: 'es' },
	build: {
		outDir: '../dist/web',
		emptyOutDir: true,
		target: 'es2022',
		// One 4.7 MB bundle made rollup/esbuild peak high enough to die with
		// "Fatal process out of memory: Zone" on this machine, and it also meant
		// every page load parsed Monaco before the chat could render. Splitting by
		// vendor keeps each minify step small and lets the browser fetch these in
		// parallel; the app chunk itself stays tiny.
		rollupOptions: {
			output: {
				manualChunks(id: string) {
					if (!id.includes('node_modules')) {
						return undefined;
					}
					if (id.includes('monaco-editor')) {
						return 'monaco';
					}
					// Shiki is left alone on purpose: it already code-splits one chunk
					// per language, and forcing it into a single vendor chunk produced
					// a 10 MB file.
					if (id.includes('streamdown') || id.includes('katex')) {
						return 'markdown';
					}
					if (id.includes('/react') || id.includes('react-dom') || id.includes('scheduler')) {
						return 'react';
					}
					return undefined;
				},
			},
		},
	},
});
