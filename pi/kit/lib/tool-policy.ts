/**
 * The tool layer's policy, in one place: how long a shell command may run, what
 * a scan may be rooted at, and which tools stand at all.
 *
 * Three rules that must agree with each other or they are worse than nothing:
 *
 *   - **Every bash call is bounded, by the tool.** `extensions/bash.ts` owns
 *     `bash` and applies its own default and ceiling (`lib/bash.ts`), so the
 *     description the model reads and the deadline it gets come from one
 *     definition and cannot drift into a lie. This module no longer touches
 *     bash's schema or its `timeout`.
 *   - **A broad-root scan is refused, not survived.** A scan rooted at `/` or
 *     `$HOME` walks every mounted volume and has wedged this harness before,
 *     and once started there is no handle an extension can reach, so
 *     prevention is the only lever that exists. `tool_call` may return
 *     `{block, reason}` and the reason reaches the model, which then retries
 *     against a real path.
 *   - **Recursive grep is refused at any root, not just broad ones.** `rg`
 *     does the identical job strictly faster — measured 2026-09-01 over the
 *     same 550k-file tree: `grep -r … | head` hit the 120 s kill, `rg` took
 *     0.96 s — so `grep -r` has no correct use on this machine. Training-data
 *     reflex types it anyway; a prompt hint loses to that reflex, a 0-second
 *     refusal naming `rg` does not. Non-recursive grep (pipes, single files)
 *     is untouched, and owned-prompt.ts's `BASH_FILE_OPS_GUIDELINE` is the
 *     standing half of the same rule.
 *
 * And one seat-wide cut: a chat seat (`PI_CHAT=1`, the `chat` command) keeps
 * only {@link CHAT_TOOLS} — answers come from the model, the web, and a
 * look-but-don't-touch shell; every other tool schema would be standing tokens
 * on a seat that exists to cost none. {@link applyChatToolPolicy} is that cut,
 * and because bash survives it, the `tool_call` guards (which key on
 * bash-presence, not seat type) apply to chat unchanged.
 *
 * And one cut (map C6): `grep`, `find` and `ls` are deleted from the harness,
 * on every seat, because the same work routed through bash lands on a tool
 * that takes a timeout this module defaults and a guard can refuse. The cut
 * asks nothing about the seat: a tool nobody may call is dead weight
 * everywhere. {@link standingTools} is that cut, applied twice from one
 * definition — to `payload.tools` on the wire and to the `selectedTools` the
 * owned prompt derives its guidelines from — so a seat is never told to prefer
 * a tool the payload no longer carries. (The prompt's "Available tools" list,
 * which the cut also used to filter, is gone entirely as of issues/31;
 * `payload.tools` was always the authoritative copy.)
 *
 * And three cuts that *do* ask which seat is sending, each one question asked
 * once ({@link applyToolPolicy}, {@link ToolSeat}) rather than a check per
 * tool:
 *
 *   - **A worker carries no {@link DELEGATION_TOOLS}.** A worker is one job,
 *     one result — it cannot spawn, address, collect or stop agents, so six
 *     tool schemas it may never call were standing tokens and a standing
 *     temptation. The main seat and a `lead` keep them.
 *   - **{@link WORKFLOW_TOOL} stands only where the launcher said so.** Whether
 *     a seat carries it is one answer, given before its first request
 *     (`extensions/session-mode.ts`) and carried here as `workflows`: turning a
 *     tool on mid-session rewrites the whole cached prefix (~$1 at 60k), so the
 *     answer may not change while the session runs, and a child inherits its
 *     parent's. Off is the answer for a seat nobody declared one for.
 *   - **Only a workflow child carries `StructuredOutput`.** It is the one seat
 *     that returns through it — a script's `agent()` gives it a schema and
 *     waits for the call. Everywhere else the tool is registered but refused
 *     (`lib/workflow-structured-output.ts`), and an advertised refusal is
 *     tokens spent to invite a mistake.
 *
 * The price is real and accepted: the tools array is the front of the cached
 * prefix, so a worker's array is not its parent's and the child pays for its
 * own tools+system entry (map C4). Six schemas on every turn of every worker
 * cost more than one entry does once.
 *
 * Both seat cuts are guards, not advertisements: {@link carriesTool} is the
 * single rule, asked once by {@link applyToolPolicy} when the payload is built
 * and again by {@link seatRefusal} when a call arrives, because a tool left out
 * of the payload can still be called by name — the tools stay registered, and a
 * model that saw one on an earlier turn or guesses the name reaches `execute`
 * otherwise.
 *
 * Everything here is pure and makes no syscall: the request path is a function
 * of what was captured at turn start (issues/25, `owned-prompt.ts` header) and
 * must stay one. The home directory the scan guard compares against is a
 * parameter, resolved by the extension, which does not run on that path.
 */

