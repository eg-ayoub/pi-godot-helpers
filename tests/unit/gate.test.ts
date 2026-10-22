import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideToolCall, docForPath, resolveToolPath, type GateContext, type Mode } from "../../src/security/gate.ts";

function setup() {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "pgh-gate-")));
	writeFileSync(join(repo, "DESIGN.md"), "# design\n");
	writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
	mkdirSync(join(repo, "game"));
	writeFileSync(join(repo, "game", "player.gd"), "extends Node\n");
	writeFileSync(join(repo, "project.godot"), "");
	const skills = realpathSync(mkdtempSync(join(tmpdir(), "pgh-skills-")));
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "pgh-outside-")));
	writeFileSync(join(outside, "secret.txt"), "secret");
	return { repo, skills, outside };
}

function ctx(repo: string, mode: Mode, extra: Partial<GateContext> = {}): GateContext {
	return {
		mode,
		repoRoot: repo,
		docs: ["DESIGN.md", "AGENTS.md"],
		readRoots: [],
		docsEditableIn: ["review-docs"],
		maxDocEditChars: 2000,
		extraAllowedTools: [],
		ownTools: { memory_search: ["advisor", "review", "review-docs", "worker"], review_comment: ["worker"] },
		...extra,
	};
}

const edit = (path: string, newText = "x") => ({ path, edits: [{ oldText: "# design", newText }] });

describe("resolveToolPath", () => {
	it("strips @, expands ~ and resolves against cwd", () => {
		expect(resolveToolPath("@DESIGN.md", "/r")).toBe("/r/DESIGN.md");
		expect(resolveToolPath("~/x", "/r")).toBe(join(homedir(), "x"));
		expect(resolveToolPath("a/../DESIGN.md", "/r")).toBe("/r/DESIGN.md");
		expect(resolveToolPath("/abs/p", "/r")).toBe("/abs/p");
		expect(resolveToolPath("DESIGN x.md", "/r")).toBe("/r/DESIGN x.md");
	});
});

describe("gate: edits and writes", () => {
	it("blocks every edit outside the doc pass", () => {
		const { repo } = setup();
		for (const mode of ["off", "advisor", "review", "worker"] as Mode[]) {
			expect(decideToolCall("edit", edit("DESIGN.md"), repo, ctx(repo, mode))?.reason).toMatch(/not allowed/);
		}
	});

	it("allows edits of the two docs during the doc pass", () => {
		const { repo } = setup();
		const c = ctx(repo, "review-docs");
		expect(decideToolCall("edit", edit("DESIGN.md"), repo, c)).toBeUndefined();
		expect(decideToolCall("edit", edit("AGENTS.md"), repo, c)).toBeUndefined();
		expect(decideToolCall("edit", edit("@AGENTS.md"), repo, c)).toBeUndefined();
		expect(decideToolCall("edit", edit(join(repo, "DESIGN.md")), repo, c)).toBeUndefined();
		expect(decideToolCall("edit", edit("../DESIGN.md"), join(repo, "game"), c)).toBeUndefined();
	});

	it("blocks other files, other casings, nested docs and traversal", () => {
		const { repo, outside } = setup();
		const c = ctx(repo, "review-docs");
		for (const p of ["project.godot", "game/player.gd", "design.md", "Design.md", "game/DESIGN.md", "../DESIGN.md", join(outside, "DESIGN.md"), "DESIGN.md.bak", ".git/config", "README.md"]) {
			expect(decideToolCall("edit", edit(p), repo, c)?.reason, p).toMatch(/Only DESIGN.md and AGENTS.md/);
		}
	});

	it("blocks a doc that is a symlink; an alias path to the real doc is the same file", () => {
		const { repo, outside } = setup();
		writeFileSync(join(outside, "target.md"), "x");
		const repo2 = realpathSync(mkdtempSync(join(tmpdir(), "pgh-gate2-")));
		symlinkSync(join(outside, "target.md"), join(repo2, "AGENTS.md"));
		writeFileSync(join(repo2, "DESIGN.md"), "# design\n");
		const c2 = ctx(repo2, "review-docs");
		expect(decideToolCall("edit", edit("AGENTS.md"), repo2, c2)).toBeDefined();
		expect(docForPath(join(repo2, "AGENTS.md"), c2)).toBeUndefined();
		// a symlinked directory pointing at the repo reaches the real DESIGN.md: the same, allowed file
		symlinkSync(repo, join(outside, "link-to-repo"));
		expect(decideToolCall("edit", edit(join(outside, "link-to-repo", "DESIGN.md")), repo, ctx(repo, "review-docs"))).toBeUndefined();
		// but a symlinked directory cannot make another file look like a doc
		mkdirSync(join(outside, "fake"));
		writeFileSync(join(outside, "fake", "DESIGN.md"), "x");
		expect(decideToolCall("edit", edit(join(outside, "fake", "DESIGN.md")), repo, ctx(repo, "review-docs"))).toBeDefined();
	});

	it("caps the size of doc edits", () => {
		const { repo } = setup();
		const c = ctx(repo, "review-docs", { maxDocEditChars: 100 });
		expect(decideToolCall("edit", edit("DESIGN.md", "y".repeat(50)), repo, c)).toBeUndefined();
		expect(decideToolCall("edit", edit("DESIGN.md", "y".repeat(500)), repo, c)?.reason).toMatch(/limit is 100/);
	});

	it("write may only create a missing doc", () => {
		const { repo } = setup();
		const c = ctx(repo, "review-docs");
		expect(decideToolCall("write", { path: "DESIGN.md", content: "new" }, repo, c)?.reason).toMatch(/exists/);
		const repo2 = realpathSync(mkdtempSync(join(tmpdir(), "pgh-gate3-")));
		expect(decideToolCall("write", { path: "DESIGN.md", content: "new" }, repo2, ctx(repo2, "review-docs"))).toBeUndefined();
		expect(decideToolCall("write", { path: "notes.md", content: "new" }, repo2, ctx(repo2, "review-docs"))).toBeDefined();
	});
});

