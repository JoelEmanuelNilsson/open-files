import { type CacheUsage, promptTokens } from "../../lib/cache/cache-usage.ts";
import type { BlockPrint, Divergence, PriorPrint, ReasoningPrint, ToolPrint, WirePrint } from "./wire-print.ts";

const THINKING_TURN_MISS: ReadonlySet<string> = new Set(["claude-haiku-4-5"]);

const sameReasoning = (previous: ReasoningPrint, next: ReasoningPrint): boolean =>
	JSON.stringify(Object.entries(previous).sort()) === JSON.stringify(Object.entries(next).sort());

function reasoningMoves(previous: ReasoningPrint, next: ReasoningPrint): string {
	const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
	return keys
		.filter((key) => previous[key] !== next[key])
		.map((key) => `${key.slice(key.lastIndexOf(".") + 1)} ${previous[key] ?? "none"} → ${next[key] ?? "none"}`)
		.join(", ");
}

export type BreakVerdict = "reorder" | "edit" | "added" | "removed" | "reasoning" | "expired" | "thinking-turn" | "dropped" | "unknown" | "compaction" | "your edit" | "model switch";

/** Why the session already knows the transcript changed since the previous request. */
export type KnownCause = "compaction" | "your edit";

/** Whether a break is worth a warning: false when the session expects it or the provider caused it. */
export const breakIsFault = (verdict: BreakVerdict): boolean => verdict !== "expired" && verdict !== "dropped" && verdict !== "compaction" && verdict !== "your edit" && verdict !== "model switch";

function toolsVerdict(previous: readonly ToolPrint[], next: readonly ToolPrint[]): BreakVerdict {
	const before = previous.map((tool) => tool.name);
	const after = next.map((tool) => tool.name);
	if (before.some((name) => !after.includes(name))) return "removed";
	if (after.some((name) => !before.includes(name))) return "added";
	if (before.join("\u0000") !== after.join("\u0000")) return "reorder";
	return "edit";
}

interface PriorTurn {
	model: string;
	nextModel: string;
	thought: boolean;
}

/** The cause of a short read, from the two prints, the clock and the turn that wrote the prefix. */
export function verdictOf(previous: PriorPrint, next: WirePrint, divergence: Divergence | undefined, ttlExpired: boolean, turn: PriorTurn, cause?: KnownCause): BreakVerdict {
	if (divergence?.section === "tools" && previous.tools !== undefined) return toolsVerdict(previous.tools, next.tools);
	if (divergence !== undefined && divergence.section !== "messages") return divergence.kind === "changed" ? "edit" : divergence.kind;
	if (cause !== undefined) return cause;
	if (turn.model !== turn.nextModel) return "model switch";
	if (previous.reasoning !== undefined && !sameReasoning(previous.reasoning, next.reasoning)) return "reasoning";
	if (divergence !== undefined) return divergence.kind === "changed" ? "edit" : divergence.kind;
	if (ttlExpired) return "expired";
	if (previous.tools === undefined || previous.messages === undefined) return "unknown";
	if (turn.thought && THINKING_TURN_MISS.has(turn.model)) return "thinking-turn";
	return "dropped";
}

export const prefixRetired = (usage: CacheUsage, expected: number): boolean => promptTokens(usage) < expected;

export interface BreakReport {
	seq: number;
	expected: number;
	read: number;
	shortfall: number;
	sinceSec: number;
	ttlExpired: boolean;
	verdict: BreakVerdict;
	prompt: number;
	divergence?: Divergence;
	reasoning?: { previous: ReasoningPrint; next: ReasoningPrint };
	detail?: { previous: BlockPrint[] | ToolPrint[]; next: BlockPrint[] | ToolPrint[] };
	dump?: string;
}