import { isAbsolute } from "node:path";
import { commandSegments } from "./shell-words.ts";

/** Built-ins deleted from the harness, on every seat (map C6); see the module header. */
export const DELETED_TOOLS: readonly string[] = ["grep", "find", "ls"];

/**
 * The tool names that stand, out of `names`.
 *
 * Unconditional: no seat keeps a deleted built-in, whatever else it holds.
 * A cut that asked about the seat would make the tools array a function of
 * which seat sent it, and the tools array is the front of the cache key.
 */
export function standingTools(names: readonly string[]): string[] {
	return names.filter((name) => !DELETED_TOOLS.includes(lower(name)));
}

/**
 * Tool names are matched case-insensitively throughout: pi's internal names
 * are lowercase (`bash`, `grep` — what `tool_call` events carry) but the wire
 * payload carries display casing (`Bash`, `Grep`, `find`), and a predicate
 * that only knows one spelling silently does nothing on the other — measured
 * live on 2026-08-29, when the cut passed every lowercase test and left all
 * 12 tools on the wire.
 */
const lower = (name: unknown): string => (typeof name === "string" ? name.toLowerCase() : "");

/**
 * `unknown` rather than `string`, and every reader of a tool name goes through
 * it. The wire payload's casing was the first reason; the second is that a
 * caller holding a name from an event cannot promise there is one, and
 * `scanRefusal` asking its caller to lower the name is how the call-time guard
 * came to throw on `toolName: undefined` — fail-open on exactly the malformed
 * input it was written for. A name nobody can read is no tool this kit cuts, and
 * `""` matches none of them.
 */

/** The tool a seat carries only when its launcher was told to give it one. */
export const WORKFLOW_TOOL = "Workflow";

/**
 * The tools that only a delegating seat carries: they start, address, collect
 * and stop subagents, and a worker does none of those. See the module header.
 */
export const DELEGATION_TOOLS: readonly string[] = ["Agent", WORKFLOW_TOOL, "SendMessage", "ListAgents", "TaskOutput", "TaskStop"];

/** The tool a workflow child returns its result through, and the only seat that carries it. */
export const WORKFLOW_CHILD_TOOL = "StructuredOutput";

const DELEGATION_TOOL_SET = new Set(DELEGATION_TOOLS.map(lower));

/** Which seat a request is going out on, as far as the cuts are concerned. */
export interface ToolSeat {
	readonly role: "main" | "lead" | "worker";
	/** A child a workflow script started — the seat whose result is a schema-checked tool call. */
	readonly workflowChild?: boolean;
	/** Whether this seat was launched carrying {@link WORKFLOW_TOOL}; required, so no seat gets it by forgetting to say. */
	readonly workflows: boolean;
}

/**
 * The seat a request is on when nothing has been declared for it: main, and no
 * workflows until a launcher says otherwise. A live session's seat comes from
 * `lib/seat.ts`'s `toolSeatOf`, which reads both declarations.
 */
export const MAIN_SEAT: ToolSeat = { role: "main", workflows: false };

/**
 * The tools array as it should go on the wire: the cuts applied, nothing else.
 *
 * Every tool that stands goes out exactly as it was registered — the harness
 * owns the ones whose words matter (`bash`, and the engine's `Agent` and its
 * four siblings), so their descriptions are written where they are registered
 * and no second copy of them lives here.
 *
 * Total by construction. This runs inside the handler whose *return value is
 * the request*, and pi drops that value if the handler throws — a policy that
 * could throw would strip the owned system prompt off the wire. Anything it
 * cannot understand it hands back untouched.
 *
 * The tools breakpoint is carried, not dropped: `cache_control` on a tool that
 * the cut removes moves to whatever tool is last afterwards, so filtering can
 * never cost the cached prefix it was meant to leave alone.
 */
export function applyToolPolicy(tools: readonly unknown[], seat: ToolSeat = MAIN_SEAT): unknown[] {
	try {
		return cutTools(tools, (name) => carriesTool(name, seat));
	} catch {
		return [...tools];
	}
}

