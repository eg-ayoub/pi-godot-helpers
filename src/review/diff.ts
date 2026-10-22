// The change under review: git diff parsed into files and hunks, with the enclosing GDScript functions as
// context, scene/resource changes summarized, and editor noise skipped.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../repo.ts";
import type { DiffLine, FileDiff, Hunk, Lang, ResolvedTarget } from "./types.ts";

const CONTEXT_LINES = 5;
const MAX_ENCLOSING_LINES = 120;
const SCENE_EXCERPT_LINES = 40;

export function langOf(path: string): Lang {
	const p = path.toLowerCase();
	if (p.endsWith(".gd")) return "gdscript";
	if (p.endsWith(".cs")) return "csharp";
	if (p.endsWith(".tscn") || p.endsWith(".scn")) return "scene";
	if (p.endsWith(".tres") || p.endsWith(".res")) return "resource";
	if (p.endsWith(".gdshader") || p.endsWith(".gdshaderinc") || p.endsWith(".shader")) return "shader";
	if (p.endsWith("project.godot") || p.endsWith("export_presets.cfg") || p.endsWith(".gdextension")) return "project";
	return "text";
}

/** Files that are never worth a review comment. */
export function skipReason(path: string): string | undefined {
	if (/(^|\/)\.godot\//.test(path)) return "editor cache";
	if (/\.import$/.test(path)) return "import settings (generated)";
	if (/\.uid$/.test(path)) return "resource UID (generated)";
	if (/\.translation$/.test(path)) return "compiled translation";
	if (/(^|\/)\.(DS_Store|vscode|idea)(\/|$)/.test(path)) return "editor metadata";
	return undefined;
}

/** Undo git's C-style quoting of unusual paths ("a/\303\251.gd"). */
export function unquotePath(p: string): string {
	if (!p.startsWith('"')) return p;
	const body = p.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c !== "\\") {
			bytes.push(...Buffer.from(c, "utf8"));
			continue;
		}
		const n = body[++i];
		if (/[0-7]/.test(n)) {
			bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
			i += 2;
		} else {
			const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
			bytes.push(...Buffer.from(map[n] ?? n, "utf8"));
		}
	}
	return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
	const u = unquotePath(p);
	return u.replace(/^[ab]\//, "");
}

/** Parse `git diff` output (a/ and b/ prefixes). */
export function parseUnifiedDiff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	const lines = text.split("\n");
	let file: FileDiff | undefined;
	let hunk: Hunk | undefined;
	let o = 0;
	let n = 0;
	const finishHunk = () => {
		if (file && hunk) file.hunks.push(hunk);
		hunk = undefined;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("diff --git ")) {
			finishHunk();
			const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
			const newPath = m ? stripPrefix(m[2]) : line.slice(11);
			file = { path: newPath, status: "M", binary: false, lang: langOf(newPath), hunks: [], added: 0, removed: 0 };
			files.push(file);
			continue;
		}
		if (!file) continue;
		if (!hunk) {
			if (line.startsWith("new file mode")) file.status = "A";
			else if (line.startsWith("deleted file mode")) file.status = "D";
			else if (line.startsWith("rename from ")) {
				file.oldPath = unquotePath(line.slice(12));
				file.status = "R";
			} else if (line.startsWith("rename to ")) file.path = unquotePath(line.slice(10));
			else if (line.startsWith("copy from ")) {
				file.oldPath = unquotePath(line.slice(10));
				file.status = "C";
			} else if (line.startsWith("copy to ")) file.path = unquotePath(line.slice(8));
			else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
				file.binary = true;
				file.lang = "binary";
			} else if (line.startsWith("--- ")) {
				const p = line.slice(4);
				if (p !== "/dev/null" && !file.oldPath) {
					const old = stripPrefix(p);
					if (old !== file.path) file.oldPath = old;
				}
				if (p === "/dev/null") file.status = "A";
			} else if (line.startsWith("+++ ")) {
				const p = line.slice(4);
				if (p === "/dev/null") file.status = "D";
				else file.path = stripPrefix(p);
				file.lang = file.binary ? "binary" : langOf(file.path);
			}
		}
		const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
		if (hm) {
			finishHunk();
			o = Number(hm[1]);
			n = Number(hm[3]);
			hunk = {
				id: `${file.path}#${file.hunks.length + 1}`,
				file: file.path,
				oldStart: o,
				oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
				newStart: n,
				newLines: hm[4] === undefined ? 1 : Number(hm[4]),
				header: hm[5] ?? "",
				lines: [],
				tokens: 0,
			};
			continue;
		}
		if (!hunk) continue;
		if (line.startsWith("\\")) continue; // \ No newline at end of file
		const k = line[0];
		const t = line.slice(1);
		let dl: DiffLine | undefined;
		if (k === "+") {
			dl = { k: "+", n: n++, t };
			file.added++;
		} else if (k === "-") {
			dl = { k: "-", o: o++, t };
			file.removed++;
		} else if (k === " " || (line === "" && i < lines.length - 1)) {
			dl = { k: " ", o: o++, n: n++, t };
		}
		if (dl) hunk.lines.push(dl);
	}
	finishHunk();
	return files;
}

