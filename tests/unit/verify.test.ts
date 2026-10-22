// The pure parts of /review-verify: arguments, finding the flagged code again, check verdicts, placing verdicts
// on the current diff, and the Markdown report.
import { describe, expect, it } from "vitest";
import type { ReviewRecord } from "../../src/review/record.ts";
import { renderMarkdown } from "../../src/review/report-md.ts";
import type { CheckResult, FileDiff, ReviewComment } from "../../src/review/types.ts";
import { applyVerdicts, codeThen, functionAt, locate, parseVerifyArgs, verdictsFromChecks, windowsAround, type FoundVerdict } from "../../src/review/verify.ts";

const SOURCE = `## A card.
extends Item

## Discounts this card.
func discount() -> void:
	identity.cost -= 1

## Drops the card on a slot.
func drop_on(slot: Node2D) -> void:
	position = slot.position
	slot.receive(self)
`;

const FILES: FileDiff[] = [
	{
		path: "game/card.gd",
		status: "M",
		binary: false,
		lang: "gdscript",
		added: 2,
		removed: 0,
		hunks: [
			{
				id: "h1",
				file: "game/card.gd",
				oldStart: 4,
				oldLines: 3,
				newStart: 4,
				newLines: 5,
				header: "",
				tokens: 0,
				lines: [
					{ k: " ", o: 4, n: 4, t: "## Discounts this card." },
					{ k: " ", o: 5, n: 5, t: "func discount() -> void:" },
					{ k: "+", n: 6, t: "\tidentity.cost -= 1" },
					{ k: " ", o: 6, n: 7, t: "" },
					{ k: "+", n: 10, t: "\tposition = slot.position" },
				],
				enclosing: "game/card.gd (new) lines 5-6:\n    5  func discount() -> void:\n    6  \tidentity.cost -= 1\n\ngame/card.gd (new) lines 9-11:\n    9  func drop_on(slot: Node2D) -> void:\n   10  \tposition = slot.position\n   11  \tslot.receive(self)",
			},
		],
	},
];

function comment(over: Partial<ReviewComment>): ReviewComment {
	return { id: "c1", source: "worker", file: "game/card.gd", side: "new", line: 6, hunkId: "h1", severity: "critical", discipline: "project", title: "Identity mutated", body: "Mutate CardData.", fingerprint: "fp1", ...over };
}

describe("/review-verify arguments", () => {
	it("takes a review id and flags", () => {
		expect(parseVerifyArgs("")).toEqual({ id: undefined, all: false, checks: true, open: true, unknown: [] });
		expect(parseVerifyArgs("2026-10-22T10-00-00-000Z --all --no-checks --no-open")).toEqual({ id: "2026-10-22T10-00-00-000Z", all: true, checks: false, open: false, unknown: [] });
		expect(parseVerifyArgs("--force").unknown).toEqual(["--force"]);
	});
});

describe("finding the flagged code again", () => {
	it("knows the function a line was in at review time", () => {
		expect(functionAt(FILES, comment({ line: 6 }))).toBe("func discount");
		expect(functionAt(FILES, comment({ line: 10 }))).toBe("func drop_on");
		expect(functionAt(FILES, comment({ line: null }))).toBe("");
	});

	it("finds the same line, nearest to where it was", () => {
		const moved = `## header\n\n\n${SOURCE}`;
		expect(locate(moved, "\tidentity.cost -= 1", "func discount", 6)).toEqual({ line: 9, how: "The flagged line is still in the file, at line 9." });
		const twice = `${SOURCE}\nfunc other() -> void:\n\tidentity.cost -= 1\n`;
		expect(locate(twice, "\tidentity.cost -= 1", "func discount", 6).line).toBe(6);
		expect(locate(twice, "\tidentity.cost -= 1", "func discount", 6).how).toContain("1 other place");
	});

	it("falls back to the function, and says when both are gone", () => {
		const fixed = SOURCE.replace("identity.cost -= 1", "data.cost -= 1");
		expect(locate(fixed, "\tidentity.cost -= 1", "func discount", 6)).toEqual({ line: 5, how: "The flagged line is no longer in the file; its function `func discount` is at lines 5-6." });
		const gone = SOURCE.replace(/## Discounts[\s\S]*?-= 1\n/, "");
		expect(locate(gone, "\tidentity.cost -= 1", "func discount", 6)).toEqual({ how: "Neither the flagged line nor its function `func discount` is in the file any more." });
		expect(locate(undefined, "x", "", 1)).toEqual({ how: "The file no longer exists (deleted or moved)." });
	});

	it("does not match short lines, and shows the area of a line outside the reviewed diff", () => {
		expect(locate("pass\npass\n", "pass", "", 1).line).toBeUndefined();
		expect(locate(SOURCE, "", "", 9)).toMatchObject({ line: 9, how: expect.stringContaining("outside the reviewed diff") });
		expect(locate(SOURCE, "", "", null)).toEqual({ how: "A file-level finding." });
	});

	it("shows the reviewed lines with the flagged one marked", () => {
		const then = codeThen(FILES, comment({ line: 6 })) as string;
		expect(then.split("\n").find((l) => l.startsWith(">"))).toContain("identity.cost -= 1");
		expect(then.split("\n").filter((l) => l.startsWith(">"))).toHaveLength(1);
		expect(codeThen(FILES, comment({ line: null }))).toBeUndefined();
	});

	it("merges overlapping windows", () => {
		const text = windowsAround(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), [5, 8, 30], 2, "f");
		expect(text).toContain("f lines 3-10:");
		expect(text).toContain("f lines 28-32:");
	});
});

