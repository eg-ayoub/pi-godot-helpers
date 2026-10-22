// /review-verify: a second pass over an earlier review that answers, for every finding, whether the problem is
// still in the code. The project's checks are run again for their own findings; every other finding goes to a
// worker that sees it with the code at review time and the code as it is now, and answers one review_verdict
// per finding. The result is saved as a review of its own (kind "verify"), so the viewer and review.md show it,
// and findings found fixed stop being "already raised" in later reviews.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CheckConfig } from "../config.ts";
import { git } from "../repo.ts";
import { PACKAGE_ROOT, type Runtime } from "../runtime.ts";
import { showReport } from "../ui/report.ts";
import { countByStatus, STATUS_WORDS } from "./aggregate.ts";
import { anchorComment, lineText } from "./anchor.ts";
import { filesFor, runChecks } from "./checks.ts";
import { collectDiff, enclosingSource, gdscriptFunctions, langOf } from "./diff.ts";
import type { ReviewController } from "./pipeline.ts";
import type { ReviewRecord, WorkerSummary } from "./record.ts";
import { renderMarkdown } from "./report-md.ts";
import { SEVERITIES, VERDICT_STATUSES, type CheckResult, type DiffLine, type FileDiff, type ResolvedTarget, type ReviewComment, type Verdict, type VerdictStatus } from "./types.ts";
import { readDoc, type UnitFile } from "./worker-prompt.ts";
import { runPool, runWorker, type WorkerJob } from "./worker-runner.ts";

export const VERIFY_TOOLS = ["read", "grep", "find", "ls", "bash", "review_verdict", "review_done"];
export const VERIFY_TASK = "Check every finding in the attached context: call review_verdict once per finding, then review_done.";
const MAX_FINDINGS_PER_UNIT = 8;
const SAVED_ID = /^[0-9A-Za-z-]+$/;

export const VERIFIER_ROLE = `You are checking whether the findings of an earlier review of a Godot 4 project were addressed. The attached context lists each finding with what the review said, the code at review time, and where that code is now.

For every finding, call review_verdict once:
- fixed: the problem is gone: fixed as suggested or in another valid way, or the code was removed.
- partly-fixed: part of the problem remains; say which part.
- still-present: the problem is still in the code.
- unclear: the code cannot settle it; say what a person should check.

How to work:
- Judge the problem, not the wording of the suggestion: a different fix that solves it counts as fixed.
- Look at the code as it is now before deciding. Read more when the fix may be elsewhere (a caller, a scene, a resource): read, grep, find, ls; bash runs read-only git and other read-only tools in a sandbox. You cannot change files.
- A line that moved is not a fix. A line that is gone is not proof of a fix if the same code moved elsewhere: grep for it.
- evidence: 1-3 sentences citing file:line in the current code. If the fix introduced a new problem in the same code, say so there.
- line: the current line of the code in question, when the problem is still present or partly fixed.
- When every finding has a verdict, call review_done with one sentence. Do not write a final text answer.`;

export interface VerifyOptions {
	id?: string;
	/** Check again the findings an earlier verification found fixed. */
	all: boolean;
	checks: boolean;
	open: boolean;
	unknown: string[];
}

export function parseVerifyArgs(args: string): VerifyOptions {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const flags = words.filter((w) => w.startsWith("--"));
	const known = new Set(["--all", "--no-checks", "--no-open"]);
	return {
		id: words.find((w) => !w.startsWith("--")),
		all: flags.includes("--all"),
		checks: !flags.includes("--no-checks"),
		open: !flags.includes("--no-open"),
		unknown: flags.filter((f) => !known.has(f)),
	};
}

// ------------------------------------------------------------------------------------------ saved reviews

/** Ids of the saved reviews and verifications, newest first. */
export function savedIds(reviewsDir: string): string[] {
	if (!existsSync(reviewsDir)) return [];
	return readdirSync(reviewsDir)
		.filter((id) => SAVED_ID.test(id) && existsSync(join(reviewsDir, id, "review.json")))
		.sort()
		.reverse();
}