/**
 * Whether `seat` carries `name` — the one rule, asked by the wire cut and by
 * the call-time guard so the two can never disagree.
 */
export function carriesTool(name: string, seat: ToolSeat): boolean {
	const tool = lower(name);
	if (DELETED_TOOLS.includes(tool)) return false;
	if (tool === lower(WORKFLOW_CHILD_TOOL)) return seat.workflowChild === true;
	if (tool === lower(WORKFLOW_TOOL)) return seat.role !== "worker" && seat.workflows === true;
	if (DELEGATION_TOOL_SET.has(tool)) return seat.role !== "worker";
	return true;
}

/**
 * Why this call must not run on this seat, or `undefined` if it may.
 *
 * Names the tool and the seat, then what the seat *can* do instead: a refusal
 * that only says no costs a turn and teaches nothing.
 */
export function seatRefusal(toolName: string, seat: ToolSeat): string | undefined {
	if (carriesTool(toolName, seat)) return undefined;
	const head = `Blocked: this seat does not carry ${toolName}.`;
	if (lower(toolName) === lower(WORKFLOW_CHILD_TOOL)) {
		return `${head} It belongs to a child a workflow script started, which returns a schema-checked result. Reply in plain text instead.`;
	}
	if (lower(toolName) === lower(WORKFLOW_TOOL) && seat.role !== "worker") {
		return `${head} This session was started without workflows, and that answer is fixed for its whole life — turning the tool on now would rewrite the cached prefix. Do the job with \`Agent\`, or start a session that carries workflows.`;
	}
	if (DELEGATION_TOOL_SET.has(lower(toolName))) {
		return `${head} A worker does one job and reports once — it cannot start, address, collect or stop agents. Do the work yourself and put what matters in your final reply.`;
	}
	return `${head} Use bash for that work.`;
}

/**
 * The only tools a chat seat carries: the web for the world, bash to look at
 * this machine. `web_search` takes URLs itself, so `url_context` earns
 * nothing; edit/write stay out so answering can never drift into coding.
 */
export const CHAT_TOOLS: readonly string[] = ["web_search", "bash"];

/**
 * The chat seat's tool array: everything but {@link CHAT_TOOLS} removed.
 *
 * Total by construction for the same reason {@link applyToolPolicy} is — this
 * runs in the handler whose return value is the request. Bash is the owned
 * tool here as on every seat, so its deadline and its description are already
 * true.
 */
export function applyChatToolPolicy(tools: readonly unknown[]): unknown[] {
	try {
		return cutTools(tools, (name) => CHAT_TOOLS.includes(lower(name)));
	} catch {
		return [...tools];
	}
}

/**
 * The tools array in the one order every seat sends it in: the active tools
 * sorted by name with the breakpoint on the last of them, then the deferred
 * tools in the order they arrived.
 *
 * The tools array is the front of the cached prefix, so its *sequence* is part
 * of the key, and three hands rebuild that sequence while a session runs —
 * plannotator's `setActiveTools`, pi's `_refreshToolRegistry`, and the cuts
 * above. A canonical order makes the array a function of the tool *set*, so a
 * parent, its children and a resumed session agree structurally rather than by
 * sharing a record of what was sent first (issues/45). A changed set is still a
 * real change and rewrites the prefix honestly; only a permutation is free.
 *
 * Sorted by code unit rather than by locale: the order has to be the same on
 * every machine that files against the same ledger entry.
 *
 * Deferred tools stay out of the sort. pi-ai 0.86 declares a tool added
 * mid-session as deferred and appends it after the breakpoint, so that the
 * cached prefix stays readable across the addition. Whether a deferred tool
 * ahead of the breakpoint would cost the prefix is not known here, so a name
 * sort is not allowed to carry one there. Arrival order is the transcript's, so
 * a resumed session rebuilds it.
 *
 * Total by construction, like the cuts above it: anything it cannot understand
 * — a nameless tool, two tools of one name — sorts by the name it could read
 * and goes out.
 */
export function canonicalToolOrder(tools: readonly unknown[]): unknown[] {
	try {
		const active = tools.filter((tool) => !isDeferred(tool)).sort((left, right) => (nameOf(left) < nameOf(right) ? -1 : nameOf(left) > nameOf(right) ? 1 : 0));
		return placeBreakpoint([...active, ...tools.filter(isDeferred)]);
	} catch {
		return [...tools];
	}
}

