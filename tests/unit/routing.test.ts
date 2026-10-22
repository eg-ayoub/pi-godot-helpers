import { describe, expect, it } from "vitest";
import { collectDiff, parseUnifiedDiff } from "../../src/review/diff.ts";
import { parseTargetText, resolveTarget } from "../../src/review/target.ts";
import type { FileDiff } from "../../src/review/types.ts";
import { buildUnits } from "../../src/review/units.ts";
import { SkillCatalog } from "../../src/skills/catalog.ts";
import { questionFor, questionId } from "../../src/skills/classifier.ts";
import { routeByRules } from "../../src/skills/router.ts";
import { RULES, ruleSkillNames } from "../../src/skills/rules.ts";
import { systemOneClassifier } from "../../src/skills/system-one.ts";
import { VENDORED_SKILLS } from "../../src/runtime.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";

const catalog = SkillCatalog.load([VENDORED_SKILLS]);

describe("skill catalog", () => {
	it("loads the vendored GodotPrompter skills", () => {
		expect(catalog.size).toBe(56);
		const review = catalog.get("godot-code-review")!;
		expect(review.description).toMatch(/reviewing GDScript/);
		expect(review.tokens).toBeGreaterThan(1000);
		expect(catalog.body("godot-code-review")).not.toMatch(/^---/);
	});
	it("knows every skill the rules name (except ones newer than the vendored version)", () => {
		const newer = new Set(["rendering-pipeline", "web-export", "web-services"]);
		expect(catalog.unknown(ruleSkillNames(RULES)).filter((s) => !newer.has(s))).toEqual([]);
	});
});

describe("rule routing on the fixture branch", async () => {
	const fx = makeGodotFixture();
	const target = await resolveTarget(parseTargetText("this branch against develop", "develop")!, "x", fx.root, "develop");
	const files = await collectDiff(target, fx.root);
	const decisions = routeByRules(files, catalog, { alwaysOn: ["godot-code-review"] });
	const skillsOf = (path: string) => decisions.find((d) => d.file === path)!.selected.map((s) => s.skill);

	it("routes each file to the disciplines its change touches", () => {
		expect(skillsOf("game/player.gd")).toEqual(expect.arrayContaining(["godot-code-review", "godot-optimization", "gdscript-advanced", "player-controller"]));
		expect(skillsOf("game/ui/hud.gd")).toEqual(expect.arrayContaining(["godot-code-review", "godot-ui"]));
		expect(skillsOf("game/shaders/glow.gdshader")).toEqual(["shader-basics"]);
		expect(skillsOf("game/items/card.gd")).toContain("godot-code-review");
		expect(skillsOf("game/ui/hud.gd")).not.toContain("shader-basics");
	});

	it("builds units within budget, every hunk in exactly one unit", () => {
		const units = buildUnits(files, decisions, {
			maxSkillsPerUnit: 4,
			promptBudget: 32000,
			fixedTokens: 4000,
			skillTokens: (s) => catalog.get(s)?.tokens ?? 0,
			alwaysOn: ["godot-code-review"],
		});
		const all = units.flatMap((u) => u.hunkIds).sort();
		expect(all).toEqual(files.flatMap((f) => f.hunks.map((h) => h.id)).sort());
		expect(new Set(all).size).toBe(all.length);
		for (const u of units) {
			expect(u.skills.length).toBeLessThanOrEqual(4);
			expect(u.tokens.hunks).toBeLessThanOrEqual(u.tokens.budget);
			expect(u.advertised.some((a) => u.skills.includes(a))).toBe(false);
		}
		const shaderUnit = units.find((u) => u.files.includes("game/shaders/glow.gdshader"))!;
		expect(shaderUnit.skills).toEqual(["shader-basics"]);
	});
});

