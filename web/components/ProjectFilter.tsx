/**
 * Searchable project filter for the session rail.
 *
 * A native `<select>` cannot be typed into, and the rail routinely holds a few
 * dozen projects: scrolling a dropdown to find one is the slowest way to pick
 * it. This keeps the same single-line footprint until it is opened, then offers
 * a search box and a keyboard-drivable list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectInfo } from '../api';
import { t, useLang } from '../i18n';

/** "No project filter": every session is listed. */
export const ALL = 'all';

interface ProjectFilterProps {
	readonly projects: readonly ProjectInfo[];
	/** Display names, parent-qualified where the basename collides. */
	readonly labels: ReadonlyMap<string, string>;
	readonly value: string;
	readonly onChange: (value: string) => void;
	/** Only used for the tooltip; the trigger counts projects. */
	readonly sessionTotal: number;
}

interface Option {
	readonly id: string;
	readonly label: string;
	readonly count: number;
	/** Matched but never rendered: finding `codes/agent-ui` by its path. */
	readonly search: string;
}

export function ProjectFilter({ projects, labels, value, onChange, sessionTotal }: ProjectFilterProps) {
	const lang = useLang();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const options = useMemo<readonly Option[]>(() => {
		const candidates: Option[] = projects.map(project => ({
			id: project.id,
			label: labels.get(project.id) ?? project.name,
			count: project.sessionCount,
			search: `${labels.get(project.id) ?? project.name} ${project.cwd}`.toLowerCase(),
		}));
		const needle = query.trim().toLowerCase();
		const matched = needle === ''
			? candidates
			: candidates.filter(option => option.search.includes(needle));
		// "All projects" stays at the top: clearing a filter is a search too.
		return [{ id: ALL, label: t('全部项目'), count: projects.length, search: 'all' }, ...matched];
		// `lang` is a dependency because the labels are translated here.
	}, [projects, labels, query, lang]);

	const selected = value === ALL ? undefined : projects.find(project => project.id === value);
	const triggerText = selected
		? `${labels.get(selected.id) ?? selected.name}（${selected.sessionCount}）`
		: t('全部项目（{count}）', { count: projects.length });

	// A project can disappear between refreshes (its store dir was removed); the
	// filter must not stay pinned to something the list no longer holds.
	useEffect(() => {
		if (value !== ALL && !projects.some(project => project.id === value)) {
			onChange(ALL);
		}
	}, [projects, value, onChange]);

	// Focus moves on the next tick: `autoFocus` on a popover added in the same
	// commit loses the focus to the browser's own focus pass.
	useEffect(() => {
		if (!open) {
			return;
		}
		const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(timer);
	}, [open]);

	// Clicking anywhere else closes it; `mousedown` fires before a click could
	// land on a row behind the popover.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onMouseDown = (event: MouseEvent) => {
			if (rootRef.current?.contains(event.target as Node)) {
				return;
			}
			// No focus juggling here: the click belongs to whatever was clicked.
			setOpen(false);
			setQuery('');
		};
		document.addEventListener('mousedown', onMouseDown, true);
		return () => document.removeEventListener('mousedown', onMouseDown, true);
	}, [open]);

	/** Keyboard navigation has to keep the highlighted row on screen. */
	useEffect(() => {
		const node = listRef.current?.children[active];
		if (node instanceof HTMLElement) {
			node.scrollIntoView({ block: 'nearest' });
		}
	}, [active, open]);

	const close = () => {
		setOpen(false);
		setQuery('');
		// The popover is unmounting under the caret; without this the focus falls
		// back to the body and the rail's next Tab starts from the top.
		triggerRef.current?.focus();
	};

	const choose = (id: string) => {
		onChange(id);
		close();
	};

	const move = (delta: number) => {
		setActive(index => Math.min(Math.max(index + delta, 0), options.length - 1));
	};

	return (
		<div className="project-filter" ref={rootRef}>
			<button
				type="button"
				ref={triggerRef}
				className={`project-filter-trigger${open ? ' open' : ''}`}
				onClick={() => {
					setQuery('');
					// Index into the *unfiltered* order: the query is being cleared
					// in this same commit, so the rows will be the full list.
					setActive(value === ALL ? 0 : Math.max(projects.findIndex(project => project.id === value) + 1, 0));
					setOpen(current => !current);
				}}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={t('按项目筛选')}
				title={t('{projects} 个项目，共 {sessions} 条会话', { projects: projects.length, sessions: sessionTotal })}
			>
				<span className="project-filter-text">{triggerText}</span>
				<span className="project-filter-caret">▾</span>
			</button>

			{open && (
				<div className="project-filter-pop">
					<input
						ref={inputRef}
						className="project-filter-input"
						value={query}
						placeholder={t('搜索项目（名称或路径）')}
						spellCheck={false}
						onChange={event => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={event => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								move(1);
								return;
							}
							if (event.key === 'ArrowUp') {
								event.preventDefault();
								move(-1);
								return;
							}
							if (event.key === 'Enter') {
								event.preventDefault();
								const option = options[active];
								if (option) {
									choose(option.id);
								}
								return;
							}
							if (event.key === 'Escape') {
								event.preventDefault();
								close();
							}
						}}
					/>
					<div className="project-filter-list" role="listbox" aria-label={t('项目')} ref={listRef}>
						{options.length === 1 && query.trim() !== '' && (
							<div className="project-filter-empty">{t('没有匹配「{query}」的项目', { query: query.trim() })}</div>
						)}
						{options.map((option, index) => (
							<button
								type="button"
								key={option.id}
								role="option"
								aria-selected={option.id === value}
								className={`project-filter-option${index === active ? ' active' : ''}`}
								// `mousedown` fires before focus would move out of the input.
								onMouseDown={event => {
									event.preventDefault();
									choose(option.id);
								}}
								onMouseEnter={() => setActive(index)}
							>
								<span className={`project-filter-label${option.id === value ? ' selected' : ''}`}>
									{option.label}
								</span>
								<span className="project-filter-count">{option.count}</span>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
