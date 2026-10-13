const NOTICE = /\n\n\[[^\]]*\]\s*$/;

export type Summary =
	| {
			kind: "count";
			lead: string;
			count: number;
			unit: string;
			units: string;
			partial: boolean;
	  }
	| {
			kind: "note";
			text: string;
			tone: "muted" | "warning";
	  };

export function stripNotice(text: string): string {
	return text.replace(NOTICE, "");
}

function lines(text: string): string[] {
	const body = stripNotice(text).trim();
	return body ? body.split("\n") : [];
}

function counted(lead: string, count: number, unit: string, units: string, partial: boolean): Summary {
	return { kind: "count", lead, count, unit, units, partial };
}

export function summarizeToolResult(
	tool: string,
	text: string,
	args: Record<string, unknown>,
	truncated: boolean,
): Summary | null {
	switch (tool) {
		case "read":
			return counted("Read", lines(text).length, "line", "lines", truncated);
		case "write": {
			const content = typeof args.content === "string" ? args.content : undefined;
			if (content === undefined) return null;
			const written = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
			return counted("Wrote", written, "line", "lines", false);
		}
		default:
			return null;
	}
}

/** `Read 412 lines`, `Found 1 match`, `No matches`. The plain spelling, for tests. */
export function summaryText(summary: Summary): string {
	if (summary.kind === "note") return summary.text;
	const unit = summary.count === 1 ? summary.unit : summary.units;
	return `${summary.lead} ${summary.count}${summary.partial ? "+" : ""} ${unit}`;
}

/** `2.4 MB`. Used for an image, whose only honest measure is how big it was. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const DURATION_FLOOR_MS = 500;

export function formatCallDuration(ms: number): string | null {
	if (!Number.isFinite(ms) || ms < DURATION_FLOOR_MS) return null;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}
