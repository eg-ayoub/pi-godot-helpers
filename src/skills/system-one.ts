// A client for llama.cpp's System One endpoint (POST <baseUrl>/systemone), given to pi through
// registerProvider({ classifiers }) so routing still goes through ctx.modelRegistry.classify(). pi 1.3.0 has
// the same client built in but does not export it to extensions; this one speaks the same wire format
// (public `bool` questions travel as `noul`).
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

type ProviderClassifier = NonNullable<ProviderConfig["classifiers"]>[keyof NonNullable<ProviderConfig["classifiers"]>];
type ClassifyArgs = Parameters<NonNullable<ProviderClassifier>["classify"]>;
type ClassifierResult = Awaited<ReturnType<NonNullable<ProviderClassifier>["classify"]>>;
type Answer = ClassifierResult["answers"][string];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown, what: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`System One returned no ${what}`);
	return v;
}

function parseAnswer(id: string, type: string, a: unknown): Answer {
	if (!isRecord(a)) throw new Error(`System One did not answer ${id}`);
	if (type === "bool") {
		if (a.type !== "noul") throw new Error(`System One did not return a bool answer for ${id}`);
		return { type: "bool", probability: num(a.noul, `probability for ${id}`) };
	}
	if (type === "score") {
		if (a.type !== "score") throw new Error(`System One did not return a score answer for ${id}`);
		return { type: "score", score: num(a.score, `score for ${id}`), confidence: num(a.confidence, `confidence for ${id}`) };
	}
	if (a.type !== "choice" || typeof a.choice !== "string" || !isRecord(a.probabilities)) throw new Error(`System One did not return a choice answer for ${id}`);
	const probabilities = Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [k, num(p, `probability for ${id}.${k}`)]));
	return { type: "choice", choice: a.choice, probabilities, confidence: num(a.confidence, `confidence for ${id}`) };
}

export const systemOneClassifier: NonNullable<ProviderClassifier> = {
	async classify(...[model, context, options]: ClassifyArgs): Promise<ClassifierResult> {
		const result: ClassifierResult = { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "stop", timestamp: Date.now() };
		try {
			if (context.images?.length) throw new Error("the local decision model takes no images");
			const questions = Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, q.type === "bool" ? { ...q, type: "noul" } : q]));
			const res = await (options?.fetch ?? fetch)(new URL("systemone", `${model.baseUrl.replace(/\/+$/, "")}/`), {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${options?.apiKey ?? "local"}` },
				body: JSON.stringify({ model: model.id, state: context.state, questions }),
				signal: options?.signal,
			});
			const text = await res.text();
			if (!res.ok) throw new Error(`System One answered ${res.status}: ${text.slice(0, 500)}`);
			const body = JSON.parse(text) as unknown;
			if (!isRecord(body) || !isRecord(body.answers)) throw new Error("System One returned an unexpected response");
			const answers = body.answers;
			result.answers = Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, parseAnswer(id, q.type, answers[id])]));
			if (isRecord(body.usage)) {
				const input = typeof body.usage.input_tokens === "number" ? body.usage.input_tokens : 0;
				const output = typeof body.usage.output_tokens === "number" ? body.usage.output_tokens : 0;
				result.usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			}
		} catch (e) {
			result.stopReason = options?.signal?.aborted ? "aborted" : "error";
			result.errorMessage = (e as Error).message;
		}
		return result;
	},
};
