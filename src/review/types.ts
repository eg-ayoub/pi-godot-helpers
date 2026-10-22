// Shared review data structures.

export type Lang = "gdscript" | "csharp" | "scene" | "resource" | "shader" | "project" | "text" | "binary";

export interface DiffLine {
	k: "+" | "-" | " ";
	/** Line number in the old file (context and removed lines). */
	o?: number;
	/** Line number in the new file (context and added lines). */
	n?: number;
	t: string;
}

export interface Hunk {
	id: string;
	file: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** The text after @@ ... @@ (git's function context). */
	header: string;
	lines: DiffLine[];
	/** The enclosing GDScript function(s) in the new (or old, for deletions) file, as source text. */
	enclosing?: string;
	/** Approximate tokens of the hunk as shown to a worker. */
	tokens: number;
}

export interface FileDiff {
	path: string;
	oldPath?: string;
	status: "A" | "M" | "D" | "R" | "C" | "T";
	binary: boolean;
	lang: Lang;
	hunks: Hunk[];
	added: number;
	removed: number;
	/** Scene/resource/noise files are summarized instead of reviewed line by line. */
	summary?: string;
	/** Not reviewed at all (generated files, editor caches). */
	skipped?: string;
	/** `extends` / `class_name` lines of the new file, for routing. */
	headerLines?: string;
}

export type DiffTarget =
	| { kind: "unstaged" }
	| { kind: "staged" }
	| { kind: "uncommitted" }
	| { kind: "range"; base: string; head: string; mergeBase: boolean }
	| { kind: "commit"; sha: string }
	| { kind: "lastN"; n: number };

export interface ResolvedTarget {
	target: DiffTarget;
	/** What the user asked for, in words. */
	label: string;
	/** Arguments for `git diff`. */
	gitArgs: string[];
	/** Whether untracked files are part of the change (working-tree reviews). */
	includeUntracked: boolean;
	/** Where the new side's files live: a git rev, the index, or the working tree. */
	newSide: { kind: "worktree" } | { kind: "index" } | { kind: "rev"; rev: string };
	oldSide: { kind: "index" } | { kind: "rev"; rev: string };
	/** True when the parser was certain; otherwise the user confirms. */
	exact: boolean;
	source: "parser" | "llm";
	warnings: string[];
}

export type Severity = "critical" | "important" | "minor" | "nit";

export const SEVERITIES: Severity[] = ["critical", "important", "minor", "nit"];

export interface ReviewComment {
	id: string;
	source: "worker" | "check" | "docpass";
	unitId?: string;
	file: string;
	side: "new" | "old";
	/** Null for file-level comments. */
	line: number | null;
	endLine?: number;
	hunkId?: string;
	anchorAdjusted?: { requested: number; reason: string };
	severity: Severity;
	/** Skill name, "project" for project invariants, "check:<name>" for checks, or "general". */
	discipline: string;
	title: string;
	body: string;
	suggestion?: string;
	fingerprint: string;
	alreadyRaised?: { reviewId: string; occurrences: number };
}

export interface RouteDecision {
	file: string;
	hunkIds: string[];
	selected: { skill: string; score: number; source: "always" | "rule" | "classifier" }[];
	candidates: string[];
	classifier?: { model: string; ok: boolean; error?: string; probabilities?: Record<string, number> };
}

export interface RoutedUnit {
	id: string;
	files: string[];
	hunkIds: string[];
	skills: string[];
	/** Skills only listed (name + description); the worker may read them itself. */
	advertised: string[];
	tokens: { fixed: number; hunks: number; budget: number };
}

export interface CheckResult {
	name: string;
	command: string;
	status: "passed" | "failed" | "skipped" | "error";
	reason?: string;
	output: string;
	findings: { file?: string; line?: number; message: string }[];
}
