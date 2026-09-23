#!/usr/bin/env node
/**
 * Recall a previous pi session: list its user messages, grep it, show one entry.
 *
 *   pi-recall <session.jsonl> list                every user message, numbered, one line each
 *   pi-recall <session.jsonl> grep <regex> [--limit N]   entries whose text matches, numbered, with a snippet
 *   pi-recall <session.jsonl> show <n> [--max N]  entry n whole (first N chars, default 16000)
 *   pi-recall <session.jsonl> seat               the model and level it ran on, and what a handoff carried
 *
 * A handoff continues in a new session whose first message is the document
 * the model wrote itself (map C23). The document carries intent; the exact
 * error string, the file as it was read, the user's precise wording — those
 * stay in the old session file, which the first message names. This is the
 * way back: list to orient, grep to find, show to read.
 *
 * Plain node, no dependencies, so it runs from the bash tool as-is. Only the
 * branch the old context was on is read (the last entry back to the root),
 * and only entries that were ever in the model's context: messages, custom
 * messages, compaction and branch summaries. Extension bookkeeping (`custom`
 * entries) is not conversation and is skipped. Numbers are positions on that
 * branch, so `grep` and `list` name the same `show` target.
 *
 * The regex is the model's and runs unguarded; a catastrophic one hangs until
 * the bash tool's deadline, which is the bound. `show` is capped because a
 * tool result can be a megabyte and the model asked for one entry, not the
 * whole file back.
 */

import { readFileSync } from "node:fs";

const USAGE = `usage:
  pi-recall <session.jsonl> list
  pi-recall <session.jsonl> grep <regex> [--limit N]   (the regex is always case-insensitive)
  pi-recall <session.jsonl> show <n> [--max N]
  pi-recall <session.jsonl> seat`;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 16_000;
/** Characters shown either side of the first match. */
const SNIPPET_RADIUS = 120;
/** Characters of a user message shown by `list`. */
const LIST_LINE_CHARS = 160;

/**
 * The text of a content block list, or a plain string, as one string.
 * Images become a marker so a match in the surrounding text still surfaces.
 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			switch (block.type) {
				case "text": return block.text ?? "";
				case "thinking": return `[thinking] ${block.thinking ?? ""}`;
				case "toolCall": return `${block.name}(${JSON.stringify(block.arguments ?? {})})`;
				case "image": return "[image]";
				default: return "";
			}
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

/**
 * One searchable record per context-bearing entry: `undefined` for the rest.
 * The label is what the model will quote back — role, tool if any.
 */
function recordOf(entry) {
	if (!entry || typeof entry !== "object" || typeof entry.id !== "string") return undefined;
	switch (entry.type) {
		case "message": {
			const m = entry.message;
			if (!m || typeof m.role !== "string") return undefined;
			const tool = m.role === "toolResult" && typeof m.toolName === "string" ? ` ${m.toolName}` : "";
			return { id: entry.id, role: m.role, label: `${m.role}${tool}`, time: entry.timestamp, text: contentText(m.content) };
		}
		case "custom_message":
			return { id: entry.id, role: "custom", label: `custom ${entry.customType ?? ""}`.trim(), time: entry.timestamp, text: contentText(entry.content) };
		case "compaction":
		case "branch_summary":
			return { id: entry.id, role: entry.type, label: entry.type === "compaction" ? "compaction" : "branch summary", time: entry.timestamp, text: entry.summary ?? "" };
		default:
			return undefined;
	}
}

/**
 * The branch the session ended on: from the last entry back to the root
 * along `parentId`, in file order. Entries off that path are abandoned
 * branches the model did not see at the end. Each record is numbered by its
 * position on the branch, from 1.
 */
function loadBranchRecords(file) {
	const byId = new Map();
	let last;
	for (const entry of loadEntries(file)) {
		if (typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
		last = entry;
	}
	const branch = [];
	for (let entry = last; entry !== undefined; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry);
	branch.reverse();
	const records = [];
	for (const entry of branch) {
		const record = recordOf(entry);
		if (record) records.push({ ...record, n: records.length + 1 });
	}
	return records;
}

/** Every parsable entry of the file, in file order. */
function loadEntries(file) {
	const entries = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry && typeof entry === "object") entries.push(entry);
	}
	return entries;
}

/** A seat as `extensions/continue-session.ts` records it: `provider/id at level`. */
function seatLine(seat) {
	return `${seat?.model ?? "an unknown model"} at ${seat?.thinking ?? "an unknown level"}`;
}

/**
 * What this session ran on, in file order: every model and thinking-level
 * change pi wrote, and the seat each side of a handoff recorded. A handoff
 * continues as the same seat (map C18); this is where that is checked.
 */
