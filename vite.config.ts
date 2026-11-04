import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_ORIGIN = process.env.AGENT_UI_ORIGIN ?? 'http://127.0.0.1:4711';

/**
 * A websocket proxy dies with the whole dev server when the browser drops the
 * connection mid-handshake: http-proxy emits `error` on the proxy server and,
 * with no listener, Node turns it into an uncaught exception (ECONNRESET on
 * read). Swallow it — the client is gone, and nothing else can be done.
 */
function silenceProxyErrors(options: ProxyOptions): ProxyOptions {
	return {
		...options,
		configure: proxy => {
			proxy.on('error', () => undefined);
		},
	};
}

export default defineConfig({
	root: 'web',
	plugins: [react(), tailwindcss()],
	server: {
		// 127.0.0.1 rather than 'localhost': the latter binds ::1 only on this
		// machine, so http://127.0.0.1:4712 looked like a dead port.
		host: '127.0.0.1',
		port: 4712,
		strictPort: true,
		proxy: {
			// Anchored on purpose. A bare '/api' prefix also matches the frontend
			// module '/api.ts', so Vite proxied it to the server, which answered
			// 404 — the app then failed to mount and the dev page went blank.
			'^/api/': { target: SERVER_ORIGIN, changeOrigin: true },
			'^/pty(\\?|/|$)': silenceProxyErrors({ target: SERVER_ORIGIN.replace(/^http/, 'ws'), ws: true }),
			'^/agent(\\?|/|$)': silenceProxyErrors({ target: SERVER_ORIGIN.replace(/^http/, 'ws'), ws: true }),
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
