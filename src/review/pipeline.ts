// /review <what>: resolve the target, collect the diff, run the checks, route skills, review each unit in a
// worker, run the doc pass, aggregate, save, and show the result.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { PACKAGE_ROOT } from "../runtime.ts";
import { SkillCatalog } from "../skills/catalog.ts";
import { routeByRules } from "../skills/router.ts";
import { showReport } from "../ui/report.ts";
import { commentsFromChecks, countBySeverity, dedupe, fromRaw } from "./aggregate.ts";
import { runChecks } from "./checks.ts";
import { collectDiff, reviewable } from "./diff.ts";
import { DOCPASS_ROLE, runDocPass, SettleWaiter } from "./docpass.ts";
import type { ReviewRecord, WorkerSummary } from "./record.ts";
import { renderMarkdown } from "./report-md.ts";
import { describeTarget, parseTargetJson, parseTargetText, resolveTarget, TARGET_PROMPT, TargetError } from "./target.ts";
import type { CheckResult, FileDiff, ResolvedTarget, ReviewComment, RouteDecision, RoutedUnit } from "./types.ts";
import { buildUnits } from "./units.ts";
import { buildWorkerContext, buildWorkerSystemPrompt, type UnitFile } from "./worker-prompt.ts";
import { runPool, runWorker, type WorkerJob } from "./worker-runner.ts";

export interface ReviewOptions {
	text: string;
	docs: boolean;
	checks: boolean;
	open: boolean;
	rulesOnly: boolean;
}

export function parseReviewArgs(args: string): ReviewOptions {
	const flags = new Set<string>();
	const text = args
		.replace(/(^|\s)--(no-docs|no-checks|no-open|rules-only)(?=\s|$)/g, (_m, pre: string, flag: string) => {
			flags.add(flag);
			return pre;
		})
		.trim();
	return { text, docs: !flags.has("no-docs"), checks: !flags.has("no-checks"), open: !flags.has("no-open"), rulesOnly: flags.has("rules-only") };
}

/** Hooks other phases plug into (memory, classifier routing, viewer). */
export interface ReviewHooks {
	route?: (files: FileDiff[], catalog: SkillCatalog, ctx: ExtensionContext, signal: AbortSignal, progress: (msg: string) => void) => Promise<{ decisions: RouteDecision[]; label: string }>;
	extraSections?: (unit: RoutedUnit, files: FileDiff[]) => Promise<{ title: string; body: string }[]>;
	afterReview?: (record: ReviewRecord, notes: Record<string, unknown>[], ctx: ExtensionContext) => Promise<void>;
	markRaised?: (comments: ReviewComment[], files: FileDiff[]) => Promise<void>;
	present?: (record: ReviewRecord, dir: string, ctx: ExtensionContext, open: boolean) => Promise<string | undefined>;
}

function isLocalModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return true;
	return model.provider === "llama.cpp" || /\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(model.baseUrl ?? "");
}

export class ReviewController {
	running?: { abort: AbortController; id: string };
	readonly waiter = new SettleWaiter();
	hooks: ReviewHooks = {};

	private readonly pi: ExtensionAPI;
	private readonly rt: Runtime;

	constructor(pi: ExtensionAPI, rt: Runtime) {
		this.pi = pi;
		this.rt = rt;
	}

	private progress(ctx: ExtensionContext, lines: string[]): void {
		if (ctx.hasUI) ctx.ui.setWidget("godot-review", lines);
		else process.stderr.write(`[godot-review] ${lines.at(-1)}\n`);
	}

