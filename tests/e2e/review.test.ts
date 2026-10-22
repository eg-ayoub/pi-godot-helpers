// Phase 2 end to end: /review on the fixture with the real pi 1.3.0, real worker subprocesses, the sandboxed
// checks (fake gdlint/gdformat, the fixture's Makefile) and a scripted model playing workers and doc pass.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repoIdFor } from "../../src/repo.ts";
import type { ReviewRecord } from "../../src/review/record.ts";
import { probeSandbox } from "../../src/security/sandbox.ts";
import { messageText, startMockOpenAI, systemPrompt, toolNames, toolResults, type ChatRequest, type MockServer, type ScriptedTurn } from "../fakes/mock-openai-server.ts";
import { makeFakeGdtoolkit, makeGodotFixture } from "../helpers/fixture.ts";
import { EXTENSION, makePiHome, runPiJson } from "../helpers/pi.ts";

let server: MockServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

function lineOf(source: string, needle: string): number {
	return source.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");

describe.skipIf(!probeSandbox().ok)("/review remembers across reviews", () => {
	it("stores worker notes, shows them to the next review, and marks repeated findings", async () => {
		const fx = makeGodotFixture();
		const card = fx.git("show", "HEAD:game/items/card.gd");
		const discountLine = lineOf(card, "identity.cost -= 1");
		server = await startMockOpenAI((req): ScriptedTurn => {
			const sys = systemPrompt(req);
			if (!sys.includes("You are reviewing one part of a change")) return { text: "ok" };
			if (toolResults(req).length > 0) return { toolCalls: [{ name: "review_done", arguments: { summary: "Reviewed." } }] };
			if (!userText(req).includes("## game/items/card.gd")) return { toolCalls: [{ name: "review_done", arguments: { summary: "Nothing." } }] };
			return {
				toolCalls: [
					{ name: "review_comment", arguments: { file: "game/items/card.gd", line: discountLine, severity: "critical", discipline: "project", title: "Identity resource mutated", body: "Mutate CardData." } },
					{ name: "memory_note_file", arguments: { path: "game/items/card.gd", summary: "Card: Item subclass; runtime state in CardData built from a CardIdentity blueprint.", pitfalls: ["never mutate identity"] } },
				],
			};
		});
		const home = makePiHome(server.url);
		const env = { ...home.env };
		const reviewsDir = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const run1 = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks"], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(run1.exitCode, run1.stderr).toBe(0);
		const notes = readdirSync(join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "notes"));
		expect(notes).toHaveLength(1);
		const before = server.requests.length;
		const run2 = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-checks"], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(run2.exitCode, run2.stderr).toBe(0);
		const second = server.requests.slice(before).find((r) => systemPrompt(r).includes("You are reviewing one part") && userText(r).includes("## game/items/card.gd"))!;
		expect(systemPrompt(second)).toContain("<file_notes>");
		expect(systemPrompt(second)).toContain("runtime state in CardData");
		expect(systemPrompt(second)).toContain("<already_raised>");
		expect(systemPrompt(second)).toContain("<project_brief>");
		const ids = readdirSync(reviewsDir).sort();
		const latest = JSON.parse(readFileSync(join(reviewsDir, ids.at(-1)!, "review.json"), "utf8")) as ReviewRecord;
		const repeated = latest.comments.find((c) => c.title === "Identity resource mutated")!;
		expect(repeated.alreadyRaised?.occurrences).toBe(1);
		expect(repeated.alreadyRaised?.reviewId).toBe(ids[0]);
	});
});

