import path from "node:path";
import { checkoutLayout } from "../git/checkout-layout.ts";

export const REPLY_IDS = ["R1", "R2", "R3", "R4", "R5"] as const;
export type ReplyId = (typeof REPLY_IDS)[number];

interface ReplyFormat {
	readonly kind: string;
	readonly cap: number;
	readonly keys: readonly string[];
	readonly text: string;
}

export const REPLY_FORMATS: Readonly<Record<ReplyId, ReplyFormat>> = {
	R1: {
		kind: "you made or landed a change",
		cap: 600,
		keys: ["done", "sha", "files", "verified"],
		text: "done: <one line: what is now true>\nsha: <main SHA, only after the repo's land status command confirms it | queued <branch> <sha> | branch + SHA | none: why>\nfiles: <paths, one line>\nverified: green: <command> | <n> red: <why> | not run: <why>\nopen: <one line, only when unresolved>",
	},
	R2: {
		kind: "read-only answer to a question",
		cap: 1200,
		keys: ["answer", "confidence"],
		text: "answer: <1-3 lines>\nhits: <path:line  matching line>, one per line, at most 10, grouped by file (URL + quoted sentence for web)\nconfidence: looked up | inferred | guess, <one clause why>",
	},
	R3: {
		kind: "measured against a rule written before the run",
		cap: 800,
		keys: ["rule", "verdict", "numbers", "command", "detail"],
		text: "rule: <the pre-written decision rule, one line>\nverdict: holds | fails | inconclusive, <one clause>\nnumbers: <at most 6 key=value with units and n>\ncommand: <exact command or job id, at SHA>\nopen: <one line, only when unresolved>\ndetail: <path> \u2014 <raw rows and logs>",
	},
	R4: {
		kind: "review or audit findings",
		cap: 1500,
		keys: ["scope", "count", "findings"],
		text: "scope: <diff, range or paths reviewed, one line>\ncount: <n> proven, <m> judgement calls\nfindings: <path:line  severity  one-line claim  (evidence: proven by <command|path:line> | inferred)>, one per line, at most 8, most severe first; never restate what the change does",
	},
	R5: {
		kind: "you produced a document, design or inventory",
		cap: 600,
		keys: ["file", "summary", "decide"],
		text: "file: <absolute path of the deliverable; the path the brief names, else the detail directory>\nsummary: <at most 3 lines: what it concludes>\ndecide: <each decision the parent or Joel must make, one line each, or none>\nopen: <one line, only when unresolved>",
	},
};

/** The format text injected into a child's context, naming where cut material goes. */
export function renderReplyRule(detailDir: string, override: ReplyId | undefined): string {
	const choose =
		override !== undefined
			? `Reply in ${override} (${REPLY_FORMATS[override].kind}).`
			: `Choose by job kind: ${REPLY_IDS.map((id) => `${id} ${REPLY_FORMATS[id].kind}`).join("; ")}.`;
	const formats = REPLY_IDS.filter((id) => override === undefined || id === override).map((id) => `${id} (cap ${REPLY_FORMATS[id].cap} chars)\n${REPLY_FORMATS[id].text}`);
	return [
		`${choose} The first line of your reply is the format ID alone. Then its fields in order, each starting its own line, nothing else. The cap counts the whole reply. Move what does not fit to files in ${detailDir} and add \`detail: <path> \u2014 <what is in it>\`. Every claim carries a SHA, path:line, command or file; otherwise write \`inferred\` or \`guess\`.`,
		...formats,
	].join("\n");
}

/** What is wrong with a reply, or undefined when it keeps the chosen format's cap and keys. */
export function replyProblem(reply: string, override: ReplyId | undefined, detailDir: string): string | undefined {
	const text = reply.trim();
	const first = text.split("\n", 1)[0]?.trim() ?? "";
	const id = REPLY_IDS.find((candidate) => candidate === first);
	if (id === undefined || (override !== undefined && id !== override)) {
		return `the first line must be the format ID alone${override !== undefined ? ` (${override})` : ""}: ${REPLY_IDS.join(", ")}`;
	}
	const format = REPLY_FORMATS[id];
	const missing = format.keys.filter((key) => !new RegExp(`^${key}:`, "m").test(text));
	const parts: string[] = [];
	if (text.length > format.cap) parts.push(`reply is ${text.length} chars, cap ${format.cap}: move detail to ${detailDir} and name it in \`detail:\``);
	if (missing.length > 0) parts.push(`missing ${missing.map((key) => `\`${key}:\``).join(", ")}`);
	return parts.length > 0 ? `${parts.join("; ")}. Reply again in ${id}, once.` : undefined;
}

/** `reply: 'R3'` in a workflow `agent()`: the reply's fields as a schema, so a program and an agent share one definition. */
export function replySchema(id: ReplyId) {
	const keys = REPLY_FORMATS[id].keys;
	return { type: "object", properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])), required: [...keys], additionalProperties: true } as const;
}

/** `<main checkout>/.scratch/<run>/<agent>/`, absolute: it survives the removal of an agent's worktree. Nothing is created; the agent's first write makes it. */
export function replyDetailPath(cwd: string, run: string, agent: string): string {
	return path.join(checkoutLayout(cwd)?.mainRoot ?? cwd, ".scratch", run, agent);
}
