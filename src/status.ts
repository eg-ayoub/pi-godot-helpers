// /godot-helpers-status: what the extension sees and whether its safety layer works on this host.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { dataDir } from "./config.ts";
import type { Runtime } from "./runtime.ts";
import { probeSandbox } from "./security/sandbox.ts";
import { showReport } from "./ui/report.ts";

export type StatusSection = (rt: Runtime) => Promise<string[]> | string[];

/** Other modules (skills, classifier, memory) add their lines here. */
export const statusSections: StatusSection[] = [];

export async function statusLines(rt: Runtime): Promise<string[]> {
	const lines: string[] = [`pi ${VERSION}`];
	if (!rt.repo) {
		lines.push("repository: none (not inside a git work tree): the extension is inactive");
		return lines;
	}
	lines.push(`repository: ${rt.repo.toplevel}`);
	lines.push(
		rt.active
			? `godot project: ${rt.repo.godotProjects.map((p) => p || ".").join(", ")}: guarded`
			: "godot project: none (no project.godot): the extension is inactive here",
	);
	lines.push(`repository id: ${rt.repo.id}${rt.repo.originUrl ? ` (origin ${rt.repo.originUrl})` : ""}`);
	lines.push(`mode: ${rt.mode}`);
	const global = join(dataDir(rt.agentDir), "config.json");
	const perRepo = join(rt.repoDataDir() ?? "", "config.json");
	lines.push(`config: ${existsSync(global) ? global : "defaults"}${existsSync(perRepo) ? ` + ${perRepo}` : ""}`);
	if (rt.configError) lines.push(`config error: ${rt.configError} (defaults in use)`);
	const probe = probeSandbox(rt.config.sandbox.bwrapPath, true);
	lines.push(probe.ok ? `sandbox: ok (${probe.bwrap})` : `sandbox: UNAVAILABLE: ${probe.reason}. bash is blocked in this repository.`);
	for (const section of statusSections) {
		try {
			lines.push(...(await section(rt)));
		} catch (error) {
			lines.push(`status error: ${(error as Error).message}`);
		}
	}
	return lines;
}

export function registerStatus(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerCommand("godot-helpers-status", {
		description: "Show what godot-helpers sees: repository, sandbox, skills, classifier, memory",
		handler: async (_args, ctx) => {
			await rt.refresh(ctx);
			showReport(pi, ctx.hasUI, "godot-helpers status", await statusLines(rt));
		},
	});
}
