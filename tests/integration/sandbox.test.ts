// The sandbox against the real bubblewrap on this host. Skipped where bwrap cannot run.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBwrapArgs, CommandRefused, probeSandbox, runSandboxed, type SandboxOptions } from "../../src/security/sandbox.ts";

const probe = probeSandbox(undefined, true);
const d = probe.ok ? describe : describe.skip;

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pgh-repo-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "project.godot"), "config_version=5\n");
	writeFileSync(join(dir, "player.gd"), "extends Node\n");
	git("add", ".");
	git("commit", "-q", "-m", "init");
	return dir;
}

/** Run a raw command in the sandbox, bypassing the allowlist, to test the sandbox on its own. */
function raw(opts: SandboxOptions, command: string): { status: number | null; stdout: string; stderr: string } {
	if (!probe.ok) throw new Error("no sandbox");
	const r = spawnSync(probe.bwrap, buildBwrapArgs(opts, opts.repoRoot, command), { encoding: "utf8", timeout: 20_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const allowlist = { makeTargets: ["check-todos"], extraCommands: ["sleep"] };

d("sandbox (bubblewrap)", () => {
	it("probe succeeds on this host", () => {
		expect(probe.ok).toBe(true);
	});

	it("reads the repo, and writes inside it vanish", () => {
		const repo = gitRepo();
		const r = raw({ repoRoot: repo, allowlist }, "cat player.gd && echo changed > player.gd && echo new > new.gd && rm project.godot && cat player.gd && ls");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("extends Node");
		expect(r.stdout).toContain("changed");
		expect(readFileSync(join(repo, "player.gd"), "utf8")).toBe("extends Node\n");
		expect(existsSync(join(repo, "new.gd"))).toBe(false);
		expect(existsSync(join(repo, "project.godot"))).toBe(true);
	});

	it("a commit inside the sandbox never reaches the real repository", () => {
		const repo = gitRepo();
		const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		const r = raw(
			{ repoRoot: repo, allowlist },
			"git -c user.email=x@y -c user.name=x commit -q --allow-empty -m evil && git commit -q --amend --allow-empty -m evil2 && git rev-parse HEAD",
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout.trim()).not.toBe(before);
		expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(before);
		expect(execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
	});

	it("has no network, not even the host's loopback", async () => {
		const server = createServer((s) => s.end("hello"));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		try {
			const repo = gitRepo();
			const r = raw({ repoRoot: repo, allowlist }, `exec 3<>/dev/tcp/127.0.0.1/${port} && echo CONNECTED`);
			expect(r.stdout).not.toContain("CONNECTED");
			expect(r.status).not.toBe(0);
		} finally {
			server.close();
		}
	});

	it("HOME is empty and host sockets are absent", () => {
		const repo = gitRepo();
		const uid = process.getuid?.() ?? 1000;
		const r = raw(
			{ repoRoot: repo, allowlist },
			[
				'echo "HOME_ENTRIES=$(ls -A "$HOME" | wc -l)"',
				'test -e "$HOME/.pi" && echo HAS_PI_DIR',
				'test -e "$HOME/.ssh" && echo HAS_SSH',
				`test -e /run/user/${uid}/bus && echo HAS_DBUS`,
				"test -e /nix/var/nix/daemon-socket/socket && echo HAS_NIX_DAEMON",
				"test -e /var/run/docker.sock && echo HAS_DOCKER",
				"test -e /run/docker.sock && echo HAS_DOCKER",
				'echo "ENV_COUNT=$(env | wc -l)"',
				"true",
			].join("; "),
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("HOME_ENTRIES=0");
		for (const leak of ["HAS_PI_DIR", "HAS_SSH", "HAS_DBUS", "HAS_NIX_DAEMON", "HAS_DOCKER"]) expect(r.stdout).not.toContain(leak);
		// the host really has a ~/.pi, so this check means something on the developer machine
		if (existsSync(join(homedir(), ".pi"))) expect(r.stdout).not.toContain("HAS_PI_DIR");
	});

	it("refuses commands outside the allowlist before starting the sandbox", async () => {
		const repo = gitRepo();
		await expect(runSandboxed({ repoRoot: repo, allowlist }, "git commit -m x", repo)).rejects.toBeInstanceOf(CommandRefused);
		await expect(runSandboxed({ repoRoot: repo, allowlist }, "rm -rf .", repo)).rejects.toThrow(/not on the allowlist/);
	});

	it("runs allowed commands and returns their output", async () => {
		const repo = gitRepo();
		const r = await runSandboxed({ repoRoot: repo, allowlist }, "git log --oneline | wc -l", repo);
		expect(r.exitCode).toBe(0);
		expect(r.output.trim()).toBe("1");
	});

	it("kills the whole process group on timeout", async () => {
		const repo = gitRepo();
		const started = Date.now();
		await expect(runSandboxed({ repoRoot: repo, allowlist }, "sleep 30", repo, 1)).rejects.toThrow(/timeout/);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("aborts on signal", async () => {
		const repo = gitRepo();
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 300);
		await expect(runSandboxed({ repoRoot: repo, allowlist }, "sleep 30", repo, 60, ac.signal)).rejects.toThrow(/aborted/);
	});
});
