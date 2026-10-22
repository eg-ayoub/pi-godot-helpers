// Per-session state shared by every part of the extension: the repository, the config, the mode.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, repoDataDir, type Config } from "./config.ts";
import { detectRepo, isGodotRepo, type RepoInfo } from "./repo.ts";
import type { GateContext, Mode } from "./security/gate.ts";
import type { SandboxOptions } from "./security/sandbox.ts";
import { ModeState } from "./state.ts";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENDORED_SKILLS = join(PACKAGE_ROOT, "vendor", "GodotPrompter", "skills");

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

	skillsRoot(): string {
		return this.config.skills.path ?? VENDORED_SKILLS;
	}

	readRoots(): string[] {
		const roots = [this.skillsRoot(), ...this.config.skills.extraPaths, ...this.config.readRoots];
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
