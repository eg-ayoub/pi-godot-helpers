// Where the GodotPrompter skills come from: a bare mirror of the upstream repository's branch in the extension's
// data dir (GodotPrompter: 4 MB, 1.8 s to clone, 0.5 s to fetch; a blobless mirror fetched each file of a checkout
// on its own and took minutes). On every start (in a Godot repository) the mirror fetches the default branch, and the newest tag on it
// is checked out into its own folder (skills/ and LICENSE only); current.json names the folder in use. Nothing
// is downloaded while a copy is being used: a new tag goes into a new folder, and the previous folder stays for
// reviews still running. Offline, or on any error, the last copy stays in use.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../repo.ts";

export interface SkillSourceConfig {
	/** Git URL (or path) of the GodotPrompter repository. */
	repo: string;
	/** The branch whose newest tag is used; default: the repository's default branch (master for GodotPrompter). */
	branch?: string;
	/** Fetch the newest tag on every start. */
	autoUpdate: boolean;
	timeoutSeconds: number;
}

export interface InstalledSkills {
	tag: string;
	commit: string;
	/** The folder of this version (holds skills/ and LICENSE). */
	dir: string;
	skillsDir: string;
	fetchedAt: string;
	repo: string;
}

export type UpdateResult =
	| { status: "updated" | "unchanged"; installed: InstalledSkills }
	| { status: "busy" | "failed"; installed?: InstalledSkills; error: string };

const LOCK_STALE_MS = 10 * 60 * 1000;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class SkillSource {
	/** <data dir>/skills/GodotPrompter */
	readonly store: string;
	lastResult?: UpdateResult;

	constructor(store: string) {
		this.store = store;
	}

	private get mirror(): string {
		return join(this.store, "repo.git");
	}

	private get currentFile(): string {
		return join(this.store, "current.json");
	}

	/** The copy in use, if there is one on disk. */
	current(): InstalledSkills | undefined {
		try {
			const c = JSON.parse(readFileSync(this.currentFile, "utf8")) as InstalledSkills;
			return existsSync(c.skillsDir) ? c : undefined;
		} catch {
			return undefined;
		}
	}

	private lock(): boolean {
		mkdirSync(this.store, { recursive: true });
		const file = join(this.store, ".lock");
		try {
			writeFileSync(file, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			try {
				if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) {
					rmSync(file, { force: true });
					writeFileSync(file, String(process.pid), { flag: "wx" });
					return true;
				}
			} catch {
				// another process got it
			}
			return false;
		}
	}

	private unlock(): void {
		rmSync(join(this.store, ".lock"), { force: true });
	}

	/** Fetch the branch, find its newest tag and install it if it is new. Never throws. */
	async update(cfg: SkillSourceConfig): Promise<UpdateResult> {
		const result = await this.updateInner(cfg);
		this.lastResult = result;
		return result;
	}

	private async updateInner(cfg: SkillSourceConfig): Promise<UpdateResult> {
		const before = this.current();
		if (!this.lock()) return { status: "busy", installed: before, error: "another pi session is updating the skills" };
		const timeoutMs = cfg.timeoutSeconds * 1000;
		const run = async (args: string[], cwd = this.store, env?: Record<string, string>) => {
			const r = await git(args, cwd, { timeoutMs, env });
			if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.startsWith("/")) ?? ""}: ${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
			return r.stdout.trim();
		};
		try {
			if (cfg.repo.startsWith("-")) throw new Error("invalid skills.source.repo");
			const branch = cfg.branch ?? (await this.defaultBranch(cfg.repo, run));
			if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-")) throw new Error(`invalid branch name ${JSON.stringify(branch)}`);
			if (!existsSync(join(this.mirror, "HEAD"))) {
				rmSync(this.mirror, { recursive: true, force: true });
				await run(["clone", "--bare", "--single-branch", "--branch", branch, "--", cfg.repo, this.mirror]);
			} else {
				// the config may name another repository since the mirror was made
				await run(["config", "remote.origin.url", cfg.repo], this.mirror);
				await run(["fetch", "--prune", "--tags", "--force", "origin", `+refs/heads/${branch}:refs/heads/${branch}`], this.mirror);
			}
			const tag = await run(["describe", "--tags", "--abbrev=0", `refs/heads/${branch}`], this.mirror);
			if (!TAG_PATTERN.test(tag)) throw new Error(`unexpected tag name ${JSON.stringify(tag)}`);
			const commit = await run(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], this.mirror);
			const dir = join(this.store, tag);
			if (before && before.tag === tag && before.commit === commit && existsSync(before.skillsDir)) {
				return { status: "unchanged", installed: before };
			}
			// check the tag out into a fresh folder (a separate index: the mirror is bare), then swap it in
			const tmp = join(this.store, `.${tag}.${process.pid}.tmp`);
			rmSync(tmp, { recursive: true, force: true });
			mkdirSync(tmp, { recursive: true });
			const env = { GIT_INDEX_FILE: join(tmp, ".index") };
			const tree = await run(["ls-tree", "--name-only", commit, "--", "skills"], this.mirror);
			if (tree !== "skills") {
				rmSync(tmp, { recursive: true, force: true });
				throw new Error(`${tag} has no skills folder`);
			}
			await run(["--git-dir", this.mirror, "--work-tree", tmp, "checkout", commit, "--", "skills"], this.store, env);
			await run(["--git-dir", this.mirror, "--work-tree", tmp, "checkout", commit, "--", "LICENSE"], this.store, env).catch(() => undefined);
			rmSync(join(tmp, ".index"), { force: true });
			const skillsDir = join(tmp, "skills");
			const count = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md"))).length : 0;
			if (count === 0) {
				rmSync(tmp, { recursive: true, force: true });
				throw new Error(`${tag} has no skills/*/SKILL.md`);
			}
			rmSync(dir, { recursive: true, force: true });
			renameSync(tmp, dir);
			const installed: InstalledSkills = { tag, commit, dir, skillsDir: join(dir, "skills"), fetchedAt: new Date().toISOString(), repo: cfg.repo };
			const tmpCurrent = `${this.currentFile}.${process.pid}.tmp`;
			writeFileSync(tmpCurrent, JSON.stringify(installed, null, 2));
			renameSync(tmpCurrent, this.currentFile);
			this.prune([installed.dir, before?.dir]);
			return { status: "updated", installed };
		} catch (error) {
			return { status: "failed", installed: before, error: (error as Error).message };
		} finally {
			this.unlock();
		}
	}

	private async defaultBranch(repo: string, run: (args: string[], cwd?: string) => Promise<string>): Promise<string> {
		const out = await run(["ls-remote", "--symref", "--", repo, "HEAD"]);
		const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out);
		if (!m) throw new Error("could not find the default branch of the skills repository");
		return m[1];
	}

	/** Remove version folders except `keep` (the new one, and the previous one for reviews still running). */
	private prune(keep: (string | undefined)[]): void {
		for (const entry of readdirSync(this.store)) {
			const path = join(this.store, entry);
			if (entry === "repo.git" || entry === "current.json" || entry.startsWith(".") || keep.includes(path)) continue;
			try {
				if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
			} catch {
				// in use or gone
			}
		}
	}
}
