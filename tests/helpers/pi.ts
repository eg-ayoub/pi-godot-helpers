// Runs the real pi 1.3.0 (the devDependency) against a throwaway agent directory, for spikes and e2e tests.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { mockModelsJson } from "../fakes/mock-openai-server.ts";
import { TEST_SKILLS } from "./skills.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PI_CLI = join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
export const EXTENSION = join(ROOT, "src/index.ts");

export interface PiHome {
	/** PI_CODING_AGENT_DIR */
	agentDir: string;
	/** HOME for the pi process (keeps ~/.pi of the developer out of tests) */
	home: string;
	env: Record<string, string>;
	/** Write <agentDir>/godot-helpers/config.json: the test defaults merged with `config`. */
	config(config: Record<string, unknown>): void;
}

/**
 * Tests never start a real llama-server (it would download a model): the classifier is off unless a test says so.
 * They use the fixed test skills and download none.
 */
export const TEST_CONFIG = { classifier: { enabled: false }, skills: { path: TEST_SKILLS } };

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...a };
	for (const [k, v] of Object.entries(b)) {
		const prev = out[k];
		out[k] = v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev) ? merge(prev as Record<string, unknown>, v as Record<string, unknown>) : v;
	}
	return out;
}

/** A fresh agent directory whose models.json points provider "mock" at `mockUrl`. */
export function makePiHome(mockUrl: string, opts: { contextWindow?: number; settings?: Record<string, unknown> } = {}): PiHome {
	const home = mkdtempSync(join(tmpdir(), "pgh-home-"));
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), mockModelsJson(mockUrl, opts.contextWindow));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model", ...(opts.settings ?? {}) }, null, 2),
	);
	const config = (c: Record<string, unknown>) => {
		mkdirSync(join(agentDir, "godot-helpers"), { recursive: true });
		writeFileSync(join(agentDir, "godot-helpers", "config.json"), JSON.stringify(merge(TEST_CONFIG, c), null, 2));
	};
	config({});
	return {
		agentDir,
		home,
		config,
		env: {
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			PI_OFFLINE: "1",
		},
	};
}

export interface JsonRun {
	events: Record<string, any>[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** `pi --mode json -p ...`; returns the parsed JSONL events. */
export function runPiJson(args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<JsonRun> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [PI_CLI, "--mode", "json", "-p", "--no-session", ...args], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out\nstderr:\n${stderr}\nstdout:\n${stdout.slice(-4000)}`));
		}, opts.timeoutMs ?? 60_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			const events = stdout
				.split("\n")
				.map((l) => l.replace(/\r$/, ""))
				.filter((l) => l.trim().length > 0)
				.flatMap((l) => {
					try {
						return [JSON.parse(l)];
					} catch {
						return [];
					}
				});
			resolvePromise({ events, exitCode: code, stdout, stderr });
		});
	});
}

/** An RPC client on the real CLI, for commands such as `/review ...`. */
export function rpcClient(opts: { cwd: string; env: Record<string, string>; args?: string[] }): RpcClient {
	return new RpcClient({ cliPath: PI_CLI, cwd: opts.cwd, env: opts.env, args: ["--no-session", ...(opts.args ?? [])] });
}

/** A fake llama-server (tests/fakes/fake-llama-server.mjs) behind an executable wrapper; returns its path. */
export function makeFakeLlamaServer(): string {
	const dir = mkdtempSync(join(tmpdir(), "pgh-llama-"));
	const bin = join(dir, "llama-server");
	writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "tests/fakes/fake-llama-server.mjs")}" "$@"\n`);
	chmodSync(bin, 0o755);
	return bin;
}
