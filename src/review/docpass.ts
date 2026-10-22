// The doc pass: after the workers, the main session gets one turn in review-docs mode to keep DESIGN.md and
// AGENTS.md consistent with the code. It is the only time edit/write can touch those two files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import type { FileDiff, ReviewComment } from "./types.ts";

export const DOCPASS_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export const DOCPASS_ROLE = `You maintain this project's DESIGN.md and AGENTS.md. A review of a change just finished. Your only job now is to keep those two documents consistent with the code after the change.
- Read the parts of the code you need to confirm what changed.
- Make consistency edits only: describe the architecture as the code now implements it. Do not redesign, do not add opinions or TODOs, do not restate review findings.
- If the change introduces or changes an architectural rule, state it in AGENTS.md as a general invariant: the principle, why it exists, how to spot a violation, and the known instances. Do not narrow an invariant to one example.
- Use edit with small exact replacements. Never rewrite a document.
- If the documents are already accurate, change nothing.
- End with one or two sentences: which sections you changed and why, or that the documents are up to date.`;

export interface DocPassInput {
	targetLabel: string;
	files: FileDiff[];
	comments: ReviewComment[];
}

export function docPassMessage(input: DocPassInput, docs: string[]): string {
	const files = input.files
		.filter((f) => !f.skipped)
		.map((f) => `- ${f.path} (${f.status}, +${f.added} -${f.removed})${f.summary ? `: ${f.summary.split("\n").slice(0, 3).join("; ")}` : ""}`);
	const relevant = input.comments
		.filter((c) => c.discipline === "project" || /DESIGN|AGENTS|architect|invariant|drift/i.test(`${c.title} ${c.body}`))
		.slice(0, 25)
		.map((c) => `- [${c.severity}] ${c.file}${c.line ? `:${c.line}` : ""} ${c.title}`);
	return [
		`Review of ${input.targetLabel} is complete. Now check that ${docs.join(" and ")} still describe the code.`,
		"",
		"Changed files:",
		...files,
		"",
		relevant.length ? "Findings about architecture or the docs:" : "No findings were about architecture or the docs.",
		...relevant,
		"",
		`Update ${docs.join(" and ")} only where they no longer match the code. If nothing needs to change, say so.`,
	].join("\n");
}

export interface DocPassResult {
	patches: { file: string; patch: string }[];
	finalText?: string;
	error?: string;
}

function snapshot(root: string, docs: string[]): Map<string, string | undefined> {
	const m = new Map<string, string | undefined>();
	for (const d of docs) {
		const p = join(root, d);
		m.set(d, existsSync(p) ? readFileSync(p, "utf8") : undefined);
	}
	return m;
}

/** Waits for the doc-pass run; resolved by the agent_settled handler in index.ts. */
export class SettleWaiter {
	private resolveFn?: (aborted: boolean) => void;
	wait(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolveFn = resolve;
		});
	}
	settle(aborted: boolean): void {
		const r = this.resolveFn;
		this.resolveFn = undefined;
		r?.(aborted);
	}
	get pending(): boolean {
		return this.resolveFn !== undefined;
	}
}

export async function runDocPass(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext, input: DocPassInput, waiter: SettleWaiter): Promise<DocPassResult> {
	const root = rt.repo?.toplevel;
	if (!root) return { patches: [], error: "no repository" };
	const docs = rt.config.docs;
	const before = snapshot(root, docs);
	const previousTools = pi.getActiveTools();
	const previousMode = rt.mode;
	pi.setActiveTools(DOCPASS_TOOLS);
	rt.state.set("review-docs", false);
	let finalText: string | undefined;
	try {
		const settled = waiter.wait();
		pi.sendMessage(
			{ customType: "godot-helpers-docpass", content: docPassMessage(input, docs), display: true, details: undefined },
			{ triggerTurn: true },
		);
		const aborted = await settled;
		if (aborted) return { patches: patchesFor(root, docs, before), error: "the doc pass was aborted" };
		const last = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "message")
			.map((e) => (e as { message?: { role?: string; content?: unknown } }).message)
			.filter((m) => m?.role === "assistant")
			.at(-1);
		if (last && Array.isArray(last.content)) {
			finalText = (last.content as { type: string; text?: string }[])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n")
				.trim();
		}
	} finally {
		rt.state.set(previousMode === "advisor" ? "advisor" : "off", false);
		pi.setActiveTools(previousTools);
	}
	return { patches: patchesFor(root, docs, before), finalText };
}

function patchesFor(root: string, docs: string[], before: Map<string, string | undefined>): DocPassResult["patches"] {
	const after = snapshot(root, docs);
	const out: DocPassResult["patches"] = [];
	for (const d of docs) {
		const a = before.get(d) ?? "";
		const b = after.get(d) ?? "";
		if (a !== b) out.push({ file: d, patch: generateUnifiedPatch(d, a, b) });
	}
	return out;
}
