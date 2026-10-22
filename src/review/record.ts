// The saved form of one review (review.json), shared by the Markdown report, the viewer and memory.
import type { CheckResult, FileDiff, ResolvedTarget, ReviewComment, RouteDecision, RoutedUnit } from "./types.ts";

export interface WorkerSummary {
	unitId: string;
	files: string[];
	skills: string[];
	summary?: string;
	error?: string;
	comments: number;
	usage: { input: number; output: number; cost: number };
}

export interface ReviewRecord {
	version: 1;
	id: string;
	createdAt: string;
	durationMs: number;
	repo: { toplevel: string; id: string };
	target: { label: string; description: string; resolved: ResolvedTarget };
	model?: string;
	files: FileDiff[];
	comments: ReviewComment[];
	checks: CheckResult[];
	checksNote?: string;
	routing: { decisions: RouteDecision[]; units: RoutedUnit[]; classifier?: string };
	/** The skills the review used: a GodotPrompter tag, or the configured folder. */
	skills?: { source: string; tag?: string; commit?: string };
	workers: WorkerSummary[];
	docPass?: { patches: { file: string; patch: string }[]; finalText?: string; error?: string; skipped?: string };
	warnings: string[];
	status: "complete" | "cancelled" | "failed";
	error?: string;
}