export function readRecord(reviewsDir: string, id: string): ReviewRecord | undefined {
	if (!SAVED_ID.test(id)) return undefined;
	try {
		return JSON.parse(readFileSync(join(reviewsDir, id, "review.json"), "utf8")) as ReviewRecord;
	} catch {
		return undefined;
	}
}

/** The review to verify: the one named (a verification names its review), else the newest review. */
export function pickReview(reviewsDir: string, id?: string): { review?: ReviewRecord; error?: string } {
	if (id) {
		const named = readRecord(reviewsDir, id);
		if (!named) return { error: `There is no review ${id}. /review-open lists them in the viewer.` };
		if (named.kind !== "verify") return { review: named };
		const original = named.verifies ? readRecord(reviewsDir, named.verifies.id) : undefined;
		return original ? { review: original } : { error: `The review that ${id} verified is gone.` };
	}
	for (const saved of savedIds(reviewsDir)) {
		const r = readRecord(reviewsDir, saved);
		if (r && r.kind !== "verify") return { review: r };
	}
	return { error: "There are no reviews of this repository yet; run /review first." };
}

/** The newest verification of a review. */
export function latestVerificationOf(reviewsDir: string, reviewId: string): ReviewRecord | undefined {
	for (const saved of savedIds(reviewsDir)) {
		const r = readRecord(reviewsDir, saved);
		if (r?.kind === "verify" && r.verifies?.id === reviewId) return r;
	}
	return undefined;
}

// ------------------------------------------------------------------------------------------ the code now

async function revExists(rev: string, cwd: string): Promise<boolean> {
	return (await git(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], cwd)).code === 0;
}

/**
 * The change as it is now: the reviewed base, pinned to the commit it was, against the working tree (untracked
 * files included), so fixes show whether they are committed or not.
 */
export async function verificationTarget(original: ReviewRecord, cwd: string): Promise<ResolvedTarget> {
	const r = original.target.resolved;
	const warnings: string[] = [];
	let base = r.oldSide.kind === "rev" && /^[0-9a-f]{40}$/.test(r.oldSide.rev) ? r.oldSide.rev : original.target.headAtReview;
	if (!base) warnings.push("the review did not record its HEAD; the change is shown against the current HEAD");
	else if (!(await revExists(base, cwd))) {
		warnings.push(`the reviewed base ${base.slice(0, 12)} no longer exists (rebased?); the change is shown against the current HEAD`);
		base = undefined;
	}
	const rev = base ?? "HEAD";
	return { target: r.target, label: original.target.label, gitArgs: [rev], includeUntracked: true, newSide: { kind: "worktree" }, oldSide: { kind: "rev", rev }, exact: true, source: r.source, warnings };
}

function numbered(lines: string[], from: number, to: number): string {
	return lines
		.slice(from - 1, to)
		.map((l, k) => `${String(from + k).padStart(5)}  ${l}`)
		.join("\n");
}

/** Numbered windows of `radius` lines around each line, merged where they overlap. */
export function windowsAround(source: string, lineNumbers: number[], radius: number, label: string): string {
	const lines = source.split("\n");
	const ranges = [...new Set(lineNumbers)]
		.sort((a, b) => a - b)
		.map((n) => [Math.max(1, n - radius), Math.min(lines.length, n + radius)] as [number, number]);
	const merged: [number, number][] = [];
	for (const r of ranges) {
		const last = merged.at(-1);
		if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
		else merged.push([...r]);
	}
	return merged.map(([a, b]) => `${label} lines ${a}-${b}:\n${numbered(lines, a, b)}`).join("\n\n");
}

