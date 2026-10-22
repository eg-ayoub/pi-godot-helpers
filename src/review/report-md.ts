// review.md: the review as Markdown, written next to review.json every time.
import { countBySeverity } from "./aggregate.ts";
import type { ReviewRecord } from "./record.ts";
import type { ReviewComment } from "./types.ts";

function fence(text: string, lang = ""): string {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}${lang}\n${text}\n${ticks}`;
}

function commentMd(c: ReviewComment): string[] {
	const where = c.file ? `\`${c.file}${c.line !== null ? `:${c.line}${c.endLine && c.endLine !== c.line ? `-${c.endLine}` : ""}` : ""}\`` : "(project)";
	const lines = [`- **[${c.severity}] ${c.title || "(untitled)"}** ${where} · ${c.discipline}${c.alreadyRaised ? ` · raised before (${c.alreadyRaised.occurrences}x)` : ""}`];
	if (c.body) lines.push("", ...c.body.split("\n").map((l) => `  ${l}`));
	if (c.suggestion) lines.push("", "  Suggestion:", "", ...fence(c.suggestion).split("\n").map((l) => `  ${l}`));
	if (c.anchorAdjusted) lines.push("", `  _(${c.anchorAdjusted.reason})_`);
	lines.push("");
	return lines;
}

export function renderMarkdown(r: ReviewRecord): string {
	const counts = countBySeverity(r.comments);
	const out: string[] = [
		`# Review: ${r.target.description}`,
		"",
		`${r.createdAt} · ${r.repo.toplevel} · ${r.files.filter((f) => !f.skipped).length} file(s) reviewed · ${r.comments.length} finding(s): ${counts.critical} critical, ${counts.important} important, ${counts.minor} minor, ${counts.nit} nit${r.model ? ` · model ${r.model}` : ""}`,
		"",
	];
	if (r.status !== "complete") out.push(`**Status: ${r.status}**${r.error ? `: ${r.error}` : ""}`, "");
	if (r.warnings.length) out.push("## Warnings", "", ...r.warnings.map((w) => `- ${w}`), "");
	const summaries = r.workers.filter((w) => w.summary || w.error);
	if (summaries.length) {
		out.push("## Summary", "");
		for (const w of summaries) out.push(`- **${w.files.join(", ")}** (${w.skills.join(", ") || "no skills"}): ${w.summary ?? ""}${w.error ? ` _(worker error: ${w.error})_` : ""}`);
		out.push("");
	}
	out.push("## Findings", "");
	if (r.comments.length === 0) out.push("No findings.", "");
	const byFile = new Map<string, ReviewComment[]>();
	for (const c of r.comments) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
	for (const [file, comments] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		out.push(`### ${file || "Project-wide"}`, "");
		for (const c of comments.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) out.push(...commentMd(c));
	}
	if (r.checks.length) {
		out.push("## Checks", "", "| check | status | findings |", "|---|---|---|");
		for (const c of r.checks) out.push(`| ${c.name} | ${c.status}${c.reason ? ` (${c.reason.replace(/\|/g, "\\|")})` : ""} | ${c.findings.length} |`);
		if (r.checksNote) out.push("", `_${r.checksNote}_`);
		out.push("");
	}
	out.push("## Documentation", "");
	if (!r.docPass) out.push("The doc pass did not run.", "");
	else if (r.docPass.skipped) out.push(`Skipped: ${r.docPass.skipped}`, "");
	else {
		if (r.docPass.error) out.push(`Error: ${r.docPass.error}`, "");
		if (r.docPass.patches.length === 0) out.push("DESIGN.md and AGENTS.md were left unchanged.", "");
		for (const p of r.docPass.patches) out.push(`Changed ${p.file}:`, "", fence(p.patch, "diff"), "");
		if (r.docPass.finalText) out.push(`> ${r.docPass.finalText.replace(/\n/g, "\n> ")}`, "");
	}
	out.push("## Routing", "", "| part | files | skills | other skills offered |", "|---|---|---|---|");
	for (const u of r.routing.units) out.push(`| ${u.id} | ${u.files.join(", ")} | ${u.skills.join(", ")} | ${u.advertised.length} |`);
	out.push("", `Routing: ${r.routing.classifier ?? "rules only"}`, "");
	if (r.skills) out.push(`Skills: ${r.skills.tag ? `GodotPrompter ${r.skills.tag} (${r.skills.commit?.slice(0, 7)})` : r.skills.source}`, "");
	const skipped = r.files.filter((f) => f.skipped);
	if (skipped.length) out.push("## Not reviewed", "", ...skipped.map((f) => `- ${f.path}: ${f.skipped}`), "");
	const cost = r.workers.reduce((s, w) => s + w.usage.cost, 0);
	const tokens = r.workers.reduce((s, w) => s + w.usage.input + w.usage.output, 0);
	out.push("## Cost", "", `Workers: ${r.workers.length}, ${tokens} tokens${cost ? `, $${cost.toFixed(4)}` : ""}, ${(r.durationMs / 1000).toFixed(1)} s in total.`, "");
	return out.join("\n");
}
