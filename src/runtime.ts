// Per-session state shared by every part of the extension: the repository, the config, the mode.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, dataDir, loadConfig, repoDataDir, type Config } from "./config.ts";
import { detectRepo, isGodotRepo, type RepoInfo } from "./repo.ts";
import type { GateContext, Mode } from "./security/gate.ts";
import type { SandboxOptions } from "./security/sandbox.ts";
import { SkillSource, type InstalledSkills, type UpdateResult } from "./skills/source.ts";
import { ModeState } from "./state.ts";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Tools this extension registers and the modes in which the model may call them. */
export const OWN_TOOLS: Record<string, Mode[]> = {
	memory_search: ["advisor", "review", "review-docs", "worker"],
	memory_get: ["advisor", "review", "review-docs", "worker"],
	memory_note_file: ["advisor", "review", "review-docs", "worker"],
	memory_add_fact: ["advisor", "review", "review-docs"],
	review_comment: ["worker"],
	review_done: ["worker"],
	agents_md_propose: ["docs-migrate"],
};

export class Runtime {
	repo?: RepoInfo;
	config: Config = DEFAULT_CONFIG;
	readonly state: ModeState;
	/** Set in worker subprocesses: the unit file passed with --godot-helpers-worker. */
	workerUnitFile?: string;
	agentDir = getAgentDir();
	configError?: string;
	/** The skills download started at session start, if one is running or done. */
	skillUpdate?: Promise<UpdateResult>;
	/** Its result, once it is done. */
	skillUpdateResult?: UpdateResult;

	readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.state = new ModeState(pi);
	}

	/** True when the session's repository is a Godot project: the gate and the sandbox apply. */
	get active(): boolean {
		return isGodotRepo(this.repo);
	}

	get mode(): Mode {
		return this.state.mode;
	}

	async refresh(ctx: ExtensionContext): Promise<void> {
		this.agentDir = getAgentDir();
		this.repo = await detectRepo(ctx.cwd);
		try {
			this.configError = undefined;
			this.config = loadConfig(this.agentDir, this.repo?.id);
		} catch (error) {
			this.configError = (error as Error).message;
			this.config = DEFAULT_CONFIG;
		}
	}

	repoDataDir(): string | undefined {
		return this.repo ? repoDataDir(this.agentDir, this.repo.id) : undefined;
	}

	/** All downloaded GodotPrompter versions live under this folder. */
	skillsStore(): string {
		return join(dataDir(this.agentDir), "skills");
	}

	skillSource(): SkillSource {
		return new SkillSource(join(this.skillsStore(), "GodotPrompter"));
	}

	/** The GodotPrompter copy in use (undefined when skills.path is set, or before the first download). */
	installedSkills(): InstalledSkills | undefined {
		return this.config.skills.path ? undefined : this.skillSource().current();
	}

	/** The skills folder in use: skills.path, else the downloaded copy. */
	skillsRoot(): string | undefined {
		return this.config.skills.path ?? this.installedSkills()?.skillsDir;
	}

	/** Every folder skills are loaded from, existing ones only. */
	skillRoots(): string[] {
		const root = this.skillsRoot();
		return [...(root ? [root] : []), ...this.config.skills.extraPaths].filter((r) => existsSync(r));
	}

	/** On every start in a Godot repository: fetch the newest GodotPrompter tag in the background. */
	startSkillUpdate(): void {
		const cfg = this.config.skills;
		if (cfg.path || !cfg.source.autoUpdate || this.skillUpdate) return;
		this.skillUpdate = this.skillSource().update(cfg.source);
		void this.skillUpdate.then((r) => (this.skillUpdateResult = r));
	}

	/** Wait for the download only when there is no copy at all yet (the first start). */
	async skillsReady(): Promise<void> {
		if (this.skillsRoot() || !this.skillUpdate) return;
		await this.skillUpdate;
	}

	readRoots(): string[] {
		const roots = [this.config.skills.path ?? this.skillsStore(), ...this.config.skills.extraPaths, ...this.config.readRoots];
		return roots.filter((r) => existsSync(r)).map((r) => realpathSync(r));
	}

	gateContext(): GateContext {
		if (!this.repo) throw new Error("no repository");
		return {
			mode: this.mode,
			repoRoot: this.repo.toplevel,
			docs: this.config.docs,
			readRoots: this.readRoots(),
			docsEditableIn: ["review-docs"],
			maxDocEditChars: this.config.maxDocEditChars,
			extraAllowedTools: this.config.extraAllowedTools,
			ownTools: OWN_TOOLS,
		};
	}

	sandboxOptions(): SandboxOptions {
		if (!this.repo) throw new Error("no repository");
		return {
			repoRoot: this.repo.toplevel,
			extraOverlays: this.repo.externalGitDir ? [this.repo.externalGitDir] : [],
			extraReadOnly: [...this.config.sandbox.extraReadOnly, ...this.readRoots()],
			env: this.config.sandbox.env,
			bwrapPath: this.config.sandbox.bwrapPath,
			allowlist: { makeTargets: this.config.sandbox.makeTargets, extraCommands: this.config.sandbox.extraCommands },
		};
	}
}
