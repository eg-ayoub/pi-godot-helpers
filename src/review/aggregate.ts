// Turning worker output and check findings into one deduplicated, sorted list of comments.
import { createHash } from "node:crypto";
import { anchorComment, lineText } from "./anchor.ts";
import { gdscriptFunctions } from "./diff.ts";
import { SEVERITIES, type CheckResult, type FileDiff, type ReviewComment, type Severity, type VerdictStatus } from "./types.ts";

export interface RawComment {
	file: string;
	line?: number | null;
	end_line?: number;
	side?: "new" | "old";
	severity?: string;
	discipline?: string;
	title?: string;
	body?: string;
	suggestion?: string;
	unitId?: string;
}

function normalizeSeverity(s: string | undefined): Severity {
	const v = (s ?? "").toLowerCase();
	return (SEVERITIES as string[]).includes(v) ? (v as Severity) : v === "major" || v === "high" ? "important" : v === "low" ? "minor" : "minor";
}

function norm(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Name of the GDScript function around an anchored line, from the enclosing source of its hunk. */
function enclosingName(files: FileDiff[], file: string, hunkId: string | undefined): string {
	const h = files.find((f) => f.path === file)?.hunks.find((x) => x.id === hunkId);
	if (!h?.enclosing) return "";
	const fn = gdscriptFunctions(h.enclosing.replace(/^ *\d+ {2}/gm, ""))[0];
	return fn ? fn.signature.replace(/\(.*$/, "") : "";
}

/** Stable across line shifts: discipline, file, enclosing function and the anchored line's text. */
export function fingerprintOf(c: Pick<ReviewComment, "discipline" | "file" | "line" | "side" | "hunkId" | "title">, files: FileDiff[]): string {
	const text = c.line === null ? norm(c.title).split(" ").slice(0, 6).join(" ") : norm(lineText(files, c));
	const key = [c.discipline, c.file, enclosingName(files, c.file, c.hunkId), text].join("\u0000");
	return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

let counter = 0;
function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}${counter}`;
}

export function fromRaw(raw: RawComment, files: FileDiff[], source: ReviewComment["source"]): ReviewComment {
	const anchor = anchorComment({ file: raw.file, line: raw.line, endLine: raw.end_line, side: raw.side }, files);
	const comment: ReviewComment = {
		id: nextId("c"),
		source,
		unitId: raw.unitId,
		file: anchor.file,
		side: anchor.side,
		line: anchor.line,
		endLine: anchor.endLine,
		hunkId: anchor.hunkId,
		anchorAdjusted: anchor.adjusted ?? (anchor.inDiff ? undefined : { requested: raw.line ?? 0, reason: "the file is not part of the change" }),
		severity: normalizeSeverity(raw.severity),
		discipline: (raw.discipline ?? "general").trim() || "general",
		title: (raw.title ?? "").trim() || (raw.body ?? "").split("\n")[0].slice(0, 80),
		body: (raw.body ?? "").trim(),
		suggestion: raw.suggestion?.trim() || undefined,
		fingerprint: "",
	};
	comment.fingerprint = fingerprintOf(comment, files);
	return comment;
}

/** Check findings as comments (lint is minor, formatting a nit, failing project checks important). */
export function commentsFromChecks(results: CheckResult[], files: FileDiff[]): ReviewComment[] {
	const out: ReviewComment[] = [];
	for (const r of results) {
		if (r.status !== "failed") continue;
		const severity: Severity = r.name === "gdformat" ? "nit" : r.name === "gdlint" ? "minor" : "important";
		const anchored = r.findings.filter((f) => f.file);
		for (const f of anchored) {
			out.push(fromRaw({ file: f.file as string, line: f.line, severity, discipline: `check:${r.name}`, title: f.message.slice(0, 100), body: f.message }, files, "check"));
		}
		const loose = r.findings.filter((f) => !f.file).map((f) => f.message);
		if (anchored.length === 0) {
			out.push({
				id: nextId("c"),
				source: "check",
				file: "",
				side: "new",
				line: null,
				severity,
				discipline: `check:${r.name}`,
				title: `${r.name} failed`,
				body: loose.slice(0, 30).join("\n") || r.output.slice(0, 2000),
				fingerprint: createHash("sha1").update(`check:${r.name}:${loose.slice(0, 5).join("|")}`).digest("hex").slice(0, 16),
			});
		}
	}
	return out;
}

const RANK: Record<Severity, number> = { critical: 0, important: 1, minor: 2, nit: 3 };

/** Merge duplicates (same fingerprint, or same file+line+discipline) and sort by severity, file, line. */
export function dedupe(comments: ReviewComment[]): ReviewComment[] {
	const byKey = new Map<string, ReviewComment>();
	for (const c of comments) {
		const keys = [c.fingerprint, `${c.file}:${c.side}:${c.line}:${c.discipline}`];
		const existing = keys.map((k) => byKey.get(k)).find(Boolean);
		if (existing) {
			if (RANK[c.severity] < RANK[existing.severity]) existing.severity = c.severity;
			if (c.body.length > existing.body.length) {
				existing.body = c.body;
				existing.title = c.title || existing.title;
			}
			existing.suggestion ??= c.suggestion;
			for (const k of keys) byKey.set(k, existing);
			continue;
		}
		for (const k of keys) byKey.set(k, c);
	}
	return [...new Set(byKey.values())].sort(
		(a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
	);
}

export function countBySeverity(comments: ReviewComment[]): Record<Severity, number> {
	const out: Record<Severity, number> = { critical: 0, important: 0, minor: 0, nit: 0 };
	for (const c of comments) out[c.severity]++;
	return out;
}

/** Verification results by status. */
export function countByStatus(comments: ReviewComment[]): Record<VerdictStatus, number> {
	const out: Record<VerdictStatus, number> = { "still-present": 0, "partly-fixed": 0, unclear: 0, fixed: 0 };
	for (const c of comments) if (c.verdict) out[c.verdict.status]++;
	return out;
}

export const STATUS_WORDS: Record<VerdictStatus, string> = { "still-present": "still present", "partly-fixed": "partly fixed", unclear: "unclear", fixed: "fixed" };
