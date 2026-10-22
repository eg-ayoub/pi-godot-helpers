// Tools of a review worker (a pi subprocess started with --godot-helpers-worker <unit.json>). They are
// registered inactive in every session and only reachable in worker mode (see the gate). Results go to
// the unit's out.jsonl, which the parent reads; workers never write memory or repository files.
import { appendFileSync, readFileSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Runtime } from "../runtime.ts";
import { anchorComment } from "./anchor.ts";
import type { UnitFile } from "./worker-prompt.ts";

let cachedUnit: { path: string; unit: UnitFile } | undefined;

export function loadUnit(path: string): UnitFile {
	if (cachedUnit?.path === path) return cachedUnit.unit;
	const unit = JSON.parse(readFileSync(path, "utf8")) as UnitFile;
	cachedUnit = { path, unit };
	return unit;
}

export function appendOut(unit: UnitFile, record: Record<string, unknown>): void {
	appendFileSync(unit.outFile, `${JSON.stringify({ ...record, unitId: unit.unitId, at: Date.now() })}\n`);
}

export function registerWorkerTools(pi: ExtensionAPI, rt: Runtime): void {
	let count = 0;
	pi.registerTool({
		name: "review_comment",
		label: "review comment",
		description:
			"Record one review finding on a line of the change. Use one call per problem. line is the new-side line number (side \"old\" for removed lines); omit line for a file-level comment.",
		promptSnippet: "review_comment: record one finding on a line of the change",
		defaultActive: false,
		parameters: Type.Object({
			file: Type.String({ description: "Repository-relative path, as shown in the context" }),
			line: Type.Optional(Type.Integer({ description: "Line number on `side` (default new)" })),
			end_line: Type.Optional(Type.Integer({ description: "Last line of a multi-line finding" })),
			side: Type.Optional(StringEnum(["new", "old"])),
			severity: StringEnum(["critical", "important", "minor", "nit"]),
			discipline: Type.String({ description: 'Skill name the finding comes from, "project" for AGENTS.md/DESIGN.md invariants, or "general"' }),
			title: Type.String({ description: "One line, at most 80 characters" }),
			body: Type.String({ description: "Why this is a problem here, with file:line evidence" }),
			suggestion: Type.Optional(Type.String({ description: "A concrete fix; a short code snippet when it helps" })),
		}),
		async execute(_id, params) {
			if (!rt.workerUnitFile) throw new Error("review_comment is only available to review workers");
			const unit = loadUnit(rt.workerUnitFile);
			const anchor = anchorComment({ file: params.file, line: params.line, endLine: params.end_line, side: params.side as "new" | "old" | undefined }, unit.files);
			count += 1;
			appendOut(unit, { type: "comment", ...params });
			const where = anchor.line === null ? `${anchor.file} (file-level)` : `${anchor.file}:${anchor.line}`;
			const note = !anchor.inDiff
				? ` Note: ${params.file} is not part of this change; the comment will be shown as file-level.`
				: anchor.adjusted
					? ` Note: ${anchor.adjusted.reason}.`
					: "";
			return { content: [{ type: "text", text: `Recorded finding #${count} at ${where}.${note}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "review_done",
		label: "review done",
		description: "Finish this part of the review with a short summary (2-4 sentences: risk and main themes).",
		promptSnippet: "review_done: finish this part of the review",
		defaultActive: false,
		parameters: Type.Object({ summary: Type.String() }),
		async execute(_id, params) {
			if (!rt.workerUnitFile) throw new Error("review_done is only available to review workers");
			appendOut(loadUnit(rt.workerUnitFile), { type: "done", summary: params.summary, comments: count });
			return { content: [{ type: "text", text: "Done." }], details: undefined, terminate: true };
		},
	});
}
