// Tier-2 routing: a local decision model (default Kev-4B) answers one yes/no question per candidate skill.
// The extension starts llama-server for it only while routing (no service, no Jan), registers it as a pi
// classifier provider on the built-in "typesafe-system-one" API (/v1/systemone), and classifies through
// pi's ctx.modelRegistry.classify(). The server stops when routing ends or after a short idle time.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierConfig } from "../config.ts";
import type { FileDiff, RouteDecision } from "../review/types.ts";
import type { SkillCatalog, SkillInfo } from "./catalog.ts";
import { routingInput } from "./router.ts";
import { systemOneClassifier } from "./system-one.ts";

export const CLASSIFIER_PROVIDER = "godot-helpers-classifier";
/** Skills about the agent's own workflow rather than about Godot code; never routed. */
export const META_SKILLS = new Set(["using-godot-prompter", "godot-mentor", "godot-project-setup"]);
export const CLASSIFIER_MODEL_ID = "local-decision-model";

function findOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

const helpCache = new Map<string, Promise<string>>();

/** `llama-server --help`, to pick flags this build knows (they changed between releases). */
function serverHelp(bin: string): Promise<string> {
	let help = helpCache.get(bin);
	if (!help) {
		help = new Promise((resolve) => execFile(bin, ["--help"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout, stderr) => resolve(`${stdout}${stderr}`)));
		helpCache.set(bin, help);
	}
	return help;
}

/**
 * Read the weights instead of mapping them. Measured with llama.cpp b11815 (Vulkan) on an RTX 4050 laptop GPU:
 * Kev-4B Q4_K_M took 91 s to start with mmap and 2-4 s without.
 */
export function noMmapArgs(help: string): string[] {
	if (help.includes("--load-mode")) return ["-lm", "none"];
	if (help.includes("--no-mmap")) return ["--no-mmap"];
	return [];
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const port = (s.address() as { port: number }).port;
			s.close(() => resolve(port));
		});
	});
}

async function waitHealthy(url: string, child: ChildProcess, timeoutMs: number, spawnError: () => string | undefined, signal?: AbortSignal): Promise<string | undefined> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (signal?.aborted) return "aborted";
		const failed = spawnError();
		if (failed) return `llama-server could not start: ${failed}`;
		if (child.exitCode !== null || child.signalCode !== null) return `llama-server exited (${child.exitCode ?? child.signalCode})`;
		try {
			const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return undefined;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return `llama-server did not become ready within ${Math.round(timeoutMs / 1000)}s`;
}

export interface HostStatus {
	running: boolean;
	baseUrl?: string;
	gpuLayers?: number;
	lastError?: string;
	log: string;
}

/** One llama-server process for the decision model, shared by a session, started on demand. */
export class ClassifierHost {
	private child?: ChildProcess;
	private baseUrl?: string;
	private gpuLayers?: number;
	private idleTimer?: NodeJS.Timeout;
	private log = "";
	lastError?: string;
	private readonly pi: ExtensionAPI;
	private readonly modelsDir: string;
	private readonly configOf: () => ClassifierConfig;

	/** `config` is read on every use, so a reloaded config applies to the next start. */
	constructor(pi: ExtensionAPI, modelsDir: string, config: () => ClassifierConfig) {
		this.pi = pi;
		this.modelsDir = modelsDir;
		this.configOf = config;
	}

	private get config(): ClassifierConfig {
		return this.configOf();
	}

	binary(): string | undefined {
		return this.config.llamaServer ?? findOnPath("llama-server");
	}

	private readyMarker(): string {
		const key = createHash("sha1").update(this.config.hfRepo).digest("hex").slice(0, 12);
		return join(this.modelsDir, `.ready-${key}`);
	}

	/** True when starting needs no download: a model path, or the Hugging Face model fetched before. */
	modelReady(): boolean {
		return this.config.modelPath ? existsSync(this.config.modelPath) : existsSync(this.readyMarker());
	}

	status(): HostStatus {
		return { running: !!this.child, baseUrl: this.baseUrl, gpuLayers: this.gpuLayers, lastError: this.lastError, log: this.log.slice(-2000) };
	}