describe("unit splitting", () => {
	it("splits a file that is larger than the budget by hunk", () => {
		const big: FileDiff = parseUnifiedDiff(
			["diff --git a/x.gd b/x.gd", "--- a/x.gd", "+++ b/x.gd", ...Array.from({ length: 6 }, (_, i) => [`@@ -${i * 10 + 1},1 +${i * 10 + 1},1 @@`, `-a${i}`, `+b${i}`]).flat()].join("\n"),
		)[0];
		for (const h of big.hunks) h.tokens = 3000;
		const units = buildUnits([big], [{ file: "x.gd", hunkIds: big.hunks.map((h) => h.id), selected: [{ skill: "godot-code-review", score: 100, source: "always" }], candidates: [] }], {
			maxSkillsPerUnit: 4,
			promptBudget: 20000,
			fixedTokens: 4000,
			skillTokens: () => 4000,
			alwaysOn: ["godot-code-review"],
		});
		// hunk budget: 20000 - 4000 fixed - 4000 skill = 12000, so four 3000-token hunks per unit
		expect(units.map((u) => u.hunkIds.length)).toEqual([4, 2]);
		for (const u of units) expect(u.tokens.hunks).toBeLessThanOrEqual(u.tokens.budget);
	});
});

describe("classifier questions", () => {
	it("gives every skill a valid, unique id and its own instructions (llama.cpp #30482)", () => {
		const skills = catalog.all();
		const ids = skills.map((s) => questionId(s.name));
		expect(ids.every((id) => /^[A-Za-z0-9_]+$/.test(id))).toBe(true);
		expect(new Set(ids).size).toBe(skills.length);
		const instructions = skills.map((s) => questionFor(s).instructions);
		expect(new Set(instructions).size).toBe(skills.length);
		expect(questionFor(catalog.get("event-bus")!)).toMatchObject({ type: "bool", criteria: { true: expect.any(String), false: expect.any(String) } });
	});
});

describe("System One client", () => {
	const model = { api: "typesafe-system-one", provider: "p", id: "m", baseUrl: "http://127.0.0.1:1/v1" } as unknown as Parameters<typeof systemOneClassifier.classify>[0];
	const context = {
		state: { file: "a.gd" },
		questions: { s_a: { type: "bool" as const, instructions: "A?", criteria: { true: "yes", false: "no" } } },
	};
	function stub(status: number, body: unknown, seen: { url?: string; body?: any } = {}) {
		return (async (url: URL, init: RequestInit) => {
			seen.url = String(url);
			seen.body = JSON.parse(String(init.body));
			return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
		}) as unknown as typeof fetch;
	}

	it("sends bool questions as noul to <baseUrl>/systemone and reads the probability", async () => {
		const seen: { url?: string; body?: any } = {};
		const r = await systemOneClassifier.classify(model, context, { fetch: stub(200, { answers: { s_a: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1 } }, seen) });
		expect(seen.url).toBe("http://127.0.0.1:1/v1/systemone");
		expect(seen.body).toEqual({ model: "m", state: { file: "a.gd" }, questions: { s_a: { type: "noul", instructions: "A?", criteria: { true: "yes", false: "no" } } } });
		expect(r).toMatchObject({ stopReason: "stop", answers: { s_a: { type: "bool", probability: 0.8 } }, usage: { input: 10, output: 1 } });
	});

	it("turns HTTP errors and missing answers into error results", async () => {
		const failed = await systemOneClassifier.classify(model, context, { fetch: stub(500, '{"error":{"message":"duplicate instructions"}}') });
		expect(failed).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/500.*duplicate instructions/) });
		const missing = await systemOneClassifier.classify(model, context, { fetch: stub(200, { answers: {} }) });
		expect(missing).toMatchObject({ stopReason: "error", errorMessage: "System One did not answer s_a" });
		const wrongType = await systemOneClassifier.classify(model, context, { fetch: stub(200, { answers: { s_a: { type: "bool", probability: 1 } } }) });
		expect(wrongType.errorMessage).toMatch(/did not return a bool answer/);
	});
});
