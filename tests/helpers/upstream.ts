// A local stand-in for the GodotPrompter repository: releases are commits on main with an annotated tag, each
// holding exactly the given skills (SKILL.md bodies name the tag, so a test can tell versions apart).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function upstream(): { root: string; g: (...args: string[]) => string; release: (tag: string, skills: string[]) => void } {
	const root = mkdtempSync(join(tmpdir(), "pgh-upstream-"));
	const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
	g("init", "-q", "-b", "main");
	writeFileSync(join(root, "LICENSE"), "MIT\n");
	const release = (tag: string, skills: string[]) => {
		rmSync(join(root, "skills"), { recursive: true, force: true });
		for (const s of skills) {
			mkdirSync(join(root, "skills", s), { recursive: true });
			writeFileSync(join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: Use when testing ${s} (${tag})\n---\n\n# ${s} ${tag}\n`);
		}
		g("add", "-A");
		g("commit", "-q", "--allow-empty", "-m", tag);
		g("tag", "-a", tag, "-m", tag);
	};
	return { root, g, release };
}