/** The GDScript function that contained a line at review time, from the hunk's enclosing source ("func _process"). */
export function functionAt(files: FileDiff[], c: Pick<ReviewComment, "file" | "line" | "hunkId">): string {
	if (c.line === null) return "";
	const hunk = files.find((f) => f.path === c.file)?.hunks.find((h) => h.id === c.hunkId);
	let best: { n: number; name: string } | undefined;
	for (const raw of (hunk?.enclosing ?? "").split("\n")) {
		const m = /^ *(\d+) {2}\s*((?:static\s+)?func\s+\w+)/.exec(raw);
		if (!m) continue;
		const n = Number(m[1]);
		if (n <= c.line && (!best || n > best.n)) best = { n, name: m[2].replace(/\s+/g, " ") };
	}
	return best?.name ?? "";
}

export interface Located {
	line?: number;
	/** One sentence for the worker. */
	how: string;
}

/** Where the flagged code is now: the same line (the nearest to where it was), else its function by name. */
export function locate(source: string | undefined, lineThen: string, functionName: string, previousLine: number | null): Located {
	if (source === undefined) return { how: "The file no longer exists (deleted or moved)." };
	const lines = source.split("\n");
	const text = lineThen.trim();
	// short lines ("pass", "}", "else:") match too many places to mean anything
	if (text.length >= 8) {
		const hits = lines.flatMap((l, i) => (l.trim() === text ? [i + 1] : []));
		if (hits.length) {
			const best = hits.reduce((a, b) => (Math.abs(b - (previousLine ?? 0)) < Math.abs(a - (previousLine ?? 0)) ? b : a));
			return { line: best, how: `The flagged line is still in the file, at line ${best}${hits.length > 1 ? ` (and in ${hits.length - 1} other place(s))` : ""}.` };
		}
	}
	if (functionName) {
		const fn = gdscriptFunctions(source).find((f) => f.signature.replace(/\(.*$/, "").replace(/\s+/g, " ") === functionName);
		if (fn) return { line: fn.start, how: `${text ? "The flagged line is no longer in the file; its" : "Its"} function \`${functionName}\` is at lines ${fn.start}-${fn.end}.` };
		return { how: `Neither the flagged line nor its function \`${functionName}\` is in the file any more.` };
	}
	if (text) return { how: "The flagged line is no longer in the file." };
	if (previousLine === null) return { how: "A file-level finding." };
	// a line outside the reviewed diff: its text was never recorded
	const at = Math.min(previousLine, lines.length);
	return { line: at, how: `The review pointed at line ${previousLine}, outside the reviewed diff; the code around line ${at} is shown.` };
}

/** The diff lines around a finding as they were reviewed; ">" marks the flagged line. */
export function codeThen(files: FileDiff[], c: ReviewComment, radius = 6): string | undefined {
	if (c.line === null) return undefined;
	const onSide = (l: DiffLine) => (c.side === "old" ? l.o : l.n);
	const file = files.find((f) => f.path === c.file);
	const hunk = file?.hunks.find((h) => h.id === c.hunkId) ?? file?.hunks.find((h) => h.lines.some((l) => onSide(l) === c.line));
	const at = hunk?.lines.findIndex((l) => onSide(l) === c.line) ?? -1;
	if (!hunk || at < 0) return undefined;
	return hunk.lines
		.slice(Math.max(0, at - radius), at + radius + 1)
		.map((l, k) => {
			const num = l.k === "-" ? `${String(l.o).padStart(5)}      ` : l.k === "+" ? `      ${String(l.n).padStart(5)}` : `${String(l.o).padStart(5)} ${String(l.n).padStart(5)}`;
			return `${k + Math.max(0, at - radius) === at ? ">" : " "}${num} ${l.k}${l.t}`;
		})
		.join("\n");
}

/** What changed in a file since the reviewed commit, without the diff header; undefined when unknown. */
async function changesSince(rev: string, path: string, cwd: string, maxLines = 150): Promise<string | undefined> {
	const r = await git(["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", rev, "--", path], cwd);
	if (r.code !== 0) return undefined;
	const body = r.stdout.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(l));
	while (body.length && body.at(-1) === "") body.pop();
	if (body.length > maxLines) return `${body.slice(0, maxLines).join("\n")}\n[... ${body.length - maxLines} more line(s); run git diff ${rev.slice(0, 12)} -- ${path} for the rest]`;
	return body.join("\n");
}

