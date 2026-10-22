// Settings, read from <agent dir>/godot-helpers/config.json and overridden by
// <agent dir>/godot-helpers/<repo-id>/config.json. Both live outside the repository on purpose: a repository
// must not be able to loosen its own sandbox.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillSourceConfig } from "./skills/source.ts";

export interface CheckConfig {
	name: string;
	/** Command run in the sandbox. `{files}` becomes the changed files of `scope`, quoted. */
	command: string;
	enabled: boolean;
	/** Which files `{files}` expands to; "repo" commands get no file list. */
	scope: "changed-gd" | "changed" | "repo";
	parser: "gdlint" | "gdformat" | "lines";
}

export interface ClassifierConfig {
	enabled: boolean;
	/** llama-server binary; default: found on PATH. */
	llamaServer?: string;
	/** Path to the decision model GGUF; default: <data dir>/models/<file of hfRepo>. */
	modelPath?: string;
	/** Hugging Face repo:quant to download when no modelPath is given. */
	hfRepo: string;
	/** GPU layers: "auto" tries the GPU and falls back to CPU. */
	gpuLayers: "auto" | number;
	/** Probability above which a skill is selected. */
	threshold: number;
	/**
	 * Physical batch size (-b and -ub). A yes/no prompt may be longer than one batch with Kev; a choice question
	 * (advisor pre-routing) must fit in one: 1024 holds the 53 code skills of GodotPrompter v1.15.1. clef and laya need the whole
	 * prompt in one batch. Kev-4B Q4_K_M on an RTX 4050 laptop GPU: 3.7 GB VRAM at 512, 4.4 GB at 1024, 5.5 GB at 2048.
	 */
	ubatch: number;
	contextSize: number;
	/** More llama-server arguments, e.g. ["-dev", "Vulkan1"] to pick a GPU. */
	extraArgs: string[];
	startupTimeoutSeconds: number;
	requestTimeoutSeconds: number;
	/** Keep llama-server running this long after the last use (0: stop right after each routing). */
	keepAliveSeconds: number;
	/** Which skills a review asks about: the rules' candidates, or every code skill (more questions, slower). */
	candidates: "rules" | "all";
	/** How many skills advisor pre-routing hands the model at most (0 turns it off). */
	advisorSkills: number;
	/** Use this pi classifier model instead of starting llama-server ("provider/id"). */
	piModel?: string;
}

export interface WorkerConfig {
	/** "provider/id"; default: the session model. */
	model?: string;
	thinking?: string;
	concurrencyLocal: number;
	concurrencyCloud: number;
	/**
	 * Workers load the user's extensions like a normal pi start (without MCP servers), so a model whose provider an
	 * extension registers works in them. false: only this extension and extraExtensions.
	 */
	inheritExtensions: boolean;
	/** More extensions for the workers (with inheritExtensions false, e.g. the one that provides the model). */
	extraExtensions: string[];
	timeoutSeconds: number;
	/** Share of the worker model's context window a unit's prompt may fill. */
	unitPromptFraction: number;
	/** Context window to assume when the model does not say. */
	defaultContextWindow: number;
}

export interface Config {
	baseBranch: string;
	docs: string[];
	maxDocEditChars: number;
	readRoots: string[];
	extraAllowedTools: string[];
	sandbox: {
		bwrapPath?: string;
		extraReadOnly: string[];
		env: Record<string, string>;
		timeoutSeconds: number;
		makeTargets: string[];
		extraCommands: string[];
	};
	checks: CheckConfig[];
	skills: {
		/** Use this folder of GodotPrompter-style skills and download nothing. */
		path?: string;
		/** Where the skills are downloaded from: the newest tag on the branch, fetched on every start. */
		source: SkillSourceConfig;
		maxPerUnit: number;
		alwaysOn: string[];
		/** Extra skill directories with the same layout (your own project skills). */
		extraPaths: string[];
	};
	classifier: ClassifierConfig;
	worker: WorkerConfig;
	memory: {
		maxFacts: number;
		maxFactChars: number;
		noteMaxChars: number;
		maxRaisedPerUnit: number;
	};
	viewer: {
		open: boolean;
		/** Command used to open the URL; default xdg-open / open. */
		browserCommand?: string;
	};
}

export const DEFAULT_CONFIG: Config = {
	baseBranch: "develop",
	docs: ["DESIGN.md", "AGENTS.md"],
	maxDocEditChars: 6000,
	readRoots: [],
	extraAllowedTools: [],
	sandbox: {
		extraReadOnly: [],
		env: {},
		timeoutSeconds: 300,
		makeTargets: ["check-docs", "check-todos"],
		extraCommands: [],
	},
	checks: [
		{ name: "gdlint", command: "gdlint {files}", enabled: true, scope: "changed-gd", parser: "gdlint" },
		{ name: "gdformat", command: "gdformat --check {files}", enabled: true, scope: "changed-gd", parser: "gdformat" },
		{ name: "check-todos", command: "make check-todos", enabled: true, scope: "repo", parser: "lines" },
		{ name: "check-docs", command: "make check-docs", enabled: true, scope: "repo", parser: "lines" },
	],
	skills: {
		source: { repo: "https://github.com/jame581/GodotPrompter.git", autoUpdate: true, timeoutSeconds: 120 },
		maxPerUnit: 4,
		alwaysOn: ["godot-code-review"],
		extraPaths: [],
	},
	classifier: {
		enabled: true,
		hfRepo: "ggml-org/Kev-4B-GGUF:Q4_K_M",
		gpuLayers: "auto",
		threshold: 0.5,
		ubatch: 1024,
		contextSize: 8192,
		extraArgs: [],
		startupTimeoutSeconds: 120,
		requestTimeoutSeconds: 120,
		keepAliveSeconds: 0,
		candidates: "rules",
		advisorSkills: 2,
	},
	worker: {
		concurrencyLocal: 1,
		concurrencyCloud: 3,
		inheritExtensions: true,
		extraExtensions: [],
		timeoutSeconds: 900,
		unitPromptFraction: 0.5,
		defaultContextWindow: 65536,
	},
	memory: {
		maxFacts: 300,
		maxFactChars: 400,
		noteMaxChars: 1500,
		maxRaisedPerUnit: 10,
	},
	viewer: {
		open: true,
	},
};

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge key by key, everything else (arrays included) replaces. Unknown keys are kept. */
export function mergeConfig<T>(base: T, override: unknown): T {
	if (!isObject(override)) return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(override)) {
		if (v === undefined) continue;
		const b = out[k];
		out[k] = isObject(b) && isObject(v) ? mergeConfig(b, v) : v;
	}
	return out as T;
}

export function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
}

export function dataDir(agentDir: string): string {
	return join(agentDir, "godot-helpers");
}

export function repoDataDir(agentDir: string, repoId: string): string {
	return join(dataDir(agentDir), repoId);
}

/** Global config, then per-repo overrides. */
export function loadConfig(agentDir: string, repoId?: string): Config {
	let config = mergeConfig(DEFAULT_CONFIG, readJson(join(dataDir(agentDir), "config.json")));
	if (repoId) config = mergeConfig(config, readJson(join(repoDataDir(agentDir, repoId), "config.json")));
	return config;
}
