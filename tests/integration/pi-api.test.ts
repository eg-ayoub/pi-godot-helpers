// Phase 0 spikes as regression tests: pi 1.3.0 behaviours the extension relies on.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMockOpenAI, systemPrompt, toolNames, toolResults, messageText, type MockServer } from "../fakes/mock-openai-server.ts";
import { makePiHome, ROOT, rpcClient, runPiJson } from "../helpers/pi.ts";

const SPIKE_EXT = join(ROOT, "tests/spikes/spike-ext.ts");

function makeSkill(root: string, name: string, description: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nBody of ${name}.\n`);
	return dir;
}

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("pi 1.3.0 extension API (spikes)", () => {
	it("spike 1: a bash override under the built-in name is the one that runs", async () => {
		server = await startMockOpenAI((_req, i) =>
			i === 0 ? { toolCalls: [{ name: "bash", arguments: { command: "echo hello" } }] } : { text: "done" },
		);
		const home = makePiHome(server.url);
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));
		const run = await runPiJson(["-e", SPIKE_EXT, "go"], { cwd, env: home.env });
		expect(run.exitCode, run.stderr).toBe(0);
		const results = toolResults(server.requests[1]);
		expect(results[0].text).toContain("SPIKE_BASH_OVERRIDE");
		expect(results[0].text).toContain("hello");
	});

	it("spike 2: filtering systemPromptOptions.skills changes the prompt, sections are added", async () => {
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		const skills = mkdtempSync(join(tmpdir(), "pgh-skills-"));
		const a = makeSkill(skills, "alpha-skill", "Use when reviewing alpha things.");
		const b = makeSkill(skills, "beta-skill", "Use when reviewing beta things.");
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));

		await runPiJson(["-e", SPIKE_EXT, "--skill", a, "--skill", b, "hi"], { cwd, env: home.env });
		const unfiltered = systemPrompt(server.requests[0]);
		expect(unfiltered).toContain("alpha-skill");
		expect(unfiltered).toContain("beta-skill");
		expect(unfiltered).toContain("SPIKE_ROLE_SECTION");

		await runPiJson(["-e", SPIKE_EXT, "--skill", a, "--skill", b, "hi"], {
			cwd,
			env: { ...home.env, SPIKE_KEEP_SKILLS: "alpha-skill" },
		});
		const filtered = systemPrompt(server.requests[1]);
		expect(filtered).toContain("alpha-skill");
		expect(filtered).not.toContain("beta-skill");
	});

	it("spike 3: a defaultActive:false tool is offered only when named in --tools", async () => {
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));
		await runPiJson(["-e", SPIKE_EXT, "hi"], { cwd, env: home.env });
		expect(toolNames(server.requests[0])).not.toContain("spike_hidden");
		await runPiJson(["-e", SPIKE_EXT, "--tools", "read,spike_hidden", "hi"], { cwd, env: home.env });
		expect(toolNames(server.requests[1]).sort()).toEqual(["read", "spike_hidden"]);
	});

	it("spike 4: a worker started with -ne still resolves the session's provider from models.json", async () => {
		server = await startMockOpenAI(() => ({ text: "worker ok" }));
		const home = makePiHome(server.url);
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));
		const run = await runPiJson(["-ne", "-e", SPIKE_EXT, "--model", "mock/mock-model", "hi"], { cwd, env: home.env });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(server.requests).toHaveLength(1);
		const end = run.events.filter((e) => e.type === "message_end").pop();
		expect(JSON.stringify(end)).toContain("worker ok");
	});

	it("spike 7b: a command handler can await the turn it triggered (RPC and print mode)", async () => {
		server = await startMockOpenAI(() => ({ text: "doc pass done" }));
		const home = makePiHome(server.url);
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));
		const log = join(cwd, "spike.log");
		const client = rpcClient({ cwd, env: { ...home.env, SPIKE_LOG: log }, args: ["-e", SPIKE_EXT] });
		await client.start();
		try {
			await client.prompt("/spike-await");
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline && !(existsSync(log) && readFileSync(log, "utf8").includes("command:spike-await:"))) {
				await new Promise((r) => setTimeout(r, 100));
			}
			for (let i = 0; i < 50 && !readFileSync(log, "utf8").match(/spike-await:(settled|timeout)/); i++) await new Promise((r) => setTimeout(r, 100));
		} finally {
			await client.stop();
		}
		expect(readFileSync(log, "utf8")).toContain("command:spike-await:settled");

		const log2 = join(cwd, "spike2.log");
		const run = await runPiJson(["-e", SPIKE_EXT, "/spike-await"], { cwd, env: { ...home.env, SPIKE_LOG: log2 } });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(readFileSync(log2, "utf8")).toContain("command:spike-await:settled");
	});

	it("spike 7: a command triggers a turn with sendMessage and agent_settled follows it; tool_call can block", async () => {
		server = await startMockOpenAI((req, i) => {
			if (i === 0) return { toolCalls: [{ name: "write", arguments: { path: "x.txt", content: "no" } }] };
			return { text: `saw: ${messageText(req.messages.at(-1))}` };
		});
		const home = makePiHome(server.url);
		const cwd = mkdtempSync(join(tmpdir(), "pgh-cwd-"));
		const log = join(cwd, "spike.log");
		const client = rpcClient({ cwd, env: { ...home.env, SPIKE_LOG: log }, args: ["-e", SPIKE_EXT] });
		await client.start();
		try {
			const settled = client.waitForIdle(60_000);
			await client.prompt("/spike-docpass");
			await settled;
		} finally {
			await client.stop();
		}
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines[0]).toBe("command:spike-docpass");
		expect(lines).toContain("before_agent_start:custom");
		expect(lines).toContain("tool_call:write");
		expect(lines.at(-1)).toBe("agent_settled:docpass");
		expect(messageText(server.requests[0].messages.find((m) => m.role === "user"))).toContain("SPIKE_DOC_PASS_REQUEST");
		expect(toolResults(server.requests[1])[0].text).toContain("SPIKE_BLOCKED_WRITE");
		expect(existsSync(join(cwd, "x.txt"))).toBe(false);
	});
});
