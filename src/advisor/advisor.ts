// /advise: a read-only design-advisor mode with its own role section and tool set.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ADVISOR_ROLE, ADVISOR_TOOLS } from "../prompts.ts";
import type { Runtime } from "../runtime.ts";

export function enterAdvisor(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext): void {
	if (rt.mode !== "advisor") {
		rt.state.previousTools = pi.getActiveTools();
		pi.setActiveTools(ADVISOR_TOOLS);
		rt.state.set("advisor");
		ctx.ui.setStatus("godot-helpers", "advisor");
		ctx.ui.notify("Advisor mode: read-only, grounded in the repository. /advise again to leave.", "info");
	}
}

export function leaveAdvisor(pi: ExtensionAPI, rt: Runtime, ctx: ExtensionContext): void {
	if (rt.mode !== "advisor") return;
	const previous = rt.state.previousTools;
	rt.state.previousTools = undefined;
	rt.state.set("off");
	if (previous && previous.length > 0) pi.setActiveTools(previous);
	ctx.ui.setStatus("godot-helpers", undefined);
	ctx.ui.notify("Advisor mode off.", "info");
}

export function registerAdvisor(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerCommand("advise", {
		description: "Toggle the Godot design advisor (read-only), or ask it a question: /advise <question>",
		handler: async (args, ctx) => {
			if (!rt.active) {
				ctx.ui.notify("/advise works inside a Godot project (a git repository with a project.godot).", "warning");
				return;
			}
			const question = args.trim();
			if (!question) {
				if (rt.mode === "advisor") leaveAdvisor(pi, rt, ctx);
				else enterAdvisor(pi, rt, ctx);
				return;
			}
			enterAdvisor(pi, rt, ctx);
			if (ctx.isIdle()) pi.sendUserMessage(question);
			else pi.sendUserMessage(question, { deliverAs: "followUp" });
		},
	});

	pi.on("before_agent_start", (event) => {
		if (rt.active && rt.mode === "advisor") event.systemPromptOptions.sections.godot_advisor = ADVISOR_ROLE;
	});
}