/**
 * The tools breakpoint, on the last tool that may hold it and on no other.
 *
 * Both callers end here, because both move the breakpoint off where it was: a
 * reorder leaves it inwards, a cut takes the tool out from under it and passes
 * what it held as `orphaned`. A breakpoint anywhere but the target is taken
 * off, so the rule holds by construction rather than by the list happening to
 * arrive well-formed — including on a deferred tool. When no tool may hold one,
 * none does.
 */
function placeBreakpoint(tools: unknown[], orphaned?: unknown): unknown[] {
	const target = breakpointHolder(tools);
	let breakpoint = orphaned;
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index];
		if (index === target || !isRecord(tool) || tool.cache_control === undefined) continue;
		const { cache_control, ...rest } = tool;
		breakpoint ??= cache_control;
		tools[index] = rest;
	}
	if (target < 0 || breakpoint === undefined) return tools;
	const holder = tools[target];
	if (isRecord(holder) && holder.cache_control === undefined) tools[target] = { ...holder, cache_control: breakpoint };
	return tools;
}

/**
 * The last tool a breakpoint may sit on: the last one that is not deferred.
 *
 * A deferred tool is declared now and loaded later, so it is not part of the
 * cached prefix, and a breakpoint on it marks a boundary that is not there.
 * Whether Anthropic rejects that outright is not known here: pi-ai puts the
 * breakpoint on the last initial tool, ahead of any deferred one, so it has
 * never been sent. Only this module placing it on the last tool could put it
 * there, which is reason enough not to.
 *
 * pi-ai 0.86 ends an Anthropic tool list with its `__pi_deferred_placeholder__`
 * whenever the model accepts native mid-conversation tool changes, so "last"
 * and "last cacheable" are no longer the same tool. `-1` when nothing may hold
 * it, and then the breakpoint goes. See {@link placeBreakpoint}, which is what
 * takes it off.
 */
function breakpointHolder(tools: readonly unknown[]): number {
	for (let index = tools.length - 1; index >= 0; index--) {
		const tool = tools[index];
		if (isRecord(tool) && !isDeferred(tool)) return index;
	}
	return -1;
}

function isDeferred(tool: unknown): boolean {
	return isRecord(tool) && tool.defer_loading === true;
}

/**
 * One filter, shared by both cuts, with the tools breakpoint carried rather
 * than dropped: `cache_control` on a tool the cut removes moves to whatever
 * tool is last afterwards, so filtering can never cost the cached prefix it
 * was meant to leave alone. A tool whose name cannot be read is kept untouched
 * — anything this module cannot understand it hands back.
 */
function cutTools(tools: readonly unknown[], keeps: (name: string) => boolean): unknown[] {
	const kept: unknown[] = [];
	let orphanedBreakpoint: unknown;
	for (const tool of tools) {
		const name = nameOf(tool);
		if (name !== "" && !keeps(name)) {
			if (isRecord(tool) && tool.cache_control !== undefined) orphanedBreakpoint = tool.cache_control;
			continue;
		}
		kept.push(tool);
	}
	return placeBreakpoint(kept, orphanedBreakpoint);
}

/** Programs whose bash invocation walks a tree, and where their path arguments sit. */
const SCANNERS: Record<string, "leading" | "trailing"> = {
	// find/fd take their roots first, before the first predicate flag.
	find: "leading",
	fd: "leading",
	// rg/ag/ack take the pattern first and paths after it. grep is not here:
	// non-recursive grep never walks a tree, and recursive grep is refused
	// before root-checking ever happens (see GREP_REFUSAL).
	rg: "trailing",
	ag: "trailing",
	ack: "trailing",
};

/**
 * Why recursive grep may never run, at any root. Short on purpose: the
 * literal-token parser will occasionally show this to an innocent command
 * (a heredoc that *writes* `grep -r`), and the cost of a false block is one
 * reworded retry, so the message must be a lesson, not an essay.
 */
const GREP_REFUSAL =
	"Blocked: recursive grep. Use rg — same job, parallel, measured here at 0.96s where grep -r hit the 120s kill. " +
	"rg skips gitignored files by default; add -uu to search ignored and hidden files too.";

/** A grep flag that walks a tree: -r/-R alone or in a cluster, or the long forms. */
const isRecursiveGrepFlag = (arg: string): boolean =>
	/^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive" || arg === "--dereference-recursive";

