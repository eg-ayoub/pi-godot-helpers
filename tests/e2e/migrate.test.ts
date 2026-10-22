// /agents-md-migrate end to end: the model may only read and propose; the extension writes AGENTS.md itself,
// and only with --apply (print mode) or after the user confirms.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import { messageText, startMockOpenAI, toolNames, toolResults, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, runPiJson } from "../helpers/pi.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");

const PROPOSED = `# Agents

## Critical rule
Do not modify any file except AGENTS.md and DESIGN.md.

## Invariants

### Identity resources are blueprints
- **Principle:** shared Resource blueprints are never changed at runtime.
- **Why:** every instance shares them (to confirm).
- **Signals of a violation:** an assignment to a field of \`identity\`.
- **Known instances:** CardIdentity is never mutated.
`;

function migrator(): (req: ChatRequest) => ScriptedTurn {
	return (req) => {
		if (!userText(req).includes("Restructure this repository's AGENTS.md")) return { text: "ok" };
		const results = toolResults(req);
		if (results.length === 0) {
			return {
				toolCalls: [
					{ name: "edit", arguments: { path: "AGENTS.md", edits: [{ oldText: "# Agents", newText: "# Pwned" }] } },
					{ name: "read", arguments: { path: "DESIGN.md" } },
				],
			};
		}
		if (results.length === 2) return { toolCalls: [{ name: "agents_md_propose", arguments: { content: PROPOSED, summary: "Turned the invariants list into principles with signals." } }] };
		return { text: "done" };
	};
}

describe("/agents-md-migrate", () => {
	it("writes the proposed AGENTS.md with --apply; the model itself cannot edit", async () => {
		const fx = makeGodotFixture();
		const before = readFileSync(join(fx.root, "AGENTS.md"), "utf8");
		server = await startMockOpenAI(migrator());
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "/agents-md-migrate --apply"], { cwd: fx.root, env: home.env, timeoutMs: 120_000 });
		expect(run.exitCode, run.stderr).toBe(0);

		const asked = server.requests.find((r) => userText(r).includes("Restructure this repository's AGENTS.md"))!;
		expect(userText(asked)).toContain("<current_agents_md>");
		expect(userText(asked)).toContain("Identity resources are never mutated at runtime.");
		expect(userText(asked)).toContain("### <Short name of the rule>");
		expect(toolNames(asked).sort()).toEqual(["agents_md_propose", "bash", "find", "grep", "ls", "read"]);
		const results = toolResults(server.requests.at(-1)!).map((r) => r.text);
		expect(results[0]).toMatch(/not found|not allowed/);
		expect(results[1]).toContain("# Design");

		expect(readFileSync(join(fx.root, "AGENTS.md"), "utf8")).toBe(PROPOSED);
		const changed = fx.git("status", "--porcelain").trimEnd().split("\n").filter((l) => !/card_identity|game_manager/.test(l));
		expect(changed).toEqual([" M AGENTS.md"]);
		const dir = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "agents-md");
		const [saved] = readdirSync(dir);
		expect(readFileSync(join(dir, saved, "AGENTS.md.before"), "utf8")).toBe(before);
		expect(readFileSync(join(dir, saved, "AGENTS.md.patch"), "utf8")).toContain("+### Identity resources are blueprints");
	});

	it("keeps AGENTS.md as it is without --apply and no one to ask", async () => {
		const fx = makeGodotFixture();
		const before = readFileSync(join(fx.root, "AGENTS.md"), "utf8");
		server = await startMockOpenAI(migrator());
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "/agents-md-migrate"], { cwd: fx.root, env: home.env, timeoutMs: 120_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(readFileSync(join(fx.root, "AGENTS.md"), "utf8")).toBe(before);
		expect(run.stderr).toMatch(/Not written/);
	});
});
