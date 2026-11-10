/**
 * Display names for projects, parent-qualified only where the name collides.
 *
 * A session store routinely holds several checkouts called `agent-ui`, and the
 * rail lists projects by basename alone: two identical rows, and picking the
 * wrong one opens somebody else's conversations. Prefixing every row with its
 * parent would spend the rail's width on a label nobody needs, so the parent is
 * added only for the names that repeat.
 */
import type { ProjectInfo } from './api';

/** `/home/me/codes/agent-ui` -> `codes` (empty for a project at the root). */
function parentOf(cwd: string): string | undefined {
	const segments = cwd.split(/[\\/]+/).filter(segment => segment !== '');
	return segments[segments.length - 2];
}

export function projectLabels(projects: readonly ProjectInfo[]): ReadonlyMap<string, string> {
	const byName = new Map<string, number>();
	for (const project of projects) {
		byName.set(project.name, (byName.get(project.name) ?? 0) + 1);
	}

	const labels = new Map<string, string>();
	for (const project of projects) {
		if ((byName.get(project.name) ?? 0) < 2) {
			labels.set(project.id, project.name);
			continue;
		}
		const parent = parentOf(project.cwd);
		// A project sitting at the filesystem root has no parent to show.
		labels.set(project.id, parent ? `${parent}/${project.name}` : project.cwd);
	}

	// Two `agent-ui` under parents that are themselves both called `codes` would
	// still read the same; the absolute path is the label that cannot collide.
	const byLabel = new Map<string, number>();
	for (const label of labels.values()) {
		byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
	}
	for (const project of projects) {
		if ((byLabel.get(labels.get(project.id) ?? '') ?? 0) > 1) {
			labels.set(project.id, project.cwd);
		}
	}
	return labels;
}
