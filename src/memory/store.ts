// Long-term memory of one repository, outside the repository: <agent dir>/godot-helpers/<repo-id>/.
// Only the extension (the parent process) writes here; the model proposes through tools, workers through
// their out.jsonl. Writes are atomic (temp file + rename).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../repo.ts";
import type { Severity } from "../review/types.ts";

export const MEMORY_VERSION = 1;

export interface Provenance {
	kind: "advisor" | "review" | "worker" | "user";
	at: string;
	reviewId?: string;
	session?: string;
}

export interface FileNote {
	v: number;
	path: string;
	/** Blob of the file when the note was written (computed by the extension). */
	blobSha: string;
	summary: string;
	symbols?: { className?: string; extends?: string; signals?: string[]; functions?: string[] };
	pitfalls?: string[];
	provenance: Provenance;
	updatedAt: string;
}

export type FactCategory = "architecture" | "convention" | "decision" | "pitfall" | "workflow" | "other";

export interface Fact {
	id: string;
	text: string;
	category: FactCategory;
	files?: string[];
	provenance: Provenance[];
	hits: number;
	createdAt: string;
	lastUsedAt?: string;
	status: "active" | "superseded";
	supersededBy?: string;
}

export interface RaisedItem {
	fingerprint: string;
	file: string;
	discipline: string;
	title: string;
	severity: Severity;
	firstReviewId: string;
	lastReviewId: string;
	occurrences: number;
	/** The verification that found it fixed; cleared when a later review raises it again. */
	resolvedIn?: string;
}

export function writeAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function notePathKey(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** Words of a text, lowercased, for matching and dedupe. */
export function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((w) => w.length > 2);
}

export function jaccard(a: string, b: string): number {
	const A = new Set(words(a));
	const B = new Set(words(b));
	if (A.size === 0 || B.size === 0) return 0;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	return inter / (A.size + B.size - inter);
}

