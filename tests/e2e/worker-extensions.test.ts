// Review workers keep the user's extensions: a model whose provider an extension registers (like pi-llama-cpp
// does for Strata and Jan) must work in the workers too, and this extension, also installed as a package, must
// not load twice.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import type { ReviewRecord } from "../../src/review/record.ts";
import { probeSandbox } from "../../src/security/sandbox.ts";
import { startMockOpenAI, systemPrompt, toolNames, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, ROOT, runPiJson } from "../helpers/pi.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const PROVIDER_EXTENSION = `export default function (pi) {
	pi.registerProvider("extprov", {
		baseUrl: process.env.PGH_EXT_PROVIDER_URL,
		apiKey: "test",
		api: "openai-completions",
		models: [{
			id: "ext-model", name: "Model from an extension", reasoning: false, input: ["text"],
			contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		}],
	});
}
`;

const isWorker = (req: ChatRequest) => systemPrompt(req).includes("You are reviewing one part of a change");

describe.skipIf(!probeSandbox().ok)("review workers and the user's extensions", () => {
	it("reach a model registered by another extension; this extension loads once", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI((req): ScriptedTurn => (isWorker(req) ? { toolCalls: [{ name: "review_done", arguments: { summary: "ok" } }] } : { text: "ok" }));
		// the session's model comes from an extension; this package is also installed
		const home = makePiHome(server.url, { settings: { defaultProvider: "extprov", defaultModel: "ext-model", packages: [ROOT] } });
		mkdirSync(join(home.agentDir, "extensions"), { recursive: true });
		writeFileSync(join(home.agentDir, "extensions", "provider.js"), PROVIDER_EXTENSION);
		const env = { ...home.env, PGH_EXT_PROVIDER_URL: `${server.url}/v1` };

		const run = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks --no-open"], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const record = JSON.parse(readFileSync(join(reviews, readdirSync(reviews)[0], "review.json"), "utf8")) as ReviewRecord;
		expect(record.status, record.error).toBe("complete");
		expect(record.model).toBe("extprov/ext-model");
		expect(record.workers.length).toBeGreaterThan(0);
		expect(record.workers.map((w) => w.error).filter(Boolean)).toEqual([]);

		const workers = server.requests.filter(isWorker);
		expect(workers.length).toBe(record.workers.length);
		for (const req of workers) {
			expect((req as { model?: string }).model).toBe("ext-model");
			const tools = toolNames(req);
			expect(new Set(tools).size, tools.join(", ")).toBe(tools.length);
			expect(tools).toContain("review_comment");
		}
	});
});
