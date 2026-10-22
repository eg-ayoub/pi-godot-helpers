// godot-helpers: a Godot design advisor and PR reviewer for pi, with a sandbox, routed skills and memory.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "./advisor/advisor.ts";
import { registerMigrate } from "./docs/migrate.ts";
import { memoryFor, registerMemory } from "./memory/tools.ts";
import { repositoryRules } from "./prompts.ts";
import { registerReview } from "./review/pipeline.ts";
import { registerWorkerTools } from "./review/worker-mode.ts";
import { Runtime } from "./runtime.ts";
import { decideToolCall } from "./security/gate.ts";
import { registerGuardedTools } from "./security/guarded-tools.ts";
import { registerRouting } from "./skills/routing.ts";
import { registerStatus, statusSections } from "./status.ts";
import { registerReportRenderer } from "./ui/report.ts";
import { registerViewer } from "./viewer/viewer.ts";

export const MIN_PI_VERSION = [1, 3, 0];

export function versionAtLeast(version: string, min: number[]): boolean {
	const parts = version.split(/[.-]/).map((p) => Number.parseInt(p, 10));
	for (let i = 0; i < min.length; i++) {
		const v = Number.isFinite(parts[i]) ? parts[i] : 0;
		if (v !== min[i]) return v > min[i];
	}
	return true;
}

export default function godotHelpers(pi: ExtensionAPI): void {
	if (!versionAtLeast(VERSION, MIN_PI_VERSION)) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`godot-helpers needs pi >= ${MIN_PI_VERSION.join(".")} (this is ${VERSION}); it is disabled.`, "warning");
		});
		return;
	}

	const rt = new Runtime(pi);

	pi.registerFlag("godot-helpers-worker", {
		description: "internal: run as a review worker for the given unit file",
		type: "string",
	});

	registerReportRenderer(pi);
	registerGuardedTools(pi, rt);
	registerWorkerTools(pi, rt);
	registerAdvisor(pi, rt);
	const reviews = registerReview(pi, rt);
	registerViewer(pi, rt, reviews);
	registerMemory(pi, rt, reviews);
	registerRouting(pi, rt, reviews);
	registerMigrate(pi, rt, reviews);
	registerStatus(pi, rt);
	statusSections.push((r) => {
		const store = memoryFor(r);
		if (!store) return [];
		const s = store.stats();
		return [`memory: ${s.notes} file note(s), ${s.facts} fact(s), ${s.raised} raised item(s), ${s.reviews} review(s) in ${store.dir}`];
	});

	pi.on("session_start", async (_event, ctx) => {
		await rt.refresh(ctx);
		const unit = pi.getFlag("godot-helpers-worker");
		if (typeof unit === "string" && unit.length > 0) {
			rt.workerUnitFile = unit;
			rt.state.set("worker", false);
			return;
		}
		rt.state.restore(ctx);
		if (rt.active && rt.mode === "advisor") ctx.ui.setStatus("godot-helpers", "advisor");
	});

	pi.on("tool_call", (event, ctx) => {
		if (!rt.active) return undefined;
		return decideToolCall(event.toolName, event.input as Record<string, unknown>, ctx.cwd, rt.gateContext());
	});

	pi.on("before_agent_start", (event) => {
		if (rt.active) event.systemPromptOptions.sections.godot_repository_rules = repositoryRules(rt.config.docs);
	});
}
