import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../helpers/pi.ts";
import { ViewerServer } from "../../src/viewer/server.ts";

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method: "GET", headers }, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function reviewsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pgh-reviews-"));
	const id = "2026-10-22T10-00-00-000Z";
	mkdirSync(join(dir, id));
	writeFileSync(
		join(dir, id, "review.json"),
		JSON.stringify({
			version: 1,
			id,
			createdAt: "2026-10-22T10:00:00.000Z",
			target: { description: "HEAD against develop" },
			status: "complete",
			files: [],
			comments: [{ id: "c1", file: "a.gd", line: 1, side: "new", severity: "minor", discipline: "general", title: "<img src=x onerror=alert(1)>", body: "<script>alert(1)</script>" }],
			workers: [],
			checks: [],
			routing: { units: [], decisions: [] },
			warnings: [],
		}),
	);
	writeFileSync(join(dir, id, "review.md"), "# Review");
	return dir;
}

let server: ViewerServer | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
});

describe("review viewer server", () => {
	it("starts and stops idempotently on a random loopback port", async () => {
		server = new ViewerServer(reviewsDir());
		await server.start();
		await server.start();
		expect(server.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
		await server.stop();
		await server.stop();
		expect(server.running).toBe(false);
	});

	it("requires the token, then a cookie; sends strict security headers", async () => {
		server = new ViewerServer(reviewsDir());
		await server.start();
		const url = new URL(server.url());
		const base = `${url.origin}`;
		expect((await get(`${base}/`)).status).toBe(403);
		expect((await get(`${base}/api/reviews`)).status).toBe(403);
		expect((await get(`${base}/?t=wrong`)).status).toBe(403);
		const page = await get(server.url());
		expect(page.status).toBe(200);
		expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
		expect(String(page.headers["content-security-policy"])).toContain("default-src 'none'");
		expect(page.headers["x-content-type-options"]).toBe("nosniff");
		const cookie = String(page.headers["set-cookie"]).split(";")[0];
		const list = await get(`${base}/api/reviews`, { cookie });
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)[0]).toMatchObject({ description: "HEAD against develop", findings: 1 });
		const review = await get(`${base}/api/review/2026-10-22T10-00-00-000Z`, { cookie });
		expect(JSON.parse(review.body).comments[0].title).toBe("<img src=x onerror=alert(1)>");
		expect((await get(`${base}/api/review/2026-10-22T10-00-00-000Z/md`, { cookie })).headers["content-disposition"]).toContain("attachment");
	});

	it("embeds the review as an inert JSON block that review text cannot break out of", async () => {
		server = new ViewerServer(reviewsDir());
		await server.start();
		const page = await get(server.url("2026-10-22T10-00-00-000Z"));
		expect(page.body).toContain('<script id="review-data" type="application/json">');
		expect(page.body).toContain("\\u003cimg src=x onerror=alert(1)>");
		expect(page.body).toContain("\\u003cscript>alert(1)\\u003c/script>");
		expect(page.body).not.toContain("<img src=x");
		expect(page.body).not.toContain("<script>alert(1)");
	});

	it("rejects other Host headers (DNS rebinding) and path tricks", async () => {
		server = new ViewerServer(reviewsDir());
		await server.start();
		const url = new URL(server.url());
		expect((await get(server.url(), { host: `evil.example:${url.port}` })).status).toBe(403);
		expect((await get(`${url.origin}/api/review/..%2F..%2Fetc?t=${url.searchParams.get("t")}`)).status).toBe(404);
		expect((await get(`${url.origin}/api/review/../../x?t=${url.searchParams.get("t")}`)).status).toBe(404);
	});
});

describe("viewer page script", () => {
	it("never builds HTML from strings (review text is untrusted)", () => {
		const js = readFileSync(join(ROOT, "assets/viewer/viewer.js"), "utf8");
		for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) expect(js).not.toContain(sink);
		const html = readFileSync(join(ROOT, "assets/viewer/index.html"), "utf8");
		expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
		expect(html).not.toMatch(/\son\w+=/);
	});
});
