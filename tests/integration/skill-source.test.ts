// The skills download: a local stand-in for the GodotPrompter repository, with tags on main and elsewhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillSource, type SkillSourceConfig } from "../../src/skills/source.ts";
import { upstream } from "../helpers/upstream.ts";

const config = (repo: string, branch?: string): SkillSourceConfig => ({ repo, branch, autoUpdate: true, timeoutSeconds: 60 });

describe("skill source", () => {
	it("installs the newest tag on main, ignores tags elsewhere, updates and prunes", async () => {
		const up = upstream();
		up.release("v1.0.0", ["event-bus"]);
		up.release("v1.1.0", ["event-bus", "godot-ui"]);
		up.g("checkout", "-q", "-b", "next");
		up.release("v2.0.0", ["event-bus", "godot-ui", "shiny"]);
		up.g("checkout", "-q", "main");

		const store = join(mkdtempSync(join(tmpdir(), "pgh-store-")), "GodotPrompter");
		const source = new SkillSource(store);
		expect(source.current()).toBeUndefined();

		const first = await source.update(config(up.root));
		expect(first.status, "error" in first ? first.error : "").toBe("updated");
		const v11 = source.current()!;
		expect(v11.tag).toBe("v1.1.0");
		expect(v11.commit).toBe(up.g("rev-parse", "v1.1.0^{commit}").trim());
		expect(readFileSync(join(v11.skillsDir, "godot-ui", "SKILL.md"), "utf8")).toContain("(v1.1.0)");
		expect(existsSync(join(v11.skillsDir, "shiny"))).toBe(false);
		expect(existsSync(join(v11.dir, "LICENSE"))).toBe(true);

		expect((await source.update(config(up.root))).status).toBe("unchanged");

		up.release("v1.2.0", ["event-bus", "godot-ui", "save-load"]);
		const second = await source.update(config(up.root));
		expect(second.status).toBe("updated");
		expect(source.current()!.tag).toBe("v1.2.0");
		expect(existsSync(join(source.current()!.skillsDir, "save-load", "SKILL.md"))).toBe(true);
		expect(existsSync(v11.dir)).toBe(true); // kept for reviews still using it

		up.release("v1.3.0", ["event-bus"]);
		expect((await source.update(config(up.root))).status).toBe("updated");
		expect(existsSync(v11.dir)).toBe(false);
		expect(existsSync(join(store, "v1.2.0"))).toBe(true);
		expect(existsSync(join(store, "v1.3.0", "skills", "godot-ui"))).toBe(false);
	});

	it("keeps the last copy when the repository cannot be reached or a tag has no skills", async () => {
		const up = upstream();
		up.release("v1.0.0", ["event-bus"]);
		const store = join(mkdtempSync(join(tmpdir(), "pgh-store-")), "GodotPrompter");
		const source = new SkillSource(store);
		expect((await source.update(config(up.root))).status).toBe("updated");

		up.g("rm", "-q", "-r", "skills");
		up.g("-c", "user.name=t", "commit", "-q", "-m", "drop");
		up.g("tag", "-a", "v1.1.0", "-m", "v1.1.0");
		const empty = await source.update(config(up.root));
		expect(empty).toMatchObject({ status: "failed", error: expect.stringMatching(/v1.1.0 has no skills/) });
		expect(source.current()!.tag).toBe("v1.0.0");

		renameSync(up.root, `${up.root}-gone`);
		const offline = await source.update(config(up.root));
		expect(offline.status).toBe("failed");
		expect(offline.installed?.tag).toBe("v1.0.0");
		expect(source.current()!.tag).toBe("v1.0.0");
	});

	it("follows a named branch instead of the default one", async () => {
		const up = upstream();
		up.release("v1.0.0", ["event-bus"]);
		up.g("checkout", "-q", "-b", "next");
		up.release("v2.0.0", ["event-bus", "shiny"]);
		up.g("checkout", "-q", "main");
		const source = new SkillSource(join(mkdtempSync(join(tmpdir(), "pgh-store-")), "GodotPrompter"));
		expect((await source.update(config(up.root, "next"))).status).toBe("updated");
		expect(source.current()!.tag).toBe("v2.0.0");
	});

	it("leaves the update to another session that holds the lock", async () => {
		const up = upstream();
		up.release("v1.0.0", ["event-bus"]);
		const store = join(mkdtempSync(join(tmpdir(), "pgh-store-")), "GodotPrompter");
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, ".lock"), "12345");
		const source = new SkillSource(store);
		expect((await source.update(config(up.root))).status).toBe("busy");
		expect(source.current()).toBeUndefined();
	});

	it("fails without a first copy when nothing can be fetched", async () => {
		const store = join(mkdtempSync(join(tmpdir(), "pgh-store-")), "GodotPrompter");
		const source = new SkillSource(store);
		const r = await source.update(config(join(tmpdir(), "pgh-no-such-repo")));
		expect(r.status).toBe("failed");
		expect(source.current()).toBeUndefined();
	});
});
