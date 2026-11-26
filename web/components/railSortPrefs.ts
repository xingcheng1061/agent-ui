/**
 * Sorting preferences for the three ordered lists in the session rail.
 *
 * Each list independently picks one of three orders. All default to
 * `updated` (most recent activity first), which preserves the current feel;
 * `created` uses the file/project/group creation time and `name` is a stable
 * alphabetical order. Stored per browser so a reload keeps the choices.
 */

export type SortMode = 'name' | 'created' | 'updated';

export interface RailSortPrefs {
	/** Order of the opened-project list. */
	readonly projects: SortMode;
	/** Order of the conversation-group blocks. */
	readonly groups: SortMode;
	/** Order of conversations inside a group/project block. */
	readonly sessions: SortMode;
}

const KEYS: Record<keyof RailSortPrefs, string> = {
	projects: 'agentui.sortProjects',
	groups: 'agentui.sortGroups',
	sessions: 'agentui.sortSessions',
};

export const SORT_MODES: readonly SortMode[] = ['name', 'created', 'updated'];

export function sortModeLabel(mode: SortMode): { readonly zh: string; readonly en: string } {
	return mode === 'name'
		? { zh: '名称', en: 'Name' }
		: mode === 'created'
			? { zh: '创建', en: 'Created' }
			: { zh: '更新', en: 'Updated' };
}

function read(key: keyof RailSortPrefs): SortMode {
	try {
		const value = localStorage.getItem(KEYS[key]);
		return SORT_MODES.includes(value as SortMode) ? value as SortMode : 'updated';
	} catch {
		return 'updated';
	}
}

export function readRailSortPrefs(): RailSortPrefs {
	return { projects: read('projects'), groups: read('groups'), sessions: read('sessions') };
}

export function writeRailSortPref(key: keyof RailSortPrefs, value: SortMode): void {
	try {
		localStorage.setItem(KEYS[key], value);
	} catch {
		// Private mode: the choice lasts for this page only.
	}
}