/** One line for a human, for the notice and for `/trace`. The verdict leads; the prose is its tail. */
export function describeBreak(report: BreakReport): string {
	const cost = `${report.shortfall.toLocaleString()} tokens re-billed (read ${report.read.toLocaleString()} of ${report.expected.toLocaleString()})`;
	if (report.verdict === "expired")
		return `cache expired: nothing renewed it within its window (${report.sinceSec}s since the last request). Expected after an idle pause, not a fault; ${cost}`;
	if (report.verdict === "compaction") return `compaction: new prefix of ${report.prompt.toLocaleString()} tokens after compaction`;
	if (report.verdict === "model switch") return `model switch: a different model reads its own cache, so ${cost}`;
	if (report.verdict === "your edit") return `your edit: you changed the transcript, so ${cost}`;
	const where =
		report.verdict === "reasoning" && report.reasoning
			? `${reasoningMoves(report.reasoning.previous, report.reasoning.next)} rewrote the conversation tier`
			: report.divergence
				? `${report.divergence.section}[${report.divergence.index}] ${report.divergence.kind}`
				: report.verdict === "thinking-turn"
					? "the model missed the tier written by a turn it thought on — a known per-model quirk, not notified"
					: report.verdict === "dropped"
						? `nothing of ours changed in ${report.sinceSec}s — the provider dropped it`
						: `no cause after ${report.sinceSec}s — the ledger cannot compare every section`;
	return `cache break: ${report.verdict} — ${where}, ${cost}`;
}

/** The prefix a reload inherited: what the provider holds, and the roster it was written with. */
export interface Inherited {
	tools?: readonly ToolPrint[];
	toolsHash?: string;
	prefix: number;
}

function toolMoves(previous: readonly ToolPrint[], next: readonly ToolPrint[]): string[] {
	const before = new Map(previous.map((tool) => [tool.name, tool.hash]));
	const after = new Map(next.map((tool) => [tool.name, tool.hash]));
	const moves = [
		...next.filter((tool) => !before.has(tool.name)).map((tool) => `${tool.name} added`),
		...previous.filter((tool) => !after.has(tool.name)).map((tool) => `${tool.name} removed`),
		...next.filter((tool) => before.has(tool.name) && before.get(tool.name) !== tool.hash).map((tool) => `${tool.name} edited`),
	];
	const sameSet = previous.length === next.length && previous.every((tool) => after.has(tool.name));
	const names = (roster: readonly ToolPrint[]) => roster.map((tool) => tool.name).join("\u0000");
	if (sameSet && names(previous) !== names(next)) moves.push("the same tools in a new order");
	return moves;
}

/** The reload notice and how loud it is: new code loaded is "info"; a removal, a reorder or an unnamed move is a "warning". */
export interface RewriteNotice {
	text: string;
	severity: "info" | "warning";
}

export function rewriteNotice(inherited: Inherited, print: WirePrint): RewriteNotice | undefined {
	const cost = inherited.prefix > 0 ? ` ${inherited.prefix.toLocaleString()} tokens of cached prefix are being written again.` : "";
	if (inherited.tools === undefined) {
		if (inherited.toolsHash === undefined || inherited.toolsHash === print.toolsHash) return undefined;
		return { text: `reload rewrote the tools block; the ledger holds no roster for the prefix it inherited, so which tool changed cannot be named.${cost}`, severity: "warning" };
	}
	const moves = toolMoves(inherited.tools, print.tools);
	if (moves.length === 0) return undefined;
	const expected = moves.every((move) => move.endsWith(" added") || move.endsWith(" edited"));
	return { text: `reload rewrote the tools block: ${moves.join(", ")}.${cost}`, severity: expected ? "info" : "warning" };
}

/** The blocks on both sides of the one entry that moved. Types and sizes, never text. */
export function detailFor(previous: PriorPrint, next: WirePrint, divergence: Divergence): BreakReport["detail"] {
	const { section, index } = divergence;
	if (section === "tools") return { previous: (previous.tools ?? []).slice(index, index + 1), next: next.tools.slice(index, index + 1) };
	if (section === "system") return { previous: previous.system.slice(index, index + 1), next: next.system.slice(index, index + 1) };
	return { previous: previous.messages?.[index]?.blocks ?? [], next: next.messages[index]?.blocks ?? [] };
}
