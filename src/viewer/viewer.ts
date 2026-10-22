// The review viewer's lifecycle: started on demand after a review or by /review-open, one per session,
// stopped when the session shuts down (also on /reload, /new, /resume and /fork).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewController } from "../review/pipeline.ts";
import type { Runtime } from "../runtime.ts";
import { openInBrowser, ViewerServer } from "./server.ts";

export function registerViewer(pi: ExtensionAPI, rt: Runtime, controller: ReviewController): void {
	let viewer: ViewerServer | undefined;

	const reviewsDir = () => join(rt.repoDataDir() as string, "reviews");

	async function ensure(): Promise<ViewerServer> {
		if (!viewer) viewer = new ViewerServer(reviewsDir());
		viewer.setReviewsDir(reviewsDir());
		await viewer.start();
		return viewer;
	}

	controller.hooks.present = async (record, dir, ctx: ExtensionContext, open) => {
		// print and json modes exit right after the command; a server would die with them
		if (ctx.mode === "print" || ctx.mode === "json") return undefined;
		const v = await ensure();
		const url = v.url(record.id);
		writeFileSync(join(dir, "viewer.json"), JSON.stringify({ url }));
		if (open && rt.config.viewer.open && ctx.hasUI && ctx.mode === "tui") openInBrowser(url, rt.config.viewer.browserCommand);
		return url;
	};

	pi.registerCommand("review-open", {
		description: "Open the review viewer (latest review, or /review-open <id>)",
		handler: async (args, ctx) => {
			await rt.refresh(ctx);
			if (!rt.active || !rt.repo) {
				ctx.ui.notify("/review-open works inside a Godot project.", "warning");
				return;
			}
			const v = await ensure();
			const list = v.list();
			const id = args.trim() || list[0]?.id;
			if (!id) {
				ctx.ui.notify("There are no reviews for this repository yet.", "info");
				return;
			}
			if (!list.some((r) => r.id === id)) {
				ctx.ui.notify(`No review ${id}. Known: ${list.slice(0, 5).map((r) => r.id).join(", ")}`, "warning");
				return;
			}
			const url = v.url(id);
			if (ctx.mode === "tui") openInBrowser(url, rt.config.viewer.browserCommand);
			ctx.ui.notify(`Review viewer: ${url}`, "info");
			if (!ctx.hasUI) process.stderr.write(`Review viewer: ${url}\n`);
		},
	});

	pi.on("session_shutdown", async () => {
		const v = viewer;
		viewer = undefined;
		await v?.stop();
	});
}
