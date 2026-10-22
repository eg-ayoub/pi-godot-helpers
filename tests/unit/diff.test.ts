import { describe, expect, it } from "vitest";
import { collectDiff, enclosingSource, gdscriptFunctions, parseUnifiedDiff, renderHunk, summarizeSceneDiff, unquotePath } from "../../src/review/diff.ts";
import { parseTargetText, resolveTarget } from "../../src/review/target.ts";
import { makeGodotFixture } from "../helpers/fixture.ts";

const SAMPLE = `diff --git a/game/a.gd b/game/a.gd
index 1111111..2222222 100644
--- a/game/a.gd
+++ b/game/a.gd
@@ -1,4 +1,5 @@ extends Node
 extends Node
-var x = 1
+var x := 1
+var y := 2

 func f():
\\ No newline at end of file
diff --git a/new.gd b/new.gd
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.gd
@@ -0,0 +1,2 @@
+extends Node
+func g(): pass
diff --git a/old.gd b/renamed.gd
similarity index 90%
rename from old.gd
rename to renamed.gd
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/gone.gd b/gone.gd
deleted file mode 100644
--- a/gone.gd
+++ /dev/null
@@ -1 +0,0 @@
-extends Node
`;

describe("parseUnifiedDiff", () => {
	const files = parseUnifiedDiff(SAMPLE);
	it("reads files, statuses and line numbers", () => {
		expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
			["game/a.gd", "M", false],
			["new.gd", "A", false],
			["renamed.gd", "R", false],
			["img.png", "M", true],
			["gone.gd", "D", false],
		]);
		const h = files[0].hunks[0];
		expect(h.header).toBe("extends Node");
		expect(h.lines.filter((l) => l.k === "+").map((l) => l.n)).toEqual([2, 3]);
		expect(h.lines.filter((l) => l.k === "-").map((l) => l.o)).toEqual([2]);
		expect(files[0].added).toBe(2);
		expect(files[0].removed).toBe(1);
		expect(files[2].oldPath).toBe("old.gd");
		expect(files[4].hunks[0].lines[0]).toEqual({ k: "-", o: 1, t: "extends Node" });
	});
	it("renders hunks with both line numbers", () => {
		expect(renderHunk(files[0].hunks[0])).toContain("      2     +var x := 1".replace("      2     ", "          2 "));
	});
});

describe("GDScript helpers", () => {
	const src = `extends Node

## Doc.
func a() -> void:
\tvar x = 1
\tif x:
\t\tprint(x)

static func b(v: int) -> int:
\treturn v * 2
var after := 1
`;
	it("finds functions by indentation", () => {
		expect(gdscriptFunctions(src).map((f) => [f.signature, f.start, f.end])).toEqual([
			["func a() -> void:", 4, 7],
			["static func b(v: int) -> int:", 9, 10],
		]);
	});
	it("returns the enclosing source with line numbers", () => {
		const out = enclosingSource(src, [6], "x.gd (new)");
		expect(out).toContain("x.gd (new) lines 4-7");
		expect(out).toContain("    6  \tif x:");
		expect(out).not.toContain("static func b");
	});
	it("unquotes git paths", () => {
		expect(unquotePath('"a/caf\\303\\251.gd"')).toBe("a/café.gd");
	});
});

describe("scene summaries", () => {
	it("lists nodes, connections and resources", () => {
		const [file] = parseUnifiedDiff(`diff --git a/ui.tscn b/ui.tscn
--- a/ui.tscn
+++ b/ui.tscn
@@ -1,3 +1,6 @@
 [gd_scene format=3]
+[ext_resource type="Script" path="res://game/ui/hud.gd" id="1"]
+[node name="Score" type="Label" parent="."]
+text = "0"
+[connection signal="pressed" from="Button" to="." method="_on_pressed"]
-[node name="Old" type="Panel" parent="."]
`);
		const s = summarizeSceneDiff(file);
		expect(s).toContain("added node Score (Label)");
		expect(s).toContain("added connection Button.pressed -> ..");
		expect(s).toContain("removed node Old (Panel)");
		expect(s).toContain("added ext_resource Script res://game/ui/hud.gd");
		expect(s).toContain("1 property line(s) changed");
	});
});

describe("collectDiff on the fixture", () => {
	it("collects a branch review with function context from the head commit", async () => {
		const fx = makeGodotFixture();
		const target = await resolveTarget(parseTargetText("this branch against develop", "develop")!, "x", fx.root, "develop");
		const files = await collectDiff(target, fx.root);
		const paths = files.map((f) => f.path).sort();
		expect(paths).toEqual(["game/items/card.gd", "game/player.gd", "game/shaders/glow.gdshader", "game/ui/hud.gd"]);
		const card = files.find((f) => f.path === "game/items/card.gd")!;
		expect(card.headerLines).toContain("class_name Card");
		const discount = card.hunks.find((h) => h.lines.some((l) => l.t.includes("identity.cost -= 1")))!;
		expect(discount.enclosing).toContain("func discount() -> void:");
		const glow = files.find((f) => f.path.endsWith(".gdshader"))!;
		expect(glow.lang).toBe("shader");
	});

	it("includes untracked files for working-tree reviews and reads the working tree", async () => {
		const fx = makeGodotFixture();
		fx.write("game/new_thing.gd", "extends Node\n\nfunc _ready() -> void:\n\tpass\n");
		const target = await resolveTarget(parseTargetText("unstaged", "develop")!, "x", fx.root, "develop");
		const files = await collectDiff(target, fx.root);
		expect(files.map((f) => f.path).sort()).toEqual(["game/game_manager.gd", "game/new_thing.gd"]);
		const fresh = files.find((f) => f.path === "game/new_thing.gd")!;
		expect(fresh.status).toBe("A");
		expect(fresh.hunks[0].enclosing).toContain("func _ready()");
	});

	it("staged review sees only the index", async () => {
		const fx = makeGodotFixture();
		const target = await resolveTarget(parseTargetText("staged", "develop")!, "x", fx.root, "develop");
		const files = await collectDiff(target, fx.root);
		expect(files.map((f) => f.path)).toEqual(["game/resources/card_identity.gd"]);
	});
});
