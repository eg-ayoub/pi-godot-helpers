// Which tool calls may run inside a Godot repository. Default deny: only the read-only tools, the sandboxed
// bash, this extension's own tools, and edit/write on DESIGN.md / AGENTS.md during the review's doc pass.
// The path checks here are repeated at write time by the guarded edit/write operations (guarded-tools.ts).
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Mode = "off" | "advisor" | "review" | "review-docs" | "docs-migrate" | "worker";

export interface GateContext {
	mode: Mode;
	/** Real path of the git toplevel. */
	repoRoot: string;
	/** Doc file names at the toplevel that the doc pass may edit. */
	docs: string[];
	/** Real paths (besides the repo) that read/grep/find/ls may look at. */
	readRoots: string[];
	/** Modes in which the docs are editable. */
	docsEditableIn: Mode[];
	/** Largest total edit (characters) per call on a doc. */
	maxDocEditChars: number;
	/** Extra tool names allowed in Godot repos. */
	extraAllowedTools: string[];
	/** Tools this extension registers, allowed per mode. */
	ownTools: Record<string, Mode[]>;
}

export type GateDecision = { block: true; reason: string } | undefined;

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const UNICODE_SPACES = /[  -   　]/g;

/** Resolve a tool path the way pi does (strip a leading @, normalize spaces, expand ~, resolve against cwd). */
export function resolveToolPath(raw: string, cwd: string): string {
	let p = raw.replace(UNICODE_SPACES, " ").trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Real path of `abs`, or of its nearest existing ancestor joined with the rest. */
export function realOrNearest(abs: string): string {
	let current = abs;
	const rest: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return abs;
		rest.unshift(basename(current));
		current = parent;
	}
	try {
		return join(realpathSync(current), ...rest);
	} catch {
		return abs;
	}
}

/** The doc a path names, if it is exactly one of the toplevel docs (no symlinks, no other casing). */
export function docForPath(abs: string, ctx: Pick<GateContext, "repoRoot" | "docs">): string | undefined {
	const real = realOrNearest(abs);
	for (const doc of ctx.docs) {
		const target = join(ctx.repoRoot, doc);
		if (real !== target) continue;
		try {
			// a doc that is itself a symlink could point anywhere: never edit through it
			if (existsSync(target) && lstatSync(target).isSymbolicLink()) return undefined;
		} catch {
			return undefined;
		}
		return doc;
	}
	return undefined;
}

export function checkReadPath(raw: string | undefined, cwd: string, ctx: GateContext): string | undefined {
	const abs = raw === undefined || raw === "" ? resolve(cwd) : resolveToolPath(raw, cwd);
	const real = realOrNearest(abs);
	if (within(real, ctx.repoRoot)) return undefined;
	if (ctx.readRoots.some((root) => within(real, root))) return undefined;
	return `reading outside the repository is not allowed (${raw ?? cwd}); allowed: the repository${ctx.readRoots.length ? `, ${ctx.readRoots.join(", ")}` : ""}`;
}

/** Characters an edit call changes, counted generously (old + new text of every replacement). */
export function editSize(edits: { oldText?: unknown; newText?: unknown }[] | undefined): number {
	let total = 0;
	for (const e of edits ?? []) total += String(e?.oldText ?? "").length + String(e?.newText ?? "").length;
	return total;
}

export function checkWrite(toolName: "edit" | "write", input: Record<string, unknown>, cwd: string, ctx: GateContext): string | undefined {
	const docsList = ctx.docs.join(" and ");
	if (!ctx.docsEditableIn.includes(ctx.mode)) {
		return `Changing files is not allowed in this repository (mode: ${ctx.mode}). Only ${docsList} can be edited, and only during the review's documentation pass.`;
	}
	const raw = typeof input.path === "string" ? input.path : "";
	if (!raw) return "a path is required";
	const abs = resolveToolPath(raw, cwd);
	const doc = docForPath(abs, ctx);
	if (!doc) return `Only ${docsList} at the repository root may be changed (not ${raw}).`;
	if (toolName === "write" && existsSync(join(ctx.repoRoot, doc))) {
		return `${doc} exists: change it with edit (small, exact replacements), not by rewriting it with write.`;
	}
	if (toolName === "edit") {
		const size = editSize(input.edits as { oldText?: unknown; newText?: unknown }[]);
		if (size > ctx.maxDocEditChars) {
			return `This edit changes ${size} characters of ${doc}; the limit is ${ctx.maxDocEditChars}. Keep doc changes to the minimal consistency fixes (no rewrites).`;
		}
	}
	if (toolName === "write") {
		const size = String(input.content ?? "").length;
		if (size > ctx.maxDocEditChars * 4) return `Creating ${doc} with ${size} characters exceeds the limit.`;
	}
	return undefined;
}

/** The decision for one tool call inside a Godot repository. */
export function decideToolCall(toolName: string, input: Record<string, unknown>, cwd: string, ctx: GateContext): GateDecision {
	if (READ_TOOLS.has(toolName)) {
		const why = checkReadPath(typeof input.path === "string" ? input.path : undefined, cwd, ctx);
		return why ? { block: true, reason: why } : undefined;
	}
	if (toolName === "bash") return undefined; // checked and sandboxed by the guarded bash operations
	if (toolName === "edit" || toolName === "write") {
		const why = checkWrite(toolName, input, cwd, ctx);
		return why ? { block: true, reason: why } : undefined;
	}
	const ownModes = ctx.ownTools[toolName];
	if (ownModes) {
		return ownModes.includes(ctx.mode) ? undefined : { block: true, reason: `${toolName} is not available in mode ${ctx.mode}` };
	}
	if (ctx.extraAllowedTools.includes(toolName)) return undefined;
	return {
		block: true,
		reason: `The tool ${toolName} is not allowed in this repository. Use read, grep, find, ls and the sandboxed bash.`,
	};
}
