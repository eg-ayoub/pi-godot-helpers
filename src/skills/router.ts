// Which skills each changed file needs. Tier 1 is the rule table; tier 2 (classifier.ts) refines the
// candidates with a local decision model. The main agent never routes; workers only see the result.
import type { FileDiff, RouteDecision } from "../review/types.ts";
import type { SkillCatalog } from "./catalog.ts";
import { DEFAULT_CANDIDATES, RULES, scoreRules, type Rule, type RoutingInput } from "./rules.ts";

export interface RouterOptions {
	alwaysOn: string[];
	rules?: Rule[];
}

/** What a file's change looks like to the rules and the classifier. */
export function routingInput(file: FileDiff): RoutingInput {
	const changed: string[] = [];
	const context: string[] = [];
	for (const h of file.hunks) {
		for (const l of h.lines) if (l.k !== " ") changed.push(l.t);
		if (h.enclosing) context.push(h.enclosing);
	}
	if (file.summary) changed.push(file.summary);
	return { file: file.path, lang: file.lang, changed: changed.join("\n"), context: context.join("\n"), header: file.headerLines ?? "" };
}

/** Rule-based routing of one file. */
export function routeFileByRules(file: FileDiff, catalog: SkillCatalog, opts: RouterOptions): RouteDecision {
	const input = routingInput(file);
	const scores = scoreRules(input, opts.rules ?? RULES).filter((s) => catalog.has(s.skill));
	const selected: RouteDecision["selected"] = [];
	if (file.lang === "gdscript" || file.lang === "csharp") {
		for (const skill of opts.alwaysOn) if (catalog.has(skill)) selected.push({ skill, score: 100, source: "always" });
	}
	for (const s of scores) {
		if (s.score >= 2 && !selected.some((x) => x.skill === s.skill)) selected.push({ skill: s.skill, score: s.score, source: "rule" });
	}
	const candidates = new Set<string>();
	for (const s of scores) if (s.score < 2) candidates.add(s.skill);
	for (const c of DEFAULT_CANDIDATES[file.lang] ?? []) if (catalog.has(c)) candidates.add(c);
	for (const s of selected) candidates.delete(s.skill);
	return { file: file.path, hunkIds: file.hunks.map((h) => h.id), selected, candidates: [...candidates].sort() };
}

export function routeByRules(files: FileDiff[], catalog: SkillCatalog, opts: RouterOptions): RouteDecision[] {
	return files.map((f) => routeFileByRules(f, catalog, opts));
}
