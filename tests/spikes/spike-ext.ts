// Phase 0 spikes: the pi 1.3.0 behaviours the design depends on, checked against the real CLI by
// tests/integration/pi-api.test.ts. Markers are appended to $SPIKE_LOG so the test can read the order.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function mark(line: string): void {
	const log = process.env.SPIKE_LOG;
	if (log) appendFileSync(log, `${line}\n`);
}

export default function (pi: ExtensionAPI) {
	// Spike 1: a bash override registered under the built-in name is the one that runs.
	const local = createLocalBashOperations();
	const bash = createBashToolDefinition(process.cwd(), {
		operations: {
			exec: async (command, cwd, options) => {
				options.onData(Buffer.from("SPIKE_BASH_OVERRIDE\n"));
				return local.exec(command, cwd, options);
			},
		},
	});
	pi.registerTool({ ...bash, label: "bash (spike)" });

	// Spike 3: a tool that stays inactive unless named in --tools.
	pi.registerTool({
		name: "spike_hidden",
		label: "spike hidden",
		description: "A tool that must only appear when named in --tools.",
		promptSnippet: "spike_hidden: test tool",
		parameters: Type.Object({ note: Type.String() }),
		defaultActive: false,
		async execute(_id, params) {
			mark(`spike_hidden:${params.note}`);
			return { content: [{ type: "text", text: `noted ${params.note}` }], details: undefined };
		},
	});

	// Spike 2: filtering systemPromptOptions.skills per run, and adding a section.
	pi.on("before_agent_start", (event) => {
		const keep = process.env.SPIKE_KEEP_SKILLS;
		if (keep !== undefined) {
			const names = new Set(keep.split(",").filter(Boolean));
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter((s) => names.has(s.name));
		}
		event.systemPromptOptions.sections.spike_role = "SPIKE_ROLE_SECTION";
		mark(`before_agent_start:${event.messageType}`);
	});

	pi.on("tool_call", (event) => {
		mark(`tool_call:${event.toolName}`);
		if (event.toolName === "write") return { block: true, reason: "SPIKE_BLOCKED_WRITE" };
		return undefined;
	});

	// Spike 7: a command starts a run with sendMessage({triggerTurn}) and learns its end from agent_settled.
	let docPassPending = false;
	pi.registerCommand("spike-docpass", {
		description: "spike: trigger a turn from a command",
		handler: async () => {
			docPassPending = true;
			mark("command:spike-docpass");
			pi.sendMessage(
				{ customType: "spike-docpass", content: "SPIKE_DOC_PASS_REQUEST", display: true, details: undefined },
				{ triggerTurn: true },
			);
		},
	});
	// Spike 7b: a command that awaits the turn it triggered (agent_settled) before returning.
	let settledWaiter: (() => void) | undefined;
	pi.registerCommand("spike-await", {
		description: "spike: await a triggered turn inside the command handler",
		handler: async () => {
			mark("command:spike-await:start");
			const settled = new Promise<string>((resolve) => {
				const timer = setTimeout(() => resolve("timeout"), 20_000);
				timer.unref();
				settledWaiter = () => {
					clearTimeout(timer);
					resolve("settled");
				};
			});
			pi.sendMessage({ customType: "spike-await", content: "SPIKE_AWAIT_REQUEST", display: true, details: undefined }, { triggerTurn: true });
			mark(`command:spike-await:${await settled}`);
		},
	});
	pi.on("agent_settled", () => {
		mark(`agent_settled:${docPassPending ? "docpass" : "other"}`);
		docPassPending = false;
		settledWaiter?.();
		settledWaiter = undefined;
	});
}
