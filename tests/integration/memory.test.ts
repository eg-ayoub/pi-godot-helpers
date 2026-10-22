import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { structuralBrief, topFacts } from "../../src/memory/brief.ts";
import { MemoryStore } from "../../src/memory/store.ts";
import { fromRaw } from "../../src/review/aggregate.ts";
import { parseUnifiedDiff } from "../../src/review/diff.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";

const prov = { kind: "advisor" as const, at: "2026-10-22T00:00:00Z" };
const limits = { maxFacts: 3, maxFactChars: 120 };

function store() {
	const fx = makeGodotFixture();
	return { fx, store: new MemoryStore(mkdtempSync(join(tmpdir(), "pgh-mem-")), fx.root) };
}

describe("file notes", () => {
	it("records the blob and symbols, and goes stale when the file changes", async () => {
		const { fx, store: s } = store();
		const note = await s.putNote("game/items/card.gd", "A card; data comes from its identity.", ["identity is shared"], prov, 1500);
		expect(note.blobSha).toMatch(/^[0-9a-f]{40}$/);
		expect(note.symbols).toMatchObject({ className: "Card", extends: "Item" });
		expect(note.symbols?.functions).toEqual(expect.arrayContaining(["_ready", "discount", "drop_on"]));
		expect((await s.noteWithFreshness("game/items/card.gd"))?.fresh).toBe(true);
		fx.write("game/items/card.gd", `${readFileSync(join(fx.root, "game/items/card.gd"), "utf8")}\n# changed\n`);
		expect((await s.noteWithFreshness("game/items/card.gd"))?.fresh).toBe(false);
	});
	it("caps the summary length", async () => {
		const { store: s } = store();
		const note = await s.putNote("game/items/card.gd", "x".repeat(5000), undefined, prov, 100);
		expect(note.summary).toHaveLength(100);
	});
});

describe("facts", () => {
	it("adds, merges near-duplicates, and enforces caps", () => {
		const { store: s } = store();
		expect(s.addFact({ text: "Interactions go through the action broadcaster.", category: "architecture" }, prov, limits).outcome).toBe("added");
		const merged = s.addFact({ text: "interactions go through the action broadcaster", category: "architecture" }, prov, limits);
		expect(merged.outcome).toBe("merged");
		expect(merged.fact?.provenance).toHaveLength(2);
		expect(s.addFact({ text: "x".repeat(200), category: "other" }, prov, limits).outcome).toBe("rejected");
		s.addFact({ text: "Identity resources are immutable blueprints.", category: "architecture" }, prov, limits);
		s.addFact({ text: "Motion uses ItemTransformationDescriptor.", category: "convention" }, prov, limits);
		const full = s.addFact({ text: "A fourth unrelated fact about audio buses.", category: "other" }, prov, limits);
		expect(full.outcome).toBe("rejected");
		expect(full.reason).toMatch(/consolidate/);
		expect(s.facts()).toHaveLength(3);
	});
	it("ranks facts about touched files first", () => {
		const { store: s } = store();
		s.addFact({ text: "Audio buses are named after their purpose.", category: "convention" }, prov, { maxFacts: 10, maxFactChars: 200 });
		s.addFact({ text: "Cards never mutate their identity.", category: "pitfall", files: ["game/items/card.gd"] }, prov, { maxFacts: 10, maxFactChars: 200 });
		expect(topFacts(s.facts(), ["game/items/card.gd"])[0].text).toMatch(/Cards never mutate/);
	});
});

describe("raised items and search", () => {
	it("counts occurrences across reviews", () => {
		const { store: s } = store();
		const item = { fingerprint: "abc", file: "game/items/card.gd", discipline: "project", title: "Identity mutated", severity: "critical" as const };
		s.recordRaised([item], "r1");
		s.recordRaised([item], "r1");
		s.recordRaised([item], "r2");
		const r = s.raised().get("abc")!;
		expect(r).toMatchObject({ firstReviewId: "r1", lastReviewId: "r2", occurrences: 2 });
	});
	it("drops items a verification found fixed, until a review raises them again", () => {
		const { store: s } = store();
		const item = { fingerprint: "abc", file: "game/items/card.gd", discipline: "project", title: "Identity mutated", severity: "critical" as const };
		s.recordRaised([item, { ...item, fingerprint: "def", title: "Other" }], "r1");
		expect(s.resolveRaised(["abc", "nope"], "v1")).toBe(1);
		expect(s.resolveRaised(["abc"], "v2")).toBe(0);
		expect(s.raised().get("abc")?.resolvedIn).toBe("v1");
		expect(s.stats().raised).toBe(1);
		s.recordRaised([item], "r2");
		expect(s.raised().get("abc")).toMatchObject({ occurrences: 2, lastReviewId: "r2" });
		expect(s.raised().get("abc")).not.toHaveProperty("resolvedIn");
		expect(s.stats().raised).toBe(2);
	});
	it("finds notes by path, class and summary, and facts by words", async () => {
		const { store: s } = store();
		await s.putNote("game/items/card.gd", "Cards are dragged onto slots.", undefined, prov, 1500);
		s.addFact({ text: "Interactions go through the action broadcaster.", category: "architecture" }, prov, { maxFacts: 10, maxFactChars: 200 });
		expect(s.search("card slots")[0].note?.path).toBe("game/items/card.gd");
		expect(s.search("broadcaster")[0].fact?.text).toMatch(/action broadcaster/);
		expect(s.search("zzz")).toEqual([]);
	});
});

describe("project brief", () => {
	it("lists autoloads and classes, and is rebuilt when the tree changes", async () => {
		const { fx, store: s } = store();
		const brief = await structuralBrief(s, [""]);
		expect(brief).toContain('Godot project "Fixture"');
		expect(brief).toContain("GameManager (res://game/game_manager.gd)");
		expect(brief).toContain("Card=game/items/card.gd");
		expect(brief).toContain("Player=game/player.gd");
		fx.write("game/enemy.gd", "class_name Enemy\nextends Node2D\n");
		expect(await structuralBrief(s, [""])).toContain("Enemy=game/enemy.gd");
	});
});

describe("fingerprints", () => {
	it("survive lines shifting above the finding", () => {
		const diff = (offset: number) =>
			parseUnifiedDiff(
				[
					"diff --git a/game/a.gd b/game/a.gd",
					"--- a/game/a.gd",
					"+++ b/game/a.gd",
					`@@ -${10 + offset},2 +${10 + offset},3 @@`,
					" func f() -> void:",
					"+\tidentity.cost -= 1",
					" \tpass",
				].join("\n"),
			);
		const a = fromRaw({ file: "game/a.gd", line: 11, discipline: "project", title: "Identity mutated", body: "x" }, diff(0), "worker");
		const b = fromRaw({ file: "game/a.gd", line: 31, discipline: "project", title: "Identity resource is mutated", body: "y" }, diff(20), "worker");
		expect(a.line).toBe(11);
		expect(b.line).toBe(31);
		expect(a.fingerprint).toBe(b.fingerprint);
	});
});