	private modelArgs(): { args: string[]; downloading: boolean } {
		if (this.config.modelPath) return { args: ["-m", this.config.modelPath], downloading: false };
		// let llama-server fetch and cache the GGUF (first use needs network and a few minutes)
		return { args: ["-hf", this.config.hfRepo], downloading: true };
	}

	private async launch(gpuLayers: number, signal?: AbortSignal): Promise<string | undefined> {
		const bin = this.binary();
		if (!bin) return "llama-server was not found (install llama.cpp >= 0.6.0, or set classifier.llamaServer)";
		if (!existsSync(bin)) return `llama-server was not found at ${bin}`;
		if (this.config.modelPath && !existsSync(this.config.modelPath)) return `the classifier model ${this.config.modelPath} does not exist`;
		const port = await freePort();
		const model = this.modelArgs();
		const help = await serverHelp(bin);
		const args = [
			...model.args,
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"-np",
			"1",
			"-c",
			String(this.config.contextSize),
			"-b",
			String(this.config.ubatch),
			"-ub",
			String(this.config.ubatch),
			"-ngl",
			String(gpuLayers),
			...noMmapArgs(help),
			...this.config.extraArgs,
		];
		this.log = "";
		let spawnError: string | undefined;
		mkdirSync(this.modelsDir, { recursive: true });
		const child = spawn(bin, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, LLAMA_CACHE: process.env.LLAMA_CACHE ?? this.modelsDir },
		});
		child.stdout?.on("data", (d: Buffer) => (this.log = (this.log + d.toString("utf8")).slice(-20000)));
		child.stderr?.on("data", (d: Buffer) => (this.log = (this.log + d.toString("utf8")).slice(-20000)));
		child.on("error", (e) => {
			spawnError = e.message;
			this.log += `\n${e.message}`;
		});
		this.child = child;
		const url = `http://127.0.0.1:${port}`;
		const timeout = (model.downloading ? Math.max(this.config.startupTimeoutSeconds, 1800) : this.config.startupTimeoutSeconds) * 1000;
		const problem = await waitHealthy(url, child, timeout, () => spawnError, signal);
		if (problem) {
			this.kill();
			return problem;
		}
		this.baseUrl = url;
		this.gpuLayers = gpuLayers;
		if (model.downloading) writeFileSync(this.readyMarker(), `${this.config.hfRepo}\n`);
		return undefined;
	}

	/** Start the server if needed and register the pi provider; returns an error message on failure. */
	async ensure(signal?: AbortSignal): Promise<string | undefined> {
		this.touch();
		if (this.child && this.baseUrl) return undefined;
		const g = this.config.gpuLayers;
		let problem = await this.launch(g === "auto" ? 999 : g, signal);
		if (problem && g === "auto" && !signal?.aborted && problem !== "aborted") {
			// not enough VRAM next to whatever else holds the GPU: run on the CPU
			problem = await this.launch(0, signal);
		}
		if (problem) {
			this.lastError = `${problem}${this.log ? `\n${this.log.split("\n").slice(-8).join("\n")}` : ""}`;
			return this.lastError;
		}
		this.pi.registerProvider(CLASSIFIER_PROVIDER, {
			baseUrl: `${this.baseUrl}/v1`,
			apiKey: "local",
			api: "typesafe-system-one",
			classifiers: { "typesafe-system-one": systemOneClassifier },
			models: [
				{
					id: CLASSIFIER_MODEL_ID,
					name: `Local decision model (${this.config.modelPath ? this.config.modelPath.split("/").pop() : this.config.hfRepo})`,
					type: "classifier",
					api: "typesafe-system-one",
					input: ["text"],
					contextWindow: this.config.contextSize,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		this.lastError = undefined;
		return undefined;
	}

	private touch(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.config.keepAliveSeconds <= 0) return;
		this.idleTimer = setTimeout(() => void this.stop(), this.config.keepAliveSeconds * 1000);
		this.idleTimer.unref();
	}

	/** Called after a use: stop now, or leave the idle timer to do it. */
	async release(): Promise<void> {
		if (this.config.keepAliveSeconds <= 0) await this.stop();
		else this.touch();
	}

	private kill(): void {
		const child = this.child;
		this.child = undefined;
		this.baseUrl = undefined;
		if (child?.pid) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			const pid = child.pid;
			setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// gone
				}
			}, 3000).unref();
		}
	}

	async stop(): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (!this.child) return;
		this.kill();
		try {
			this.pi.unregisterProvider(CLASSIFIER_PROVIDER);
		} catch {
			// not registered
		}
	}
}

