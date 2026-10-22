// Review units: files grouped by the skills they need, small groups merged into supersets, and every unit
// sized to fit the worker model's context budget.
import type { FileDiff, RouteDecision, RoutedUnit } from "./types.ts";

export interface UnitOptions {
	maxSkillsPerUnit: number;
	/** Tokens the whole worker prompt may use (context window × fraction). */
	promptBudget: number;
	/** Tokens of everything but skills and hunks (pi base prompt, role, AGENTS.md, DESIGN.md, brief). */
	fixedTokens: number;
	skillTokens: (skill: string) => number;
	/** Skills that always come first (never dropped to advertised). */
	alwaysOn: string[];
	/** Hunk budget below which lower-scored skills are dropped to "advertised". */
	minHunkBudget?: number;
}

interface Group {
	skills: Map<string, number>;
	candidates: Set<string>;
	files: FileDiff[];
}

function fileTokens(f: FileDiff): number {
	return f.hunks.reduce((s, h) => s + h.tokens, 0) + (f.summary ? Math.ceil(f.summary.length / 4) : 0) + 20;
}

function key(skills: Iterable<string>): string {
	return [...skills].sort().join(",");
}

function isSubset(a: Map<string, number>, b: Map<string, number>): boolean {
	for (const k of a.keys()) if (!b.has(k)) return false;
	return true;
}

export function buildUnits(files: FileDiff[], decisions: RouteDecision[], opts: UnitOptions): RoutedUnit[] {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const groups = new Map<string, Group>();
	for (const d of decisions) {
		const file = byPath.get(d.file);
		if (!file) continue;
		const skills = new Map(d.selected.map((s) => [s.skill, s.score]));
		const k = key(skills.keys());
		const g: Group = groups.get(k) ?? { skills: new Map(), candidates: new Set(), files: [] };
		for (const [s, score] of skills) g.skills.set(s, Math.max(g.skills.get(s) ?? 0, score));
		for (const c of d.candidates) g.candidates.add(c);
		g.files.push(file);
		groups.set(k, g);
	}

	// merge each group into a superset group when the files still fit together
	const list = [...groups.values()].sort((a, b) => a.skills.size - b.skills.size);
	const merged: Group[] = [];
	for (const g of list) {
		const host = merged
			.filter((h) => h !== g && isSubset(g.skills, h.skills))
			.sort((a, b) => a.skills.size - b.skills.size)[0];
		const budget = opts.promptBudget - opts.fixedTokens - skillCost(host?.skills ?? g.skills, opts);
		if (host && sumTokens(host.files) + sumTokens(g.files) <= budget) {
			host.files.push(...g.files);
			for (const c of g.candidates) host.candidates.add(c);
		} else {
			merged.push(g);
		}
	}
	// supersets come later in `list`, so merge again in the other direction (small into later large)
	const final: Group[] = [];
	for (const g of merged.sort((a, b) => b.skills.size - a.skills.size)) {
		const host = final.find((h) => isSubset(g.skills, h.skills));
		const budget = opts.promptBudget - opts.fixedTokens - skillCost(host?.skills ?? g.skills, opts);
		if (host && sumTokens(host.files) + sumTokens(g.files) <= budget) {
			host.files.push(...g.files);
			for (const c of g.candidates) host.candidates.add(c);
		} else final.push(g);
	}

	const units: RoutedUnit[] = [];
	for (const g of final) {
		const ordered = [...g.skills.entries()]
			.sort((a, b) => Number(opts.alwaysOn.includes(b[0])) - Number(opts.alwaysOn.includes(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([s]) => s);
		let skills = ordered.slice(0, opts.maxSkillsPerUnit);
		const advertised = new Set([...ordered.slice(opts.maxSkillsPerUnit), ...g.candidates]);
		const minHunks = opts.minHunkBudget ?? 4000;
		while (skills.length > 1 && opts.promptBudget - opts.fixedTokens - skillCost(new Map(skills.map((s) => [s, 0])), opts) < minHunks) {
			const dropped = skills.pop() as string;
			if (opts.alwaysOn.includes(dropped)) {
				skills.push(dropped);
				break;
			}
			advertised.add(dropped);
		}
		for (const s of skills) advertised.delete(s);
		const skillTokens = skills.reduce((s, k) => s + opts.skillTokens(k), 0);
		const hunkBudget = Math.max(minHunks, opts.promptBudget - opts.fixedTokens - skillTokens);
		// split into units that fit the hunk budget: whole files first, hunks of one large file if needed
		let current: { files: string[]; hunkIds: string[]; tokens: number } = { files: [], hunkIds: [], tokens: 0 };
		const flush = () => {
			if (current.hunkIds.length === 0 && current.files.length === 0) return;
			units.push({
				id: `u${units.length + 1}`,
				files: [...new Set(current.files)],
				hunkIds: current.hunkIds,
				skills: [...skills],
				advertised: [...advertised].sort(),
				tokens: { fixed: opts.fixedTokens + skillTokens, hunks: current.tokens, budget: hunkBudget },
			});
			current = { files: [], hunkIds: [], tokens: 0 };
		};
		for (const f of g.files.sort((a, b) => a.path.localeCompare(b.path))) {
			const ft = fileTokens(f);
			if (ft <= hunkBudget) {
				if (current.tokens + ft > hunkBudget) flush();
				current.files.push(f.path);
				current.hunkIds.push(...f.hunks.map((h) => h.id));
				current.tokens += ft;
				continue;
			}
			for (const h of f.hunks) {
				if (current.tokens + h.tokens > hunkBudget && current.hunkIds.length > 0) flush();
				current.files.push(f.path);
				current.hunkIds.push(h.id);
				current.tokens += h.tokens;
			}
		}
		flush();
	}
	return units;
}

function sumTokens(files: FileDiff[]): number {
	return files.reduce((s, f) => s + fileTokens(f), 0);
}

function skillCost(skills: Map<string, number>, opts: UnitOptions): number {
	let n = 0;
	for (const s of [...skills.keys()].slice(0, opts.maxSkillsPerUnit)) n += opts.skillTokens(s);
	return n;
}
