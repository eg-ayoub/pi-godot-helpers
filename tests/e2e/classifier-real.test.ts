// Opt-in: the whole /review with a real llama-server and a real decision model (the main model is still the
// scripted mock). Run it on the machine that will do the reviews:
//   PGH_REAL_LLAMA_SERVER=$(which llama-server) PGH_REAL_CLASSIFIER_MODEL=/path/Kev-4B-Q4_K_M.gguf \
//     npx vitest run tests/e2e/classifier-real.test.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import type { ReviewRecord } from "../../src/review/record.ts";
import { probeSandbox } from "../../src/security/sandbox.ts";
import { messageText, startMockOpenAI, systemPrompt, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, rpcClient, runPiJson } from "../helpers/pi.ts";

const BIN = process.env.PGH_REAL_LLAMA_SERVER;
const MODEL = process.env.PGH_REAL_CLASSIFIER_MODEL;

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");

describe.skipIf(!BIN || !MODEL || !probeSandbox().ok)("real decision model", () => {
	it("routes a review through pi's classify() with the real llama-server", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI((req): ScriptedTurn => (systemPrompt(req).includes("You are reviewing one part") ? { toolCalls: [{ name: "review_done", arguments: { summary: "ok" } }] } : { text: "ok" }));
		const home = makePiHome(server.url);
		home.config({ classifier: { enabled: true, llamaServer: BIN, modelPath: MODEL } });
		const started = Date.now();
		const run = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks --no-open"], { cwd: fx.root, env: home.env, timeoutMs: 600_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const record = JSON.parse(readFileSync(join(reviews, readdirSync(reviews)[0], "review.json"), "utf8")) as ReviewRecord;
		expect(record.status, record.error).toBe("complete");
		expect(record.routing.classifier).toMatch(/^rules \+ classifier /);
		const asked = record.routing.decisions.filter((d) => d.classifier);
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every((d) => d.classifier?.ok), JSON.stringify(asked.map((d) => d.classifier?.error))).toBe(true);
		console.log(`review in ${((Date.now() - started) / 1000).toFixed(1)} s; ${record.routing.classifier}`);
		for (const d of record.routing.decisions) console.log(`  ${d.file}: ${d.selected.map((s) => `${s.skill}(${s.source})`).join(", ")}`);
	});

	it("pre-routes an advisor question", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		home.config({ classifier: { enabled: true, llamaServer: BIN, modelPath: MODEL } });
		const client = rpcClient({ cwd: fx.root, env: home.env, args: ["-e", EXTENSION] });
		await client.start();
		try {
			const settled = client.waitForIdle(300_000);
			await client.prompt("/advise Should the Card emit a signal on a global event bus when it is dropped on a Slot, or call the Slot directly?");
			await settled;
		} finally {
			await client.stop();
		}
		const text = userText(server.requests[0]);
		const picked = /Godot guidance selected for this question \(([^)]*)\)/.exec(text)?.[1];
		console.log(`advisor skills: ${picked ?? "(none above the threshold)"}`);
		expect(picked).toBeDefined();
	});
});
