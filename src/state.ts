// The extension's mode, kept in memory and in the session branch (a custom entry the model never sees), so
// /resume, /fork and /reload come back in the same mode.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Mode } from "./security/gate.ts";

export const STATE_ENTRY = "godot-helpers-state";

export interface PersistedState {
	mode: Mode;
	/** Tools that were active before advisor mode switched them, restored when it ends. */
	previousTools?: string[];
}

export class ModeState {
	mode: Mode = "off";
	previousTools?: string[];

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	set(mode: Mode, persist = true): void {
		this.mode = mode;
		if (persist && mode !== "worker") this.pi.appendEntry<PersistedState>(STATE_ENTRY, { mode, previousTools: this.previousTools });
	}

	/** The last persisted state on the current branch. Transient modes (review, review-docs) come back as off. */
	restore(ctx: ExtensionContext): void {
		let found: PersistedState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) found = entry.data as PersistedState;
		}
		const mode = found?.mode;
		this.mode = mode === "advisor" ? "advisor" : "off";
		this.previousTools = found?.previousTools;
	}
}