/** GDScript symbols, extracted by the extension (no model involved). */
export function gdSymbols(source: string): FileNote["symbols"] {
	const className = /^class_name\s+(\w+)/m.exec(source)?.[1];
	const ext = /^extends\s+([\w."/]+)/m.exec(source)?.[1];
	const signals = [...source.matchAll(/^signal\s+(\w+)/gm)].map((m) => m[1]);
	const functions = [...source.matchAll(/^(?:static\s+)?func\s+(\w+)/gm)].map((m) => m[1]);
	return { className, extends: ext, signals: signals.length ? signals : undefined, functions: functions.length ? functions.slice(0, 40) : undefined };
}

export class MemoryStore {
	readonly dir: string;
	readonly repoRoot: string;

	constructor(dir: string, repoRoot: string) {
		this.dir = dir;
		this.repoRoot = repoRoot;
	}

	// ------------------------------------------------------------------------------------------- notes

	private noteFile(path: string): string {
		return join(this.dir, "notes", `${notePathKey(path)}.json`);
	}

	/** The working-tree blob of a file (git hash-object, without writing objects), or undefined if gone. */
	async currentBlob(path: string): Promise<string | undefined> {
		if (!existsSync(join(this.repoRoot, path))) return undefined;
		const r = await git(["hash-object", "--", path], this.repoRoot);
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	getNote(path: string): FileNote | undefined {
		return readJsonFile<FileNote | undefined>(this.noteFile(path), undefined);
	}

	allNotes(): FileNote[] {
		const dir = join(this.dir, "notes");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => readJsonFile<FileNote | undefined>(join(dir, f), undefined))
			.filter((n): n is FileNote => !!n);
	}

	async putNote(path: string, summary: string, pitfalls: string[] | undefined, provenance: Provenance, maxChars: number): Promise<FileNote> {
		const blobSha = (await this.currentBlob(path)) ?? "missing";
		let symbols: FileNote["symbols"];
		if (path.endsWith(".gd") && existsSync(join(this.repoRoot, path))) symbols = gdSymbols(readFileSync(join(this.repoRoot, path), "utf8"));
		const note: FileNote = {
			v: MEMORY_VERSION,
			path,
			blobSha,
			summary: summary.trim().slice(0, maxChars),
			symbols,
			pitfalls: pitfalls?.map((p) => p.trim()).filter(Boolean).slice(0, 10),
			provenance,
			updatedAt: new Date().toISOString(),
		};
		writeAtomic(this.noteFile(path), JSON.stringify(note, null, 1));
		return note;
	}

	/** A note and whether the file changed since it was written. */
	async noteWithFreshness(path: string): Promise<{ note: FileNote; fresh: boolean; current?: string } | undefined> {
		const note = this.getNote(path);
		if (!note) return undefined;
		const current = await this.currentBlob(path);
		return { note, fresh: current === note.blobSha, current };
	}

	// ------------------------------------------------------------------------------------------- facts

	private factsFile(): string {
		return join(this.dir, "facts.json");
	}

	facts(): Fact[] {
		return readJsonFile<{ v: number; facts: Fact[] }>(this.factsFile(), { v: MEMORY_VERSION, facts: [] }).facts;
	}

	saveFacts(facts: Fact[]): void {
		writeAtomic(this.factsFile(), JSON.stringify({ v: MEMORY_VERSION, facts }, null, 1));
	}

	addFact(
		input: { text: string; category: FactCategory; files?: string[] },
		provenance: Provenance,
		limits: { maxFacts: number; maxFactChars: number },
	): { outcome: "added" | "merged" | "rejected"; fact?: Fact; reason?: string } {
		const text = input.text.trim().replace(/\s+/g, " ");
		if (!text) return { outcome: "rejected", reason: "empty fact" };
		if (text.length > limits.maxFactChars) return { outcome: "rejected", reason: `facts are limited to ${limits.maxFactChars} characters; state it more briefly` };
		const facts = this.facts();
		const norm = text.toLowerCase();
		const same = facts.find((f) => f.status === "active" && (f.text.toLowerCase() === norm || jaccard(f.text, text) >= 0.8));
		if (same) {
			same.provenance.push(provenance);
			same.hits += 1;
			if (text.length > same.text.length) same.text = text;
			same.files = [...new Set([...(same.files ?? []), ...(input.files ?? [])])];
			this.saveFacts(facts);
			return { outcome: "merged", fact: same };
		}
		if (facts.filter((f) => f.status === "active").length >= limits.maxFacts) {
			return { outcome: "rejected", reason: `memory holds ${limits.maxFacts} facts already; run /memory-consolidate` };
		}
		const fact: Fact = {
			id: `f${createHash("sha1").update(norm).digest("hex").slice(0, 10)}`,
			text,
			category: input.category,
			files: input.files?.length ? input.files : undefined,
			provenance: [provenance],
			hits: 0,
			createdAt: new Date().toISOString(),
			status: "active",
		};
		facts.push(fact);
		this.saveFacts(facts);
		return { outcome: "added", fact };
	}

	/** Mark facts as used (they rank higher in briefs and searches). */
	touchFacts(ids: string[]): void {
		if (ids.length === 0) return;
		const facts = this.facts();
		const now = new Date().toISOString();
		for (const f of facts) {
			if (ids.includes(f.id)) {
				f.hits += 1;
				f.lastUsedAt = now;
			}
		}
		this.saveFacts(facts);
	}

	// ------------------------------------------------------------------------------------------ raised

	private raisedFile(): string {
		return join(this.dir, "raised.json");
	}

	raised(): Map<string, RaisedItem> {
		const list = readJsonFile<RaisedItem[]>(this.raisedFile(), []);
		return new Map(list.map((r) => [r.fingerprint, r]));
	}

	recordRaised(items: Omit<RaisedItem, "firstReviewId" | "lastReviewId" | "occurrences" | "resolvedIn">[], reviewId: string): void {
		const map = this.raised();
		for (const item of items) {
			const existing = map.get(item.fingerprint);
			if (existing) {
				if (existing.lastReviewId !== reviewId) existing.occurrences += 1;
				existing.lastReviewId = reviewId;
				existing.severity = item.severity;
				existing.title = item.title;
				delete existing.resolvedIn;
			} else map.set(item.fingerprint, { ...item, firstReviewId: reviewId, lastReviewId: reviewId, occurrences: 1 });
		}
		writeAtomic(this.raisedFile(), JSON.stringify([...map.values()], null, 1));
	}

	/** Mark raised items as fixed (a verification found them gone); later reviews no longer list them. */
	resolveRaised(fingerprints: string[], verificationId: string): number {
		const map = this.raised();
		let n = 0;
		for (const fp of fingerprints) {
			const item = map.get(fp);
			if (!item || item.resolvedIn) continue;
			item.resolvedIn = verificationId;
			n++;
		}
		if (n) writeAtomic(this.raisedFile(), JSON.stringify([...map.values()], null, 1));
		return n;
	}

	// ------------------------------------------------------------------------------------------ search

	/** Keyword search over notes and facts, best first. */
	search(query: string, limit = 8): { kind: "note" | "fact"; score: number; note?: FileNote; fact?: Fact }[] {
		const q = new Set(words(query));
		if (q.size === 0) return [];
		const score = (text: string) => {
			const ws = words(text);
			let s = 0;
			for (const w of ws) if (q.has(w)) s += 1;
			return ws.length ? s / Math.sqrt(ws.length) : 0;
		};
		const out: { kind: "note" | "fact"; score: number; note?: FileNote; fact?: Fact }[] = [];
		for (const n of this.allNotes()) {
			const text = `${n.path} ${n.symbols?.className ?? ""} ${(n.symbols?.functions ?? []).join(" ")} ${(n.symbols?.signals ?? []).join(" ")} ${n.summary} ${(n.pitfalls ?? []).join(" ")}`;
			const s = score(text) + (words(n.path).some((w) => q.has(w)) ? 1 : 0);
			if (s > 0) out.push({ kind: "note", score: s, note: n });
		}
		for (const f of this.facts()) {
			if (f.status !== "active") continue;
			const s = score(`${f.text} ${(f.files ?? []).join(" ")} ${f.category}`);
			if (s > 0) out.push({ kind: "fact", score: s + Math.min(f.hits, 10) * 0.02, fact: f });
		}
		return out.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	stats(): { notes: number; facts: number; raised: number; reviews: number } {
		const reviews = join(this.dir, "reviews");
		return {
			notes: this.allNotes().length,
			facts: this.facts().filter((f) => f.status === "active").length,
			raised: [...this.raised().values()].filter((r) => !r.resolvedIn).length,
			reviews: existsSync(reviews) ? readdirSync(reviews).length : 0,
		};
	}
}
