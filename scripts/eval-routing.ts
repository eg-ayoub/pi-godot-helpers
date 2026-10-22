// Routing eval: precision and recall of the skill routing on the labelled cases in routing-cases.ts, for the
// rules alone and for rules + a real decision model, over a range of thresholds. Manual, not run in CI.
//
//   npm run eval:routing                                   rules only
//   npm run eval:routing -- --server http://127.0.0.1:8080 a llama-server that already runs a decision model
//   npm run eval:routing -- --llama-server $(which llama-server) --model ~/models/Kev-4B-Q4_K_M.gguf
//   npm run eval:routing -- --llama-server … --hf ggml-org/Kev-4B-GGUF:Q4_K_M   (downloads on first use)
//   options: --scope rules|all|both  --gpu-layers auto|N  --verbose  --json out.json
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, mergeConfig, type ClassifierConfig } from "../src/config.ts";
import type { FileDiff, RouteDecision } from "../src/review/types.ts";
import { SkillCatalog } from "../src/skills/catalog.ts";
import { applyProbabilities, ClassifierHost, META_SKILLS, refineWithClassifier } from "../src/skills/classifier.ts";
import { routeByRules } from "../src/skills/router.ts";
import { systemOneClassifier } from "../src/skills/system-one.ts";
import { CASES, type RoutingCase } from "./routing-cases.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALWAYS_ON = ["godot-code-review"];
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const WEAK_RULE_FACTORS = [0.5, 1];

function args(): Map<string, string> {
	const out = new Map<string, string>();
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) out.set(argv[i].slice(2), "true");
		else out.set(argv[i].slice(2), argv[++i]);
	}
	return out;
}

function toFile(c: RoutingCase): FileDiff {
	const lines = c.code.split("\n").map((t, i) => ({ k: "+" as const, n: i + 1, t }));
	return {
		path: c.path,
		status: "M",
		binary: false,
		lang: c.lang ?? "gdscript",
		added: lines.length,
		removed: 0,
		headerLines: c.header,
		hunks: [{ id: `${c.path}#1`, file: c.path, oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, header: "", lines, enclosing: c.context, tokens: Math.ceil(c.code.length / 4) }],
	};
}

const picked = (d: RouteDecision) => new Set(d.selected.map((s) => s.skill).filter((s) => !ALWAYS_ON.includes(s) && !META_SKILLS.has(s)));

interface Score {
	tp: number;
	fp: number;
	fn: number;
	p: number;
	r: number;
	f1: number;
	misses: { id: string; missing: string[]; extra: string[] }[];
}

function score(decisions: RouteDecision[]): Score {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	const misses: Score["misses"] = [];
	CASES.forEach((c, i) => {
		const got = picked(decisions[i]);
		const want = new Set(c.labels);
		const missing = [...want].filter((s) => !got.has(s));
		const extra = [...got].filter((s) => !want.has(s));
		tp += want.size - missing.length;
		fn += missing.length;
		fp += extra.length;
		if (missing.length || extra.length) misses.push({ id: c.id, missing, extra });
	});
	const p = tp + fp ? tp / (tp + fp) : 1;
	const r = tp + fn ? tp / (tp + fn) : 1;
	return { tp, fp, fn, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, misses };
}

const fmt = (s: Score) => `P ${s.p.toFixed(2)}  R ${s.r.toFixed(2)}  F1 ${s.f1.toFixed(2)}  (tp ${s.tp}, fp ${s.fp}, fn ${s.fn})`;

function printMisses(s: Score): void {
	for (const m of s.misses) console.log(`    ${m.id.padEnd(18)} ${m.missing.length ? `missing ${m.missing.join(", ")}` : ""}${m.missing.length && m.extra.length ? "; " : ""}${m.extra.length ? `extra ${m.extra.join(", ")}` : ""}`);
}

