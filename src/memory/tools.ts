// Memory tools for the model, memory sections for prompts, and the review hooks that keep memory current.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewController } from "../review/pipeline.ts";
import type { FileDiff, ReviewComment, RoutedUnit } from "../review/types.ts";
import { appendOut, loadUnit } from "../review/worker-mode.ts";
import type { Runtime } from "../runtime.ts";
import { showReport } from "../ui/report.ts";
import { renderFacts, structuralBrief, topFacts } from "./brief.ts";
import { jaccard, MemoryStore, notePathKey, type FactCategory, type FileNote, type Provenance } from "./store.ts";

export function memoryFor(rt: Runtime): MemoryStore | undefined {
	const dir = rt.repoDataDir();
	return rt.active && rt.repo && dir ? new MemoryStore(dir, rt.repo.toplevel) : undefined;
}

function provenance(rt: Runtime, ctx: ExtensionContext | undefined): Provenance {
	const kind = rt.mode === "worker" ? "worker" : rt.mode === "advisor" ? "advisor" : "review";
	return { kind, at: new Date().toISOString(), session: ctx?.sessionManager.getSessionId() };
}

function renderNote(n: FileNote, fresh: boolean): string {
	const sym = n.symbols;
	const symText = sym ? [sym.className && `class ${sym.className}`, sym.extends && `extends ${sym.extends}`, sym.signals?.length && `signals: ${sym.signals.join(", ")}`].filter(Boolean).join("; ") : "";
	return [
		`### ${n.path}${fresh ? "" : " (STALE: the file changed since this note; recheck before relying on it)"}`,
		symText,
		n.summary,
		...(n.pitfalls ?? []).map((p) => `- pitfall: ${p}`),
	]
		.filter(Boolean)
		.join("\n");
}

const CATEGORIES = ["architecture", "convention", "decision", "pitfall", "workflow", "other"] as const;