function fence(text: string, lang = ""): string {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}${lang}\n${text}\n${ticks}`;
}

export interface VerifyUnit {
	id: string;
	files: string[];
	findings: ReviewComment[];
	context: string;
}

/**
 * The verification units: findings grouped by file (at most MAX_FINDINGS_PER_UNIT per unit, small files packed
 * together within the budget), each file with its findings, the code then, the code now and the changes since.
 */
export async function buildVerifyUnits(
	original: ReviewRecord,
	findings: ReviewComment[],
	repoRoot: string,
	opts: { snapshot?: string; budgetChars: number },
): Promise<{ units: VerifyUnit[]; located: Map<string, number | undefined> }> {
	const located = new Map<string, number | undefined>();
	const byFile = new Map<string, ReviewComment[]>();
	for (const c of findings) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
	const sections: { file: string; findings: ReviewComment[]; text: string }[] = [];
	for (const [file, all] of [...byFile.entries()].sort((a, b) => (a[0] || "￿").localeCompare(b[0] || "￿"))) {
		const source = file ? await readFile(join(repoRoot, file), "utf8").catch(() => undefined) : undefined;
		const since = file && opts.snapshot && source !== undefined ? await changesSince(opts.snapshot, file, repoRoot) : undefined;
		const sorted = [...all].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
		for (let i = 0; i < sorted.length; i += MAX_FINDINGS_PER_UNIT) {
			const chunk = sorted.slice(i, i + MAX_FINDINGS_PER_UNIT);
			const out: string[] = [`## ${file || "Project-wide findings"}`];
			const nowLines: number[] = [];
			for (const c of chunk) {
				const fn = functionAt(original.files, c);
				const where = locate(file ? source : "", lineText(original.files, c), fn, c.line);
				located.set(c.id, where.line);
				if (where.line) nowLines.push(where.line);
				out.push(
					"",
					`### Finding ${c.id}: ${c.title || "(untitled)"}`,
					`[${c.severity}] ${c.discipline}${c.line !== null ? `, ${c.side === "old" ? "removed " : ""}line ${c.line}` : ", file-level"}${fn ? ` (in \`${fn}\`)` : ""}`,
				);
				if (c.body) out.push("", "The review said:", ...c.body.split("\n").map((l) => `> ${l}`));
				if (c.suggestion) out.push("", "Suggested fix:", fence(c.suggestion));
				const then = codeThen(original.files, c);
				if (then) out.push("", "Code at review time (> marks the flagged line):", fence(then));
				if (file) out.push("", `Now: ${where.how}`);
			}
			if (file && source !== undefined) {
				const lang = langOf(file);
				const lines = source.split("\n");
				let now = "";
				if (nowLines.length && lang === "gdscript") {
					const inFunctions = enclosingSource(source, nowLines, `${file} (now)`);
					const covered = gdscriptFunctions(source).filter((f) => nowLines.some((n) => n >= f.start && n <= f.end));
					const outside = nowLines.filter((n) => !covered.some((f) => n >= f.start && n <= f.end));
					now = [inFunctions, outside.length ? windowsAround(source, outside, 12, `${file} (now)`) : ""].filter(Boolean).join("\n\n");
				} else if (nowLines.length) now = windowsAround(source, nowLines, 15, `${file} (now)`);
				else if (lines.length <= 150) now = `${file} (now) lines 1-${lines.length}:\n${numbered(lines, 1, lines.length)}`;
				out.push("", `### ${file} now`, now ? fence(now) : `The flagged code was not found; read ${file} to check.`);
				if (opts.snapshot) {
					out.push("", `### Changes to ${file} since the review`, since === undefined ? "Unknown." : since.trim() ? fence(since, "diff") : "None: the file is as it was reviewed.");
				}
			}
			sections.push({ file, findings: chunk, text: out.join("\n") });
		}
	}
	const units: VerifyUnit[] = [];
	for (const s of sections) {
		const last = units.at(-1);
		if (last && last.findings.length + s.findings.length <= MAX_FINDINGS_PER_UNIT && last.context.length + s.text.length <= opts.budgetChars) {
			last.findings.push(...s.findings);
			if (!last.files.includes(s.file)) last.files.push(s.file);
			last.context += `\n\n${s.text}`;
		} else units.push({ id: `v${units.length + 1}`, files: [s.file], findings: [...s.findings], context: s.text });
	}
	return { units, located };
}

