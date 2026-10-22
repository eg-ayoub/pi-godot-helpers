// Comments must point at lines of the diff. A comment on a line outside every hunk is moved to the nearest
// changed line of the same file (and says so); a comment on a file outside the change becomes file-level.
import type { FileDiff } from "./types.ts";

export interface AnchorRequest {
	file: string;
	line?: number | null;
	endLine?: number;
	side?: "new" | "old";
}

export interface Anchor {
	file: string;
	side: "new" | "old";
	line: number | null;
	endLine?: number;
	hunkId?: string;
	adjusted?: { requested: number; reason: string };
	inDiff: boolean;
}

/** Find the diff file a comment names: exact path, then a unique suffix match. */
export function findFile(path: string, files: FileDiff[]): FileDiff | undefined {
	const clean = path.replace(/^\.\//, "").replace(/^[ab]\//, "");
	const exact = files.find((f) => f.path === clean || f.oldPath === clean);
	if (exact) return exact;
	const matches = files.filter((f) => f.path.endsWith(`/${clean}`) || clean.endsWith(`/${f.path}`));
	return matches.length === 1 ? matches[0] : undefined;
}

function linesOn(file: FileDiff, side: "new" | "old"): { line: number; hunkId: string; changed: boolean }[] {
	const out: { line: number; hunkId: string; changed: boolean }[] = [];
	for (const h of file.hunks) {
		for (const l of h.lines) {
			const n = side === "new" ? l.n : l.o;
			if (n !== undefined) out.push({ line: n, hunkId: h.id, changed: l.k !== " " });
		}
	}
	return out;
}

export function anchorComment(req: AnchorRequest, files: FileDiff[]): Anchor {
	const file = findFile(req.file, files);
	if (!file) return { file: req.file, side: req.side ?? "new", line: req.line ?? null, inDiff: false };
	const side = req.side ?? (file.status === "D" ? "old" : "new");
	if (req.line === undefined || req.line === null) return { file: file.path, side, line: null, inDiff: true };
	const requested = req.line;
	for (const s of side === "new" ? (["new", "old"] as const) : (["old", "new"] as const)) {
		const hit = linesOn(file, s).find((x) => x.line === requested);
		if (hit) {
			return {
				file: file.path,
				side: s,
				line: requested,
				endLine: req.endLine && req.endLine >= requested ? req.endLine : undefined,
				hunkId: hit.hunkId,
				adjusted: s !== side ? { requested, reason: `line ${requested} exists only on the ${s} side` } : undefined,
				inDiff: true,
			};
		}
	}
	const candidates = linesOn(file, side);
	if (candidates.length === 0) return { file: file.path, side, line: null, inDiff: true, adjusted: { requested, reason: "no lines on that side; file-level comment" } };
	// prefer changed lines, then the nearest
	const best = candidates
		.map((c) => ({ ...c, d: Math.abs(c.line - requested) + (c.changed ? 0 : 0.5) }))
		.sort((a, b) => a.d - b.d)[0];
	return {
		file: file.path,
		side,
		line: best.line,
		hunkId: best.hunkId,
		adjusted: { requested, reason: `line ${requested} is outside the diff; moved to the nearest diff line ${best.line}` },
		inDiff: true,
	};
}

/** The diff text at an anchor (for fingerprints and the viewer). */
export function lineText(files: FileDiff[], anchor: Pick<Anchor, "file" | "side" | "line">): string {
	if (anchor.line === null) return "";
	const file = files.find((f) => f.path === anchor.file);
	for (const h of file?.hunks ?? []) {
		for (const l of h.lines) if ((anchor.side === "new" ? l.n : l.o) === anchor.line) return l.t;
	}
	return "";
}
