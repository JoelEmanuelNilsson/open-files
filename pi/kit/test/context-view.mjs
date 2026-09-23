/**
 * An instrument may not move what it measures.
 *
 * `/context` used to fire a silent probe when it was opened before the first
 * real turn of a runtime: an empty user message that started a full agent run
 * and aborted it at `turn_start`. pi raises `agent_start` and `turn_start`
 * unconditionally and every extension in this kit sees them, so several of them
 * read that synthetic run as a real turn — `zen-chrome` restored the built-in
 * `Working...` row it had turned off at `session_start` and never got it back,
 * `transcript` replanned, `notify` burned its turn clock, and so on. Issue 18
 * retired the probe.
 *
 * This is the check that it stays retired, at the seam where the bug lived: all
 * five extensions loaded against **one** shared UI state and one event bus, the
 * way pi loads them, and `/context` driven for real. `sendUserMessage` here does
 * what pi does — it raises the whole lifecycle at everyone — so a probe coming
 * back is not a subtle regression, it is a red line.
 *
 * The standing rule it enforces: no extension writes another extension's UI
 * state. `zen-chrome` is the sole writer of `setWorkingVisible`, and of the
 * shared turn clock — which lives on `globalThis` rather than on `ctx`, so it
 * is watched here through an accessor and attributed the same way.
 */
import "./env.mjs";
const PI = "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti.mjs`);
const path = await import("node:path");
const jiti = createJiti(import.meta.url, { interopDefault: true });
// Resolved from this file: a git worktree must test itself, not the checkout
// next door.
const ROOT = path.resolve(import.meta.dirname, "..");

const { initTheme } = await jiti.import("@earendil-works/pi-coding-agent");
const { TURN_CLOCK_KEY, readTurnClock } = await jiti.import(`${ROOT}/lib/turn-clock.ts`);
initTheme("dark");

let pass = 0;
let fail = 0;
const eq = (name, actual, expected) => {
	if (Object.is(actual, expected)) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
};

const theme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	italic: (t) => t,
	dim: (t) => t,
	inverse: (t) => t,
	strikethrough: (t) => t,
};

// The five that misread the probe's run, plus context-view itself. Order is the
// manifest's, so registration order in the test matches registration order in pi.
const EXTENSIONS = [
	["zen-chrome", "extensions/zen-chrome/index.ts"],
	["context-view", "extensions/context-view/index.ts"],
	["session-mode", "extensions/session-mode.ts"],
	["herdr-agent-state", "extensions/herdr-agent-state.ts"],
	["transcript", "extensions/transcript/index.ts"],
	["notify", "extensions/notify.ts"],
];

/**
 * The events a run is *steered* through, as opposed to merely observed through.
 * `before_agent_start` is not here: passive capture legitimately reads the
 * structured prompt options from it. The rest exist, for context-view, only if
 * it is manufacturing a run again.
 */
const PROBE_ONLY_EVENTS = ["input", "agent_start", "turn_start", "message_start", "message_end", "agent_settled"];

/**
 * One pi runtime: six extensions, one event bus, one shared ctx.
 *
 * Every mutating call any extension makes on the shared surface is recorded
 * with the name of the extension that made it, because "did `/context` disturb
 * anything" is exactly the question "did anyone write while it ran".
 */
