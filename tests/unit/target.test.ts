import { describe, expect, it } from "vitest";
import { parseTargetJson, parseTargetText, resolveTarget } from "../../src/review/target.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";

const cases: [string, unknown, boolean?][] = [
	["review the unstaged changes", { kind: "unstaged" }],
	["unstaged", { kind: "unstaged" }],
	["the changes I haven't staged", { kind: "unstaged" }],
	["review the staged changes", { kind: "staged" }],
	["what I staged", { kind: "staged" }],
	["review my uncommitted changes", { kind: "uncommitted" }],
	["all my changes", { kind: "uncommitted" }],
	["local changes", { kind: "uncommitted" }],
	["review this branch against develop", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["this branch vs main", { kind: "range", base: "main", head: "HEAD", mergeBase: true }],
	["review feature/player against develop", { kind: "range", base: "develop", head: "feature/player", mergeBase: true }],
	["review branch feature/x compared to develop", { kind: "range", base: "develop", head: "feature/x", mergeBase: true }],
	["compare feature/x versus release/1.0", { kind: "range", base: "release/1.0", head: "feature/x", mergeBase: true }],
	["review my branch relative to develop", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["everything since develop", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["review against origin/develop", { kind: "range", base: "origin/develop", head: "HEAD", mergeBase: true }],
	["develop..feature/x", { kind: "range", base: "develop", head: "feature/x", mergeBase: false }],
	["review develop...HEAD", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["review this branch", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["review the PR", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }],
	["review the last commit", { kind: "commit", sha: "HEAD" }],
	["the latest commit", { kind: "commit", sha: "HEAD" }],
	["review the last 3 commits", { kind: "lastN", n: 3 }],
	["last three commits", { kind: "lastN", n: 3 }],
	["review commit abc1234", { kind: "commit", sha: "abc1234" }],
	["", { kind: "range", base: "develop", head: "HEAD", mergeBase: true }, false],
	["feature/x", { kind: "range", base: "develop", head: "feature/x", mergeBase: true }, false],
	["a1b2c3d4", { kind: "commit", sha: "a1b2c3d4" }, false],
];

describe("parseTargetText", () => {
	it.each(cases)("%s", (text, expected, exact = true) => {
		const r = parseTargetText(text, "develop");
		expect(r?.target).toEqual(expected);
		expect(r?.exact).toBe(exact);
	});

	it("gives up on text it cannot read", () => {
		expect(parseTargetText("please look at what Bob did yesterday afternoon", "develop")).toBeUndefined();
	});
});

describe("parseTargetJson", () => {
	it("reads the model's JSON", () => {
		expect(parseTargetJson('```json\n{"kind":"range","base":"develop"}\n```')).toEqual({ kind: "range", base: "develop", head: "HEAD", mergeBase: true });
		expect(parseTargetJson('{"kind":"lastN","n":2}')).toEqual({ kind: "lastN", n: 2 });
		expect(parseTargetJson('{"kind":"nope"}')).toBeUndefined();
		expect(parseTargetJson("no json")).toBeUndefined();
	});
});

describe("resolveTarget against a repository", () => {
	it("resolves ranges to the merge base, commits to their parent, and checks refs", async () => {
		const fx = makeGodotFixture();
		const develop = fx.git("rev-parse", "develop").trim();
		const head = fx.git("rev-parse", "HEAD").trim();
		const range = await resolveTarget(parseTargetText("this branch against develop", "develop")!, "x", fx.root, "develop");
		expect(range.gitArgs).toEqual([develop, head]);
		expect(range.newSide).toEqual({ kind: "rev", rev: head });
		const commit = await resolveTarget(parseTargetText("the last commit", "develop")!, "x", fx.root, "develop");
		expect(commit.gitArgs).toEqual([develop, head]);
		const unstaged = await resolveTarget(parseTargetText("unstaged", "develop")!, "x", fx.root, "develop");
		expect(unstaged.includeUntracked).toBe(true);
		await expect(resolveTarget(parseTargetText("this branch against nope", "develop")!, "x", fx.root, "develop")).rejects.toThrow(/no branch or commit named nope/);
	});

	it("falls back to main/master when the default base is missing, with a warning", async () => {
		const fx = makeGodotFixture();
		fx.git("branch", "-m", "develop", "main");
		const r = await resolveTarget(parseTargetText("review this branch", "develop")!, "x", fx.root, "develop");
		expect(r.warnings.join(" ")).toMatch(/no develop branch; comparing against main/);
	});
});
