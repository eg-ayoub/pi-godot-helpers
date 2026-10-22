// The skills download in a real pi session: the first start in a Godot repository downloads the newest tag
// (and a review waits for it), the next start moves to a newer tag, and nothing is downloaded elsewhere.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import type { ReviewRecord } from "../../src/review/record.ts";
import { messageText, startMockOpenAI, systemPrompt, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, runPiJson } from "../helpers/pi.ts";
import { upstream } from "../helpers/upstream.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");
const isWorker = (req: ChatRequest) => systemPrompt(req).includes("You are reviewing one part of a change");

describe("skills download", () => {
	it("downloads the newest tag on the first start, then follows new tags", async () => {
		const up = upstream();
		up.release("v1.0.0", ["godot-code-review", "event-bus"]);
		const fx = makeGodotFixture();
		server = await startMockOpenAI((req): ScriptedTurn => (isWorker(req) ? { toolCalls: [{ name: "review_done", arguments: { summary: "ok" } }] } : { text: "ok" }));
		const home = makePiHome(server.url);
		home.config({ skills: { path: null, source: { repo: up.root } } });
		const current = join(home.agentDir, "godot-helpers", "skills", "GodotPrompter", "current.json");
		const review = ["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks --no-open"];

		const first = await runPiJson(review, { cwd: fx.root, env: home.env, timeoutMs: 180_000 });
		expect(first.exitCode, first.stderr).toBe(0);
		expect(JSON.parse(readFileSync(current, "utf8")).tag).toBe("v1.0.0");
		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const record = JSON.parse(readFileSync(join(reviews, readdirSync(reviews)[0], "review.json"), "utf8")) as ReviewRecord;
		expect(record.status, record.error).toBe("complete");
		expect(record.skills).toMatchObject({ tag: "v1.0.0", source: up.root });
		const worker = server.requests.find((r) => isWorker(r) && userText(r).includes("## game/player.gd"))!;
		expect(systemPrompt(worker)).toContain("# godot-code-review v1.0.0");

		up.release("v1.1.0", ["godot-code-review", "event-bus", "save-load"]);
		const second = await runPiJson(["-e", EXTENSION, "/godot-helpers-status"], { cwd: fx.root, env: home.env, timeoutMs: 120_000 });
		expect(second.exitCode, second.stderr).toBe(0);
		expect(second.stderr).toMatch(/skills: 2 from GodotPrompter v1\.0\.0|skills: 3 from GodotPrompter v1\.1\.0/);
		// the update ran during that start; pi waited for it before exiting
		expect(JSON.parse(readFileSync(current, "utf8")).tag).toBe("v1.1.0");
		expect(readdirSync(join(home.agentDir, "godot-helpers", "skills", "GodotPrompter")).sort()).toEqual(["current.json", "repo.git", "v1.0.0", "v1.1.0"]);
	});

	it("downloads nothing outside a Godot repository", async () => {
		const up = upstream();
		up.release("v1.0.0", ["godot-code-review"]);
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		home.config({ skills: { path: null, source: { repo: up.root } } });
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "pgh-plain-")));
		const run = await runPiJson(["-e", EXTENSION, "hello"], { cwd: plain, env: home.env });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(existsSync(join(home.agentDir, "godot-helpers", "skills"))).toBe(false);
	});
});