async function runtime(entries = []) {
	const handlers = new Map();
	const commands = new Map();
	const writes = [];
	const pending = [];
	let acting = "?";
	const ui = { workingVisible: true };

	const record = (surface, value) => writes.push({ by: acting, surface, value });

	const apiFor = (name) => ({
		registerTool: () => {},
		registerCommand: (n, o) => commands.set(n, o),
		registerEntryRenderer: () => {},
		registerShortcut: () => {},
		appendEntry: (type, data) => {
			record("appendEntry", type);
			entries.push({ type: "custom", customType: type, data, id: `e${entries.length}` });
		},
		on: (event, handler) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push({ name, handler });
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "off",
		sendUserMessage: (text) => {
			record("sendUserMessage", text);
			// pi runs the turn asynchronously; the caller gets void back. Faithful,
			// because the retired probe relied on exactly that to await its own run.
			pending.push(Promise.resolve().then(() => turn(text, "extension")));
		},
		events: { on: () => {}, emit: () => {} },
		flags: new Map(),
	});

	const ctx = {
		mode: "tui",
		isIdle: () => true,
		hasUI: true,
		cwd: ROOT,
		model: { id: "claude-opus-5", provider: "anthropic", reasoning: true },
		thinkingLevel: "high",
		isProjectTrusted: () => true,
		modelRegistry: { hasConfiguredAuth: () => true },
		getContextUsage: () => ({ percent: 3, totalTokens: 4200, maxTokens: 200000 }),
		getSystemPrompt: () => "pi's vanilla prompt",
		getSystemPromptOptions: () => ({ cwd: ROOT, contextFiles: [], skills: [] }),
		getAllTools: () => [],
		getActiveTools: () => [],
		abort: () => record("abort", true),
		waitForIdle: async () => {
			await Promise.all(pending.splice(0));
		},
		sessionManager: {
			getCwd: () => ROOT,
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id,
			getBranch: () => entries,
			buildContextEntries: () => [],
		},
		ui: {
			theme,
			setWorkingVisible: (visible) => {
				record("setWorkingVisible", visible);
				ui.workingVisible = visible;
			},
			setFooter: () => record("setFooter", true),
			setEditorComponent: () => record("setEditorComponent", true),
			setWidget: () => record("setWidget", true),
			setExtensionStatus: () => record("setExtensionStatus", true),
			getToolsExpanded: () => false,
			notify: (message) => record("notify", message),
			// The views open through ui.custom; build and render one, then close it,
			// so a `/context` that throws mid-render is a failure and not a pass.
			custom: async (factory) => {
				const tui = { terminal: { rows: 40, columns: 100 }, requestRender: () => {} };
				let resolve;
				const closed = new Promise((r) => { resolve = r; });
				const view = factory(tui, theme, {}, resolve);
				view.render(100);
				resolve(undefined);
				await closed;
				view.dispose?.();
			},
		},
	};

	/** Dispatch one event to every listener, tagging whatever it writes. */
	const fire = async (type, event = {}) => {
		for (const { name, handler } of handlers.get(type) ?? []) {
			acting = name;
			await handler({ type, reason: "startup", ...event }, ctx);
		}
		acting = "?";
	};

	/** The full run pi raises for one user message, abort or no abort. */
	const turn = async (text, source) => {
		const options = ctx.getSystemPromptOptions();
		await fire("input", { source, text });
		await fire("before_agent_start", { prompt: text, systemPromptOptions: options });
		await fire("agent_start");
		await fire("turn_start");
		const user = { role: "user", content: text, timestamp: 1_000 };
		const assistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 2_000 };
		for (const message of [user, assistant]) {
			await fire("message_start", { message });
			await fire("message_end", { message });
		}
		await fire("context", { messages: [user, assistant] });
		await fire("agent_settled");
	};

	// The turn clock meets its readers on `globalThis`, because pi hands every
	// extension its own module registry. Watching the property itself puts it on
	// the same footing as a write to `ctx.ui`: attributed to whoever made it.
	let clock = readTurnClock();
	Object.defineProperty(globalThis, TURN_CLOCK_KEY, {
		configurable: true,
		get: () => clock,
		set: (value) => {
			record("turnClock", value?.startedAt === null ? "idle" : "running");
			clock = value;
		},
	});

	for (const [name, file] of EXTENSIONS) {
		await (await jiti.import(`${ROOT}/${file}`, { default: true }))(apiFor(name));
	}

	return {
		ui,
		writes,
		handlers,
		entries,
		fire,
		turn,
		/** Run `/context` the way pi runs it, then let any run it started finish. */
		async context(args = "") {
			await commands.get("context").handler(args, ctx);
			await Promise.all(pending.splice(0));
		},
	};
}

// ---------------------------------------------------------------------------
// A freshly loaded session: `/context` before any turn has run.
// ---------------------------------------------------------------------------

const fresh = await runtime();
await fresh.fire("session_start", { reason: "resume" });
eq("zen-chrome hides the built-in Working row at session start", fresh.ui.workingVisible, false);

const afterStart = fresh.writes.length;
await fresh.context();

eq("and /context on a freshly resumed session leaves it hidden", fresh.ui.workingVisible, false);
// The general form of the same fact: an instrument that writes nothing cannot
// disturb the wave, the cache glyph, the transcript planner, the herdr sidebar
// or notify's turn clock. One assertion covers all five.
eq(
	"and writes nothing at all while it runs",
	JSON.stringify(fresh.writes.slice(afterStart)),
	"[]",
);
eq("and raises no run", fresh.writes.some((w) => w.surface === "sendUserMessage"), false);
eq("and aborts nothing", fresh.writes.some((w) => w.surface === "abort"), false);

