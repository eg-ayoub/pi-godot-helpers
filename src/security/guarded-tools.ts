// pi's bash, edit and write tools, guarded in Godot repositories: bash runs through the allowlist and the
// sandbox; edit and write re-check the target at write time (the tool_call gate checked it before the call).
// Outside Godot repositories they behave exactly like pi's own tools.
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditOperations, ExtensionAPI, WriteOperations } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { docForPath } from "./gate.ts";
import { createSandboxedBashOps } from "./sandbox.ts";

export class WriteRefused extends Error {}

/** Throws unless `absPath` is one of the docs and the mode allows doc edits. */
export function assertDocWrite(rt: Runtime, absPath: string): void {
	const gate = rt.gateContext();
	if (!gate.docsEditableIn.includes(gate.mode)) throw new WriteRefused(`writing files is not allowed in mode ${gate.mode}`);
	if (!docForPath(absPath, gate)) throw new WriteRefused(`only ${gate.docs.join(" and ")} at the repository root may be written (not ${absPath})`);
}

export function registerGuardedTools(pi: ExtensionAPI, rt: Runtime): void {
	const baseBash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...baseBash,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!rt.active) return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const def = createBashToolDefinition(ctx.cwd, {
				operations: createSandboxedBashOps(rt.sandboxOptions()),
				exposeSessionEnvironment: false,
			});
			const timeout = params.timeout ?? rt.config.sandbox.timeoutSeconds;
			return def.execute(id, { ...params, timeout }, signal, onUpdate, ctx);
		},
	});

	const baseEdit = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...baseEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!rt.active) return createEditToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const ops: EditOperations = {
				readFile: (p) => readFile(p),
				access: (p) => access(p, constants.R_OK | constants.W_OK),
				writeFile: async (p, content) => {
					assertDocWrite(rt, p);
					await writeFile(p, content, "utf8");
				},
			};
			return createEditToolDefinition(ctx.cwd, { operations: ops }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	const baseWrite = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...baseWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!rt.active) return createWriteToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			const ops: WriteOperations = {
				writeFile: async (p, content) => {
					assertDocWrite(rt, p);
					await writeFile(p, content, { encoding: "utf8", flag: "wx" });
				},
				mkdir: async (dir) => {
					// docs live at the toplevel, which exists: never create directories
					const root = rt.repo?.toplevel;
					if (!root || join(dir) !== root) throw new WriteRefused("creating directories is not allowed");
				},
			};
			return createWriteToolDefinition(ctx.cwd, { operations: ops }).execute(id, params, signal, onUpdate, ctx);
		},
	});
}
