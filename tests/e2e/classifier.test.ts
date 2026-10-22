// Phase 5 end to end: the extension starts a (fake) llama-server, registers it as a pi classifier provider and
// routes through pi's own modelRegistry.classify(); it stops the server before the workers run, falls back to
// the CPU and to rules, and pre-routes advisor questions.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import type { ReviewRecord } from "../../src/review/record.ts";
import { probeSandbox } from "../../src/security/sandbox.ts";
import { messageText, startMockOpenAI, systemPrompt, toolResults, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makeFakeLlamaServer, makePiHome, rpcClient, runPiJson } from "../helpers/pi.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");

interface LlamaLog {
	event: "start" | "systemone" | "stop";
	pid: number;
	args?: string[];
	request?: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions: string }> };
}

function readLog(file: string): LlamaLog[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as LlamaLog)
		: [];
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Workers that only say they are done; anything else answers "ok". */
function quietWorkers(): (req: ChatRequest) => ScriptedTurn {
	return (req) => (systemPrompt(req).includes("You are reviewing one part of a change") ? { toolCalls: [{ name: "review_done", arguments: { summary: "Reviewed." } }] } : { text: "ok" });
}

function latestRecord(agentDir: string, root: string): ReviewRecord {
	const reviews = join(agentDir, "godot-helpers", repoIdFor(root), "reviews");
	const ids = readdirSync(reviews).sort();
	return JSON.parse(readFileSync(join(reviews, ids.at(-1)!, "review.json"), "utf8")) as ReviewRecord;
}

describe.skipIf(!probeSandbox().ok)("classifier routing", () => {
	it("starts llama-server, classifies through pi, stops it before the workers, falls back to the CPU", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(quietWorkers());
		const home = makePiHome(server.url);
		const scratch = mkdtempSync(join(tmpdir(), "pgh-cls-"));
		const model = join(scratch, "kev.gguf");
		writeFileSync(model, "not really a model");
		const log = join(scratch, "llama.jsonl");
		home.config({ classifier: { enabled: true, llamaServer: makeFakeLlamaServer(), modelPath: model, startupTimeoutSeconds: 20 } });
		const run = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks --no-open"], {
			cwd: fx.root,
			env: {
				...home.env,
				FAKE_LLAMA_LOG: log,
				FAKE_LLAMA_FAIL_GPU: "1",
				FAKE_LLAMA_KEYWORDS: JSON.stringify({ s_resource_pattern: "identity\\.cost" }),
			},
			timeoutMs: 180_000,
		});
		expect(run.exitCode, run.stderr).toBe(0);

		const record = latestRecord(home.agentDir, fx.root);
		expect(record.status, record.error).toBe("complete");
		expect(record.routing.classifier).toBe("rules + classifier kev.gguf");
		const card = record.routing.decisions.find((d) => d.file === "game/items/card.gd")!;
		expect(card.classifier).toMatchObject({ ok: true, model: "godot-helpers-classifier/local-decision-model" });
		expect(card.selected).toContainEqual(expect.objectContaining({ skill: "resource-pattern", source: "classifier" }));
		expect(card.selected).toContainEqual(expect.objectContaining({ skill: "godot-code-review", source: "always" }));
		// a strong rule hit stays even when the classifier doubts it
		const shader = record.routing.decisions.find((d) => d.file === "game/shaders/glow.gdshader")!;
		expect(shader.classifier?.probabilities?.["shader-basics"]).toBeLessThan(0.5);
		expect(shader.selected.map((s) => s.skill)).toContain("shader-basics");

		// the GPU start failed, the CPU start served; the server is gone afterwards
		const events = readLog(log);
		const starts = events.filter((e) => e.event === "start");
		expect(starts.map((s) => s.args![s.args!.indexOf("-ngl") + 1])).toEqual(["999", "0"]);
		expect(starts[1].args).toEqual(expect.arrayContaining(["-m", model, "--host", "127.0.0.1", "-np", "1", "-ub", "1024", "-lm", "none"]));
		expect(events.some((e) => e.event === "stop" && e.pid === starts[1].pid)).toBe(true);
		expect(alive(starts[1].pid)).toBe(false);

		// pi sent bool questions as "noul", one per candidate, each with its own instructions
		const requests = events.filter((e) => e.event === "systemone").map((e) => e.request!);
		expect(requests.length).toBeGreaterThanOrEqual(3);
		for (const r of requests) {
			const qs = Object.values(r.questions);
			expect(qs.every((q) => q.type === "noul")).toBe(true);
			expect(new Set(qs.map((q) => q.instructions)).size).toBe(qs.length);
			expect(Object.keys(r.questions)).not.toContain("s_godot_code_review");
		}
		expect(requests.find((r) => r.state.file === "game/items/card.gd")!.state.change).toContain("identity.cost -= 1");

		// the card worker got the skill the classifier picked
		const cardWorker = server.requests.find((r) => systemPrompt(r).includes("You are reviewing one part of a change") && userText(r).includes("## game/items/card.gd"))!;
		expect(systemPrompt(cardWorker)).toContain('<skill name="resource-pattern">');
	});

	it("routes with the rules when llama-server cannot start", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(quietWorkers());
		const home = makePiHome(server.url);
		home.config({ classifier: { enabled: true, llamaServer: "/nonexistent/llama-server" } });
		const run = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks --no-open"], { cwd: fx.root, env: home.env, timeoutMs: 180_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		const record = latestRecord(home.agentDir, fx.root);
		expect(record.status, record.error).toBe("complete");
		expect(record.routing.classifier).toMatch(/^rules only \(classifier unavailable: llama-server was not found at \/nonexistent/);
		expect(record.routing.decisions.find((d) => d.file === "game/player.gd")!.selected.map((s) => s.skill)).toContain("gdscript-advanced");
	});
});

