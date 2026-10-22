// What a review worker sees: a system prompt (role, project docs, routed skills, memory, check findings) in a
// fixed order for prompt-cache reuse, and a context file with the unit's hunks and their enclosing code.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillCatalog } from "../skills/catalog.ts";
import { renderHunk } from "./diff.ts";
import type { CheckResult, FileDiff, RoutedUnit } from "./types.ts";

export const REVIEWER_ROLE = `You are reviewing one part of a change to a Godot 4 project. Find real problems and report each one with the review_comment tool.

What to look for:
- Bugs: wrong logic, null/freed-node access, lifecycle and ordering mistakes (_ready, _enter_tree, deferred calls), signals connected but never disconnected or connected twice, await on things that may never resolve, shared Resource state mutated at runtime.
- The project's architecture: AGENTS.md and DESIGN.md below describe its invariants. Treat each invariant as a principle, not a list of examples: a new case of the same category (another kind of interaction bypassing the central mechanism, another blueprint resource mutated, another motion done directly) is a violation even when it does not match a listed example.
- Godot practice, using the skills below: performance in hot paths (_process, _physics_process, loops), scene and node organization, typing, UI layout, shaders, and anything else the skills cover.
- Documentation drift: code that no longer matches DESIGN.md or AGENTS.md (say which section).

How to work:
- The context file shows the hunks with line numbers (old new) and the full functions around them. Read more when you need it: callers, scenes, resources (read, grep, find, ls; bash runs read-only git and other read-only tools in a sandbox). You cannot change files.
- Do not repeat what the check findings below already report (lint and formatting).
- Every comment needs evidence: cite file:line, and say why it is a problem in this code, not in general.
- Severity: critical = crash, data loss, or a broken project invariant that will cause bugs; important = a likely bug, an architecture violation, or a real performance problem in a hot path; minor = maintainability or Godot idiom; nit = small style point the formatter does not catch.
- discipline: the name of the skill the finding comes from, "project" for AGENTS.md/DESIGN.md invariants, or "general".
- Put the comment on the changed line it is about (new-side line numbers; side "old" for removed lines). Use one comment per problem.
- Give a concrete suggestion (a short code snippet when it helps).
- When you are done, call review_done with a 2-4 sentence summary of this part (risk and main themes). If you found nothing, call review_done and say so. Do not write a final text answer.`;

export interface WorkerPromptInput {
	repoRoot: string;
	docs: string[];
	unit: RoutedUnit;
	files: FileDiff[];
	catalog: SkillCatalog;
	checks: CheckResult[];
	targetLabel: string;
	/** Extra sections (memory notes, facts, already raised items). */
	extraSections?: { title: string; body: string }[];
	designCapChars?: number;
}

export function readDoc(repoRoot: string, name: string, cap: number): string | undefined {
	const p = join(repoRoot, name);
	if (!existsSync(p)) return undefined;
	const text = readFileSync(p, "utf8");
	return text.length > cap ? `${text.slice(0, cap)}\n\n[... ${name} truncated; read the rest of the file if you need it]` : text;
}

export function buildWorkerSystemPrompt(input: WorkerPromptInput): string {
	const parts: string[] = [REVIEWER_ROLE];
	const cap = input.designCapChars ?? 16000;
	for (const doc of input.docs) {
		const text = readDoc(input.repoRoot, doc, cap);
		if (text) parts.push(`<project_doc name="${doc}">\n${text}\n</project_doc>`);
	}
	for (const skill of input.unit.skills) {
		const body = input.catalog.body(skill);
		if (body) parts.push(`<skill name="${skill}">\n${body}\n</skill>`);
	}
	// the unit's other candidate skills reach the worker through pi's own --skill listing (name, description, path)
	for (const extra of input.extraSections ?? []) {
		if (extra.body.trim()) parts.push(`<${extra.title}>\n${extra.body.trim()}\n</${extra.title}>`);
	}
	const unitFiles = new Set(input.unit.files);
	const findings: string[] = [];
	for (const r of input.checks) {
		for (const f of r.findings) {
			if (f.file && !unitFiles.has(f.file)) continue;
			findings.push(`- [${r.name}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.message}`);
		}
	}
	if (findings.length) parts.push(`<check_findings>\nAlready reported by the project's checks (do not repeat):\n${findings.slice(0, 80).join("\n")}\n</check_findings>`);
	return parts.join("\n\n");
}

export function buildWorkerContext(input: WorkerPromptInput): string {
	const hunkIds = new Set(input.unit.hunkIds);
	const out: string[] = [`# Change under review: ${input.targetLabel}`, "", `This part covers ${input.unit.files.length} file(s). Line numbers are "old new".`];
	for (const path of input.unit.files) {
		const file = input.files.find((f) => f.path === path);
		if (!file) continue;
		const hunks = file.hunks.filter((h) => hunkIds.has(h.id));
		out.push("", `## ${file.path} (${{ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" }[file.status]}${file.oldPath ? ` from ${file.oldPath}` : ""}, +${file.added} -${file.removed})`);
		if (file.headerLines) out.push("", "```gdscript", file.headerLines, "```");
		if (file.summary) {
			out.push("", "Summary of the scene/resource change:", file.summary || "(only property changes)");
			const excerpt = hunks.flatMap((h) => h.lines.filter((l) => l.k !== " ").map((l) => `${l.k === "+" ? `+${String(l.n).padStart(5)}` : `-${String(l.o).padStart(5)}`} ${l.t}`));
			if (excerpt.length) out.push("", "Changed lines (excerpt):", "```", ...excerpt.slice(0, 40), "```");
			continue;
		}
		for (const h of hunks) {
			out.push("", "```diff", renderHunk(h), "```");
			if (h.enclosing) out.push("", "Enclosing code:", "```gdscript", h.enclosing, "```");
		}
	}
	return out.join("\n");
}

/** The anchoring data a worker needs to validate its comments. */
export interface UnitFile {
	reviewId: string;
	unitId: string;
	repoRoot: string;
	outFile: string;
	files: FileDiff[];
	/** Verification units: the ids of the earlier findings the worker gives a verdict on. */
	findings?: string[];
}
