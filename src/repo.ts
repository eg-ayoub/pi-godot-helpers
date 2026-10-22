// The git repository the session works in: its toplevel, whether it is a Godot project, and a stable id for
// the memory directory. Git runs with fixed argv, no pager, no hooks, no fsmonitor and no optional locks.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

const GIT_ENV = {
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
	PAGER: "cat",
	LC_ALL: "C",
};

/** Run git on the host (the extension's own reads; the model's commands go through the sandbox). */
export function git(args: string[], cwd: string, opts: { maxBuffer?: number; input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		const child = execFile(
			"git",
			["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "--no-pager", ...args],
			{ cwd, env: { ...process.env, ...GIT_ENV, ...opts.env }, maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024, encoding: "utf8", timeout: opts.timeoutMs ?? 0, killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
				resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
			},
		);
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

export async function gitOk(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
	return r.stdout;
}

export interface RepoInfo {
	/** Real path of the toplevel. */
	toplevel: string;
	/** Directories (relative to the toplevel, "" for the root) that hold a project.godot. */
	godotProjects: string[];
	/** Stable id for the memory directory. */
	id: string;
	originUrl?: string;
	/** Real path of the common git dir when it lives outside the toplevel (linked worktrees). */
	externalGitDir?: string;
}

/** origin URL without credentials, protocol, trailing .git or case differences in the host. */
export function normalizeRemote(url: string): string {
	let u = url.trim();
	u = u.replace(/^[a-z+]+:\/\//i, "");
	u = u.replace(/^[^@/]+@/, "");
	u = u.replace(/:(?!\d+\/)/, "/");
	u = u.replace(/:\d+\//, "/");
	u = u.replace(/\.git$/, "").replace(/\/+$/, "");
	const slash = u.indexOf("/");
	return slash === -1 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}

export function repoIdFor(toplevel: string, originUrl?: string): string {
	const key = originUrl ? normalizeRemote(originUrl) : `path:${toplevel}`;
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
	const name = (originUrl ? normalizeRemote(originUrl).split("/").pop() : toplevel.split(sep).pop()) ?? "repo";
	const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
	return `${slug}-${hash}`;
}

/** The repository at `cwd`, or undefined when cwd is not inside a git work tree. */
export async function detectRepo(cwd: string): Promise<RepoInfo | undefined> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) return undefined;
	const toplevel = realpathSync(top.stdout.trim());
	const files = await git(["ls-files", "-z", "--", "project.godot", "*/project.godot"], toplevel);
	const godotProjects = new Set<string>();
	for (const f of files.stdout.split("\0")) {
		if (!f) continue;
		godotProjects.add(f === "project.godot" ? "" : f.slice(0, -"/project.godot".length));
	}
	// an untracked project.godot at the root still counts (fresh projects)
	if (existsSync(join(toplevel, "project.godot"))) godotProjects.add("");
	const origin = await git(["remote", "get-url", "origin"], toplevel);
	const originUrl = origin.code === 0 ? origin.stdout.trim() : undefined;
	const common = await git(["rev-parse", "--git-common-dir"], toplevel);
	let externalGitDir: string | undefined;
	if (common.code === 0) {
		const raw = common.stdout.trim();
		const abs = realpathSync(isAbsolute(raw) ? raw : resolve(toplevel, raw));
		if (!(abs === toplevel || abs.startsWith(toplevel + sep))) externalGitDir = abs;
	}
	return {
		toplevel,
		godotProjects: [...godotProjects].sort(),
		id: repoIdFor(toplevel, originUrl),
		originUrl,
		externalGitDir,
	};
}

export function isGodotRepo(repo: RepoInfo | undefined): repo is RepoInfo {
	return !!repo && repo.godotProjects.length > 0;
}
