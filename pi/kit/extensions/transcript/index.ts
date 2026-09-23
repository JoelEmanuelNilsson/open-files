/**
 * transcript — tool calls as receipts, in Claude Code's grammar.
 *
 *     ● Read(lib/split-diff.ts)
 *       ⎿  Read 412 lines
 *
 *     ● Grep(renderCall in kit/)
 *       ⎿  Found 7 matches
 *
 *     ● Bash(npm test)
 *       ⎿  41 passed  +12 lines · 2.4s
 *
 * pi's own row is a `Spacer`, a padded `Box`, the call, and ten lines of
 * whatever the tool printed. Ten calls in a turn is forty blank lines and a
 * screen of text nobody reads, and the only thing separating a call that failed
 * from one that worked is a background colour some themes set to
 * transparent: the state was invisible and the noise was not.
 *
 * Two lines per call instead. The header says what ran, the result line says
 * what came back, and the dot in column zero says which of the two it is still
 * doing. Nothing is positional beyond that, so a long tool name or a narrow pane
 * degrades instead of breaking a grid, and `ctrl+o` opens the whole payload.
 *
 * A run of adjacent read-only calls is one line rather than one row each, and
 * that line has two tenses. While the turn is going it says what the run is
 * doing and, under it, where the run has got to:
 *
 *     ● Running 2 shell commands…
 *       ⎿  $ ping -c 25 127.0.0.1 > /dev/null
 *
 * and when the turn ends it becomes what the run did, in the same columns, so
 * the only thing that moves is the gutter going away:
 *
 *     Listed 1 directory, ran 6 shell commands
 *
 * `group.ts` decides which rows those are and which one speaks; `rollup.ts`
 * writes the line in either tense. `ctrl+o` or a click on the line puts the
 * rows back. Anything that changed something, failed, or was cut off keeps its
 * row, because that row is the record.
 *
 * `PI_TRANSCRIPT=off` restores pi's rows, `PI_TRANSCRIPT_ROLLUP=off` keeps
 * every row forever.
 */

import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { jsonArgumentCoercionFor } from "../../lib/tool-argument-coercion.ts";
import { enableRowClicks } from "./click.ts";
import { forgetResults, forgetRows, noteResult, regroup, stopTicking, ungroup } from "./group.ts";
import { receipt } from "./receipt.ts";
import { quiesce, transcriptEnabled } from "./row.ts";
import { executeWithOverwriteDiff } from "./write.ts";

type Factory = (cwd: string) => ToolDefinition<any, any, any>;

/**
 * The built-ins this extension owns by re-registering them.
 *
 * Re-registration carries two things: the row, and the argument rule (ticket
 * 63). pi validates a built-in's arguments itself, so `read` with
 * `offset: "50"` died where the kit's own tools repaired the same mistake —
 * the same call succeeded or failed depending on which side of that line the
 * tool sat. An override is the only place a built-in's `prepareArguments` can
 * be reached, and it takes pi's own `parameters` with it, so nothing here
 * restates a schema pi may change.
 *
 * `bash` is not here: the kit owns that tool outright (`extensions/bash.ts`,
 * the process side) and borrows this extension's receipt from `receipt.ts`, so
 * one registrar holds execution and rendering both. `powershell` is only listed
 * on Windows: registering a tool is what makes it callable, so claiming it on a
 * Mac would hand the model a shell that is not there. pi gates the built-in by
 * platform and an override cannot.
 */
const FACTORIES: Record<string, Factory> = {
	read: createReadToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
	write: createWriteToolDefinition,
	...(process.platform === "win32" ? { powershell: createPowerShellToolDefinition } : {}),
};

function off(name: string): boolean {
	return (process.env[name] ?? "").toLowerCase() === "off";
}

/**
 * Reads the groups back off the session.
 *
 * `buildContextEntries` is the same list pi rebuilds the chat from, so a plan
 * made from it is a plan about the rows that are actually on screen. It is also
 * the only thing this extension asks the session for.
 *
 * A message that is still streaming is not in the session yet — pi hands
 * extensions `message_end` before it writes the message down — but its rows are
 * already on screen, because pi creates them as the arguments arrive. So the
 * message being streamed is handed in and stood on the end of the list, where
 * it will be in a moment anyway.
 */
function replan(ctx: ExtensionContext, live = false, streaming?: unknown): void {
	if (off("PI_TRANSCRIPT_ROLLUP")) return;
	try {
		const entries = ctx.sessionManager.buildContextEntries();
		const last = entries[entries.length - 1] as { message?: unknown } | undefined;
		if (streaming && last?.message !== streaming) entries.push({ type: "message", message: streaming } as never);
		regroup(entries, live);
	} catch {
		// A session that cannot be read is a session with no rollups, not a crash
		// in an event handler.
	}
}

/** The tool calls in a message, however far along it is. */
function callsIn(message: { content?: unknown }): number {
	const content = message.content;
	if (!Array.isArray(content)) return 0;
	return content.filter((block) => (block as { type?: string })?.type === "toolCall").length;
}

/** Built-in definitions are cwd-bound, so they are built per session directory, once. */
const definitions = new Map<string, ToolDefinition<any, any, any>>();
function builtIn(tool: string, cwd: string): ToolDefinition<any, any, any> {
	const key = `${tool}\u0000${cwd}`;
	const cached = definitions.get(key);
	if (cached) return cached;
	const factory = FACTORIES[tool];
	if (!factory) throw new Error(`transcript: no built-in named ${tool}`);
	const made = factory(cwd);
	definitions.set(key, made);
	return made;
}

