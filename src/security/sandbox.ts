// Every agent shell command runs in bubblewrap: the repository is a throwaway overlay (writes vanish when
// the command ends), the host is visible only through explicit read-only binds, HOME and /tmp are empty
// tmpfs, there is no network and the environment is cleared. Unix sockets keep working through read-only
// mounts, so `/` is never bound as a whole: no D-Bus, nix-daemon or docker socket is reachable.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { checkCommand, type AllowlistOptions } from "./allowlist.ts";

export interface SandboxOptions {
	/** Repository toplevel: overlaid read-write, changes discarded. */
	repoRoot: string;
	/** Directories that must be writable-but-discarded too, e.g. a worktree's common git dir outside the repo. */
	extraOverlays?: string[];
	/** Extra host paths visible read-only (tool installs, a godot binary, skills). */
	extraReadOnly?: string[];
	/** Extra environment variables inside the sandbox. */
	env?: Record<string, string>;
	bwrapPath?: string;
	allowlist: AllowlistOptions;
}

/** Host directories bound read-only when present. Nothing else of the host is visible. */
const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix/store", "/nix/var/nix/profiles", "/run/current-system"];

function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, name);
		try {
			if (existsSync(p)) return realpathSync(p);
		} catch {
			// unreadable PATH entry
		}
	}
	return undefined;
}

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Bind a host path read-only, keeping symlinked roots (merged /usr, NixOS /run/current-system) as symlinks. */
function bindArgs(path: string): string[] {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return [];
	}
	if (st.isSymbolicLink()) return ["--symlink", readlinkSync(path), path];
	return ["--ro-bind", path, path];
}

export function resolveBwrap(explicit?: string): string | undefined {
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	return findOnPath("bwrap");
}

export function resolveBash(): string {
	return findOnPath("bash") ?? "/bin/bash";
}

/** PATH inside the sandbox: host PATH entries that resolve inside a bound root. */
export function sandboxPath(roots: string[]): string {
	const out: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		let real: string;
		try {
			real = realpathSync(dir);
		} catch {
			continue;
		}
		if (roots.some((r) => within(real, r) || within(dir, r)) && !out.includes(dir)) out.push(dir);
	}
	for (const fallback of ["/run/current-system/sw/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
		if (existsSync(fallback) && !out.includes(fallback)) out.push(fallback);
	}
	return out.join(":");
}

/** The full bwrap argv (without the bwrap binary itself) for running `command` in `cwd`. */
export function buildBwrapArgs(opts: SandboxOptions, cwd: string, command: string): string[] {
	const repo = realpathSync(opts.repoRoot);
	const home = homedir();
	const user = userInfo().username;
	const roots = [...SYSTEM_ROOTS, ...(opts.extraReadOnly ?? [])].filter((p) => existsSync(p));
	const args: string[] = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"];
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const root of roots) args.push(...bindArgs(root));
	// HOME is an empty tmpfs; parents of the repo are created inside it by the overlay mount.
	if (within(home, "/home")) args.push("--tmpfs", "/home");
	else args.push("--tmpfs", home);
	args.push("--dir", home);
	for (const overlay of [repo, ...(opts.extraOverlays ?? []).map((p) => realpathSync(p))]) {
		args.push("--overlay-src", overlay, "--tmp-overlay", overlay);
	}
	const env: Record<string, string> = {
		PATH: sandboxPath(roots),
		HOME: home,
		USER: user,
		LOGNAME: user,
		LANG: "C.UTF-8",
		TERM: "dumb",
		NO_COLOR: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		...(opts.env ?? {}),
	};
	for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
	const realCwd = existsSync(cwd) ? realpathSync(cwd) : repo;
	args.push("--chdir", within(realCwd, repo) ? realCwd : repo);
	args.push("--", resolveBash(), "-c", command);
	return args;
}

export type ProbeResult = { ok: true; bwrap: string } | { ok: false; reason: string };

let probeCache: ProbeResult | undefined;

/**
 * Prove the sandbox works on this host before trusting it: a write inside the overlay must succeed in the
 * sandbox and leave no trace on the host, and the network must be unreachable.
 */
export function probeSandbox(bwrapPath?: string, refresh = false): ProbeResult {
	if (probeCache && !refresh) return probeCache;
	const bwrap = resolveBwrap(bwrapPath);
	if (!bwrap) return (probeCache = { ok: false, reason: "bubblewrap (bwrap) is not installed" });
	const dir = mkdtempSync(join(tmpdir(), "pgh-probe-"));
	try {
		writeFileSync(join(dir, "seed"), "seed");
		const args = buildBwrapArgs({ repoRoot: dir, allowlist: { makeTargets: [], extraCommands: [] } }, dir, "echo inside > written && cat written && rm seed && echo PROBE_OK");
		const r = spawnSync(bwrap, args, { encoding: "utf8", timeout: 20_000 });
		if (r.status !== 0 || !r.stdout.includes("PROBE_OK")) {
			return (probeCache = {
				ok: false,
				reason: `bubblewrap could not run with a throwaway overlay (needs bwrap >= 0.10, unprivileged user namespaces and overlayfs): ${(r.stderr || r.error?.message || "").trim()}`,
			});
		}
		if (existsSync(join(dir, "written")) || !existsSync(join(dir, "seed"))) {
			return (probeCache = { ok: false, reason: "the sandbox overlay leaked writes to the host" });
		}
		return (probeCache = { ok: true, bwrap });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export class CommandRefused extends Error {}

/** BashOperations that check the allowlist (fail closed) and run the command in bubblewrap. */
export function createSandboxedBashOps(opts: SandboxOptions): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			const policy = checkCommand(command, opts.allowlist);
			if (!policy.ok) throw new CommandRefused(`Command refused: ${policy.reason}`);
			const probe = probeSandbox(opts.bwrapPath);
			if (!probe.ok) throw new CommandRefused(`Command refused: the sandbox is unavailable (${probe.reason}); shell commands are blocked rather than run unsandboxed`);
			const args = buildBwrapArgs(opts, resolve(cwd), command);
			return new Promise((resolvePromise, reject) => {
				const child = spawn(probe.bwrap, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const killGroup = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				const timer =
					timeout !== undefined && timeout > 0
						? setTimeout(() => {
								timedOut = true;
								killGroup();
							}, timeout * 1000)
						: undefined;
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				});
				const onAbort = () => killGroup();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolvePromise({ exitCode: code });
				});
			});
		},
	};
}

/** Run one command in the sandbox and collect its output (used by the extension's own checks). */
export async function runSandboxed(
	opts: SandboxOptions,
	command: string,
	cwd: string,
	timeoutSeconds = 300,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
	const chunks: Buffer[] = [];
	const ops = createSandboxedBashOps(opts);
	const r = await ops.exec(command, cwd, { onData: (d) => chunks.push(d), timeout: timeoutSeconds, signal });
	return { exitCode: r.exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

/** For tests: drop the cached probe result. */
export function resetProbeCache(): void {
	probeCache = undefined;
}