describe.skipIf(!probeSandbox().ok)("/review end to end", () => {
	it("reviews a branch: checks, routed workers, anchored findings, doc pass, saved report", async () => {
		const fx = makeGodotFixture();
		const player = fx.git("show", "HEAD:game/player.gd");
		const card = fx.git("show", "HEAD:game/items/card.gd");
		const hudLine = lineOf(player, "var hud = get_node");
		const discountLine = lineOf(card, "identity.cost -= 1");
		const positionLine = lineOf(card, "position = slot.position");

		server = await startMockOpenAI((req): ScriptedTurn => {
			const sys = systemPrompt(req);
			const done = toolResults(req).length > 0;
			if (sys.includes("You are reviewing one part of a change")) {
				if (done) return { toolCalls: [{ name: "review_done", arguments: { summary: "Reviewed." } }] };
				const ctx = userText(req);
				const calls: NonNullable<ScriptedTurn["toolCalls"]> = [];
				if (ctx.includes("## game/player.gd")) {
					calls.push({ name: "review_comment", arguments: { file: "game/player.gd", line: hudLine, severity: "important", discipline: "godot-optimization", title: "get_node every frame in _process", body: `game/player.gd:${hudLine} looks up the HUD every frame.`, suggestion: "@onready var hud := $\"/root/Main/HUD\"" } });
					calls.push({ name: "review_comment", arguments: { file: "game/player.gd", line: 999, severity: "minor", discipline: "general", title: "far away line", body: "anchored outside the diff" } });
				}
				if (ctx.includes("## game/items/card.gd")) {
					calls.push({ name: "review_comment", arguments: { file: "game/items/card.gd", line: discountLine, severity: "critical", discipline: "project", title: "Identity resource mutated", body: "CardIdentity is a shared blueprint; mutate CardData instead." } });
					calls.push({ name: "review_comment", arguments: { file: "game/items/card.gd", line: positionLine, severity: "important", discipline: "project", title: "Movement bypasses ItemTransformationDescriptor", body: "Use move_to()." } });
				}
				return calls.length ? { toolCalls: calls } : { toolCalls: [{ name: "review_done", arguments: { summary: "Nothing found." } }] };
			}
			if (sys.includes("godot_doc_maintainer")) {
				if (!done) {
					return {
						toolCalls: [
							{ name: "edit", arguments: { path: "DESIGN.md", edits: [{ oldText: "- game/ui: HUD", newText: "- game/ui: HUD\n- game/player.gd: the player (CharacterBody2D)" }] } },
							{ name: "edit", arguments: { path: "project.godot", edits: [{ oldText: "config_version=5", newText: "config_version=6" }] } },
						],
					};
				}
				return { text: "Added the player to the Folders section of DESIGN.md." };
			}
			return { text: "ok" };
		});
		const home = makePiHome(server.url);
		const bin = makeFakeGdtoolkit();
		home.config({ sandbox: { extraReadOnly: [bin] } });
		const run = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-open"], {
			cwd: fx.root,
			env: { ...home.env, PATH: `${bin}:${process.env.PATH}` },
			timeoutMs: 180_000,
		});
		expect(run.exitCode, run.stderr).toBe(0);

		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const [id] = readdirSync(reviews);
		const record = JSON.parse(readFileSync(join(reviews, id, "review.json"), "utf8")) as ReviewRecord;
		expect(record.status, record.error).toBe("complete");
		const md = readFileSync(join(reviews, id, "review.md"), "utf8");
		expect(md).toContain("# Review:");
		if (process.env.PGH_DUMP) console.log(md, "\n----- stderr -----\n", run.stderr);

		// workers ran per routed unit and saw only their skills
		const workerReqs = server.requests.filter((r) => systemPrompt(r).includes("You are reviewing one part of a change"));
		expect(workerReqs.length).toBeGreaterThanOrEqual(2);
		const shaderReq = workerReqs.find((r) => userText(r).includes("## game/shaders/glow.gdshader"))!;
		expect(systemPrompt(shaderReq)).toContain('<skill name="shader-basics">');
		expect(systemPrompt(shaderReq)).not.toContain('<skill name="godot-code-review">');
		const playerReq = workerReqs.find((r) => userText(r).includes("## game/player.gd"))!;
		expect(systemPrompt(playerReq)).toContain('<skill name="godot-code-review">');
		expect(systemPrompt(playerReq)).toContain('<project_doc name="AGENTS.md">');
		expect(toolNames(playerReq)).toEqual(expect.arrayContaining(["review_comment", "review_done", "read", "grep", "bash"]));
		expect(toolNames(playerReq)).not.toContain("edit");
		expect(toolNames(playerReq)).not.toContain("write");

		// findings anchored to the planted lines; the out-of-diff one moved; check findings included
		const byTitle = (t: string) => record.comments.find((c) => c.title === t)!;
		expect(byTitle("get_node every frame in _process")).toMatchObject({ file: "game/player.gd", line: hudLine, severity: "important" });
		expect(byTitle("Identity resource mutated")).toMatchObject({ file: "game/items/card.gd", line: discountLine, severity: "critical" });
		expect(byTitle("Movement bypasses ItemTransformationDescriptor").line).toBe(positionLine);
		expect(byTitle("far away line").anchorAdjusted?.reason).toMatch(/outside the diff/);
		expect(record.comments[0].severity).toBe("critical");
		const gdlint = record.checks.find((c) => c.name === "gdlint")!;
		expect(gdlint.status).toBe("failed");
		expect(record.comments.some((c) => c.discipline === "check:gdlint" && c.line === hudLine)).toBe(true);
		expect(record.checks.find((c) => c.name === "check-docs")!.status).toBe("failed");

		// the doc pass changed DESIGN.md and nothing else
		expect(readFileSync(join(fx.root, "DESIGN.md"), "utf8")).toContain("game/player.gd: the player");
		expect(readFileSync(join(fx.root, "project.godot"), "utf8")).toContain("config_version=5");
		expect(record.docPass?.patches.map((p) => p.file)).toEqual(["DESIGN.md"]);
		expect(record.docPass?.finalText).toContain("Folders section");
		const docReqs = server.requests.filter((r) => systemPrompt(r).includes("godot_doc_maintainer"));
		expect(toolResults(docReqs.at(-1)!).map((r) => r.text).join("\n")).toMatch(/Only DESIGN.md and AGENTS.md/);
		// git is untouched apart from the doc edit
		expect(fx.git("status", "--porcelain")).toContain(" M DESIGN.md");
		expect(fx.git("log", "--oneline").trim().split("\n")).toHaveLength(2);
	});
});

describe.skipIf(!probeSandbox().ok)("/review target fallback", () => {
	it("asks the model to interpret a request the parser does not understand", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI((req): ScriptedTurn => {
			const sys = systemPrompt(req);
			if (sys.startsWith("Turn a request to review git changes into JSON")) {
				return { text: 'Here you go: {"kind":"range","base":"develop","head":"HEAD","mergeBase":true}' };
			}
			if (sys.includes("You are reviewing one part of a change")) return { toolCalls: [{ name: "review_done", arguments: { summary: "Reviewed." } }] };
			return { text: "ok" };
		});
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "/review everything I did for the player feature --no-docs --no-checks --no-open"], { cwd: fx.root, env: home.env, timeoutMs: 180_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const [id] = readdirSync(reviews);
		const record = JSON.parse(readFileSync(join(reviews, id, "review.json"), "utf8")) as ReviewRecord;
		expect(record.status, record.error).toBe("complete");
		expect(record.target.resolved.source).toBe("llm");
		expect(record.target.resolved.exact).toBe(false);
		expect(record.files.map((f) => f.path)).toContain("game/player.gd");
		const ask = server.requests.find((r) => systemPrompt(r).startsWith("Turn a request"))!;
		expect(userText(ask)).toContain("Default base branch: develop");
		expect(userText(ask)).toContain("everything I did for the player feature");
	});
});