export function verifyContextHeader(original: ReviewRecord, snapshot: string | undefined, unit: VerifyUnit): string {
	return [
		`# Findings to verify: ${unit.findings.map((c) => c.id).join(", ")}`,
		"",
		`A review of ${original.target.description}, made ${original.createdAt}, reported the findings below. For each one, decide whether the problem is still in the code as it is now (the working tree).`,
		snapshot
			? `"Changes since the review" shows what changed in each file since the reviewed commit ${snapshot.slice(0, 12)}.`
			: "The review looked at uncommitted changes, so there is no record of what changed since; compare the code then and now.",
		"",
		unit.context,
	].join("\n");
}

// ------------------------------------------------------------------------------------------ verdicts

export type FoundVerdict = Verdict & { line?: number };

/**
 * Verdicts for the findings of the project's checks, from running them again. A finding whose check could not
 * run, or did not look at its file this time, gets none (a worker checks it instead).
 */
export function verdictsFromChecks(findings: ReviewComment[], results: CheckResult[], looked: (check: string, file: string) => boolean): Map<string, FoundVerdict> {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
	const out = new Map<string, FoundVerdict>();
	for (const c of findings) {
		if (c.source !== "check") continue;
		const name = c.discipline.replace(/^check:/, "");
		const r = results.find((x) => x.name === name);
		if (!r || (r.status !== "passed" && r.status !== "failed")) continue;
		if (!c.file) {
			out.set(c.id, r.status === "passed" ? { status: "fixed", evidence: `${name} passes now.`, by: "check" } : { status: "still-present", evidence: `${name} still fails.`, by: "check" });
			continue;
		}
		if (!looked(name, c.file)) continue;
		// two messages on one line are merged into one finding: its title is from one, its body maybe from the other
		const same = r.findings.find((f) => f.file === c.file && (norm(f.message) === norm(c.body) || (norm(c.title) !== "" && norm(f.message).startsWith(norm(c.title)))));
		out.set(
			c.id,
			same
				? { status: "still-present", evidence: `${name} still reports it at ${c.file}${same.line ? `:${same.line}` : ""}.`, by: "check", line: same.line }
				: { status: "fixed", evidence: `${name} no longer reports it.`, by: "check" },
		);
	}
	return out;
}

const STATUS_RANK = Object.fromEntries(VERDICT_STATUSES.map((s, i) => [s, i])) as Record<VerdictStatus, number>;
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<string, number>;

/** The review's findings with their verdicts, placed on the current diff (fixed ones stay file-level). */
export function applyVerdicts(original: ReviewComment[], verdicts: Map<string, FoundVerdict>, located: Map<string, number | undefined>, current: FileDiff[]): ReviewComment[] {
	return original
		.map((c) => {
			const found = verdicts.get(c.id) ?? { status: "unclear" as const, evidence: "No verdict was given.", by: "worker" as const };
			const { line: verdictLine, ...verdict } = found;
			const out: ReviewComment = { ...c, previous: { side: c.side, line: c.line }, verdict, alreadyRaised: undefined, anchorAdjusted: undefined, hunkId: undefined, endLine: undefined, line: null, side: "new" };
			const line = verdict.status === "fixed" ? undefined : (verdictLine ?? located.get(c.id));
			if (c.file && line) {
				const a = anchorComment({ file: c.file, line }, current);
				Object.assign(out, { file: a.file, side: a.side, line: a.line, hunkId: a.hunkId, anchorAdjusted: a.adjusted });
			}
			return out;
		})
		.sort(
			(a, b) =>
				STATUS_RANK[(a.verdict as Verdict).status] - STATUS_RANK[(b.verdict as Verdict).status] ||
				SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
				a.file.localeCompare(b.file) ||
				(a.line ?? 0) - (b.line ?? 0),
		);
}

