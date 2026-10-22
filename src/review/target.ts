// "review this branch against develop", "review the unstaged changes", ... → which git diff to review.
// A deterministic parser handles the usual phrasings; anything else goes to one short model call.
import { git } from "../repo.ts";
import type { DiffTarget, ResolvedTarget } from "./types.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const REF = String.raw`([A-Za-z0-9._\/@{}~^-]+)`;
// a ref without consecutive dots, so that a..b and a...b split correctly
const RANGE_REF = String.raw`([A-Za-z0-9_\/@{}~^-]+(?:\.[A-Za-z0-9_\/@{}~^-]+)*)`;
const NOT_A_REF = /^(review|check|diff|compare|changes|everything|all|me|it|look|please)$/i;

export type ParsedTarget = { target: DiffTarget; exact: boolean } | undefined;

const HEAD_WORDS = /^(this|my|the|current|our)\s+branch$|^head$|^here$|^this$|^it$/i;

function cleanRef(word: string): string {
	return word.replace(/^["'`]+|["'`.,;:!?]+$/g, "");
}

function headRef(word: string | undefined): string {
	if (!word) return "HEAD";
	const w = word.trim();
	return HEAD_WORDS.test(w) ? "HEAD" : cleanRef(w.replace(/^branch\s+/i, ""));
}

/** Parse the free text of /review. `baseBranch` is used for "this branch" without an explicit base. */
export function parseTargetText(text: string, baseBranch: string): ParsedTarget {
	const t = text.trim().replace(/\s+/g, " ");
	const lower = t.toLowerCase();

	if (lower === "") return { target: { kind: "range", base: baseBranch, head: "HEAD", mergeBase: true }, exact: false };

	// explicit git ranges: a..b, a...b
	const range = new RegExp(String.raw`(?:^|\s)${RANGE_REF}(\.\.\.?)${RANGE_REF}(?:\s|$)`).exec(t);
	if (range) return { target: { kind: "range", base: cleanRef(range[1]), head: cleanRef(range[3]), mergeBase: range[2] === "..." }, exact: true };

	if (/\b(unstaged|not (yet )?staged|haven'?t staged|working tree changes|changes in the working tree)\b/.test(lower)) {
		return { target: { kind: "unstaged" }, exact: true };
	}
	if (/\b(staged|in the index|what i staged|cached)\b/.test(lower) && !/\bunstaged\b/.test(lower)) {
		return { target: { kind: "staged" }, exact: true };
	}
	if (/\b(uncommitted|local changes|pending changes|working copy|all my changes|current changes|my changes|working directory|everything i changed)\b/.test(lower)) {
		return { target: { kind: "uncommitted" }, exact: true };
	}

	const lastN = /\b(?:last|latest|previous|past)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+commits?\b/.exec(lower);
	if (lastN) {
		const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
		const n = words[lastN[1]] ?? Number.parseInt(lastN[1], 10);
		if (n >= 1) return { target: { kind: "lastN", n }, exact: true };
	}
	if (/\b(the\s+)?(last|latest|previous|most recent|head)\s+commit\b/.test(lower)) {
		return { target: { kind: "commit", sha: "HEAD" }, exact: true };
	}
	const commit = /\bcommit\s+([0-9a-f]{7,40}|HEAD(?:~\d+|\^+)?)\b/i.exec(t);
	if (commit) return { target: { kind: "commit", sha: commit[1] }, exact: true };

	// "<head> against|vs|compared to <base>"
	const versus = new RegExp(
		String.raw`(?:^|\b(?:review|check|diff|compare)\s+)?(?:the\s+)?(?:changes\s+(?:in|on|of)\s+)?((?:this|my|the|current|our)\s+branch|branch\s+${REF}|HEAD|${REF})\s+(?:against|vs\.?|versus|compared\s+(?:to|with)|relative\s+to|on\s+top\s+of|over)\s+(?:the\s+)?(?:branch\s+)?${REF}`,
		"i",
	).exec(t);
	if (versus && !NOT_A_REF.test(versus[1])) {
		const headWord = versus[1];
		const base = cleanRef(versus[4]);
		return { target: { kind: "range", base, head: headRef(headWord), mergeBase: true }, exact: true };
	}
	// "since|against|vs <base>" (head is HEAD)
	const since = new RegExp(String.raw`\b(?:since|against|vs\.?|versus|compared\s+(?:to|with)|relative\s+to|from)\s+(?:the\s+)?(?:branch\s+)?${REF}`, "i").exec(t);
	if (since) return { target: { kind: "range", base: cleanRef(since[1]), head: "HEAD", mergeBase: true }, exact: true };

	if (/\b(this|my|the|current|our)\s+(branch|pr|pull request|feature)\b/.test(lower)) {
		return { target: { kind: "range", base: baseBranch, head: "HEAD", mergeBase: true }, exact: true };
	}
	// a lone ref or sha
	const lone = /^(?:review\s+)?(?:branch\s+)?([A-Za-z0-9._\/-]+)$/.exec(t);
	if (lone && /^[0-9a-f]{7,40}$/.test(lone[1])) return { target: { kind: "commit", sha: lone[1] }, exact: false };
	if (lone && !/^(review|changes|everything|all)$/i.test(lone[1])) {
		return { target: { kind: "range", base: baseBranch, head: lone[1], mergeBase: true }, exact: false };
	}
	return undefined;
}

async function verifyCommit(ref: string, cwd: string): Promise<string | undefined> {
	const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/** A ref that exists: the name itself, else origin/<name>. */
async function resolveRef(ref: string, cwd: string, warnings: string[]): Promise<{ ref: string; sha: string } | undefined> {
	const sha = await verifyCommit(ref, cwd);
	if (sha) return { ref, sha };
	if (!ref.startsWith("origin/")) {
		const remote = await verifyCommit(`origin/${ref}`, cwd);
		if (remote) {
			warnings.push(`there is no local ${ref}; using origin/${ref}`);
			return { ref: `origin/${ref}`, sha: remote };
		}
	}
	return undefined;
}

export class TargetError extends Error {}

/** Turn a parsed target into git arguments, checking that every ref exists. */
export async function resolveTarget(parsed: { target: DiffTarget; exact: boolean }, label: string, cwd: string, baseBranch: string, source: "parser" | "llm" = "parser"): Promise<ResolvedTarget> {
	const warnings: string[] = [];
	const target = parsed.target;
	switch (target.kind) {
		case "unstaged":
			return { target, label, gitArgs: [], includeUntracked: true, newSide: { kind: "worktree" }, oldSide: { kind: "index" }, exact: parsed.exact, source, warnings };
		case "staged":
			return { target, label, gitArgs: ["--cached"], includeUntracked: false, newSide: { kind: "index" }, oldSide: { kind: "rev", rev: "HEAD" }, exact: parsed.exact, source, warnings };
		case "uncommitted":
			return { target, label, gitArgs: ["HEAD"], includeUntracked: true, newSide: { kind: "worktree" }, oldSide: { kind: "rev", rev: "HEAD" }, exact: parsed.exact, source, warnings };
		case "lastN": {
			const head = await verifyCommit("HEAD", cwd);
			if (!head) throw new TargetError("the repository has no commits");
			const base = await verifyCommit(`HEAD~${target.n}`, cwd);
			const old = base ?? EMPTY_TREE;
			if (!base) warnings.push(`there are fewer than ${target.n} commits; reviewing the whole history`);
			return { target, label, gitArgs: [old, head], includeUntracked: false, newSide: { kind: "rev", rev: head }, oldSide: { kind: "rev", rev: old }, exact: parsed.exact, source, warnings };
		}
		case "commit": {
			const sha = await verifyCommit(target.sha, cwd);
			if (!sha) throw new TargetError(`no commit named ${target.sha}`);
			const parent = await verifyCommit(`${sha}^`, cwd);
			const old = parent ?? EMPTY_TREE;
			return { target: { kind: "commit", sha }, label, gitArgs: [old, sha], includeUntracked: false, newSide: { kind: "rev", rev: sha }, oldSide: { kind: "rev", rev: old }, exact: parsed.exact, source, warnings };
		}
		case "range": {
			let baseName = target.base;
			let base = await resolveRef(baseName, cwd, warnings);
			if (!base && baseName === baseBranch) {
				for (const fallback of ["main", "master"]) {
					base = await resolveRef(fallback, cwd, warnings);
					if (base) {
						warnings.push(`there is no ${baseBranch} branch; comparing against ${base.ref}`);
						baseName = fallback;
						break;
					}
				}
			}
			if (!base) throw new TargetError(`no branch or commit named ${target.base}`);
			const head = await resolveRef(target.head, cwd, warnings);
			if (!head) throw new TargetError(`no branch or commit named ${target.head}`);
			if (!base.ref.startsWith("origin/")) {
				const upstream = await verifyCommit(`origin/${base.ref}`, cwd);
				if (upstream && upstream !== base.sha) {
					const behind = await git(["rev-list", "--count", `${base.sha}..${upstream}`], cwd);
					const n = Number.parseInt(behind.stdout.trim(), 10);
					if (n > 0) warnings.push(`local ${base.ref} is ${n} commit(s) behind origin/${base.ref}; godot-helpers never fetches, so run git fetch yourself if that matters`);
				}
			}
			let oldRev = base.sha;
			if (target.mergeBase) {
				const mb = await git(["merge-base", base.sha, head.sha], cwd);
				if (mb.code !== 0) throw new TargetError(`${base.ref} and ${head.ref} have no common ancestor`);
				oldRev = mb.stdout.trim();
			}
			if (oldRev === head.sha) warnings.push(`${head.ref} has no commits that ${base.ref} does not have`);
			return {
				target: { kind: "range", base: base.ref, head: head.ref, mergeBase: target.mergeBase },
				label,
				gitArgs: [oldRev, head.sha],
				includeUntracked: false,
				newSide: { kind: "rev", rev: head.sha },
				oldSide: { kind: "rev", rev: oldRev },
				exact: parsed.exact,
				source,
				warnings,
			};
		}
	}
}

/** A one-line description of what will be reviewed. */
export function describeTarget(t: ResolvedTarget): string {
	switch (t.target.kind) {
		case "unstaged":
			return "unstaged changes (working tree vs index, untracked files included)";
		case "staged":
			return "staged changes (index vs HEAD)";
		case "uncommitted":
			return "all uncommitted changes (working tree vs HEAD, untracked files included)";
		case "lastN":
			return `the last ${t.target.n} commit(s)`;
		case "commit":
			return `commit ${t.target.sha.slice(0, 12)}`;
		case "range":
			return `${t.target.head} against ${t.target.base}${t.target.mergeBase ? " (since their merge base)" : ""}`;
	}
}

export const TARGET_PROMPT = `Turn a request to review git changes into JSON. Reply with JSON only, one of:
{"kind":"unstaged"} {"kind":"staged"} {"kind":"uncommitted"} {"kind":"lastN","n":3} {"kind":"commit","sha":"<sha or ref>"} {"kind":"range","base":"<ref>","head":"<ref or HEAD>","mergeBase":true}
Use HEAD for "this branch". If the request does not name a base branch, use the default base branch given.`;

/** Parse the model's JSON answer; undefined when it is not one of the shapes. */
export function parseTargetJson(text: string): DiffTarget | undefined {
	const m = /\{[\s\S]*\}/.exec(text);
	if (!m) return undefined;
	try {
		const o = JSON.parse(m[0]) as Record<string, unknown>;
		switch (o.kind) {
			case "unstaged":
			case "staged":
			case "uncommitted":
				return { kind: o.kind };
			case "lastN":
				return typeof o.n === "number" && o.n >= 1 ? { kind: "lastN", n: Math.floor(o.n) } : undefined;
			case "commit":
				return typeof o.sha === "string" && o.sha ? { kind: "commit", sha: o.sha } : undefined;
			case "range":
				return typeof o.base === "string" && o.base
					? { kind: "range", base: o.base, head: typeof o.head === "string" && o.head ? o.head : "HEAD", mergeBase: o.mergeBase !== false }
					: undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