export interface GdFunction {
	start: number;
	end: number;
	signature: string;
	indent: number;
}

function indentOf(line: string): number {
	let w = 0;
	for (const c of line) {
		if (c === "\t") w += 4;
		else if (c === " ") w += 1;
		else break;
	}
	return w;
}

/** GDScript functions (1-based inclusive line ranges): a func line and the lines indented deeper than it. */
export function gdscriptFunctions(source: string): GdFunction[] {
	const lines = source.split("\n");
	const out: GdFunction[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)(?:static\s+)?func\s+\w+/.exec(lines[i]);
		if (!m) continue;
		const base = indentOf(lines[i]);
		let end = i;
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j];
			if (l.trim() === "") continue;
			if (indentOf(l) <= base) break;
			end = j;
		}
		out.push({ start: i + 1, end: end + 1, signature: lines[i].trim(), indent: base });
	}
	return out;
}

/** The source of the functions that contain any of `lineNumbers`, numbered, capped at `maxLines`. */
export function enclosingSource(source: string, lineNumbers: number[], label: string, maxLines = MAX_ENCLOSING_LINES): string {
	if (lineNumbers.length === 0) return "";
	const lines = source.split("\n");
	const funcs = gdscriptFunctions(source);
	// innermost function per line
	const chosen = new Map<number, GdFunction>();
	for (const ln of lineNumbers) {
		let best: GdFunction | undefined;
		for (const f of funcs) if (ln >= f.start && ln <= f.end && (!best || f.indent >= best.indent)) best = f;
		if (best) chosen.set(best.start, best);
	}
	const parts: string[] = [];
	let used = 0;
	for (const f of [...chosen.values()].sort((a, b) => a.start - b.start)) {
		const length = f.end - f.start + 1;
		const remaining = maxLines - used;
		if (remaining <= 0) break;
		const take = Math.min(length, remaining);
		const body = lines
			.slice(f.start - 1, f.start - 1 + take)
			.map((l, k) => `${String(f.start + k).padStart(5)}  ${l}`)
			.join("\n");
		parts.push(`${label} lines ${f.start}-${f.end}${take < length ? ` (first ${take})` : ""}:\n${body}`);
		used += take;
	}
	return parts.join("\n\n");
}

/** extends / class_name lines, for routing. */
export function headerLines(source: string): string {
	return source
		.split("\n")
		.slice(0, 40)
		.filter((l) => /^\s*(extends|class_name|@tool|@icon)\b/.test(l))
		.join("\n");
}

/** A readable summary of a scene or resource diff: nodes, connections and resources added or removed. */
export function summarizeSceneDiff(file: FileDiff): string {
	const out: string[] = [];
	let props = 0;
	for (const h of file.hunks) {
		for (const l of h.lines) {
			if (l.k === " ") continue;
			const sign = l.k === "+" ? "added" : "removed";
			const node = /^\[node name="([^"]+)"(?: type="([^"]+)")?(?: parent="([^"]*)")?/.exec(l.t);
			const conn = /^\[connection signal="([^"]+)" from="([^"]*)" to="([^"]*)" method="([^"]+)"/.exec(l.t);
			const res = /^\[(ext_resource|sub_resource)\b/.exec(l.t);
			if (node) out.push(`${sign} node ${node[1]}${node[2] ? ` (${node[2]})` : ""}${node[3] !== undefined ? ` under "${node[3]}"` : ""}`);
			else if (conn) out.push(`${sign} connection ${conn[2] || "."}.${conn[1]} -> ${conn[3] || "."}.${conn[4]}`);
			else if (res) {
				const type = /\btype="([^"]+)"/.exec(l.t)?.[1];
				const path = /\bpath="([^"]+)"/.exec(l.t)?.[1];
				out.push(`${sign} ${res[1]}${type ? ` ${type}` : ""}${path ? ` ${path}` : ""}`);
			}
			else if (/^\s*[\w/]+\s*=/.test(l.t)) props++;
		}
	}
	if (props) out.push(`${props} property line(s) changed`);
	return out.slice(0, 60).join("\n");
}