// ------------------------------------------------------------------------------------------ the command

function isLocal(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return true;
	return model.provider === "llama.cpp" || /\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(model.baseUrl ?? "");
}

export async function runVerification(pi: ExtensionAPI, rt: Runtime, controller: ReviewController, args: string, ctx: ExtensionCommandContext): Promise<ReviewRecord | undefined> {
	// print and json modes have no UI for notifications
	const tell = (message: string, level: "info" | "warning" | "error") => {
		ctx.ui.notify(message, level);
		if (!ctx.hasUI) process.stderr.write(`[godot-review] ${message}\n`);
	};
	if (!rt.active || !rt.repo) {
		tell("/review-verify works inside a Godot project (a git repository with a project.godot).", "warning");
		return undefined;
	}
	if (controller.running) {
		tell("A review is already running (/review-cancel stops it).", "warning");
		return undefined;
	}
	const opts = parseVerifyArgs(args);
	if (opts.unknown.length) {
		tell(`Unknown option ${opts.unknown.join(" ")}. Use: /review-verify [review id] [--all] [--no-checks] [--no-open]`, "warning");
		return undefined;
	}
	const reviewsDir = join(rt.repoDataDir() as string, "reviews");
	const picked = pickReview(reviewsDir, opts.id);
	const original = picked.review;
	if (!original) {
		tell(picked.error as string, "warning");
		return undefined;
	}
	if (original.comments.length === 0) {
		tell(`The review of ${original.target.description} had no findings; there is nothing to verify.`, "info");
		return undefined;
	}
	const earlier = opts.all ? undefined : latestVerificationOf(reviewsDir, original.id);

	const repo = rt.repo;
	const abort = new AbortController();
	const started = Date.now();
	const id = new Date(started).toISOString().replace(/[:.]/g, "-");
	controller.running = { abort, id };
	const status: string[] = [];
	const say = (line: string) => {
		status.push(line);
		controller.progress(ctx, status.slice(-8));
	};
	const previousMode = rt.mode;
	rt.state.set("review", false);
	const dir = join(reviewsDir, id);
	let record: ReviewRecord | undefined;
	let carried = 0;
	try {
		say(`Verifying ${original.comments.length} finding(s) of the review of ${original.target.description} (${original.id})`);
		const target = await verificationTarget(original, repo.toplevel);
		const current = await collectDiff(target, repo.toplevel);
		mkdirSync(join(dir, "units"), { recursive: true });

		const verdicts = new Map<string, FoundVerdict>();
		for (const c of earlier?.comments ?? []) {
			if (c.verdict?.status !== "fixed") continue;
			verdicts.set(c.id, { status: "fixed", evidence: c.verdict.evidence, by: "earlier", verificationId: c.verdict.by === "earlier" ? c.verdict.verificationId : earlier?.id });
			carried++;
		}

		let checks: CheckResult[] = [];
		let checksNote: string | undefined;
		const checkFindings = original.comments.filter((c) => c.source === "check" && !verdicts.has(c.id));
		if (opts.checks && checkFindings.length) {
			const r = await runChecks(rt.config.checks, current, target, rt.sandboxOptions(), {
				repoRoot: repo.toplevel,
				timeoutSeconds: rt.config.sandbox.timeoutSeconds,
				signal: abort.signal,
				onProgress: (name) => say(`Running check ${name}…`),
			});
			checks = r.results;
			checksNote = r.note;
			const configs = new Map<string, CheckConfig>(rt.config.checks.map((c) => [c.name, c]));
			const looked = (name: string, file: string) => {
				const cfg = configs.get(name);
				return !!cfg && (!cfg.command.includes("{files}") || filesFor(cfg, current).includes(file));
			};
			for (const [cid, v] of verdictsFromChecks(checkFindings, checks, looked)) verdicts.set(cid, v);
		}
		if (abort.signal.aborted) throw new Error("cancelled");

		const open = original.comments.filter((c) => !verdicts.has(c.id));
		const reviewed = original.target.resolved.newSide;
		const snapshot = reviewed.kind === "rev" && (await revExists(reviewed.rev, repo.toplevel)) ? reviewed.rev : undefined;
		const contextWindow = ctx.model?.contextWindow || rt.config.worker.defaultContextWindow;
		const { units, located } = await buildVerifyUnits(original, open, repo.toplevel, { snapshot, budgetChars: Math.floor(contextWindow * rt.config.worker.unitPromptFraction * 4 * 0.6) });

		const model = rt.config.worker.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		if (units.length && !model) throw new Error("no model is selected for the workers (/model, or worker.model in the config)");
		const system = [VERIFIER_ROLE, ...rt.config.docs.map((d) => readDoc(repo.toplevel, d, 16000)).flatMap((text, i) => (text ? [`<project_doc name="${rt.config.docs[i]}">\n${text}\n</project_doc>`] : []))].join("\n\n");
		const jobs: WorkerJob[] = units.map((unit) => {
			const base = join(dir, "units", unit.id);
			const unitFile: UnitFile = { reviewId: id, unitId: unit.id, repoRoot: repo.toplevel, outFile: `${base}.out.jsonl`, files: [], findings: unit.findings.map((c) => c.id) };
			writeFileSync(`${base}.system.md`, system);
			writeFileSync(`${base}.context.md`, verifyContextHeader(original, snapshot, unit));
			writeFileSync(`${base}.json`, JSON.stringify(unitFile));
			writeFileSync(unitFile.outFile, "");
			return { unitId: unit.id, systemFile: `${base}.system.md`, contextFile: `${base}.context.md`, unitFile: `${base}.json`, outFile: unitFile.outFile, logFile: `${base}.log`, advertisedSkillDirs: [], tools: VERIFY_TOOLS, task: VERIFY_TASK };
		});
		if (units.length) say(`${open.length} finding(s) to check in ${units.length} part(s)${carried ? `; ${carried} found fixed earlier` : ""}`);
		const answered = new Map<string, number>();
		const outcomes = await runPool(jobs, isLocal(ctx.model) ? rt.config.worker.concurrencyLocal : rt.config.worker.concurrencyCloud, (job) => {
			say(`Checking ${job.unitId}…`);
			return runWorker(job, {
				cwd: repo.toplevel,
				extensionPath: join(PACKAGE_ROOT, "src", "index.ts"),
				model,
				thinking: rt.config.worker.thinking ?? pi.getThinkingLevel(),
				inheritExtensions: rt.config.worker.inheritExtensions,
				extraExtensions: rt.config.worker.extraExtensions,
				timeoutSeconds: rt.config.worker.timeoutSeconds,
				signal: abort.signal,
				onEvent: (unitId, event) => {
					if (event.type === "tool_execution_end" && event.toolName === "review_verdict" && !event.isError) {
						answered.set(unitId, (answered.get(unitId) ?? 0) + 1);
						say(`${unitId}: ${answered.get(unitId)} verdict(s)`);
					}
				},
			});
		});
		if (abort.signal.aborted) throw new Error("cancelled");

		const workers: WorkerSummary[] = [];
		for (const o of outcomes) {
			const unit = units.find((u) => u.id === o.unitId) as VerifyUnit;
			const ids = new Set(unit.findings.map((c) => c.id));
			let count = 0;
			for (const v of o.verdicts) {
				if (!ids.has(v.finding) || !(VERDICT_STATUSES as string[]).includes(v.status)) continue;
				verdicts.set(v.finding, { status: v.status as VerdictStatus, evidence: (v.evidence ?? "").trim(), by: "worker", line: v.line });
				count++;
			}
			const error = o.finished ? undefined : (o.error ?? "the worker stopped without review_done");
			for (const c of unit.findings) {
				if (!verdicts.has(c.id)) verdicts.set(c.id, { status: "unclear", evidence: error ? `Not checked: ${error}.` : "The worker gave no verdict.", by: "worker" });
			}
			workers.push({ unitId: o.unitId, files: unit.files, skills: [], summary: o.summary, error, comments: count, usage: o.usage });
		}

		const comments = applyVerdicts(original.comments, verdicts, located, current);
		const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], repo.toplevel)).stdout.trim() || undefined;
		record = {
			version: 1,
			kind: "verify",
			verifies: { id: original.id, description: original.target.description, createdAt: original.createdAt },
			id,
			createdAt: new Date(started).toISOString(),
			durationMs: 0,
			repo: { toplevel: repo.toplevel, id: repo.id },
			target: { label: original.target.label, description: original.target.description, resolved: target, headAtReview: head },
			model,
			files: current,
			comments,
			checks,
			checksNote,
			routing: { decisions: [], units: [] },
			workers,
			warnings: [...target.warnings, ...(carried ? [`${carried} finding(s) found fixed by an earlier verification were not checked again (--all checks them too)`] : [])],
			status: "complete",
		};
		if (controller.hooks.afterVerify) await controller.hooks.afterVerify(record);
	} catch (error) {
		const message = (error as Error).message;
		const cancelled = abort.signal.aborted || message === "cancelled";
		tell(cancelled ? "Verification cancelled." : `Verification failed: ${message}`, cancelled ? "info" : "error");
		return undefined;
	} finally {
		controller.running = undefined;
		rt.state.set(previousMode === "advisor" ? "advisor" : "off", false);
		if (ctx.hasUI) ctx.ui.setWidget("godot-review", undefined);
	}
	record.durationMs = Date.now() - started;
	writeFileSync(join(dir, "review.json"), JSON.stringify(record, null, 1));
	writeFileSync(join(dir, "review.md"), renderMarkdown(record));
	const url = controller.hooks.present ? await controller.hooks.present(record, dir, ctx, opts.open) : undefined;
	const counts = countByStatus(record.comments);
	const lines = [
		`${record.comments.length} finding(s) of the review of ${original.target.description}: ${counts.fixed} fixed, ${counts["partly-fixed"]} partly fixed, ${counts["still-present"]} still present, ${counts.unclear} unclear`,
		...record.comments
			.filter((c) => c.verdict?.status !== "fixed")
			.slice(0, 15)
			.map((c) => `[${STATUS_WORDS[(c.verdict as Verdict).status]}] [${c.severity}] ${c.file}${c.line !== null ? `:${c.line}` : ""} ${c.title}${c.verdict?.evidence ? `: ${c.verdict.evidence.split("\n")[0].slice(0, 160)}` : ""}`),
		...record.warnings.map((w) => `note: ${w}`),
		...record.workers.filter((w) => w.error).map((w) => `${w.unitId} incomplete: ${w.error}`),
		`report: ${join(dir, "review.md")}`,
		...(url ? [`viewer: ${url}`] : []),
	];
	showReport(pi, ctx.hasUI, "Verification complete", lines);
	return record;
}

export function registerVerify(pi: ExtensionAPI, rt: Runtime, controller: ReviewController): void {
	pi.registerCommand("review-verify", {
		description: "Check whether the findings of a review were fixed: /review-verify [review id] [--all] [--no-checks] [--no-open]",
		handler: async (args, ctx) => {
			await rt.refresh(ctx);
			if (ctx.mode === "print" || ctx.mode === "json") {
				await runVerification(pi, rt, controller, args, ctx);
				return;
			}
			void runVerification(pi, rt, controller, args, ctx).catch((error: Error) => ctx.ui.notify(`Verification failed: ${error.message}`, "error"));
		},
	});
}