function seat(file) {
	const lines = [];
	for (const entry of loadEntries(file)) {
		if (entry.type === "model_change") lines.push(`model ${entry.provider}/${entry.modelId}`);
		else if (entry.type === "thinking_level_change") lines.push(`thinking ${entry.thinkingLevel}`);
		else if (entry.type === "custom" && entry.customType === "handoff-seat") {
			const data = entry.data ?? {};
			if (data.side === "handoff") lines.push(`handoff from ${seatLine(data)}`);
			else lines.push(`continuation on ${seatLine(data)} — ${data.carried ? "the seat was kept" : `the seat was NOT kept; it wanted ${seatLine(data.wanted)}`}`);
		}
	}
	return lines.length === 0 ? "no seat record in this file" : lines.join("\n");
}

function oneLine(text, max) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function snippet(text, index, length) {
	const start = Math.max(0, index - SNIPPET_RADIUS);
	const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function header(record) {
	return `[${record.n} ${record.label}] ${record.time ?? ""}`.trimEnd();
}

function list(records) {
	const users = records.filter((r) => r.role === "user");
	if (users.length === 0) return "no user messages on this branch";
	return users.map((r) => `${r.n}  ${oneLine(r.text, LIST_LINE_CHARS)}`).join("\n");
}

function grep(records, regex, limit) {
	const hits = [];
	for (const record of records) {
		const match = regex.exec(record.text);
		if (!match) continue;
		const count = record.text.match(new RegExp(regex.source, `${regex.flags}g`))?.length ?? 1;
		hits.push({ record, first: match.index, length: match[0].length || 1, count });
	}
	const lines = [];
	for (const hit of hits.slice(0, limit)) {
		const more = hit.count > 1 ? ` (${hit.count} matches)` : "";
		lines.push(`${header(hit.record)}${more}`);
		lines.push(`  ${snippet(hit.record.text, hit.first, hit.length)}`);
	}
	const shown = Math.min(hits.length, limit);
	const tail = shown < hits.length ? `${shown} of ${hits.length} shown; raise --limit or narrow the regex` : "";
	lines.push(`${hits.length} entries match${tail ? ` — ${tail}` : ""}`);
	return lines.join("\n");
}

function show(records, n, max) {
	const record = records.find((r) => r.n === n);
	if (!record) return { error: `no entry ${n}; the branch has ${records.length}` };
	const text = record.text.length > max
		? `${record.text.slice(0, max)}\n… ${record.text.length - max} more characters; --max ${record.text.length} shows all`
		: record.text;
	return { text: `${header(record)}\n${text}` };
}

function parseArgs(argv) {
	const [file, command, ...rest] = argv;
	if (!file || !command) return { error: USAGE };
	let limit = DEFAULT_LIMIT;
	let max = DEFAULT_MAX_CHARS;
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--limit" || arg === "--max") {
			const n = Number(rest[++i]);
			if (!Number.isInteger(n) || n <= 0) return { error: `${arg} needs a positive integer` };
			if (arg === "--limit") limit = n; else max = n;
			continue;
		}
		// Named, not swallowed as a positional: `grep -i bird` used to come back as
		// the whole usage blob, which never mentions `-i` and so never says why.
		if (arg.startsWith("-")) return { error: `no such option ${arg}; --limit and --max are the only flags, and grep is always case-insensitive` };
		positional.push(arg);
	}
	switch (command) {
		case "list":
		case "seat":
			return positional.length === 0 ? { file, command } : { error: USAGE };
		case "grep": {
			if (positional.length !== 1) return { error: USAGE };
			try {
				return { file, command, regex: new RegExp(positional[0], "i"), limit };
			} catch (error) {
				return { error: `bad regex: ${error instanceof Error ? error.message : String(error)}` };
			}
		}
		case "show": {
			const n = Number(positional[0]);
			if (positional.length !== 1 || !Number.isInteger(n) || n <= 0) return { error: "show needs the entry number from list or grep" };
			return { file, command, n, max };
		}
		default:
			return { error: USAGE };
	}
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.error) { console.error(args.error); return 1; }
	let records;
	try { records = loadBranchRecords(args.file); } catch (error) {
		console.error(`cannot read ${args.file}: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	switch (args.command) {
		case "list":
			console.log(list(records));
			return 0;
		case "seat":
			console.log(seat(args.file));
			return 0;
		case "grep":
			console.log(grep(records, args.regex, args.limit));
			return 0;
		case "show": {
			const shown = show(records, args.n, args.max);
			if (shown.error) { console.error(shown.error); return 1; }
			console.log(shown.text);
			return 0;
		}
		default:
			return 1;
	}
}

process.exit(main(process.argv.slice(2)));