/** Question id for a skill (System One ids: letters, digits, underscores). */
export function questionId(skill: string): string {
	return `s_${skill.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

export function questionFor(skill: SkillInfo): { type: "bool"; instructions: string; criteria: { true: string; false: string } } {
	const scope = skill.description.replace(/^Use when\s+/i, "");
	return {
		type: "bool",
		instructions: `Does reviewing this change need the "${skill.title ?? skill.name}" guidance (${skill.name})? It applies when ${scope}`,
		criteria: {
			true: `The changed code involves this: ${scope}`,
			false: `The changed code does not involve ${skill.name}`,
		},
	};
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export interface ClassifyRouteOptions {
	threshold: number;
	alwaysOn: string[];
	maxCandidates?: number;
	/** "all": ask about every code skill, not only the rules' candidates. */
	scope?: "rules" | "all";
	temperature?: number;
	requestTimeoutSeconds?: number;
	/** The pi classifier to use (default: the local llama-server this extension registers). */
	model?: { provider: string; id: string };
}

function withTimeout(signal: AbortSignal | undefined, seconds: number | undefined): AbortSignal | undefined {
	if (!seconds) return signal;
	const timeout = AbortSignal.timeout(seconds * 1000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function classifierModel(ctx: ExtensionContext, ref?: { provider: string; id: string }) {
	return ctx.modelRegistry.findOfType("classifier", ref?.provider ?? CLASSIFIER_PROVIDER, ref?.id ?? CLASSIFIER_MODEL_ID);
}

/**
 * The selection rule: always-on skills stay; a candidate is kept when p >= threshold, a strong rule hit
 * (score >= 3) always, a score-2 rule hit when p >= threshold × weakRuleFactor. Unchosen skills with some probability stay
 * advertised as candidates.
 */
export function applyProbabilities(decision: RouteDecision, asked: string[], probs: Record<string, number>, threshold: number, weakRuleFactor = 1): RouteDecision {
	const ruleSkills = decision.selected.filter((s) => s.source === "rule");
	const selected: RouteDecision["selected"] = decision.selected.filter((s) => s.source === "always");
	for (const name of asked) {
		const p = probs[name] ?? 0;
		const rule = ruleSkills.find((r) => r.skill === name);
		const keep = (rule && rule.score >= 3) || p >= threshold || (rule && rule.score >= 2 && p >= threshold * weakRuleFactor);
		if (keep) selected.push({ skill: name, score: Math.round(p * 10 * 100) / 100 + (rule?.score ?? 0), source: rule && p < threshold ? "rule" : "classifier" });
	}
	const chosen = new Set(selected.map((s) => s.skill));
	return { ...decision, selected, candidates: asked.filter((s) => !chosen.has(s) && (probs[s] ?? 0) >= threshold / 3) };
}

/**
 * Refine rule decisions with the classifier: candidates and weak rule hits are kept when p >= threshold,
 * strong rule hits (score >= 3) and always-on skills stay; score-2 hits need p >= threshold / 2.
 */
export async function refineWithClassifier(
	ctx: ExtensionContext,
	files: FileDiff[],
	decisions: RouteDecision[],
	catalog: SkillCatalog,
	opts: ClassifyRouteOptions,
	signal?: AbortSignal,
	progress?: (msg: string) => void,
): Promise<RouteDecision[]> {
	const model = classifierModel(ctx, opts.model);
	if (!model) throw new Error(`the classifier ${opts.model ? `${opts.model.provider}/${opts.model.id}` : "(local)"} is not registered`);
	const out: RouteDecision[] = [];
	let n = 0;
	for (const decision of decisions) {
		n++;
		const file = files.find((f) => f.path === decision.file);
		if (!file || signal?.aborted) {
			out.push(decision);
			continue;
		}
		progress?.(`Classifying ${file.path} (${n}/${decisions.length})…`);
		const ruleSkills = decision.selected.filter((s) => s.source === "rule");
		const pool = opts.scope === "all" ? catalog.all().map((s) => s.name) : decision.candidates;
		const candidates = [...new Set([...ruleSkills.map((s) => s.skill), ...pool])]
			.filter((s) => !opts.alwaysOn.includes(s) && !META_SKILLS.has(s))
			.map((s) => catalog.get(s))
			.filter((s): s is SkillInfo => !!s)
			.slice(0, opts.maxCandidates ?? (opts.scope === "all" ? 128 : 16));
		if (candidates.length === 0) {
			out.push(decision);
			continue;
		}
		const input = routingInput(file);
		const questions = Object.fromEntries(candidates.map((s) => [questionId(s.name), questionFor(s)]));
		const result = await ctx.modelRegistry.classify(
			model,
			{ state: { file: file.path, language: file.lang, declaration: input.header, change: clip(input.changed, 3000), surrounding_code: clip(input.context, 1500) }, questions },
			{ signal: withTimeout(signal, opts.requestTimeoutSeconds), temperature: opts.temperature },
		);
		if (result.stopReason !== "stop") {
			out.push({ ...decision, classifier: { model: `${model.provider}/${model.id}`, ok: false, error: result.errorMessage } });
			continue;
		}
		const probs: Record<string, number> = {};
		for (const s of candidates) {
			const a = result.answers[questionId(s.name)];
			if (a?.type === "bool") probs[s.name] = a.probability;
		}
		out.push({ ...applyProbabilities(decision, candidates.map((s) => s.name), probs, opts.threshold), classifier: { model: `${model.provider}/${model.id}`, ok: true, probabilities: probs } });
	}
	return out;
}

/** One short line per skill for a `choice` question (all options must fit in one llama.cpp batch). */
export function shortDescription(skill: SkillInfo): string {
	return skill.description.replace(/^Use when\s+/i, "").split(/[.;—–(]/)[0].trim().slice(0, 70);
}

/**
 * Skills most relevant to a free-text question (advisor pre-routing), best first. One `choice` question over
 * every skill makes a shortlist, then a yes/no question per shortlisted skill decides. Measured with Kev-4B
 * Q4_K_M on an RTX 4050 laptop GPU (Vulkan, -ub 1024): 1.3-1.8 s per question, against about 20 s for yes/no
 * questions on all 53 skills. When the choice question is refused (options larger than the batch), every
 * skill gets a yes/no question.
 */
export async function rankSkillsForText(
	ctx: ExtensionContext,
	text: string,
	skills: SkillInfo[],
	opts: { threshold: number; topK: number; shortlist?: number; temperature?: number; requestTimeoutSeconds?: number; model?: { provider: string; id: string } },
	signal?: AbortSignal,
): Promise<{ skill: string; p: number }[]> {
	const model = classifierModel(ctx, opts.model);
	if (!model || skills.length === 0) return [];
	const state = { question: clip(text, 4000) };
	const options = { signal: withTimeout(signal, opts.requestTimeoutSeconds), temperature: opts.temperature };
	let pool = skills;
	const shortlist = opts.shortlist ?? 8;
	if (skills.length > shortlist) {
		const choice = await ctx.modelRegistry.classify(
			model,
			{ state, questions: { topic: { type: "choice", instructions: "Which Godot guidance is most relevant to answering this question about a Godot 4 project?", criteria: Object.fromEntries(skills.map((s) => [s.name, shortDescription(s)])) } } },
			options,
		);
		const answer = choice.stopReason === "stop" ? choice.answers.topic : undefined;
		if (answer?.type === "choice") {
			const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
			const names = new Set(ranked.slice(0, shortlist).map(([k]) => k));
			pool = skills.filter((s) => names.has(s.name));
		} else if (signal?.aborted) {
			return [];
		}
	}
	const questions = Object.fromEntries(pool.map((s) => [questionId(s.name), { ...questionFor(s), instructions: `Does answering this question about a Godot project need the "${s.title ?? s.name}" guidance (${s.name})? It applies when ${s.description.replace(/^Use when\s+/i, "")}` }]));
	const result = await ctx.modelRegistry.classify(model, { state, questions }, options);
	if (result.stopReason !== "stop") return [];
	return pool
		.map((s) => {
			const a = result.answers[questionId(s.name)];
			return { skill: s.name, p: a?.type === "bool" ? a.probability : 0 };
		})
		.filter((x) => x.p >= opts.threshold)
		.sort((a, b) => b.p - a.p)
		.slice(0, opts.topK);
}