async function main(): Promise<void> {
	const a = args();
	const verbose = a.has("verbose");
	const catalog = SkillCatalog.load([join(ROOT, "vendor", "GodotPrompter", "skills")]);
	const unknown = catalog.unknown(CASES.flatMap((c) => c.labels));
	if (unknown.length) throw new Error(`labels name unknown skills: ${unknown.join(", ")}`);
	const files = CASES.map(toFile);
	const rules = files.map((f) => routeByRules([f], catalog, { alwaysOn: ALWAYS_ON })[0]);
	const report: Record<string, unknown> = { cases: CASES.length, labels: CASES.reduce((n, c) => n + c.labels.length, 0) };

	const rulesScore = score(rules);
	report.rules = rulesScore;
	console.log(`${CASES.length} cases, ${report.labels} labels\n`);
	console.log(`rules only                ${fmt(rulesScore)}`);
	if (verbose) printMisses(rulesScore);

	let baseUrl = a.get("server");
	let host: ClassifierHost | undefined;
	const started = Date.now();
	if (!baseUrl && a.has("llama-server")) {
		const gpu = a.get("gpu-layers") ?? "auto";
		const cfg = mergeConfig<ClassifierConfig>(DEFAULT_CONFIG.classifier, {
			llamaServer: a.get("llama-server"),
			modelPath: a.get("model"),
			hfRepo: a.get("hf") ?? DEFAULT_CONFIG.classifier.hfRepo,
			gpuLayers: gpu === "auto" ? "auto" : Number(gpu),
		});
		const stub = { registerProvider: (_n: string, c: { baseUrl?: string }) => (baseUrl = c.baseUrl), unregisterProvider: () => {} } as unknown as ExtensionAPI;
		host = new ClassifierHost(stub, join(homedir(), ".pi", "agent", "godot-helpers", "models"), () => cfg);
		process.stdout.write("\nstarting llama-server… ");
		const problem = await host.ensure();
		if (problem) throw new Error(problem);
		console.log(`ready in ${((Date.now() - started) / 1000).toFixed(1)} s (gpu layers ${host.status().gpuLayers})`);
		report.startSeconds = (Date.now() - started) / 1000;
		report.gpuLayers = host.status().gpuLayers;
	}
	if (!baseUrl) {
		console.log("\n(no classifier: pass --server URL or --llama-server BIN --model GGUF to measure one)");
		if (a.get("json")) writeFileSync(a.get("json")!, JSON.stringify(report, null, 2));
		return;
	}
	if (!/\/v1\/?$/.test(baseUrl)) baseUrl = `${baseUrl.replace(/\/+$/, "")}/v1`;

	const model = { type: "classifier", api: "typesafe-system-one", provider: "eval", id: "decision", name: "decision", baseUrl, input: ["text"], contextWindow: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const latencies: number[] = [];
	const ctx = {
		modelRegistry: {
			findOfType: () => model,
			classify: async (m: unknown, c: unknown, o: Record<string, unknown> = {}) => {
				const t = Date.now();
				const r = await systemOneClassifier.classify(m as never, c as never, { ...o, apiKey: "local" } as never);
				latencies.push(Date.now() - t);
				return r;
			},
		},
	} as unknown as ExtensionContext;

	try {
		const scopes = (a.get("scope") ?? "both") === "both" ? (["rules", "all"] as const) : ([a.get("scope") as "rules" | "all"] as const);
		for (const scope of scopes) {
			latencies.length = 0;
			const refined = await refineWithClassifier(ctx, files, rules, catalog, { threshold: 0.5, alwaysOn: ALWAYS_ON, scope, requestTimeoutSeconds: 300 }, undefined, verbose ? (m) => process.stderr.write(`${m}\r`) : undefined);
			const errors = refined.filter((d) => d.classifier && !d.classifier.ok);
			if (errors.length) console.log(`\n${errors.length} classifier error(s), first: ${errors[0].classifier?.error}`);
			if (verbose) console.log(`  per request (ms): ${latencies.join(" ")}`);
			const sorted = [...latencies].sort((x, y) => x - y);
			const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
			const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
			console.log(`\nclassifier, ${scope === "all" ? "every code skill" : "the rules' candidates"} asked (${sorted.length} requests, median ${median} ms, p90 ${p90} ms)`);
			const sweep: Record<string, Score> = {};
			let best: { t: number; w: number; s: Score } | undefined;
			for (const w of WEAK_RULE_FACTORS) {
				console.log(`  a score-2 rule hit needs p >= ${w} × threshold`);
				for (const t of THRESHOLDS) {
					const decisions = refined.map((d, i) => (d.classifier?.ok ? applyProbabilities(rules[i], Object.keys(d.classifier.probabilities ?? {}), d.classifier.probabilities ?? {}, t, w) : rules[i]));
					const s = score(decisions);
					sweep[`${w}/${t}`] = s;
					console.log(`    threshold ${t.toFixed(1)}         ${fmt(s)}`);
					if (!best || s.f1 > best.s.f1) best = { t, w, s };
				}
			}
			if (best) {
				console.log(`  best F1 at threshold ${best.t}, factor ${best.w}${verbose ? ":" : ""}`);
				if (verbose) printMisses(best.s);
			}
			report[`classifier_${scope}`] = { medianMs: median, p90Ms: p90, requests: sorted.length, errors: errors.length, sweep, best: best && { threshold: best.t, weakRuleFactor: best.w } };
			if (verbose) {
				for (const [i, d] of refined.entries()) {
					const probs = Object.entries(d.classifier?.probabilities ?? {})
						.sort((x, y) => y[1] - x[1])
						.slice(0, 4)
						.map(([k, v]) => `${k} ${v.toFixed(2)}`);
					console.log(`    ${CASES[i].id.padEnd(18)} [${CASES[i].labels.join(", ")}] → ${probs.join(", ")}`);
				}
			}
		}
	} finally {
		await host?.stop();
	}
	if (a.get("json")) writeFileSync(a.get("json")!, JSON.stringify(report, null, 2));
}

main().catch((e) => {
	console.error((e as Error).message);
	process.exit(1);
});