describe("gate: reads and other tools", () => {
	it("allows reads inside the repo and configured roots only", () => {
		const { repo, skills, outside } = setup();
		const c = ctx(repo, "advisor", { readRoots: [skills] });
		expect(decideToolCall("read", { path: "game/player.gd" }, repo, c)).toBeUndefined();
		expect(decideToolCall("ls", {}, repo, c)).toBeUndefined();
		expect(decideToolCall("grep", { pattern: "x" }, repo, c)).toBeUndefined();
		expect(decideToolCall("find", { pattern: "*.gd", path: "game" }, repo, c)).toBeUndefined();
		expect(decideToolCall("read", { path: join(skills, "x/SKILL.md") }, repo, c)).toBeUndefined();
		expect(decideToolCall("read", { path: join(outside, "secret.txt") }, repo, c)?.reason).toMatch(/outside the repository/);
		expect(decideToolCall("read", { path: "~/.ssh/id_ed25519" }, repo, c)?.reason).toMatch(/outside/);
		expect(decideToolCall("read", { path: "../../etc/passwd" }, repo, c)?.reason).toMatch(/outside/);
		expect(decideToolCall("grep", { pattern: "x", path: "/" }, repo, c)?.reason).toMatch(/outside/);
	});

	it("blocks reads through a symlink that leaves the repo", () => {
		const { repo, outside } = setup();
		symlinkSync(join(outside, "secret.txt"), join(repo, "innocent.txt"));
		expect(decideToolCall("read", { path: "innocent.txt" }, repo, ctx(repo, "advisor"))?.reason).toMatch(/outside/);
	});

	it("lets bash through to the guarded operations, gates own tools by mode, denies the rest", () => {
		const { repo } = setup();
		expect(decideToolCall("bash", { command: "rm -rf /" }, repo, ctx(repo, "advisor"))).toBeUndefined();
		expect(decideToolCall("memory_search", { query: "x" }, repo, ctx(repo, "advisor"))).toBeUndefined();
		expect(decideToolCall("review_comment", {}, repo, ctx(repo, "advisor"))?.reason).toMatch(/not available/);
		expect(decideToolCall("review_comment", {}, repo, ctx(repo, "worker"))).toBeUndefined();
		expect(decideToolCall("powershell", { command: "x" }, repo, ctx(repo, "advisor"))?.reason).toMatch(/not allowed/);
		expect(decideToolCall("codemode", { code: "x" }, repo, ctx(repo, "advisor"))?.reason).toMatch(/not allowed/);
		expect(decideToolCall("mcp__x__y", {}, repo, ctx(repo, "advisor"))?.reason).toMatch(/not allowed/);
		expect(decideToolCall("codemode", {}, repo, ctx(repo, "advisor", { extraAllowedTools: ["codemode"] }))).toBeUndefined();
	});
});
