/**
 * What one session in this process may do to another.
 *
 * pi runs subagents in-process: `createAgentSession` + `bindExtensions`, on the
 * factory its extension cache already holds, so a subagent gets the same copy of
 * every extension module the TUI is running. Its session ends when its run does,
 * and the engine emits `session_shutdown` on that child's runner when it does.
 *
 * Everything the kit puts on a prototype or at module scope is therefore shared
 * with sessions that have no screen, and is torn down by their shutdowns unless
 * ownership is explicit. This is the test for that: a child session runs its
 * whole lifecycle, and the TUI session must not notice.
 */
import { is, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { identityTheme } from "../support/identity-theme.mjs";

const jiti = kitJiti();

const { UserMessageComponent, initTheme } = await jiti.import(
	"@earendil-works/pi-coding-agent",
);
const { elapsedMs, turnClockReading, readTurnClock } = await jiti.import(`${KIT_ROOT}/lib/session/turn-clock.ts`);
initTheme("dark");

const theme = identityTheme;

/**
 * One extension runtime: the handlers a factory registers, and the ctx pi hands
 * them. `planned` counts the reads the transcript planner makes of the session,
 * which is the only thing it asks for and so the cheapest sign it ran at all.
 */
function session(mode) {
	const handlers = new Map();
	const state = { planned: 0 };
	const api = {
		registerTool: () => {},
		registerToolRenderer: () => {},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		on: (event, handler) => handlers.set(event, handler),
		events: { on: () => {}, emit: () => {} },
	};
	const ctx = {
		mode,
		cwd: KIT_ROOT,
		hasUI: mode === "tui",
		model: { id: "claude-opus-5", reasoning: true },
		thinkingLevel: "high",
		sessionManager: {
			getCwd: () => KIT_ROOT,
			getSessionName: () => undefined,
			getSessionId: () => mode,
			getEntries: () => [],
			buildContextEntries: () => {
				state.planned++;
				return [];
			},
		},
		getContextUsage: () => ({ percent: 12 }),
		ui: {
			theme,
			setWorkingVisible: () => {},
			setFooter: () => {},
			setEditorComponent: () => {},
			notify: () => {},
		},
	};
	const fire = async (type, event = {}) => {
		const handler = handlers.get(type);
		if (handler) await handler({ type, reason: "startup", ...event }, ctx);
	};
	return { api, ctx, fire, state };
}

const ASSISTANT = { message: { role: "assistant", content: [], stopReason: "stop" } };

/** Everything a running subagent raises at the extensions it shares with the TUI. */
async function childRuns(path) {
	const factory = await jiti.import(`${KIT_ROOT}/${path}`, { default: true });
	const child = session("print");
	await factory(child.api);
	await child.fire("session_start");
	await child.fire("agent_start");
	await child.fire("message_end", ASSISTANT);
	await child.fire("tool_execution_end", { toolCallId: "child-call", isError: false });
	await child.fire("agent_settled");
	await child.fire("session_tree");
	await child.fire("session_shutdown");
	return child;
}

const framed = (lines) => lines.some((line) => line.includes("╭─ User"));
const renderUser = () => new UserMessageComponent("hello there").render(60);

// ---------------------------------------------------------------------------
// zen-chrome: the box around a sent message.
// ---------------------------------------------------------------------------

const chrome = await jiti.import(`${KIT_ROOT}/extensions/zen-chrome/index.ts`, { default: true });
const tui = session("tui");
await chrome(tui.api);

is("no frame before the TUI session starts", framed(renderUser()), false);
await tui.fire("session_start");
is("the TUI session frames sent messages", framed(renderUser()), true);

// The same question about the other thing this extension owns: the shared turn
// clock. Both of its live states are checked, because a subagent's events do
// different damage to each — its settle would freeze a running turn at nothing,
// its start would wipe a figure being held, and its session_start would clear
// either. Read at a fixed distance from the turn's own start, so every
// assertion is a duration and never a timestamp.
await tui.fire("before_agent_start");
const turnStart = readTurnClock().startedAt;
const later = (turnStart ?? 0) + 72_000;
is("the framed session's running turn is on the shared clock", turnClockReading(readTurnClock(), later).label, "1m 12s");

await childRuns("extensions/zen-chrome/index.ts");
is("a subagent's whole lifecycle leaves the frame alone", framed(renderUser()), true);
is("and a running turn's clock alone", turnClockReading(readTurnClock(), later).label, "1m 12s");
is("still the same turn, not a fresh one", readTurnClock().startedAt, turnStart);

await tui.fire("agent_settled");
const heldMs = elapsedMs(readTurnClock(), later);
is("the settled turn is what the clock then holds", readTurnClock().startedAt, null);

await childRuns("extensions/zen-chrome/index.ts");
is("and a held figure alone", elapsedMs(readTurnClock(), later), heldMs);

await tui.fire("session_shutdown");
is("and the session that framed takes it back down", framed(renderUser()), false);

// ---------------------------------------------------------------------------
// transcript: the planner's rows.
// ---------------------------------------------------------------------------

const transcript = await jiti.import(`${KIT_ROOT}/extensions/transcript/index.ts`, { default: true });
const drawing = session("tui");
await transcript(drawing.api);
await drawing.fire("session_start");

is("and plans the rows it draws", drawing.state.planned > 0, true);

const child = await childRuns("extensions/transcript/index.ts");
// The planner's rows are module-level, and a subagent raises the same events as
// anyone else. Its rows are drawn nowhere — pi calls `renderCall` from the TUI's
// tool component and nowhere else — so they must be planned nowhere.
is("and never replans, having no rows on screen", child.state.planned, 0);

await drawing.fire("session_shutdown");

await finish();
