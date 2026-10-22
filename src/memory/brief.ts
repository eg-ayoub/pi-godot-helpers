// A short project brief built from the repository itself (no model call): Godot projects, autoloads, main
// scene, a class_name index and the folder layout, plus the most useful remembered facts. Cached per tree.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../repo.ts";
import { writeAtomic, type Fact, type MemoryStore } from "./store.ts";

const MAX_CLASSES = 200;
const MAX_FACT_CHARS = 2500;

export function parseProjectGodot(text: string): { name?: string; mainScene?: string; autoloads: { name: string; path: string }[] } {
	const autoloads: { name: string; path: string }[] = [];
	let section = "";
	let name: string | undefined;
	let mainScene: string | undefined;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const sec = /^\[(.+)\]$/.exec(line);
		if (sec) {
			section = sec[1];
			continue;
		}
		const kv = /^([\w/]+)\s*=\s*(.*)$/.exec(line);
		if (!kv) continue;
		const value = kv[2].replace(/^"|"$/g, "");
		if (section === "application" && kv[1] === "config/name") name = value;
		if (section === "application" && kv[1] === "run/main_scene") mainScene = value;
		if (section === "autoload") autoloads.push({ name: kv[1], path: value.replace(/^\*/, "") });
	}
	return { name, mainScene, autoloads };
}

async function cacheKey(root: string): Promise<string> {
	const tree = await git(["rev-parse", "HEAD^{tree}"], root);
	const changed = await git(["status", "--porcelain", "--untracked-files=normal"], root);
	return createHash("sha1").update(`${tree.stdout.trim()}\n${changed.stdout}`).digest("hex").slice(0, 16);
}

/** The structural part of the brief (cached until the tree or the working-tree status changes). */
export async function structuralBrief(store: MemoryStore, godotProjects: string[]): Promise<string> {
	const root = store.repoRoot;
	const key = await cacheKey(root);
	const cacheFile = join(store.dir, "brief.json");
	if (existsSync(cacheFile)) {
		try {
			const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { key: string; text: string };
			if (cached.key === key) return cached.text;
		} catch {
			// rebuild
		}
	}
	const out: string[] = [];
	for (const project of godotProjects) {
		const file = join(root, project, "project.godot");
		if (!existsSync(file)) continue;
		const p = parseProjectGodot(readFileSync(file, "utf8"));
		out.push(`Godot project ${p.name ? `"${p.name}" ` : ""}at ${project || "."}${p.mainScene ? `, main scene ${p.mainScene}` : ""}.`);
		if (p.autoloads.length) out.push(`Autoloads: ${p.autoloads.map((a) => `${a.name} (${a.path})`).join(", ")}.`);
	}
	const classes = await git(["grep", "--untracked", "-n", "-I", "-E", "^class_name[[:space:]]+[A-Za-z_][A-Za-z0-9_]*", "--", "*.gd"], root);
	const entries = classes.stdout
		.split("\n")
		.map((l) => /^(.+?):\d+:class_name\s+(\w+)/.exec(l))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => `${m[2]}=${m[1]}`)
		.sort();
	if (entries.length) out.push(`Classes (class_name=file): ${entries.slice(0, MAX_CLASSES).join(", ")}${entries.length > MAX_CLASSES ? `, … ${entries.length - MAX_CLASSES} more` : ""}.`);
	const files = await git(["ls-files", "--cached", "--others", "--exclude-standard"], root);
	const dirs = new Map<string, { gd: number; tscn: number; tres: number }>();
	for (const f of files.stdout.split("\n")) {
		if (!/\.(gd|tscn|tres)$/.test(f)) continue;
		const parts = f.split("/");
		const d = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0] : ".";
		const c = dirs.get(d) ?? { gd: 0, tscn: 0, tres: 0 };
		if (f.endsWith(".gd")) c.gd++;
		else if (f.endsWith(".tscn")) c.tscn++;
		else c.tres++;
		dirs.set(d, c);
	}
	if (dirs.size) {
		const list = [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 60);
		out.push(`Folders: ${list.map(([d, c]) => `${d} (${[c.gd && `${c.gd} gd`, c.tscn && `${c.tscn} tscn`, c.tres && `${c.tres} tres`].filter(Boolean).join(", ")})`).join("; ")}.`);
	}
	const text = out.join("\n");
	writeAtomic(cacheFile, JSON.stringify({ key, text }));
	return text;
}

/** Remembered facts worth putting in front of the model, most useful first, within a character budget. */
export function topFacts(facts: Fact[], files?: string[], budget = MAX_FACT_CHARS): Fact[] {
	const active = facts.filter((f) => f.status === "active");
	const touched = new Set(files ?? []);
	const scored = active.map((f) => ({
		f,
		s: (f.files?.some((x) => touched.has(x)) ? 10 : 0) + (f.category === "architecture" || f.category === "convention" ? 3 : 0) + Math.min(f.hits, 20) * 0.3,
	}));
	scored.sort((a, b) => b.s - a.s || b.f.createdAt.localeCompare(a.f.createdAt));
	const out: Fact[] = [];
	let used = 0;
	for (const { f } of scored) {
		if (used + f.text.length > budget) continue;
		out.push(f);
		used += f.text.length;
	}
	return out;
}

export function renderFacts(facts: Fact[]): string {
	return facts.map((f) => `- (${f.category}) ${f.text}${f.files?.length ? ` [${f.files.join(", ")}]` : ""}`).join("\n");
}