export default function (pi: ExtensionAPI) {
	// The rows are a preference; the argument rule is not. `PI_TRANSCRIPT=off`
	// hands the rendering back to pi — which comes along in the definition
	// itself — and keeps the coercion, so no environment variable decides
	// whether a stringified argument is repaired.
	const rows = transcriptEnabled();

	for (const tool of Object.keys(FACTORIES)) {
		const meta = builtIn(tool, process.cwd());
		// The built-in resolves paths against the directory it was built for, so
		// execution goes to the definition for the session's cwd, not this one.
		const execute: ToolDefinition<any, any, any>["execute"] = (id, params, signal, onUpdate, ctx) =>
			builtIn(tool, ctx.cwd).execute(id, params, signal, onUpdate, ctx);
		pi.registerTool({
			...meta,
			name: tool,
			// A string where this schema declares a number, array, object or boolean
			// is that value; pi runs this before it validates. Built from pi's own
			// `parameters`, so it tracks the built-in rather than describing it.
			prepareArguments: jsonArgumentCoercionFor(meta.parameters),
			// The write receipt shows a diff when the file already existed, and only
			// the execute can know what it replaced.
			execute: rows && tool === "write" ? executeWithOverwriteDiff(execute) : execute,
			// pi's default shell is a `Box` with a column of padding, a blank line
			// above and below, and a background some themes make transparent.
			// A two-line receipt inside it is five lines of mostly nothing.
			...(rows ? receipt(tool) : {}),
		});
	}

	if (!rows) return;

	/**
	 * Whether this session is the one whose rows are on screen.
	 *
	 * The planner's rows live at module scope, and pi hands every session in the
	 * process the same copy of this module — including the subagents it runs
	 * in-process, which raise the same tool events all session long. A row only
	 * exists where pi calls `renderCall`, which is the TUI's tool component and
	 * nowhere else, so a subagent has no rows and must not replan the ones that
	 * are drawn.
	 */
	let owns = false;
	/** Set only while this session is the one wearing the clicks. */
	let unclick: (() => void) | undefined;

	// pi creates a row for every call in a batch as its arguments stream, so a
	// seven-call turn is seven rows on screen before any of them has run. The
	// plan is redone as each new call appears — not per token, which is what
	// `message_update` otherwise means — so the rows behind the one being waited
	// on never draw themselves in the first place. A call seated this early is
	// counted by nothing until its arguments close (`rollup.ts`), so the line does
	// not move for a call it cannot yet name.
	let streamed = 0;
	pi.on("message_start", () => {
		streamed = 0;
	});
	pi.on("message_update", (event, ctx) => {
		if (!owns || event.message.role !== "assistant") return;
		const calls = callsIn(event.message);
		if (calls === streamed) return;
		streamed = calls;
		replan(ctx, true, event.message);
	});
	pi.on("message_end", (event, ctx) => {
		if (owns && event.message.role === "assistant") replan(ctx, true, event.message);
	});

	// A call folds as soon as it lands. Doing it here rather than at the end of
	// the turn is what keeps the transcript from printing a screen of rows and
	// then swallowing them: each row is replaced by its own line in the count
	// above it, and when the turn ends nothing moves at all.
	//
	// pi hands extensions this event before it writes the result into the
	// session, and a parallel batch holds every result message back until the
	// last call returns, so the result is handed to the planner directly.
	pi.on("tool_execution_end", (event, ctx) => {
		if (!owns) return;
		noteResult(event.toolCallId, event.isError === true);
		replan(ctx, true);
	});

	// A run that is over is the authority on itself: every call has a result or
	// never will, nothing more will be printed between two rows, and the session
	// now holds all of it. In the ordinary case this changes nothing, because the
	// rows folded as they landed.
	pi.on("agent_settled", (_event, ctx) => {
		if (!owns) return;
		quiesce();
		// The replan below stops the clock by itself, having nothing live left to
		// count. This is the belt: a session that cannot be read swallows the replan,
		// and a timer that outlived the run it was timing would repaint forever.
		stopTicking();
		replan(ctx);
	});

	// The results of the last run are in the session by now, so the copies kept
	// for the rows that folded before it got there can go.
	pi.on("agent_start", () => {
		if (owns) forgetResults();
	});

	// pi rebuilds every row from the session when it compacts, forks or walks the
	// tree, and the row that was leading a group can be the one that just left the
	// context. Replanning over the same entries pi rebuilt from keeps the line and
	// the rows it stands for in agreement; the components that drew the old rows
	// are gone, and the new ones register themselves as they draw.
	pi.on("session_compact", (_event, ctx) => {
		if (!owns) return;
		forgetRows();
		replan(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!owns) return;
		forgetRows();
		replan(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		owns = true;
		// A resumed session is a transcript of runs that all settled long ago, and
		// the planner cannot tell the difference. Same function, same entries.
		forgetRows();
		replan(ctx);
		// Only fullscreen mode has a mouse at all, and the patch is inert until one
		// arrives, so this costs nothing in the mode that has none.
		if (!off("PI_TRANSCRIPT_CLICK")) unclick = enableRowClicks();
	});

	// The click patch lives on a shared prototype, and the rows in a shared map,
	// so both outlive this runtime unless they are taken down with it — but only
	// by the runtime that put them there. pi runs subagents in this process, and
	// they shut down all session long; none of this is theirs to remove.
	pi.on("session_shutdown", () => {
		unclick?.();
		unclick = undefined;
		if (!owns) return;
		owns = false;
		ungroup();
	});
}
