// Text reports (status, review summaries) shown in the session but never sent to the model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

export const REPORT_ENTRY = "godot-helpers-report";

export interface ReportData {
	title: string;
	lines: string[];
}

export function registerReportRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ReportData>(REPORT_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "godot-helpers", lines: [] };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", data.title), 0, 0));
		const lines = expanded || data.lines.length <= 25 ? data.lines : [...data.lines.slice(0, 25), theme.fg("dim", `… ${data.lines.length - 25} more (expand to see all)`)];
		for (const line of lines) box.addChild(new Text(line, 0, 0));
		return box;
	});
}

/** Show a report in the TUI; in print/json/rpc modes write it to stderr so it is not lost. */
export function showReport(pi: ExtensionAPI, hasUI: boolean, title: string, lines: string[]): void {
	pi.appendEntry<ReportData>(REPORT_ENTRY, { title, lines });
	if (!hasUI) process.stderr.write(`${title}\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
}