describe("advisor pre-routing", () => {
	it("hands the advisor the skills the classifier picks for the question, then stops the server", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "Emit a signal from Card." }));
		const home = makePiHome(server.url);
		const scratch = mkdtempSync(join(tmpdir(), "pgh-cls-"));
		const model = join(scratch, "kev.gguf");
		writeFileSync(model, "x");
		const log = join(scratch, "llama.jsonl");
		home.config({ classifier: { enabled: true, llamaServer: makeFakeLlamaServer(), modelPath: model } });
		const client = rpcClient({
			cwd: fx.root,
			env: { ...home.env, FAKE_LLAMA_LOG: log, FAKE_LLAMA_KEYWORDS: JSON.stringify({ s_event_bus: "[Ss]ignal", s_godot_brainstorming: "[Ss]hould" }) },
			args: ["-e", EXTENSION],
		});
		await client.start();
		try {
			const settled = client.waitForIdle(60_000);
			await client.prompt("/advise Should Card tell Slot it was dropped through a signal or a direct call?");
			await settled;
		} finally {
			await client.stop();
		}
		const events = readLog(log);
		expect(events.map((e) => e.event)).toEqual(["start", "systemone", "systemone", "stop"]);
		// a choice question over every skill makes the shortlist; yes/no questions decide
		const [shortlist, decide] = events.filter((e) => e.event === "systemone").map((e) => e.request!);
		const options = Object.keys((shortlist.questions.topic as unknown as { criteria: Record<string, string> }).criteria);
		expect(options.length).toBeGreaterThan(40);
		expect(options).not.toContain("godot-code-review");
		expect(options).not.toContain("csharp-signals");
		expect(Object.keys(decide.questions).length).toBe(8);
		const req = server.requests[0];
		const text = userText(req);
		if (process.env.PGH_DUMP) console.log(JSON.stringify(req.messages, null, 1).slice(0, 3000));
		expect(text).toContain("Godot guidance selected for this question (event-bus, godot-brainstorming)");
		expect(text).toContain('<skill name="event-bus">');
		expect(text).not.toContain('<skill name="shader-basics">');
		// the skill bodies are a message, not part of the (cached) system prompt
		expect(systemPrompt(req)).not.toContain('<skill name="event-bus">');
		expect(toolResults(req)).toEqual([]);
		expect(decide.state.question).toContain("Card tell Slot");
		expect(options).not.toContain("using-godot-prompter");
		expect(events.some((e) => e.event === "stop")).toBe(true);
	});

	it("asks every skill yes/no when the choice question is refused", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		const scratch = mkdtempSync(join(tmpdir(), "pgh-cls-"));
		const model = join(scratch, "kev.gguf");
		writeFileSync(model, "x");
		const log = join(scratch, "llama.jsonl");
		home.config({ classifier: { enabled: true, llamaServer: makeFakeLlamaServer(), modelPath: model } });
		const client = rpcClient({ cwd: fx.root, env: { ...home.env, FAKE_LLAMA_LOG: log, FAKE_LLAMA_MAX_OPTIONS: "10", FAKE_LLAMA_KEYWORDS: JSON.stringify({ s_save_load: "save" }) }, args: ["-e", EXTENSION] });
		await client.start();
		try {
			const settled = client.waitForIdle(60_000);
			await client.prompt("/advise How do I version my save files?");
			await settled;
		} finally {
			await client.stop();
		}
		const asks = readLog(log).filter((e) => e.event === "systemone").map((e) => e.request!);
		expect(asks).toHaveLength(2);
		expect(Object.keys(asks[1].questions).length).toBeGreaterThan(40);
		expect(userText(server.requests[0])).toContain("Godot guidance selected for this question (save-load)");
	});

	it("does not start a download in the middle of a chat turn", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		const log = join(mkdtempSync(join(tmpdir(), "pgh-cls-")), "llama.jsonl");
		// no modelPath and nothing downloaded yet
		home.config({ classifier: { enabled: true, llamaServer: makeFakeLlamaServer() } });
		const client = rpcClient({ cwd: fx.root, env: { ...home.env, FAKE_LLAMA_LOG: log }, args: ["-e", EXTENSION] });
		await client.start();
		try {
			const settled = client.waitForIdle(60_000);
			await client.prompt("/advise Signals or direct calls?");
			await settled;
		} finally {
			await client.stop();
		}
		expect(readLog(log)).toEqual([]);
		expect(userText(server.requests[0])).not.toContain("Godot guidance selected");
	});
});
