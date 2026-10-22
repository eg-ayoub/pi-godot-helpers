// A scripted OpenAI-compatible chat server for driving a real pi process in tests.
// pi's `openai-completions` client streams SSE chunks and needs a finish_reason; tool calls arrive as
// `delta.tool_calls` (node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	tools?: { type: string; function: { name: string; description?: string; parameters?: unknown } }[];
	stream?: boolean;
	[key: string]: unknown;
}

export interface ScriptedTurn {
	text?: string;
	toolCalls?: { name: string; arguments: Record<string, unknown> }[];
}

/** Decides the next answer from the request; `index` counts chat requests from 0. */
export type Responder = (request: ChatRequest, index: number) => ScriptedTurn;

export interface MockServer {
	url: string;
	requests: ChatRequest[];
	close(): Promise<void>;
}

/** The text of a message whatever its shape (string, or a list of {type:"text", text} parts). */
export function messageText(message: ChatMessage | undefined): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

/** The system prompt pi sent (first system or developer message). */
export function systemPrompt(request: ChatRequest): string {
	return messageText(request.messages.find((m) => m.role === "system" || m.role === "developer"));
}

export function toolNames(request: ChatRequest): string[] {
	return (request.tools ?? []).map((t) => t.function.name);
}

/** Tool results pi sent back, newest last. */
export function toolResults(request: ChatRequest): { id: string; text: string }[] {
	return request.messages.filter((m) => m.role === "tool").map((m) => ({ id: String(m.tool_call_id), text: messageText(m) }));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sse(res: ServerResponse, data: unknown): void {
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function startMockOpenAI(responder: Responder): Promise<MockServer> {
	const requests: ChatRequest[] = [];
	let callCounter = 0;
	const server = createServer(async (req, res) => {
		try {
			const path = (req.url ?? "").split("?")[0];
			if (req.method === "GET" && path.endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
				return;
			}
			if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
				res.writeHead(404);
				res.end();
				return;
			}
			const request = JSON.parse(await readBody(req)) as ChatRequest;
			const index = requests.length;
			requests.push(request);
			const turn = responder(request, index);
			const id = `chatcmpl-${index}`;
			const base = { id, object: "chat.completion.chunk", created: 0, model: request.model };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			if (turn.text) {
				sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] });
			}
			const calls = turn.toolCalls ?? [];
			calls.forEach((call, i) => {
				callCounter += 1;
				sse(res, {
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: i,
										id: `call_${callCounter}`,
										type: "function",
										function: { name: call.name, arguments: JSON.stringify(call.arguments) },
									},
								],
							},
							finish_reason: null,
						},
					],
				});
			});
			sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }] });
			sse(res, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			res.write("data: [DONE]\n\n");
			res.end();
		} catch (error) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** models.json content that points a pi provider named "mock" at the server. */
export function mockModelsJson(url: string, contextWindow = 65536): string {
	return JSON.stringify(
		{
			providers: {
				mock: {
					baseUrl: `${url}/v1`,
					api: "openai-completions",
					apiKey: "test",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [
						{
							id: "mock-model",
							name: "Mock model",
							reasoning: false,
							input: ["text"],
							contextWindow,
							maxTokens: 4096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		},
		null,
		2,
	);
}
