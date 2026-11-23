import { useEffect, useRef, useState } from 'react';
import { searchSessions, type SessionMatch } from '../api';
import { t } from '../i18n';

interface ChatFindProps {
	readonly sessionId: string | undefined;
	/** Fired with a hit so the panel can scroll to and highlight the message. */
	readonly onJump: (match: SessionMatch) => void;
}

/**
 * Find box for the conversation on screen, opened with Ctrl+F while the chat
 * has focus. Searches this session's jsonl on the server (so older, unloaded
 * pages are included) and lets the user step through the hits.
 */
export function ChatFind({ sessionId, onJump }: ChatFindProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [matches, setMatches] = useState<readonly SessionMatch[]>([]);
	const [index, setIndex] = useState(0);
	const [searching, setSearching] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		const onFind = () => {
			setOpen(true);
			window.setTimeout(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			}, 0);
		};
		window.addEventListener('agentui:find-chat', onFind);
		return () => window.removeEventListener('agentui:find-chat', onFind);
	}, []);

	// Close when the conversation changes; a search bound to the old session is
	// meaningless in the new one.
	useEffect(() => {
		setOpen(false);
		setMatches([]);
		setQuery('');
		setIndex(0);
	}, [sessionId]);

	useEffect(() => {
		const term = query.trim();
		if (!open || term === '' || sessionId === undefined) {
			setMatches([]);
			setIndex(0);
			return;
		}
		let cancelled = false;
		setSearching(true);
		const timer = window.setTimeout(() => {
			void searchSessions(term, false, sessionId)
				.then(hits => {
					if (!cancelled) {
						setMatches(hits);
						setIndex(0);
					}
				})
				.catch(() => { if (!cancelled) setMatches([]); })
				.finally(() => { if (!cancelled) setSearching(false); });
		}, 200);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [open, query, sessionId]);

	const jumpTo = (next: number) => {
		if (matches.length === 0) {
			return;
		}
		const wrapped = (next + matches.length) % matches.length;
		setIndex(wrapped);
		onJump(matches[wrapped]!);
	};

	if (!open) {
		return null;
	}

	return (
		<div className="chat-find">
			<input
				ref={inputRef}
				value={query}
				placeholder={t('在当前会话中查找…')}
				aria-label={t('在当前会话中查找')}
				onChange={event => setQuery(event.target.value)}
				onKeyDown={event => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						jumpTo(event.shiftKey ? index - 1 : index + 1);
					} else if (event.key === 'Escape') {
						event.preventDefault();
						setOpen(false);
					}
				}}
			/>
			<span className="chat-find-count">
				{searching ? '…' : query.trim() === '' ? '' : matches.length === 0 ? t('无结果') : `${index + 1}/${matches.length}`}
			</span>
			<button type="button" title={t('上一个（Shift+Enter）')} onClick={() => jumpTo(index - 1)} disabled={matches.length === 0}>↑</button>
			<button type="button" title={t('下一个（Enter）')} onClick={() => jumpTo(index + 1)} disabled={matches.length === 0}>↓</button>
			<button type="button" title={t('关闭（Esc）')} onClick={() => setOpen(false)}>×</button>
		</div>
	);
}