// Structural, so the check fails on the design and not only on the symptom:
// these are the events a synthetic run is seen through. context-view listening
// on any of them again means it is in the run business again.
for (const event of PROBE_ONLY_EVENTS) {
	const listeners = (fresh.handlers.get(event) ?? []).map((h) => h.name);
	eq(`context-view does not listen on ${event}`, listeners.includes("context-view"), false);
}

// zen-chrome is the sole writer of the flag, in this run and every other.
eq(
	"setWorkingVisible has exactly one writer",
	[...new Set(fresh.writes.filter((w) => w.surface === "setWorkingVisible").map((w) => w.by))].join(","),
	"zen-chrome",
);

// `/context injections` degrades rather than probing, and says so.
await fresh.context("injections");
eq("and /context injections degrades without probing either", fresh.ui.workingVisible, false);

// ---------------------------------------------------------------------------
// After a real turn: passive capture, unchanged.
// ---------------------------------------------------------------------------

const used = await runtime();
await used.fire("session_start", { reason: "resume" });
await used.turn("what is in my context", "user");
const beforeContext = used.writes.length;
await used.context();
eq("[real turn] /context leaves the Working row hidden", used.ui.workingVisible, false);
eq(
	"[real turn] and still writes nothing",
	JSON.stringify(used.writes.slice(beforeContext).filter((w) => w.by === "context-view")),
	"[]",
);

// The same standing rule, applied to the clock. `notify` reads it for the
// duration in its ping and the chrome reads it every frame; if either could
// write it, there would be two definitions of "a turn" again.
const clockWrites = used.writes.filter((w) => w.surface === "turnClock");
eq(
	"[real turn] the turn clock has exactly one writer",
	[...new Set(clockWrites.map((w) => w.by))].join(","),
	"zen-chrome",
);
// session_start clears it, before_agent_start opens the turn, agent_start finds
// it already open, agent_settled closes it. Four writes, one run, no reset in
// the middle — which is the bug the shared clock exists to make impossible.
eq(
	"[real turn] and it brackets the whole run without restarting",
	clockWrites.map((w) => w.value).join(" "),
	"idle running running idle",
);

// ---------------------------------------------------------------------------
// Migration: sessions on disk that already carry probe identities.
// ---------------------------------------------------------------------------

const { createLegacyProbeFilter } = await jiti.import(`${ROOT}/extensions/context-view/capture.ts`);

const probeUser = { role: "user", content: "", timestamp: 111 };
const probeAssistant = { role: "assistant", content: [], stopReason: "stop", timestamp: 222 };
const real = { role: "user", content: "hello", timestamp: 333 };
const persisted = [{
	type: "custom",
	customType: "pi-context-view:probe-identities",
	data: { messages: [{ role: "user", timestamp: 111 }, { role: "assistant", timestamp: 222 }] },
	id: "p0",
}];

const migrating = createLegacyProbeFilter(persisted);
eq(
	"a resumed old session drops the persisted probe pair",
	migrating([probeUser, probeAssistant, real]).length,
	1,
);
eq(
	"and keeps a real message with a probe's timestamp but another role",
	migrating([{ role: "custom", customType: "x", timestamp: 111 }]).length,
	1,
);
eq(
	"a corrupt identities entry suppresses nothing",
	createLegacyProbeFilter([{ type: "custom", customType: "pi-context-view:probe-identities", data: { messages: 7 } }])(
		[probeUser, real],
	).length,
	2,
);
// Referential identity, not just equal contents: pi reads a returned array as a
// rewrite of the context, so a session with nothing to migrate must return the
// very array it was handed.
const clean = [probeUser, real];
const noProbeMessages = [real];
eq("a session with no probe history is untouched", createLegacyProbeFilter([])(clean), clean);
eq("and so is a session whose probe messages are already gone", migrating(noProbeMessages), noProbeMessages);

// Nothing writes the identities entry any more; the filter is read-only.
eq(
	"no runtime persists probe identities",
	fresh.entries.some((e) => e.customType === "pi-context-view:probe-identities"),
	false,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
