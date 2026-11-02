/**
 * Builds only the render probe (`web/__render_probe.html`) into a throwaway
 * directory, so `e2e/render_check.py` can assert on a static bundle instead of
 * needing a dev server to stay alive.
 *
 *   npx vite build --config e2e/render_probe.vite.config.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: path.resolve(here, '../web'),
	base: './',
	plugins: [react()],
	build: {
		outDir: process.env['PROBE_OUT_DIR'] ?? path.resolve(here, '../.probe-dist'),
		emptyOutDir: true,
		target: 'es2022',
		rollupOptions: {
			input: path.resolve(here, '../web/__render_probe.html'),
		},
	},
});
