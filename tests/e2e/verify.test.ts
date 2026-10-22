// /review-verify end to end with the real pi: a review, two fixes in the working tree, then a verification. Check
// findings are settled by running the checks again; the other findings go to a scripted verifier worker.
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

const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === "user").map(messageText).join("\n");
const isReviewer = (req: ChatRequest) => systemPrompt(req).includes("You are reviewing one part of a change");
const isVerifier = (req: ChatRequest) => systemPrompt(req).includes("You are checking whether the findings of an earlier review");
const lineOf = (source: string, needle: string) => source.split("\n").findIndex((l) => l.includes(needle)) + 1;

describe.skipIf(!probeSandbox().ok)("/review-verify", () => {
	it("re-runs the checks, asks a worker about the rest, and records what was fixed", async () => {
		const fx = makeGodotFixture();
		const card = fx.git("show", "HEAD:game/items/card.gd");
		const discountLine = lineOf(card, "identity.cost -= 1");
		const positionLine = lineOf(card, "position = slot.position");

		server = await startMockOpenAI((req): ScriptedTurn => {
			if (isReviewer(req)) {
				if (toolResults(req).length > 0 || !userText(req).includes("## game/items/card.gd")) return { toolCalls: [{ name: "review_done", arguments: { summary: "Reviewed." } }] };
				return {
					toolCalls: [
						{ name: "review_comment", arguments: { file: "game/items/card.gd", line: discountLine, severity: "critical", discipline: "project", title: "Identity resource mutated", body: "Mutate CardData instead." } },
						{ name: "review_comment", arguments: { file: "game/items/card.gd", line: positionLine, severity: "important", discipline: "project", title: "Movement bypasses ItemTransformationDescriptor", body: "Use move_to()." } },
					],
				};
			}
			if (isVerifier(req)) {
				const results = toolResults(req);
				// finishing before any verdict gets a reminder listing the findings
				if (results.length === 0) return { toolCalls: [{ name: "review_done", arguments: { summary: "Too early." } }] };
				if (!results.at(-1)?.text.includes("have no verdict yet")) return { toolCalls: [{ name: "review_done", arguments: { summary: "Checked." } }] };
				const context = userText(req);
				const findings = [...context.matchAll(/^### Finding (c\d+): (.+)$/gm)];
				return {
					toolCalls: findings.map(([, finding, title]) =>
						title === "Identity resource mutated" && context.includes("+\tdata.cost -= 1")
							? { name: "review_verdict", arguments: { finding, status: "fixed", evidence: "discount() changes data.cost now." } }
							: { name: "review_verdict", arguments: { finding, status: "still-present", evidence: `Still at game/items/card.gd:${positionLine}.`, line: positionLine } },
					),
				};
			}
			return { text: "ok" };
		});
		const home = makePiHome(server.url);
		const bin = makeFakeGdtoolkit();
		home.config({ sandbox: { extraReadOnly: [bin] } });
		const env = { ...home.env, PATH: `${bin}:${process.env.PATH}` };
		const reviews = join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "reviews");
		const record = (id: string) => JSON.parse(readFileSync(join(reviews, id, "review.json"), "utf8")) as ReviewRecord;

		const review = await runPiJson(["-e", EXTENSION, "/review this branch against develop --no-docs --no-open"], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(review.exitCode, review.stderr).toBe(0);
		const [reviewId] = readdirSync(reviews);
		const original = record(reviewId);
		expect(original.status, original.error).toBe("complete");
		expect(original.target.headAtReview).toBe(fx.git("rev-parse", "HEAD").trim());
		const untyped = original.comments.find((c) => c.discipline === "check:gdlint")!;
		expect(untyped.file).toBe("game/player.gd");
		expect(original.comments.some((c) => c.discipline === "check:check-docs")).toBe(true);

		// the user fixes two of the findings, without committing
		fx.write("game/items/card.gd", readFileSync(join(fx.root, "game/items/card.gd"), "utf8").replace("identity.cost -= 1", "data.cost -= 1"));
		fx.write("game/player.gd", readFileSync(join(fx.root, "game/player.gd"), "utf8").replace("var hud = get_node", "var hud: Control = get_node"));
		const statusBefore = fx.git("status", "--porcelain");

		const before = server.requests.length;
		const verify = await runPiJson(["-e", EXTENSION, "/review-verify --no-open"], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(verify.exitCode, verify.stderr).toBe(0);
		expect(verify.stderr).toContain("Verification complete");
		const verifyId = readdirSync(reviews).sort().at(-1)!;
		const v = record(verifyId);
		expect(v).toMatchObject({ kind: "verify", status: "complete", verifies: { id: reviewId } });
		expect(v.comments).toHaveLength(original.comments.length);
		const byTitle = (t: string) => v.comments.find((c) => c.title === t)!;
		expect(byTitle("Identity resource mutated")).toMatchObject({ line: null, previous: { line: discountLine }, verdict: { status: "fixed", by: "worker" } });
		expect(byTitle("Movement bypasses ItemTransformationDescriptor")).toMatchObject({ line: positionLine, verdict: { status: "still-present", by: "worker" } });
		expect(v.comments.find((c) => c.id === untyped.id)?.verdict).toMatchObject({ status: "fixed", by: "check" });
		expect(v.comments.filter((c) => c.discipline === "check:check-docs").every((c) => c.verdict?.status === "still-present" && c.verdict.by === "check")).toBe(true);
		expect(v.comments[0].verdict?.status).not.toBe("fixed");

		// the verifier saw the findings with the code then and now, and only verification tools
		const verifiers = server.requests.slice(before).filter(isVerifier);
		expect(verifiers.length).toBeGreaterThan(0);
		const first = verifiers[0];
		expect(toolNames(first)).toEqual(expect.arrayContaining(["review_verdict", "review_done", "read", "grep"]));
		expect(toolNames(first)).not.toContain("review_comment");
		expect(toolNames(first)).not.toContain("edit");
		const context = userText(first);
		if (process.env.PGH_DUMP) console.log(context, "\n----- review.md -----\n", readFileSync(join(reviews, verifyId, "review.md"), "utf8"));
		expect(context).toContain("Code at review time (> marks the flagged line)");
		expect(context).toContain("Now: The flagged line is no longer in the file; its function `func discount`");
		expect(context).toContain("### Changes to game/items/card.gd since the review");
		expect(context).toContain("+\tdata.cost -= 1");
		expect(context).not.toContain("has no static type");
		expect(server.requests.slice(before).some(isReviewer)).toBe(false);
		expect(readFileSync(join(reviews, verifyId, "review.md"), "utf8")).toMatch(/## Still present \(\d+\)[\s\S]*## Fixed \(2\)/);

		// what was fixed is no longer "already raised"; the repository was not touched
		const raised = JSON.parse(readFileSync(join(home.agentDir, "godot-helpers", repoIdFor(fx.root), "raised.json"), "utf8")) as { title: string; resolvedIn?: string }[];
		expect(raised.find((r) => r.title === "Identity resource mutated")?.resolvedIn).toBe(verifyId);
		expect(raised.find((r) => r.title.startsWith("Movement"))?.resolvedIn).toBeUndefined();
		expect(fx.git("status", "--porcelain")).toBe(statusBefore);

		// a second verification does not ask about what was already found fixed
		const again = server.requests.length;
		const second = await runPiJson(["-e", EXTENSION, `/review-verify ${verifyId} --no-open --no-checks`], { cwd: fx.root, env, timeoutMs: 180_000 });
		expect(second.exitCode, second.stderr).toBe(0);
		const v2 = record(readdirSync(reviews).sort().at(-1)!);
		expect(v2.verifies?.id).toBe(reviewId);
		expect(v2.comments.find((c) => c.title === "Identity resource mutated")?.verdict).toMatchObject({ status: "fixed", by: "earlier", verificationId: verifyId });
		const asked = server.requests.slice(again).filter(isVerifier).map(userText).join("\n");
		expect(asked).toContain("Movement bypasses ItemTransformationDescriptor");
		expect(asked).not.toContain("Identity resource mutated");
	});

	it("says so when there is nothing to verify", async () => {
		const fx = makeGodotFixture();
		server = await startMockOpenAI(() => ({ text: "ok" }));
		const home = makePiHome(server.url);
		const run = await runPiJson(["-e", EXTENSION, "/review-verify"], { cwd: fx.root, env: home.env, timeoutMs: 60_000 });
		expect(run.exitCode, run.stderr).toBe(0);
		expect(run.stderr + run.stdout).toContain("There are no reviews of this repository yet");
	});
});
