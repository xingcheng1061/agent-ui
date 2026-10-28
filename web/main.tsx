import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { reportClientLog } from './api';
import { App } from './App';
import './monacoSetup';
import './styles.css';
// Applies `data-theme` before the first paint, so there is no flash of the
// wrong palette. Must run before the styles are used.
import './theme';

/**
 * A render error used to take the whole app with it: React unmounts the tree and
 * all that is left of the page is its CSS borders. Show the error and report it
 * instead, so a blank window can be diagnosed without the devtools console.
 */
class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error?: Error }> {
	state: { readonly error?: Error } = {};

	static getDerivedStateFromError(error: Error): { readonly error: Error } {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		reportClientLog({
			event: 'render-error',
			message: error.message,
			stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 1200),
		});
	}

	render(): ReactNode {
		const error = this.state.error;
		if (error) {
			return (
				<pre style={{ padding: 16, color: '#ff6b6b', whiteSpace: 'pre-wrap', font: '12px/1.5 monospace' }}>
					{`渲染出错：${error.message}\n\n${error.stack ?? ''}`}
				</pre>
			);
		}
		return this.props.children;
	}
}

// Failures that happen outside React's render path (a rejected promise in an
// effect, an event handler) still need to reach the server log.
window.addEventListener('error', event => {
	reportClientLog({
		event: 'window-error',
		message: String(event.message),
		stack: String((event.error as Error | undefined)?.stack ?? '').slice(0, 1200),
	});
});
window.addEventListener('unhandledrejection', event => {
	reportClientLog({ event: 'unhandled-rejection', message: String(event.reason) });
});

const container = document.getElementById('root');
if (!container) {
	throw new Error('Missing #root element.');
}

createRoot(container).render(
	<ErrorBoundary>
		<App />
	</ErrorBoundary>,
);