export function registerMemory(pi: ExtensionAPI, rt: Runtime, reviews: ReviewController): void {
	pi.registerTool({
		name: "memory_search",
		label: "memory search",
		description:
			"Search what earlier sessions learned about this repository (per-file notes and project facts) before exploring code again. Notes marked STALE describe an older version of the file.",
		promptSnippet: "memory_search: search remembered notes and facts about this repository",
		defaultActive: false,
		parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
		async execute(_id, params) {
			const store = memoryFor(rt);
			if (!store) throw new Error("memory is only available in a Godot repository");
			const hits = store.search(params.query, params.limit ?? 8);
			if (hits.length === 0) return { content: [{ type: "text", text: "Nothing remembered matches." }], details: undefined };
			const parts: string[] = [];
			const used: string[] = [];
			for (const h of hits) {
				if (h.note) {
					const fresh = (await store.currentBlob(h.note.path)) === h.note.blobSha;
					parts.push(renderNote(h.note, fresh));
				} else if (h.fact) {
					parts.push(`- fact ${h.fact.id} (${h.fact.category}): ${h.fact.text}`);
					used.push(h.fact.id);
				}
			}
			store.touchFacts(used);
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "memory get",
		description: "Get the remembered notes for specific files (repository-relative paths).",
		promptSnippet: "memory_get: remembered notes for given files",
		defaultActive: false,
		parameters: Type.Object({ paths: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
		async execute(_id, params) {
			const store = memoryFor(rt);
			if (!store) throw new Error("memory is only available in a Godot repository");
			const parts: string[] = [];
			for (const p of params.paths) {
				const r = await store.noteWithFreshness(p.replace(/^\.\//, ""));
				parts.push(r ? renderNote(r.note, r.fresh) : `### ${p}\n(no note)`);
			}
			return { content: [{ type: "text", text: parts.join("\n\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_note_file",
		label: "memory note",
		description:
			"Remember what you learned about one file after reading it: its role, how it is used, and pitfalls. Later sessions read this instead of re-reading the file while the file is unchanged. Keep it factual and short.",
		promptSnippet: "memory_note_file: remember what a file does after reading it",
		defaultActive: false,
		parameters: Type.Object({
			path: Type.String({ description: "Repository-relative path" }),
			summary: Type.String({ description: "Role of the file, key types/functions, how other code uses it (at most ~1500 characters)" }),
			pitfalls: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = params.path.replace(/^\.\//, "");
			if (rt.mode === "worker" && rt.workerUnitFile) {
				appendOut(loadUnit(rt.workerUnitFile), { type: "note", path, summary: params.summary, pitfalls: params.pitfalls });
				return { content: [{ type: "text", text: `Noted ${path}.` }], details: undefined };
			}
			const store = memoryFor(rt);
			if (!store) throw new Error("memory is only available in a Godot repository");
			if (!existsSync(join(store.repoRoot, path))) throw new Error(`${path} does not exist in the repository`);
			await store.putNote(path, params.summary, params.pitfalls, provenance(rt, ctx), rt.config.memory.noteMaxChars);
			return { content: [{ type: "text", text: `Noted ${path}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "memory_add_fact",
		label: "memory fact",
		description:
			"Remember a durable fact about this project (an architectural rule, a convention, a decision and its reason, a pitfall). Not for transient details of the current task. One fact per call, one or two sentences.",
		promptSnippet: "memory_add_fact: remember a durable project fact",
		defaultActive: false,
		parameters: Type.Object({
			text: Type.String(),
			category: StringEnum(CATEGORIES),
			files: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const store = memoryFor(rt);
			if (!store) throw new Error("memory is only available in a Godot repository");
			const r = store.addFact({ text: params.text, category: params.category as FactCategory, files: params.files }, provenance(rt, ctx), rt.config.memory);
			const text = r.outcome === "rejected" ? `Not remembered: ${r.reason}` : r.outcome === "merged" ? `Already known (${r.fact?.id}); merged.` : `Remembered as ${r.fact?.id}.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// the advisor gets the brief and the top facts as a stable section
	pi.on("before_agent_start", async (event) => {
		if (!rt.active || !rt.repo || (rt.mode !== "advisor" && rt.mode !== "review-docs")) return;
		const store = memoryFor(rt);
		if (!store) return;
		try {
			const brief = await structuralBrief(store, rt.repo.godotProjects);
			const facts = topFacts(store.facts());
			event.systemPromptOptions.sections.godot_project_brief = [brief, facts.length ? `Remembered facts:\n${renderFacts(facts)}` : ""].filter(Boolean).join("\n\n");
		} catch {
			// a brief is a convenience; never block a run on it
		}
	});

	// review integration: memory in the worker prompts, raised items, merging the workers' notes
	reviews.hooks.extraSections = async (unit: RoutedUnit, files: FileDiff[]) => {
		const store = memoryFor(rt);
		if (!store || !rt.repo) return [];
		const sections: { title: string; body: string }[] = [];
		sections.push({ title: "project_brief", body: await structuralBrief(store, rt.repo.godotProjects) });
		const notes: string[] = [];
		for (const path of unit.files) {
			const r = await store.noteWithFreshness(path);
			if (r) notes.push(renderNote(r.note, r.fresh));
		}
		if (notes.length) sections.push({ title: "file_notes", body: `What earlier sessions learned about these files:\n\n${notes.join("\n\n")}` });
		const facts = topFacts(store.facts(), unit.files, 1500);
		if (facts.length) sections.push({ title: "project_facts", body: renderFacts(facts) });
		const raised = [...store.raised().values()].filter((r) => !r.resolvedIn && unit.files.includes(r.file)).slice(0, rt.config.memory.maxRaisedPerUnit);
		if (raised.length) {
			sections.push({
				title: "already_raised",
				body: `Raised in earlier reviews (if still present, report them again briefly; they will be marked as repeats):\n${raised.map((r) => `- [${r.severity}] ${r.file}: ${r.title} (${r.occurrences}x)`).join("\n")}`,
			});
		}
		void files;
		return sections;
	};

	reviews.hooks.markRaised = async (comments: ReviewComment[]) => {
		const store = memoryFor(rt);
		if (!store) return;
		const raised = store.raised();
		for (const c of comments) {
			const r = raised.get(c.fingerprint);
			if (r) c.alreadyRaised = { reviewId: r.firstReviewId, occurrences: r.occurrences };
		}
	};

	reviews.hooks.afterVerify = async (record) => {
		const store = memoryFor(rt);
		if (!store) return;
		store.resolveRaised(record.comments.filter((c) => c.verdict?.status === "fixed").map((c) => c.fingerprint), record.id);
	};

	reviews.hooks.afterReview = async (record, notes, ctx) => {
		const store = memoryFor(rt);
		if (!store) return;
		store.recordRaised(
			record.comments.filter((c) => c.source === "worker" && c.file).map((c) => ({ fingerprint: c.fingerprint, file: c.file, discipline: c.discipline, title: c.title, severity: c.severity })),
			record.id,
		);
		for (const n of notes) {
			if (n.type !== "note" || typeof n.path !== "string" || typeof n.summary !== "string") continue;
			if (!existsSync(join(store.repoRoot, n.path))) continue;
			await store.putNote(n.path, n.summary, Array.isArray(n.pitfalls) ? (n.pitfalls as string[]) : undefined, { kind: "worker", at: new Date().toISOString(), reviewId: record.id }, rt.config.memory.noteMaxChars);
		}
		void ctx;
	};

	pi.registerCommand("memory", {
		description: "What godot-helpers remembers about this repository: /memory [facts|notes|forget <fact id>]",
		handler: async (args, ctx) => {
			await rt.refresh(ctx);
			const store = memoryFor(rt);
			if (!store) {
				ctx.ui.notify("Memory works inside a Godot project.", "warning");
				return;
			}
			const [sub, arg] = args.trim().split(/\s+/);
			if (sub === "forget" && arg) {
				const facts = store.facts();
				const f = facts.find((x) => x.id === arg);
				if (!f) return ctx.ui.notify(`No fact ${arg}.`, "warning");
				f.status = "superseded";
				store.saveFacts(facts);
				return ctx.ui.notify(`Forgot ${arg}.`, "info");
			}
			const s = store.stats();
			const lines = [`memory: ${store.dir}`, `${s.notes} file note(s), ${s.facts} fact(s), ${s.raised} open raised item(s), ${s.reviews} review(s)`];
			if (sub === "facts" || !sub) {
				for (const f of store.facts().filter((x) => x.status === "active").slice(0, sub ? 500 : 15)) lines.push(`${f.id} (${f.category}, used ${f.hits}x): ${f.text}`);
			}
			if (sub === "notes") {
				for (const n of store.allNotes()) {
					const fresh = (await store.currentBlob(n.path)) === n.blobSha;
					lines.push(`${n.path}${fresh ? "" : " (stale)"}: ${n.summary.slice(0, 100)}`);
				}
			}
			showReport(pi, ctx.hasUI, "godot-helpers memory", lines);
		},
	});

	pi.registerCommand("memory-consolidate", {
		description: "Clean up memory: merge near-duplicate facts, drop notes of deleted files (asks first)",
		handler: async (_args, ctx) => {
			await rt.refresh(ctx);
			const store = memoryFor(rt);
			if (!store) return ctx.ui.notify("Memory works inside a Godot project.", "warning");
			const facts = store.facts();
			const active = facts.filter((f) => f.status === "active");
			const merges: [string, string][] = [];
			for (let i = 0; i < active.length; i++) {
				for (let j = i + 1; j < active.length; j++) {
					const a = active[i];
					const b = active[j];
					if (a.status !== "active" || b.status !== "active") continue;
					if (jaccard(a.text, b.text) >= 0.6) merges.push([b.id, a.id]);
				}
			}
			const orphans = store.allNotes().filter((n) => !existsSync(join(store.repoRoot, n.path)));
			if (merges.length === 0 && orphans.length === 0) return ctx.ui.notify("Memory is already tidy.", "info");
			const summary = `${merges.length} near-duplicate fact(s) to merge, ${orphans.length} note(s) of deleted files to drop.`;
			const ok = ctx.hasUI ? await ctx.ui.confirm("Consolidate memory?", summary) : true;
			if (!ok) return;
			for (const [dup, keep] of merges) {
				const d = facts.find((f) => f.id === dup);
				const k = facts.find((f) => f.id === keep);
				if (!d || !k) continue;
				d.status = "superseded";
				d.supersededBy = keep;
				k.provenance.push(...d.provenance);
				k.hits += d.hits;
			}
			store.saveFacts(facts);
			for (const n of orphans) rmSync(join(store.dir, "notes", `${notePathKey(n.path)}.json`), { force: true });
			ctx.ui.notify(`Consolidated: ${summary}`, "info");
		},
	});
}