/**
 * Why this scan must not run, or `undefined` if it may.
 *
 * Only a shell command can be one now: `grep`/`find`/`ls` are deleted from
 * every seat (map C6), so a scan can only be typed into `bash` or
 * `powershell`, and a guard for a tool that cannot be called is the false
 * promise that ruling was written against.
 *
 * A bash command is judged on its *literal* tokens only — `/`, `~`, `$HOME`,
 * the home path itself. Matching a shell command properly is not possible and
 * pretending otherwise buys false blocks: `find .` in a home-rooted session
 * reads as ordinary work and is left alone. Best-effort by design; the timeout
 * is the other half of the pair, and it has no exceptions.
 */
export function scanRefusal(toolName: unknown, input: Record<string, unknown> | undefined, { home }: { home: string }): string | undefined {
	const tool = lower(toolName);
	if (tool !== "bash" && tool !== "powershell") return undefined;
	const command = typeof input?.command === "string" ? input.command : "";
	if (recursiveGrepIn(command)) return GREP_REFUSAL;
	const hit = broadScanIn(command, home);
	if (hit === undefined) return undefined;
	return refusal(`\`${hit.program}\` at ${describeRoot(hit.root, home)}`, "Re-run it rooted at a specific path — `.` for this directory, or a named subtree");
}

const refusal = (what: string, remedy: string): string =>
	`Blocked: ${what}. A scan rooted at the filesystem root or your home directory walks every mounted volume, ` +
	`takes many minutes, and has wedged this harness before. ${remedy}, then try again.`;

const describeRoot = (root: string, home: string): string => (root === "/" ? "/" : root === home ? `${root} (your home directory)` : root);

/**
 * Each simple command as tokens, env-var prefixes dropped.
 *
 * The lexing is `lib/shell-words.ts`'s job — this only strips the `FOO=1`
 * prefixes bash allows in front of a program, so `FOO=1 find /` is judged on
 * `find` and not on the assignment.
 */
function* segmentTokens(command: string): Generator<string[]> {
	for (const tokens of commandSegments(command)) {
		let index = 0;
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
		if (index < tokens.length) yield tokens.slice(index);
	}
}

/** Whether any segment invokes grep with a flag that walks a tree, wherever rooted. */
function recursiveGrepIn(command: string): boolean {
	for (const tokens of segmentTokens(command)) {
		if (basename(tokens[0]) !== "grep") continue;
		if (tokens.slice(1).some(isRecursiveGrepFlag)) return true;
	}
	return false;
}

/** The first broad-rooted scanner in a command line, if there is one. */
function broadScanIn(command: string, home: string): { program: string; root: string } | undefined {
	for (const tokens of segmentTokens(command)) {
		const program = basename(tokens[0]);
		const placement = SCANNERS[program];
		if (placement === undefined) continue;
		const args = tokens.slice(1);
		for (const arg of placement === "leading" ? leadingRoots(args) : trailingRoots(args)) {
			const root = literalRoot(arg, home);
			if (root !== undefined) return { program, root };
		}
	}
	return undefined;
}

/** `find [-H] root... [expression]` — the roots are the run of words before the first predicate. */
function leadingRoots(args: readonly string[]): string[] {
	const roots: string[] = [];
	for (const arg of args) {
		if (arg.startsWith("-")) {
			if (roots.length > 0) break;
			continue;
		}
		roots.push(arg);
	}
	return roots;
}

/** `rg [flags] pattern path...` — everything after the pattern, flags ignored. */
function trailingRoots(args: readonly string[]): string[] {
	const words = args.filter((arg) => !arg.startsWith("-"));
	return words.slice(1);
}

/**
 * A written-out `/` or `$HOME`, unresolved: a relative path is never one of these.
 *
 * The token arrives already unquoted from `commandSegments`, so `find "/"` and
 * `find /` are the same scan here without this function knowing what a quote is.
 */
function literalRoot(token: string, home: string): string | undefined {
	if (token === "/") return "/";
	if (token === "~" || token === "~/" || token === "$HOME" || token === "${HOME}" || token === "$HOME/" || token === "${HOME}/") return home;
	if (isAbsolute(token) && trimSlash(token) === trimSlash(home)) return home;
	return undefined;
}

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

const basename = (token: string): string => token.split("/").pop() ?? "";

/** A tool's name as the wire carries it, or `""` for anything this module cannot read. */
const nameOf = (tool: unknown): string => (isRecord(tool) && typeof tool.name === "string" ? tool.name : "");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
