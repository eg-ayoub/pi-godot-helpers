// The GodotPrompter version the tests are written against. The extension follows the newest tag; the tests need
// a fixed set of skills, downloaded once by tests/global-setup.ts (PGH_TEST_SKILLS points at another copy).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TEST_SKILLS_REPO = "https://github.com/jame581/GodotPrompter.git";
export const TEST_SKILLS_TAG = "v1.15.1";
export const TEST_SKILLS_COMMIT = "a82a195b541ac07806d2d05c776572283ffbe6a1";
export const TEST_SKILLS = process.env.PGH_TEST_SKILLS ?? join(ROOT, "node_modules", ".cache", "pgh-godot-prompter", TEST_SKILLS_TAG, "skills");

/** Download the test skills if they are missing; checks the tag still points at the expected commit. */
export function ensureTestSkills(): string {
	if (existsSync(join(TEST_SKILLS, "godot-code-review", "SKILL.md"))) return TEST_SKILLS;
	if (process.env.PGH_TEST_SKILLS) throw new Error(`PGH_TEST_SKILLS=${TEST_SKILLS} has no godot-code-review/SKILL.md`);
	const target = dirname(TEST_SKILLS);
	mkdirSync(dirname(target), { recursive: true });
	const tmp = mkdtempSync(join(dirname(target), ".clone-"));
	try {
		execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", TEST_SKILLS_TAG, "--", TEST_SKILLS_REPO, tmp], { stdio: "pipe" });
		const head = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		if (head !== TEST_SKILLS_COMMIT) throw new Error(`${TEST_SKILLS_TAG} is ${head}, expected ${TEST_SKILLS_COMMIT}`);
		rmSync(join(tmp, ".git"), { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { recursive: true, force: true });
		throw new Error(`could not download the test skills (GodotPrompter ${TEST_SKILLS_TAG}): ${(error as Error).message}. Set PGH_TEST_SKILLS to a local copy of its skills/ folder to run offline.`);
	}
	return TEST_SKILLS;
}
