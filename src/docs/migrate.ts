// /agents-md-migrate: restructure AGENTS.md into invariants (principle, why, signals, known instances) after
// templates/AGENTS.template.md, so a review checks the rule behind each checklist line and not only its one
// example. The model reads and proposes the new file with agents_md_propose; it cannot edit anything. The user
// sees the diff and confirms; then the extension writes AGENTS.md itself. Every proposal is kept in memory.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewController } from "../review/pipeline.ts";
import { PACKAGE_ROOT, type Runtime } from "../runtime.ts";
import { docForPath } from "../security/gate.ts";
import { showReport } from "../ui/report.ts";

export const MIGRATE_TOOLS = ["read", "grep", "find", "ls", "bash", "agents_md_propose"];
export const TEMPLATE = join(PACKAGE_ROOT, "templates", "AGENTS.template.md");

export function migrateMessage(current: string, template: string, docs: string[]): string {
	return [
		"Restructure this repository's AGENTS.md after the template below. You cannot edit files: when you are done, call agents_md_propose once with the complete new AGENTS.md.",
		"",
		"Rules:",
		"- Keep the critical rule word for word.",
		"- Keep every project-specific fact: names, paths, commands, conventions, pointers. Nothing the current file says may be lost; move it to the right section instead.",
		"- Turn each checklist item into an invariant: state the general principle it is an instance of, why it exists, the signals of a violation (searchable names and patterns), and keep the original item as a known instance. Group items that are instances of the same principle.",
		`- Read ${docs.includes("DESIGN.md") ? "DESIGN.md and " : ""}the code to make the principle, the why and the signals accurate. Do not invent rules the documents and the code do not support. Write \"(to confirm)\" after a rationale you inferred.`,
		"- Replace a list of skills to use and a review procedure with one line: the reviewer routes skills and runs the checks itself (pi-godot-helpers).",
		"- Keep the checks as commands people can run by hand.",
		"- Keep the template's section on keeping DESIGN.md and AGENTS.md current.",
		"- Plain words, short sentences. No emoji.",
		"",
		"<template>",
		template.trim(),
		"</template>",
		"",
		"<current_agents_md>",
		current.trim(),
		"</current_agents_md>",
	].join("\n");
}

interface Proposal {
	content: string;
	summary: string;
}

export function registerMigrate(pi: ExtensionAPI, rt: Runtime, reviews: ReviewController): void {
	let proposal: Proposal | undefined;

	pi.registerTool({
		name: "agents_md_propose",
		label: "propose AGENTS.md",
		description: "Propose the complete new AGENTS.md (the user reviews the diff before anything is written).",
		promptSnippet: "agents_md_propose: hand in the restructured AGENTS.md",
		defaultActive: false,
		parameters: Type.Object({
			content: Type.String({ description: "The complete new AGENTS.md" }),
			summary: Type.String({ description: "What changed, in 2-5 short lines" }),
		}),
		async execute(_id, params) {
			if (rt.state.mode !== "docs-migrate") throw new Error("agents_md_propose is only available during /agents-md-migrate");
			proposal = { content: params.content.endsWith("\n") ? params.content : `${params.content}\n`, summary: params.summary };
			return { content: [{ type: "text", text: "Proposal received. The user will review the diff." }], details: undefined, terminate: true };
		},
	});

	pi.registerCommand("agents-md-migrate", {
		description: "Restructure AGENTS.md into general invariants (shows the diff and asks before writing; --apply writes without asking)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			await rt.refresh(ctx);
			const repo = rt.repo;
			if (!rt.active || !repo) {
				ctx.ui.notify("/agents-md-migrate works inside a Godot project (a git repository with a project.godot).", "warning");
				return;
			}
			if (reviews.running || reviews.waiter.pending) {
				ctx.ui.notify("Wait for the running review to finish.", "warning");
				return;
			}
			const file = join(repo.toplevel, "AGENTS.md");
			const gate = { repoRoot: repo.toplevel, docs: ["AGENTS.md"] };
			if (!docForPath(file, gate)) {
				ctx.ui.notify("AGENTS.md at the repository root is a symlink or not a plain file; nothing was changed.", "warning");
				return;
			}
			const current = existsSync(file) ? readFileSync(file, "utf8") : "";
			const template = readFileSync(TEMPLATE, "utf8");
			const previousTools = pi.getActiveTools();
			const previousMode = rt.state.mode;
			proposal = undefined;
			pi.setActiveTools(MIGRATE_TOOLS);
			rt.state.set("docs-migrate", false);
			try {
				const settled = reviews.waiter.wait();
				pi.sendMessage(
					{ customType: "godot-helpers-migrate", content: migrateMessage(current || "(there is no AGENTS.md yet)", template, rt.config.docs), display: false, details: undefined },
					{ triggerTurn: true },
				);
				if (await settled) {
					ctx.ui.notify("Cancelled; AGENTS.md is unchanged.", "info");
					return;
				}
			} finally {
				rt.state.set(previousMode === "advisor" ? "advisor" : "off", false);
				pi.setActiveTools(previousTools);
			}
			const p = proposal as Proposal | undefined;
			if (!p) {
				showReport(pi, ctx.hasUI, "AGENTS.md migration", ["The model did not propose a new AGENTS.md; nothing was changed."]);
				return;
			}
			const patch = generateUnifiedPatch("AGENTS.md", current, p.content);
			const dir = join(rt.repoDataDir() as string, "agents-md", new Date().toISOString().replace(/[:.]/g, "-"));
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "AGENTS.md.before"), current);
			writeFileSync(join(dir, "AGENTS.md.proposed"), p.content);
			writeFileSync(join(dir, "AGENTS.md.patch"), patch);
			let apply = /(^|\s)--apply(\s|$)/.test(args);
			if (!apply && ctx.hasUI) {
				showReport(pi, true, "Proposed AGENTS.md", [p.summary, "", ...patch.split("\n")]);
				apply = await ctx.ui.confirm("Write the proposed AGENTS.md?", `${p.summary}\n\nThe full diff is above and in ${dir}.`);
			}
			if (!apply) {
				showReport(pi, ctx.hasUI, "AGENTS.md migration", [p.summary, "", `Not written. The proposal and its diff are in ${dir}`, "Run /agents-md-migrate --apply to write without asking."]);
				return;
			}
			if (!docForPath(file, gate)) {
				ctx.ui.notify("AGENTS.md changed into a symlink meanwhile; nothing was written.", "warning");
				return;
			}
			// written in place (no temporary file next to it: nothing but AGENTS.md is created in the repository)
			writeFileSync(file, p.content, "utf8");
			showReport(pi, ctx.hasUI, "AGENTS.md migration", [p.summary, "", `AGENTS.md written. The previous version and the diff are in ${dir}`]);
		},
	});
}