	async resolve(text: string, ctx: ExtensionContext): Promise<ResolvedTarget> {
		const root = this.rt.repo?.toplevel as string;
		const base = this.rt.config.baseBranch;
		const parsed = parseTargetText(text, base);
		if (parsed) return resolveTarget(parsed, text, root, base, "parser");
		if (!ctx.model) throw new TargetError(`could not understand "${text}" and no model is selected to interpret it`);
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: TARGET_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: `Default base branch: ${base}\nRequest: ${text}` }], timestamp: Date.now() }],
			},
			{ cacheRetention: "none" },
		);
		const answer = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const target = parseTargetJson(answer);
		if (!target) throw new TargetError(`could not understand "${text}"; try "this branch against ${base}", "the unstaged changes" or "the last commit"`);
		return resolveTarget({ target, exact: false }, text, root, base, "llm");
	}

	async run(args: string, ctx: ExtensionCommandContext): Promise<ReviewRecord | undefined> {
		const pi = this.pi;
		const rt = this.rt;
		if (!rt.active || !rt.repo) {
			ctx.ui.notify("/review works inside a Godot project (a git repository with a project.godot).", "warning");
			return undefined;
		}
		if (this.running) {
			ctx.ui.notify("A review is already running (/review-cancel stops it).", "warning");
			return undefined;
		}
		const opts = parseReviewArgs(args);
		const abort = new AbortController();
		const started = Date.now();
		const id = new Date(started).toISOString().replace(/[:.]/g, "-");
		this.running = { abort, id };
		const repo = rt.repo;
		const status: string[] = [];
		const say = (line: string) => {
			status.push(line);
			this.progress(ctx, status.slice(-8));
		};
		const previousMode = rt.mode;
		rt.state.set("review", false);
		const dir = join(rt.repoDataDir() as string, "reviews", id);
		let record: ReviewRecord | undefined;
		try {
			say(`Resolving "${opts.text || "(default)"}"…`);
			const target = await this.resolve(opts.text, ctx);
			const description = describeTarget(target);
			if (!target.exact && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Review this?", `${description}${target.warnings.length ? `\n\n${target.warnings.join("\n")}` : ""}`);
				if (!ok) {
					ctx.ui.notify("Review cancelled.", "info");
					return undefined;
				}
			}
			say(`Reviewing ${description}`);
			for (const w of target.warnings) say(`warning: ${w}`);
			const files = await collectDiff(target, repo.toplevel);
			const toReview = reviewable(files).filter((f) => f.lang !== "text" && f.lang !== "binary");
			if (toReview.length === 0) {
				ctx.ui.notify(`Nothing to review in ${description}.`, "info");
				return undefined;
			}
			mkdirSync(join(dir, "units"), { recursive: true });

			let checks: CheckResult[] = [];
			let checksNote: string | undefined;
			if (opts.checks) {
				const r = await runChecks(rt.config.checks, files, target, rt.sandboxOptions(), {
					repoRoot: repo.toplevel,
					timeoutSeconds: rt.config.sandbox.timeoutSeconds,
					signal: abort.signal,
					onProgress: (name) => say(`Running check ${name}…`),
				});
				checks = r.results;
				checksNote = r.note;
			}
			if (abort.signal.aborted) throw new Error("cancelled");

			const catalog = SkillCatalog.load([rt.skillsRoot(), ...rt.config.skills.extraPaths]);
			say("Routing skills…");
			const routed =
				!opts.rulesOnly && this.hooks.route
					? await this.hooks.route(toReview, catalog, ctx, abort.signal, (m) => say(m))
					: { decisions: routeByRules(toReview, catalog, { alwaysOn: rt.config.skills.alwaysOn }), label: "rules only" };

			const model = rt.config.worker.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (!model) throw new Error("no model is selected for the review workers (/model, or worker.model in the config)");
			const contextWindow = ctx.model?.contextWindow || rt.config.worker.defaultContextWindow;
			const designChars = 16000;
			const fixedTokens = 3500 + Math.ceil(designChars / 4);
			const units = buildUnits(toReview, routed.decisions, {
				maxSkillsPerUnit: rt.config.skills.maxPerUnit,
				promptBudget: Math.floor(contextWindow * rt.config.worker.unitPromptFraction),
				fixedTokens,
				skillTokens: (s) => catalog.get(s)?.tokens ?? 0,
				alwaysOn: rt.config.skills.alwaysOn,
			});
			say(`${units.length} part(s): ${units.map((u) => `${u.id} [${u.skills.join(", ")}]`).join("; ")}`);

			const jobs: WorkerJob[] = [];
			for (const unit of units) {
				const extraSections = this.hooks.extraSections ? await this.hooks.extraSections(unit, toReview) : [];
				const input = { repoRoot: repo.toplevel, docs: rt.config.docs, unit, files: toReview, catalog, checks, targetLabel: description, extraSections };
				const base = join(dir, "units", unit.id);
				const unitFiles = toReview
					.filter((f) => unit.files.includes(f.path))
					.map((f) => ({ ...f, hunks: f.hunks.filter((h) => unit.hunkIds.includes(h.id)) }));
				const unitFile: UnitFile = { reviewId: id, unitId: unit.id, repoRoot: repo.toplevel, outFile: `${base}.out.jsonl`, files: unitFiles };
				writeFileSync(`${base}.system.md`, buildWorkerSystemPrompt(input));
				writeFileSync(`${base}.context.md`, buildWorkerContext(input));
				writeFileSync(`${base}.json`, JSON.stringify(unitFile));
				writeFileSync(unitFile.outFile, "");
				jobs.push({
					unitId: unit.id,
					systemFile: `${base}.system.md`,
					contextFile: `${base}.context.md`,
					unitFile: `${base}.json`,
					outFile: unitFile.outFile,
					logFile: `${base}.log`,
					advertisedSkillDirs: unit.advertised.map((s) => catalog.get(s)?.dir).filter((d): d is string => !!d),
				});
			}

			const concurrency = isLocalModel(ctx.model) ? rt.config.worker.concurrencyLocal : rt.config.worker.concurrencyCloud;
			const found = new Map<string, number>();
			const outcomes = await runPool(jobs, concurrency, (job) => {
				say(`Reviewing ${job.unitId}…`);
				return runWorker(job, {
					cwd: repo.toplevel,
					extensionPath: join(PACKAGE_ROOT, "src", "index.ts"),
					model,
					thinking: rt.config.worker.thinking ?? pi.getThinkingLevel(),
					extraExtensions: rt.config.worker.extraExtensions,
					timeoutSeconds: rt.config.worker.timeoutSeconds,
					signal: abort.signal,
					onEvent: (unitId, event) => {
						if (event.type === "tool_execution_end" && event.toolName === "review_comment") {
							found.set(unitId, (found.get(unitId) ?? 0) + 1);
							say(`${unitId}: ${found.get(unitId)} finding(s)`);
						}
					},
				});
			});
			if (abort.signal.aborted) throw new Error("cancelled");

			const workerComments = outcomes.flatMap((o) => o.comments.map((c) => fromRaw({ ...c, unitId: o.unitId }, toReview, "worker")));
			const comments = dedupe([...commentsFromChecks(checks, toReview), ...workerComments]);
			if (this.hooks.markRaised) await this.hooks.markRaised(comments, toReview);
			const workers: WorkerSummary[] = outcomes.map((o) => {
				const unit = units.find((u) => u.id === o.unitId) as RoutedUnit;
				return { unitId: o.unitId, files: unit.files, skills: unit.skills, summary: o.summary, error: o.finished ? undefined : (o.error ?? "the worker stopped without review_done"), comments: o.comments.length, usage: o.usage };
			});

			record = {
				version: 1,
				id,
				createdAt: new Date(started).toISOString(),
				durationMs: 0,
				repo: { toplevel: repo.toplevel, id: repo.id },
				target: { label: opts.text, description, resolved: target },
				model,
				files,
				comments,
				checks,
				checksNote,
				routing: { decisions: routed.decisions, units, classifier: routed.label },
				workers,
				warnings: target.warnings,
				status: "complete",
			};

			if (opts.docs) {
				say("Checking DESIGN.md and AGENTS.md against the code…");
				const docPass = await runDocPass(pi, rt, ctx, { targetLabel: description, files: toReview, comments }, this.waiter);
				record.docPass = docPass;
			} else record.docPass = { patches: [], skipped: "--no-docs" };

			const notes = outcomes.flatMap((o) => o.notes);
			if (this.hooks.afterReview) await this.hooks.afterReview(record, notes, ctx);
		} catch (error) {
			const message = (error as Error).message;
			const cancelled = abort.signal.aborted || message === "cancelled";
			if (record) {
				record.status = cancelled ? "cancelled" : "failed";
				record.error = message;
			} else {
				ctx.ui.notify(cancelled ? "Review cancelled." : `Review failed: ${message}`, cancelled ? "info" : "error");
				if (!ctx.hasUI) process.stderr.write(`[godot-review] ${cancelled ? "cancelled" : `failed: ${message}`}\n`);
				return undefined;
			}
		} finally {
			this.running = undefined;
			rt.state.set(previousMode === "advisor" ? "advisor" : "off", false);
			if (ctx.hasUI) ctx.ui.setWidget("godot-review", undefined);
		}
		record.durationMs = Date.now() - started;
		writeFileSync(join(dir, "review.json"), JSON.stringify(record, null, 1));
		writeFileSync(join(dir, "review.md"), renderMarkdown(record));
		const url = this.hooks.present ? await this.hooks.present(record, dir, ctx, opts.open) : undefined;
		const counts = countBySeverity(record.comments);
		const lines = [
			`${record.target.description}: ${record.comments.length} finding(s): ${counts.critical} critical, ${counts.important} important, ${counts.minor} minor, ${counts.nit} nit`,
			...record.comments.filter((c) => c.severity === "critical" || c.severity === "important").slice(0, 12).map((c) => `[${c.severity}] ${c.file}${c.line !== null ? `:${c.line}` : ""} ${c.title}`),
			...(record.docPass?.patches.length ? [`docs updated: ${record.docPass.patches.map((p) => p.file).join(", ")}`] : []),
			...record.warnings.map((w) => `warning: ${w}`),
			...record.workers.filter((w) => w.error).map((w) => `${w.unitId} incomplete: ${w.error}`),
			`report: ${join(dir, "review.md")}`,
			...(url ? [`viewer: ${url}`] : []),
		];
		showReport(pi, ctx.hasUI, record.status === "complete" ? "Review complete" : `Review ${record.status}`, lines);
		return record;
	}

	cancel(ctx: ExtensionContext): void {
		if (!this.running) {
			ctx.ui.notify("No review is running.", "info");
			return;
		}
		this.running.abort.abort();
		if (this.waiter.pending) ctx.abort();
		ctx.ui.notify("Cancelling the review…", "info");
	}
}