type Side = ResolvedTarget["newSide"] | ResolvedTarget["oldSide"];

async function readSide(repoRoot: string, side: Side, path: string): Promise<string | undefined> {
	try {
		if (side.kind === "worktree") return await readFile(join(repoRoot, path), "utf8");
		const spec = side.kind === "index" ? `:${path}` : `${side.rev}:${path}`;
		const r = await git(["show", spec], repoRoot);
		return r.code === 0 ? r.stdout : undefined;
	} catch {
		return undefined;
	}
}

/** Render a hunk with line numbers, as workers see it. */
export function renderHunk(h: Hunk): string {
	const head = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ""}`;
	const body = h.lines.map((l) => {
		const num = l.k === "-" ? `${String(l.o).padStart(5)}      ` : l.k === "+" ? `      ${String(l.n).padStart(5)}` : `${String(l.o).padStart(5)} ${String(l.n).padStart(5)}`;
		return `${num} ${l.k}${l.t}`;
	});
	return [head, ...body].join("\n");
}

const DIFF_FLAGS = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", `-U${CONTEXT_LINES}`, "--src-prefix=a/", "--dst-prefix=b/"];

/** The parsed change for a resolved target. */
export async function collectDiff(target: ResolvedTarget, repoRoot: string): Promise<FileDiff[]> {
	const main = await git(["-c", "core.quotePath=false", ...DIFF_FLAGS, ...target.gitArgs], repoRoot);
	if (main.code !== 0) throw new Error(`git diff failed: ${main.stderr.trim()}`);
	let text = main.stdout;
	if (target.includeUntracked) {
		const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], repoRoot);
		for (const f of untracked.stdout.split("\0").filter(Boolean)) {
			const r = await git(["-c", "core.quotePath=false", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", f], repoRoot);
			text += `\n${r.stdout}`;
		}
	}
	const files = parseUnifiedDiff(text);
	for (const file of files) {
		const skip = skipReason(file.path);
		if (skip) {
			file.skipped = skip;
			continue;
		}
		if (file.binary) {
			file.skipped = "binary file";
			continue;
		}
		if (file.lang === "scene" || file.lang === "resource") {
			file.summary = summarizeSceneDiff(file);
		}
		let newSource: string | undefined;
		let oldSource: string | undefined;
		if (file.lang === "gdscript") {
			if (file.status !== "D") newSource = await readSide(repoRoot, target.newSide, file.path);
			if (file.status !== "A") oldSource = await readSide(repoRoot, target.oldSide, file.oldPath ?? file.path);
			file.headerLines = headerLines(newSource ?? oldSource ?? "");
		}
		for (const h of file.hunks) {
			if (file.lang === "gdscript") {
				const added = h.lines.filter((l) => l.k === "+").map((l) => l.n as number);
				const removed = h.lines.filter((l) => l.k === "-").map((l) => l.o as number);
				const parts: string[] = [];
				if (newSource && added.length) parts.push(enclosingSource(newSource, added, `${file.path} (new)`));
				if (oldSource && removed.length && !added.length) parts.push(enclosingSource(oldSource, removed, `${file.path} (old)`));
				h.enclosing = parts.filter(Boolean).join("\n\n") || undefined;
			}
			const shown = file.summary ? h.lines.filter((l) => l.k !== " ").slice(0, SCENE_EXCERPT_LINES).length * 60 : renderHunk(h).length;
			h.tokens = Math.ceil((shown + (h.enclosing?.length ?? 0)) / 4);
		}
	}
	return files;
}

/** Files a review looks at (not skipped). */
export function reviewable(files: FileDiff[]): FileDiff[] {
	return files.filter((f) => !f.skipped && f.hunks.length > 0);
}