describe("check verdicts", () => {
	const lint = (findings: CheckResult["findings"], status: CheckResult["status"] = findings.length ? "failed" : "passed"): CheckResult => ({ name: "gdlint", command: "gdlint", status, output: "", findings });
	const c = comment({ id: "k1", source: "check", discipline: "check:gdlint", line: 10, title: 'Variable "hud" has no static type', body: 'Variable "hud" has no static type (untyped-variable)' });

	it("is fixed when the check no longer reports it, still present (with the new line) when it does", () => {
		const all = () => true;
		expect(verdictsFromChecks([c], [lint([])], all).get("k1")).toMatchObject({ status: "fixed", by: "check" });
		const still = verdictsFromChecks([c], [lint([{ file: "game/card.gd", line: 12, message: 'Variable "hud" has no static type (untyped-variable)' }])], all).get("k1");
		expect(still).toMatchObject({ status: "still-present", line: 12 });
	});

	it("leaves a finding to the workers when its check could not run or did not look at its file", () => {
		expect(verdictsFromChecks([c], [lint([], "skipped")], () => true).size).toBe(0);
		expect(verdictsFromChecks([c], [lint([])], () => false).size).toBe(0);
		expect(verdictsFromChecks([comment({})], [lint([])], () => true).size).toBe(0);
	});

	it("judges a failing check without a file by its status", () => {
		const whole = comment({ id: "k2", source: "check", file: "", line: null, discipline: "check:gdlint", title: "gdlint failed", body: "" });
		expect(verdictsFromChecks([whole], [lint([])], () => true).get("k2")?.status).toBe("fixed");
		expect(verdictsFromChecks([whole], [lint([{ message: "boom" }])], () => true).get("k2")?.status).toBe("still-present");
	});
});

describe("placing verdicts", () => {
	it("keeps open findings on their current line, fixed ones file-level, and sorts what is left to do first", () => {
		const a = comment({ id: "c1", severity: "critical", line: 6 });
		const b = comment({ id: "c2", severity: "minor", line: 10, title: "Movement" });
		const d = comment({ id: "c3", severity: "nit", line: 10, title: "Nit" });
		const verdicts = new Map<string, FoundVerdict>([
			["c1", { status: "fixed", evidence: "gone", by: "worker" }],
			["c2", { status: "still-present", evidence: "still", by: "worker", line: 10 }],
		]);
		const out = applyVerdicts([a, b, d], verdicts, new Map([["c3", 10]]), FILES);
		expect(out.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
		expect(out[0]).toMatchObject({ line: 10, previous: { side: "new", line: 10 }, verdict: { status: "still-present", evidence: "still" } });
		expect(out[0].verdict).not.toHaveProperty("line");
		expect(out[1]).toMatchObject({ line: 10, verdict: { status: "unclear", evidence: "No verdict was given." } });
		expect(out[2]).toMatchObject({ line: null, previous: { line: 6 }, verdict: { status: "fixed" } });
	});
});

describe("review.md of a verification", () => {
	it("groups the findings by status", () => {
		const comments = applyVerdicts([comment({ id: "c1" }), comment({ id: "c2", title: "Movement", line: 10 })], new Map<string, FoundVerdict>([["c1", { status: "fixed", evidence: "data.cost now", by: "worker" }], ["c2", { status: "still-present", evidence: "still at 10", by: "worker", line: 10 }]]), new Map(), FILES);
		const md = renderMarkdown({
			version: 1,
			kind: "verify",
			verifies: { id: "r1", description: "HEAD against develop", createdAt: "2026-10-22T10:00:00Z" },
			id: "v1",
			createdAt: "2026-10-22T11:00:00Z",
			durationMs: 1000,
			repo: { toplevel: "/repo", id: "x" },
			target: { label: "", description: "HEAD against develop", resolved: {} as ReviewRecord["target"]["resolved"] },
			files: FILES,
			comments,
			checks: [],
			routing: { decisions: [], units: [] },
			workers: [],
			warnings: [],
			status: "complete",
		});
		expect(md).toContain("# Verification: HEAD against develop");
		expect(md).toContain("1 fixed, 0 partly fixed, 1 still present, 0 unclear");
		expect(md.indexOf("## Still present (1)")).toBeLessThan(md.indexOf("## Fixed (1)"));
		expect(md).toContain("`game/card.gd:10` (was line 10)");
		expect(md).toContain("Verdict: data.cost now");
	});
});
