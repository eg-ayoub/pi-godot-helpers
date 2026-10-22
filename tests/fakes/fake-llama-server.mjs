// A stand-in for llama-server with a decision model: GET /health and POST /v1/systemone (bool questions on
// the wire as "noul"). Probabilities come from FAKE_LLAMA_ANSWERS ({"<question id>": p}) and
// FAKE_LLAMA_KEYWORDS ({"<question id>": "<regex>"}: 0.9 when it matches the state; a choice option o weighs
// 10 instead of 1 when the regex of s_<o> matches). FAKE_LLAMA_MAX_OPTIONS refuses larger choice questions. Every start, request and
// stop is appended to FAKE_LLAMA_LOG as JSON lines. FAKE_LLAMA_FAIL_GPU makes a start with -ngl > 0 fail.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const record = (obj) => {
	if (process.env.FAKE_LLAMA_LOG) appendFileSync(process.env.FAKE_LLAMA_LOG, `${JSON.stringify({ ...obj, pid: process.pid })}\n`);
};

if (args.includes("--help")) {
	console.log("-lm,   --load-mode MODE                 model loading mode (default: auto)");
	process.exit(0);
}
record({ event: "start", args });
if (process.env.FAKE_LLAMA_FAIL_GPU && Number(arg("-ngl") ?? "0") > 0) {
	console.error("ggml_vulkan: Device memory allocation of size 3000000000 failed");
	process.exit(1);
}
const answers = JSON.parse(process.env.FAKE_LLAMA_ANSWERS ?? "{}");
const keywords = JSON.parse(process.env.FAKE_LLAMA_KEYWORDS ?? "{}");

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/health") return send(res, 200, { status: "ok" });
	if (req.method !== "POST" || req.url !== "/v1/systemone") return send(res, 404, { error: { message: "not found" } });
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		const request = JSON.parse(body);
		record({ event: "systemone", request });
		const questions = Object.entries(request.questions ?? {});
		const instructions = questions.map(([, q]) => q.instructions);
		// llama.cpp #30482: Kev answers 500 when two questions share their instructions
		if (new Set(instructions).size !== instructions.length) return send(res, 500, { error: { message: "duplicate instructions" } });
		const state = JSON.stringify(request.state);
		const out = {};
		for (const [id, q] of questions) {
			if (q.type === "choice") {
				// an option scores high when the keyword of its bool question id (s_<option>) matches the state
				const options = Object.keys(q.criteria ?? {});
				if (options.length > Number(process.env.FAKE_LLAMA_MAX_OPTIONS ?? "255")) return send(res, 400, { error: { message: "the question and its options are too large to process" } });
				const weight = (o) => {
					const k = keywords[`s_${o.replace(/[^A-Za-z0-9]+/g, "_")}`];
					return k && new RegExp(k).test(state) ? 10 : 1;
				};
				const total = options.reduce((n, o) => n + weight(o), 0);
				const probabilities = Object.fromEntries(options.map((o) => [o, weight(o) / total]));
				const choice = options.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a), options[0]);
				out[id] = { type: "choice", choice, probabilities, confidence: 0.5 };
				continue;
			}
			if (q.type !== "noul") return send(res, 400, { error: { message: `unsupported question type ${q.type}` } });
			let p = answers[id] ?? 0.05;
			if (keywords[id] && new RegExp(keywords[id]).test(state)) p = 0.9;
			out[id] = { type: "noul", noul: p };
		}
		send(res, 200, { answers: out, usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: questions.length } });
	});
});
server.listen(Number(arg("--port")), "127.0.0.1");
process.on("SIGTERM", () => {
	record({ event: "stop" });
	process.exit(0);
});
