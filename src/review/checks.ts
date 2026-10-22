// The project's own checks (gdlint, gdformat --check, make targets), run by the extension in the sandbox
// before any worker starts. Their findings become review comments and are handed to the workers, so the
// model does not spend tokens re-discovering lint.
import type { CheckConfig } from "../config.ts";
import { git } from "../repo.ts";
import { CommandRefused, runSandboxed, type SandboxOptions } from "../security/sandbox.ts";
import type { CheckResult, FileDiff, ResolvedTarget } from "./types.ts";

const MAX_OUTPUT_LINES = 300;

function quote(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Whether the checks would see the reviewed version of the files (they run on the working tree). */
export async function checksSeeTarget(target: ResolvedTarget, repoRoot: string): Promise<{ ok: boolean; note?: string }> {
	if (target.newSide.kind === "worktree") return { ok: true };
	if (target.newSide.kind === "index") return { ok: true, note: "checks ran on the working tree, which may differ from the index" };
	const head = await git(["rev-parse", "HEAD"], repoRoot);
	if (head.stdout.trim() !== target.newSide.rev) {
		return { ok: false, note: `the reviewed head ${target.newSide.rev.slice(0, 12)} is not checked out, so the checks cannot run on it` };
	}
	const dirty = await git(["status", "--porcelain", "--untracked-files=no"], repoRoot);
	return dirty.stdout.trim() ? { ok: true, note: "checks ran on the working tree, which has uncommitted changes" } : { ok: true };
}

export function filesFor(check: CheckConfig, files: FileDiff[]): string[] {
	const live = files.filter((f) => !f.skipped && f.status !== "D");
	if (check.scope === "changed-gd") return live.filter((f) => f.lang === "gdscript").map((f) => f.path);
	if (check.scope === "changed") return live.map((f) => f.path);
	return [];
}

export function parseCheckOutput(parser: CheckConfig["parser"], output: string, repoFiles: Set<string>): CheckResult["findings"] {
	const findings: CheckResult["findings"] = [];
	for (const raw of output.split("\n").slice(0, MAX_OUTPUT_LINES)) {
		const line = raw.trim();
		if (!line) continue;
		if (parser === "gdlint") {
			const m = /^(.+?):(\d+): (Error|Warning): (.+)$/.exec(line);
			if (m) findings.push({ file: m[1].replace(/^\.\//, ""), line: Number(m[2]), message: m[4] });
			continue;
		}
		if (parser === "gdformat") {
			const m = /would reformat (.+)$/.exec(line);
			if (m) findings.push({ file: m[1].trim().replace(/^\.\//, ""), message: "gdformat would reformat this file (run gdformat on it)" });
			continue;
		}
		const m = /^(?:\.\/)?([^:\s]+):(\d+):\s*(.*)$/.exec(line);
		if (m && repoFiles.has(m[1])) findings.push({ file: m[1], line: Number(m[2]), message: m[3] || line });
		else findings.push({ message: line });
	}
	return findings;
}

const NOT_INSTALLED = /command not found|No such file or directory|No rule to make target|not found in PATH|exec: .*: not found/i;

export async function runChecks(
	checks: CheckConfig[],
	files: FileDiff[],
	target: ResolvedTarget,
	sandbox: SandboxOptions,
	opts: { repoRoot: string; timeoutSeconds: number; signal?: AbortSignal; onProgress?: (name: string) => void },
): Promise<{ results: CheckResult[]; note?: string }> {
	const enabled = checks.filter((c) => c.enabled);
	if (enabled.length === 0) return { results: [] };
	const sees = await checksSeeTarget(target, opts.repoRoot);
	if (!sees.ok) {
		return {
			results: enabled.map((c) => ({ name: c.name, command: c.command, status: "skipped" as const, reason: sees.note, output: "", findings: [] })),
			note: sees.note,
		};
	}
	const repoFiles = new Set(files.map((f) => f.path));
	const results: CheckResult[] = [];
	for (const check of enabled) {
		if (opts.signal?.aborted) break;
		opts.onProgress?.(check.name);
		let command = check.command;
		if (command.includes("{files}")) {
			const list = filesFor(check, files);
			if (list.length === 0) {
				results.push({ name: check.name, command, status: "skipped", reason: "no matching changed files", output: "", findings: [] });
				continue;
			}
			command = command.replace("{files}", list.map(quote).join(" "));
		}
		try {
			const r = await runSandboxed(sandbox, command, opts.repoRoot, opts.timeoutSeconds, opts.signal);
			const output = r.output.split("\n").slice(0, MAX_OUTPUT_LINES).join("\n");
			if (r.exitCode === 127 || (r.exitCode !== 0 && NOT_INSTALLED.test(output) && parseCheckOutput(check.parser, output, repoFiles).every((f) => !f.file))) {
				results.push({ name: check.name, command, status: "skipped", reason: `not available in the sandbox: ${output.trim().split("\n")[0] ?? ""}`, output, findings: [] });
				continue;
			}
			results.push({
				name: check.name,
				command,
				status: r.exitCode === 0 ? "passed" : "failed",
				output,
				findings: parseCheckOutput(check.parser, output, repoFiles),
			});
		} catch (error) {
			const message = (error as Error).message;
			results.push({
				name: check.name,
				command,
				status: error instanceof CommandRefused ? "skipped" : "error",
				reason: message,
				output: "",
				findings: [],
			});
		}
	}
	return { results, note: sees.note };
}
