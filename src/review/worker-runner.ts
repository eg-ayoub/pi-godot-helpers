// Review workers are pi subprocesses (`pi --mode json -p --no-session ...`) with this extension loaded in
// worker mode, only the unit's skills, and a fixed tool set. Same pattern as pi's subagent example.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RawComment } from "./aggregate.ts";

export const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "review_comment", "review_done", "memory_note_file"];

/** How to start the same pi that runs this process (pi's subagent example, getPiInvocation). */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const override = process.env.PI_GODOT_HELPERS_PI;
	if (override) return { command: override, args };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export interface WorkerJob {
	unitId: string;
	systemFile: string;
	contextFile: string;
	unitFile: string;
	outFile: string;
	logFile: string;
	/** Skill directories advertised to the worker (it may read them). */
	advertisedSkillDirs: string[];
}

export interface WorkerOptions {
	cwd: string;
	extensionPath: string;
	/** "provider/id" */
	model?: string;
	thinking?: string;
	/** Load the user's extensions (the session's model may come from one); false: only this one and extraExtensions. */
	inheritExtensions: boolean;
	extraExtensions: string[];
	timeoutSeconds: number;
	signal?: AbortSignal;
	onEvent?: (unitId: string, event: Record<string, any>) => void;
}

export interface WorkerOutcome {
	unitId: string;
	exitCode: number | null;
	comments: RawComment[];
	notes: Record<string, unknown>[];
	summary?: string;
	finished: boolean;
	usage: { input: number; output: number; cost: number };
	error?: string;
}

export function workerArgs(job: WorkerJob, opts: WorkerOptions): string[] {
	// -na: a repository's own .pi files never reach a worker. The user's extensions do (a provider extension such as
	// pi-llama-cpp registers the model), minus MCP servers; their tools stay blocked by --tools and the gate.
	// pi loads an extension path once, so passing this one again is harmless when it is also installed.
	const args = ["--mode", "json", "-p", "--no-session", "-na", "-nc", ...(opts.inheritExtensions ? ["--no-mcp"] : ["-ne"])];
	for (const ext of opts.extraExtensions) args.push("-e", ext);
	args.push("-e", opts.extensionPath, "--no-skills");
	for (const dir of job.advertisedSkillDirs) args.push("--skill", dir);
	args.push("--tools", WORKER_TOOLS.join(","));
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	args.push("--append-system-prompt", job.systemFile, "--godot-helpers-worker", job.unitFile, `@${job.contextFile}`, "Review the change in the attached context. Report findings with review_comment, then call review_done.");
	return args;
}

export function readOut(outFile: string): { comments: RawComment[]; notes: Record<string, unknown>[]; summary?: string; finished: boolean } {
	const comments: RawComment[] = [];
	const notes: Record<string, unknown>[] = [];
	let summary: string | undefined;
	let finished = false;
	if (!existsSync(outFile)) return { comments, notes, finished };
	for (const line of readFileSync(outFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as Record<string, any>;
			if (r.type === "comment") comments.push(r as RawComment);
			else if (r.type === "note" || r.type === "fact") notes.push(r);
			else if (r.type === "done") {
				summary = String(r.summary ?? "");
				finished = true;
			}
		} catch {
			// a torn last line from a killed worker
		}
	}
	return { comments, notes, summary, finished };
}

export function runWorker(job: WorkerJob, opts: WorkerOptions): Promise<WorkerOutcome> {
	return new Promise((resolvePromise) => {
		const inv = piInvocation(workerArgs(job, opts));
		const log = createWriteStream(job.logFile);
		const child = spawn(inv.command, inv.args, {
			cwd: opts.cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const usage = { input: 0, output: 0, cost: 0 };
		let buffer = "";
		let lastError: string | undefined;
		const onLine = (line: string) => {
			if (!line.trim()) return;
			let event: Record<string, any>;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const u = event.message.usage;
				if (u) {
					usage.input += Number(u.input ?? 0);
					usage.output += Number(u.output ?? 0);
					usage.cost += Number(u.cost?.total ?? 0);
				}
				if (event.message.stopReason === "error") lastError = String(event.message.errorMessage ?? "model error");
			}
			opts.onEvent?.(job.unitId, event);
		};
		child.stdout.on("data", (d: Buffer) => {
			log.write(d);
			buffer += d.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				onLine(buffer.slice(0, nl).replace(/\r$/, ""));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		});
		let stderr = "";
		child.stderr.on("data", (d: Buffer) => {
			log.write(d);
			stderr += d.toString("utf8");
		});
		const kill = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutSeconds * 1000);
		timer.unref();
		const onAbort = () => kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number | null, error?: string) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			log.end();
			if (buffer) onLine(buffer);
			const out = readOut(job.outFile);
			resolvePromise({
				unitId: job.unitId,
				exitCode: code,
				...out,
				usage,
				error:
					error ??
					(opts.signal?.aborted
						? "cancelled"
						: timedOut
							? `timed out after ${opts.timeoutSeconds}s`
							: code !== 0
								? `exited with ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`
								: lastError),
			});
		};
		child.on("error", (err) => finish(null, err.message));
		child.on("close", (code) => finish(code));
	});
}

/** Run jobs with at most `concurrency` at a time, in order. */
export async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}
