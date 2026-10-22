// A local page that shows reviews like a pull request: files, hunks, and comments under their lines.
// Loopback only, random port, a per-session token (cookie after the first visit), a Host check against DNS
// rebinding, a strict Content-Security-Policy, and no inline script: review text is rendered as text.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../runtime.ts";

const ASSETS = join(PACKAGE_ROOT, "assets", "viewer");
const ID = /^[0-9A-Za-z-]+$/;

const SECURITY_HEADERS: Record<string, string> = {
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
	"cross-origin-opener-policy": "same-origin",
	"cross-origin-resource-policy": "same-origin",
};

export interface ReviewListEntry {
	id: string;
	description: string;
	createdAt: string;
	findings: number;
	status: string;
	kind: "review" | "verify";
	/** Verifications: the review they check, and how many of its findings are not fixed. */
	verifies?: string;
	open?: number;
}

export class ViewerServer {
	private server?: Server;
	private port = 0;
	private readonly token = randomBytes(24).toString("hex");

	private reviewsDir: string;

	constructor(reviewsDir: string) {
		this.reviewsDir = reviewsDir;
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	setReviewsDir(dir: string): void {
		this.reviewsDir = dir;
	}

	url(id?: string): string {
		return `http://127.0.0.1:${this.port}/${id ? `?review=${encodeURIComponent(id)}&` : "?"}t=${this.token}`;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		server.unref();
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private authorized(req: IncomingMessage, url: URL): boolean {
		const provided = url.searchParams.get("t") ?? /(?:^|;\s*)pgh=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
		const a = Buffer.from(provided);
		const b = Buffer.from(this.token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
		res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...extra });
		res.end(body);
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.send(res, 403, "bad host", "text/plain");
		if (req.method !== "GET") return this.send(res, 405, "method not allowed", "text/plain");
		let url: URL;
		try {
			url = new URL(req.url ?? "/", `http://${host}`);
		} catch {
			return this.send(res, 400, "bad request", "text/plain");
		}
		if (!this.authorized(req, url)) return this.send(res, 403, "forbidden", "text/plain");
		const cookie = { "set-cookie": `pgh=${this.token}; HttpOnly; SameSite=Strict; Path=/` };
		switch (url.pathname) {
			case "/":
				return this.send(res, 200, this.page(url.searchParams.get("review")), "text/html; charset=utf-8", cookie);
			case "/viewer.js":
				return this.send(res, 200, readFileSync(join(ASSETS, "viewer.js")), "text/javascript; charset=utf-8");
			case "/viewer.css":
				return this.send(res, 200, readFileSync(join(ASSETS, "viewer.css")), "text/css; charset=utf-8");
			case "/api/reviews":
				return this.send(res, 200, JSON.stringify(this.list()), "application/json");
		}
		const m = /^\/api\/review\/([^/]+)(\/md)?$/.exec(url.pathname);
		if (m && ID.test(m[1])) {
			const dir = join(this.reviewsDir, m[1]);
			const file = join(dir, m[2] ? "review.md" : "review.json");
			if (!existsSync(file)) return this.send(res, 404, "no such review", "text/plain");
			return m[2]
				? this.send(res, 200, readFileSync(file), "text/markdown; charset=utf-8", { "content-disposition": `attachment; filename="review-${m[1]}.md"` })
				: this.send(res, 200, readFileSync(file), "application/json");
		}
		return this.send(res, 404, "not found", "text/plain");
	}

	/**
	 * The page with the review and the list embedded as inert JSON data blocks, so it renders without a round
	 * trip. `<` is escaped, so no review text can close the block; data blocks never execute, so the CSP holds.
	 */
	page(requested: string | null): string {
		const html = readFileSync(join(ASSETS, "index.html"), "utf8");
		const list = this.list();
		const id = requested && ID.test(requested) ? requested : list[0]?.id;
		const file = id ? join(this.reviewsDir, id, "review.json") : undefined;
		const review = file && existsSync(file) ? readFileSync(file, "utf8") : "null";
		const LS = String.fromCharCode(0x2028);
		const PS = String.fromCharCode(0x2029);
		const safe = (json: string) => json.replace(/</g, "\\u003c").split(LS).join("\\u2028").split(PS).join("\\u2029");
		const blocks = `<script id="review-data" type="application/json">${safe(review)}</script>\n<script id="review-list" type="application/json">${safe(JSON.stringify(list))}</script>\n`;
		return html.replace("</body>", `${blocks}</body>`);
	}

	/** Past reviews, newest first. */
	list(): ReviewListEntry[] {
		if (!existsSync(this.reviewsDir)) return [];
		const out: ReviewListEntry[] = [];
		for (const id of readdirSync(this.reviewsDir)) {
			const file = join(this.reviewsDir, id, "review.json");
			if (!ID.test(id) || !existsSync(file)) continue;
			try {
				const r = JSON.parse(readFileSync(file, "utf8")) as {
					target?: { description?: string };
					createdAt?: string;
					comments?: { verdict?: { status?: string } }[];
					status?: string;
					kind?: string;
					verifies?: { id?: string };
				};
				const entry: ReviewListEntry = { id, description: r.target?.description ?? id, createdAt: r.createdAt ?? statSync(file).mtime.toISOString(), findings: r.comments?.length ?? 0, status: r.status ?? "?", kind: r.kind === "verify" ? "verify" : "review" };
				if (entry.kind === "verify") {
					entry.verifies = r.verifies?.id;
					entry.open = (r.comments ?? []).filter((c) => c.verdict?.status !== "fixed").length;
				}
				out.push(entry);
			} catch {
				// a review being written
			}
		}
		return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}
}

/** Open a URL in the user's browser; failures are ignored (the URL is also printed). */
export function openInBrowser(url: string, command?: string): void {
	const cmd = command ?? (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
	try {
		const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// no browser opener
	}
}
