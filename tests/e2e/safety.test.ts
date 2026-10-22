// Phase 1 end to end: the real pi 1.3.0 with this extension, in a fixture Godot repo, driven by a scripted
// model that tries things it must not do.
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeSandbox } from "../../src/security/sandbox.ts";
import { startMockOpenAI, systemPrompt, toolNames, toolResults, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, rpcClient, runPiJson } from "../helpers/pi.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

/** A model that makes the given tool calls one per turn, then says done. */
function scripted(calls: ScriptedTurn["toolCalls"]): (req: unknown, i: number) => ScriptedTurn {
	return (_req, i) => (calls && i < calls.length ? { toolCalls: [calls[i]] } : { text: "done" });
}

const sandboxOk = probeSandbox().ok;

describe("safety in a Godot repository", () => {
	it("refuses writes, edits, commits and reads outside the repo; bash runs sandboxed", async () => {
		const fx = makeGodotFixture();
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "pgh-out-")));
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
		const before = fx.git("rev-parse", "HEAD").trim();
		const designBefore = readFileSync(join(fx.root, "DESIGN.md"), "utf8");
		server = await startMockOpenAI(
			scripted([
				{ name: "write", arguments: { path: "project.godot", content: "pwned" } },
				{ name: "write", arguments: { path: "game/new.gd", content: "pwned" } },
				{ name: "edit", arguments: { path: "DESIGN.md", edits: [{ oldText: "# Design", newText: "# Pwned" }] } },
				{ name: "read", arguments: { path: join(outside, "secret.txt") } },
				{ name: "bash", arguments: { command: "git commit --allow-empty -m evil" } },
				{ name: "bash", arguments: { command: "echo pwned > project.godot" } },
				{ name: "bash", arguments: { command: "git log --oneline | wc -l" } },
			]),
		);
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "go"], { cwd: fx.root, env: home.env });
		expect(run.exitCode, run.stderr).toBe(0);
		const results = toolResults(server.requests.at(-1)!).map((r) => r.text);
		expect(results[0]).toMatch(/Changing files is not allowed/);
		expect(results[1]).toMatch(/Changing files is not allowed/);
		expect(results[2]).toMatch(/Changing files is not allowed/);
		expect(results[3]).toMatch(/outside the repository/);
		expect(results[4]).toMatch(/Command refused: .*git commit/);
		expect(results[5]).toMatch(/Command refused: `>` is not allowed/);
		if (sandboxOk) expect(results[6].trim()).toMatch(/^2/);
		// nothing changed on disk or in git
		expect(readFileSync(join(fx.root, "project.godot"), "utf8")).toContain("config_version=5");
		expect(existsSync(join(fx.root, "game/new.gd"))).toBe(false);
		expect(readFileSync(join(fx.root, "DESIGN.md"), "utf8")).toBe(designBefore);
		expect(fx.git("rev-parse", "HEAD").trim()).toBe(before);
		// the model was told the rules
		expect(systemPrompt(server.requests[0])).toContain("godot_repository_rules");
	});

	it("stays out of the way outside Godot repositories", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "pgh-plain-")));
		server = await startMockOpenAI(scripted([{ name: "write", arguments: { path: "hello.txt", content: "hi" } }]));
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "go"], { cwd: plain, env: home.env });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(readFileSync(join(plain, "hello.txt"), "utf8")).toBe("hi");
		expect(systemPrompt(server.requests[0])).not.toContain("godot_repository_rules");
	});

	it("/advise switches to the read-only advisor with its role section", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "Use the action broadcaster." }));
		const home = makePiHome(server.url);
		const client = rpcClient({ cwd: fx.root, env: home.env, args: ["-e", EXTENSION] });
		await client.start();
		try {
			const settled = client.waitForIdle(60_000);
			await client.prompt("/advise I want cards to explode when dropped, via a direct call from Card to Slot. Thoughts?");
			await settled;
		} finally {
			await client.stop();
		}
		const req = server.requests[0];
		expect(systemPrompt(req)).toContain("godot_advisor");
		expect(systemPrompt(req)).toContain("design advisor for this Godot 4 project");
		expect(toolNames(req).sort()).toEqual(["bash", "find", "grep", "ls", "memory_add_fact", "memory_get", "memory_note_file", "memory_search", "read"]);
		expect(systemPrompt(req)).toContain("godot_project_brief");
		expect(systemPrompt(req)).toContain("Card=game/items/card.gd");
	});
});