export function registerReview(pi: ExtensionAPI, rt: Runtime): ReviewController {
	const controller = new ReviewController(pi, rt);
	pi.registerCommand("review", {
		description: 'Review a change: /review this branch against develop | the unstaged changes | the last commit … [--no-docs] [--no-checks] [--no-open] [--rules-only]',
		handler: async (args, ctx) => {
			await rt.refresh(ctx);
			// print/json modes exit when the command returns, so they wait; the TUI and RPC run it in the background
			if (ctx.mode === "print" || ctx.mode === "json") {
				await controller.run(args, ctx);
				return;
			}
			void controller.run(args, ctx).catch((error: Error) => ctx.ui.notify(`Review failed: ${error.message}`, "error"));
		},
	});
	pi.registerCommand("review-cancel", {
		description: "Stop the running review",
		handler: async (_args, ctx) => controller.cancel(ctx),
	});
	pi.on("agent_settled", (event) => {
		if (controller.waiter.pending) controller.waiter.settle(event.aborted);
	});
	pi.on("input", (event, ctx) => {
		if (controller.running && event.source !== "extension") {
			ctx.ui.notify("A review is running; wait for it or /review-cancel.", "warning");
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});
	pi.on("before_agent_start", (event) => {
		if (rt.active && rt.mode === "review-docs") event.systemPromptOptions.sections.godot_doc_maintainer = DOCPASS_ROLE;
	});
	return controller;
}
