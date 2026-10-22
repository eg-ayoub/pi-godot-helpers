// Routing wiring: the review's route hook (rules, then the local classifier), advisor pre-routing, skill
// discovery in Godot repositories, and the classifier's status/self-test.
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataDir } from "../config.ts";
import { detectRepo, git, isGodotRepo } from "../repo.ts";
import type { ReviewController } from "../review/pipeline.ts";
import type { FileDiff } from "../review/types.ts";
import type { Runtime } from "../runtime.ts";
import { statusSections } from "../status.ts";
import { showReport } from "../ui/report.ts";
import { SkillCatalog } from "./catalog.ts";
import { CLASSIFIER_MODEL_ID, CLASSIFIER_PROVIDER, ClassifierHost, META_SKILLS, rankSkillsForText, refineWithClassifier } from "./classifier.ts";
import { routeByRules } from "./router.ts";
import { RULES, ruleSkillNames } from "./rules.ts";

const isWorkerProcess = () => process.argv.includes("--godot-helpers-worker");

export function registerRouting(pi: ExtensionAPI, rt: Runtime, reviews: ReviewController): ClassifierHost {
	const host = new ClassifierHost(pi, join(dataDir(rt.agentDir), "models"), () => rt.config.classifier);

	/** The classifier model to use: a configured pi classifier, else the local llama-server. */
	async function classifierReady(signal?: AbortSignal): Promise<{ ok: true; label: string } | { ok: false; reason: string }> {
		const cfg = rt.config.classifier;
		if (!cfg.enabled) return { ok: false, reason: "disabled in the config" };
		if (cfg.piModel) return { ok: true, label: cfg.piModel };
		const problem = await host.ensure(signal);
		return problem ? { ok: false, reason: problem.split("\n")[0] } : { ok: true, label: cfg.modelPath ? cfg.modelPath.split("/").pop() ?? "local" : cfg.hfRepo };
	}

	let csharpCache: { root: string; value: Promise<boolean> } | undefined;
	/** C# skills are only offered when the repository has C# files. */
	function hasCSharp(): Promise<boolean> {
		const root = rt.repo?.toplevel;
		if (!root) return Promise.resolve(false);
		if (csharpCache?.root !== root) csharpCache = { root, value: git(["ls-files", "--", "*.cs"], root).then((r) => r.stdout.trim().length > 0) };
		return csharpCache.value;
	}

	function providerAndId(): [string, string] {
		const ref = rt.config.classifier.piModel;
		if (ref && ref.includes("/")) {
			const i = ref.indexOf("/");
			return [ref.slice(0, i), ref.slice(i + 1)];
		}
		return [CLASSIFIER_PROVIDER, CLASSIFIER_MODEL_ID];
	}

	reviews.hooks.route = async (files: FileDiff[], catalog: SkillCatalog, ctx: ExtensionContext, signal: AbortSignal, progress) => {
		const cfg = rt.config.classifier;
		const rules = routeByRules(files, catalog, { alwaysOn: rt.config.skills.alwaysOn });
		if (!cfg.enabled) return { decisions: rules, label: "rules only (classifier disabled)" };
		progress(cfg.piModel || host.modelReady() ? "Starting the local classifier…" : `Starting the local classifier (first use: llama-server downloads ${cfg.hfRepo}, about 3 GB)…`);
		const ready = await classifierReady(signal);
		if (!ready.ok) {
			progress(`classifier unavailable: ${ready.reason}; routing with rules only`);
			return { decisions: rules, label: `rules only (classifier unavailable: ${ready.reason})` };
		}
		try {
			const [provider, id] = providerAndId();
			const decisions = await refineWithClassifier(ctx, files, rules, catalog, { threshold: cfg.threshold, alwaysOn: rt.config.skills.alwaysOn, scope: cfg.candidates, requestTimeoutSeconds: cfg.requestTimeoutSeconds, model: { provider, id } }, signal, progress);
			const failed = decisions.filter((d) => d.classifier && !d.classifier.ok);
			return {
				decisions,
				label: `rules + classifier ${ready.label}${failed.length ? ` (${failed.length} file(s) fell back to rules: ${failed[0].classifier?.error ?? "error"})` : ""}`,
			};
		} finally {
			// the workers' model may be local too: free the memory before they start
			if (!cfg.piModel) await host.stop();
		}
	};

	// advisor: pre-route the question and hand the model the matching skills as a message
	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = rt.config.classifier;
		if (!rt.active || rt.state.mode !== "advisor" || event.messageType !== "user" || !cfg.enabled || cfg.advisorSkills <= 0) return undefined;
		// never block a chat turn on the first model download; /godot-helpers-classifier-test or a review does it
		if (!cfg.piModel && !host.modelReady()) return undefined;
		try {
			const ready = await classifierReady(ctx.signal);
			if (!ready.ok) return undefined;
			const catalog = SkillCatalog.load(rt.skillRoots());
			const csharp = await hasCSharp();
			const skills = catalog.all().filter((s) => !META_SKILLS.has(s.name) && !rt.config.skills.alwaysOn.includes(s.name) && (csharp || !s.name.startsWith("csharp-")));
			const [provider, id] = providerAndId();
			const ranked = await rankSkillsForText(ctx, event.prompt, skills, { threshold: cfg.threshold, topK: cfg.advisorSkills, requestTimeoutSeconds: cfg.requestTimeoutSeconds, model: { provider, id } }, ctx.signal);
			if (!cfg.piModel) await host.release();
			if (ranked.length === 0) return undefined;
			const content = ranked.map((r) => `<skill name="${r.skill}">\n${catalog.body(r.skill)}\n</skill>`).join("\n\n");
			return {
				message: {
					customType: "godot-helpers-skills",
					content: `Godot guidance selected for this question (${ranked.map((r) => r.skill).join(", ")}):\n\n${content}`,
					display: false,
					details: { skills: ranked },
				},
			};
		} catch {
			if (!cfg.piModel) await host.release();
			return undefined;
		}
	});

	// in Godot repositories (not in review workers), offer the skills through pi's normal skill listing
	pi.on("resources_discover", async (event, ctx) => {
		if (isWorkerProcess()) return undefined;
		const repo = await detectRepo(event.cwd);
		if (!isGodotRepo(repo)) return undefined;
		// may run before session_start: read the config here
		await rt.refresh(ctx);
		const paths = rt.skillRoots();
		return paths.length ? { skillPaths: paths } : undefined;
	});

	pi.on("session_shutdown", async () => {
		await host.stop();
	});

	statusSections.push((r) => {
		const cfg = r.config.skills;
		const catalog = SkillCatalog.load(r.skillRoots());
		const lines: string[] = [];
		if (cfg.path) lines.push(`skills: ${catalog.size} from ${cfg.path} (skills.path: nothing is downloaded)`);
		else {
			const installed = r.installedSkills();
			lines.push(installed ? `skills: ${catalog.size} from GodotPrompter ${installed.tag} (${installed.commit.slice(0, 7)}), downloaded ${installed.fetchedAt.slice(0, 10)}` : "skills: none downloaded yet");
			const u = r.skillUpdateResult;
			if (!cfg.source.autoUpdate) lines.push("skills update: off (skills.source.autoUpdate is false)");
			else if (!u) lines.push(r.skillUpdate ? `skills update: checking ${cfg.source.repo}…` : "skills update: not started (only in a Godot repository)");
			else if (u.status === "updated") lines.push(`skills update: updated to ${u.installed.tag} at this start`);
			else if (u.status === "unchanged") lines.push(`skills update: ${u.installed.tag} is the newest tag`);
			else if (u.status === "busy" || u.status === "failed") lines.push(`skills update: ${u.status}: ${u.error}${u.installed ? ` (still using ${u.installed.tag})` : ""}`);
		}
		const missing = catalog.unknown([...ruleSkillNames(RULES), ...r.config.skills.alwaysOn]);
		if (catalog.size && missing.length) lines.push(`skills the routing rules name but this version lacks: ${missing.join(", ")}`);
		return lines;
	});

	statusSections.push((r) => {
		const cfg = r.config.classifier;
		if (!cfg.enabled) return ["classifier: disabled (rules-only routing)"];
		if (cfg.piModel) return [`classifier: pi model ${cfg.piModel}`];
		const bin = host.binary();
		const s = host.status();
		return [
			`classifier: ${bin ? `llama-server at ${bin}` : "llama-server NOT FOUND (install llama.cpp >= 0.6.0 or set classifier.llamaServer); routing falls back to rules"}`,
			`classifier model: ${cfg.modelPath ?? `${cfg.hfRepo} (downloaded by llama-server on first use)`}, gpu layers ${cfg.gpuLayers}, threshold ${cfg.threshold}`,
			...(s.lastError ? [`classifier last error: ${s.lastError.split("\n")[0]}`] : []),
		];
	});

	pi.registerCommand("godot-helpers-classifier-test", {
		description: "Start the local classifier, route a sample change, report latency (downloads the model on first use)",
		handler: async (_args, ctx) => {
			await rt.refresh(ctx);
			const t0 = Date.now();
			const ready = await classifierReady();
			if (!ready.ok) {
				showReport(pi, ctx.hasUI, "Classifier test", [`not available: ${ready.reason}`, ...(host.status().log ? host.status().log.split("\n").slice(-10) : [])]);
				return;
			}
			const started = Date.now() - t0;
			const catalog = SkillCatalog.load(rt.skillRoots());
			const sample: FileDiff = {
				path: "game/ui/hud.gd",
				status: "M",
				binary: false,
				lang: "gdscript",
				added: 3,
				removed: 0,
				headerLines: "extends Control",
				hunks: [
					{
						id: "game/ui/hud.gd#1",
						file: "game/ui/hud.gd",
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 4,
						header: "",
						tokens: 50,
						lines: [
							{ k: " ", o: 1, n: 1, t: "func _process(delta: float) -> void:" },
							{ k: "+", n: 2, t: "\tvar label = get_node(\"Score\")" },
							{ k: "+", n: 3, t: "\tlabel.add_theme_color_override(\"font_color\", Color.RED)" },
							{ k: "+", n: 4, t: "\tlabel.size = Vector2(300, 40)" },
						],
					},
				],
			};
			const t1 = Date.now();
			const [provider, id] = providerAndId();
			let lines: string[];
			try {
				const rules = routeByRules([sample], catalog, { alwaysOn: rt.config.skills.alwaysOn });
				const decisions = await refineWithClassifier(ctx, [sample], rules, catalog, { threshold: rt.config.classifier.threshold, alwaysOn: rt.config.skills.alwaysOn, requestTimeoutSeconds: rt.config.classifier.requestTimeoutSeconds, model: { provider, id } });
				const d = decisions[0];
				lines = [
					`server ready in ${(started / 1000).toFixed(1)} s (gpu layers ${host.status().gpuLayers ?? "?"})`,
					`classification of ${Object.keys(d.classifier?.probabilities ?? {}).length} skills in ${((Date.now() - t1) / 1000).toFixed(2)} s`,
					d.classifier?.ok ? `selected: ${d.selected.map((s) => s.skill).join(", ")}` : `error: ${d.classifier?.error}`,
					...Object.entries(d.classifier?.probabilities ?? {})
						.sort((a, b) => b[1] - a[1])
						.map(([k, v]) => `  ${v.toFixed(3)}  ${k}`),
				];
			} catch (e) {
				lines = [`error: ${(e as Error).message}`];
			} finally {
				if (!rt.config.classifier.piModel) await host.stop();
			}
			showReport(pi, ctx.hasUI, "Classifier test", lines);
		},
	});

	return host;
}
