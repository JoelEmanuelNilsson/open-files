/**
 * The turn watchdog (extensions/watchdog/): the silence clock and its texts
 * driven on a fake clock, then the entry's wiring on real timers.
 */

import { check, finish } from "../support/check-harness.mjs";
import { until } from "../support/async-waits.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });

// ---------------------------------------------------------------------------
console.log("watchdog");
{
	const W = {
		...(await jiti.import(`${KIT_ROOT}/extensions/watchdog/silence-watchdog.ts`)),
		...(await jiti.import(`${KIT_ROOT}/extensions/watchdog/watchdog-message.ts`)),
	};

	/** Deterministic time. `advance` fires due timers in order, moving `now` to each. */
	const fakeClock = () => {
		let now = 0;
		const timers = [];
		return {
			now: () => now,
			schedule: (delayMs, fire) => {
				const timer = { at: now + delayMs, fire, dead: false };
				timers.push(timer);
				return () => { timer.dead = true; };
			},
			live: () => timers.filter((t) => !t.dead).length,
			advance(ms) {
				const target = now + ms;
				for (;;) {
					const due = timers.filter((t) => !t.dead && t.at <= target).sort((a, b) => a.at - b.at)[0];
					if (!due) break;
					due.dead = true;
					now = due.at;
					due.fire();
				}
				now = target;
			},
		};
	};

	// 900ms stands in for 15 minutes; warn lands at 300.
	const DEADLINE = 900;
	const build = (mode = "abort") => {
		const clock = fakeClock();
		const acted = [];
		const dog = new W.Watchdog({
			deadlineMs: DEADLINE, mode,
			now: clock.now, schedule: clock.schedule,
			act: (a) => acted.push(a),
		});
		return { clock, acted, dog };
	};

	// -- arming ---------------------------------------------------------------
	{
		const { clock, acted, dog } = build();
		check("idle holds no timer", dog.timerCount === 0 && clock.live() === 0);
		dog.start();
		check("running holds exactly one", dog.timerCount === 1);
		clock.advance(DEADLINE * 2);
		check("idle-armed session with no events aborts", acted.filter((a) => a.kind === "abort").length === 1, JSON.stringify(acted));
		check("and releases its timer", dog.timerCount === 0);
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.stop();
		clock.advance(DEADLINE * 3);
		check("stop() disarms — a finished agent is never aborted", acted.length === 0);
		check("and leaves no live timer", clock.live() === 0);
	}

	// -- the observed failure: a tool that starts and never ends ---------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("t1", "grep");
		clock.advance(DEADLINE - 1);
		// Warnings escalate rather than latch: they are custom entries, which pi
		// keeps out of LLM context, so the liveness trail is free.
		check("a hung tool warns before the deadline", acted.length > 0 && acted.every((a) => a.kind === "warn"), JSON.stringify(acted));
		check("and keeps warning as the silence grows", acted.length === 2 && acted[1].silentMs > acted[0].silentMs, JSON.stringify(acted));
		check("and names the tool", acted[0].toolName === "grep");
		clock.advance(2);
		const abort = acted.find((a) => a.kind === "abort");
		check("then aborts at the deadline", Boolean(abort));
		check("blaming the hung tool", abort.toolName === "grep");
		check("with the measured silence", abort.silentMs >= DEADLINE, String(abort?.silentMs));
		clock.advance(DEADLINE * 3);
		check("and aborts exactly once", acted.filter((a) => a.kind === "abort").length === 1);
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("t1", "grep");
		clock.advance(DEADLINE - 10);
		dog.toolEnd("t1");
		clock.advance(DEADLINE - 10);
		check("a tool that returns resets the clock", acted.every((a) => a.kind !== "abort"), JSON.stringify(acted));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("slow", "web_search");
		dog.toolStart("fast", "read");
		clock.advance(DEADLINE - 100);
		dog.toolEnd("fast");
		clock.advance(DEADLINE - 100);
		check("a sibling finishing counts as progress for the batch", !acted.some((a) => a.kind === "abort"));
		clock.advance(200);
		check("but the batch still dies on the survivor", acted.at(-1).kind === "abort" && acted.at(-1).toolName === "web_search", JSON.stringify(acted.at(-1)));
	}

	// -- the latent failure: a stalled stream, no tool in flight ---------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.touch();
		clock.advance(DEADLINE + 1);
		const abort = acted.find((a) => a.kind === "abort");
		check("a stalled model stream aborts too", Boolean(abort));
		check("and is reported as stream silence, not a tool", abort.toolName === undefined);
		check("the reason says so", W.abortReason(abort, DEADLINE).includes("the model stream"));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		for (let i = 0; i < 400; i++) { clock.advance(2); dog.touch(); }
		check("streaming deltas keep it alive", acted.length === 0);
		check("and never churn timers — one live, whatever the token rate", dog.timerCount === 1 && clock.live() === 1, String(clock.live()));
	}

	// -- waits this session does not own --------------------------------------
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("a1", "TaskOutput");
		clock.advance(DEADLINE * 20);
		check("waiting on a child never aborts the parent", acted.length === 0, JSON.stringify(acted));
		dog.toolEnd("a1");
		clock.advance(DEADLINE + 1);
		check("but the deadline runs again once the wait returns", acted.some((a) => a.kind === "abort"));
	}
	for (const name of ["Agent"]) {
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("x", name);
		clock.advance(DEADLINE * 5);
		check(`${name} is bounded elsewhere, not here`, acted.length === 0);
	}
	{
		// The kit's own bash defaults and clamps its timeout and moves a long
		// command to the background: a silent bash is a quiet command, not a wedge.
		const { clock, acted, dog } = build("warn");
		dog.start();
		dog.toolStart("x", "bash");
		clock.advance(DEADLINE * 5);
		check("bash is bounded by itself — no warning, no abort", acted.length === 0, JSON.stringify(acted));
	}
	{
		const { clock, acted, dog } = build();
		dog.start();
		dog.toolStart("wait", "TaskOutput");
		dog.toolStart("hung", "grep");
		clock.advance(DEADLINE * 3);
		check("one exempt tool shields the whole batch", acted.length === 0, JSON.stringify(acted));
		dog.toolEnd("wait");
		clock.advance(DEADLINE + 1);
		check("and the hung sibling is blamed once the shield lifts", acted.at(-1).kind === "abort" && acted.at(-1).toolName === "grep");
	}

	// -- warn mode: a human is watching ---------------------------------------
	{
		const { clock, acted, dog } = build("warn");
		dog.start();
		dog.toolStart("t", "web_search");
		clock.advance(DEADLINE * 6);
		check("warn mode never aborts", acted.every((a) => a.kind === "warn"), JSON.stringify(acted.map((a) => a.kind)));
		check("and warns once for the whole silence, not every few minutes", acted.length === 1, String(acted.length));
		dog.touch();
		clock.advance(DEADLINE);
		check("a new silence after activity warns again", acted.length === 2, String(acted.length));
	}

	// -- what the reader is told ----------------------------------------------
	{
		check("humanMs: seconds under 90", W.humanMs(42_000) === "42s");
		check("humanMs: minutes above", W.humanMs(900_000) === "15m" && W.humanMs(2_552_421) === "43m");
		const reason = W.abortReason({ kind: "abort", toolName: "grep", silentMs: 902_000 }, 900_000);
		check("the abort reason names the watchdog", reason.startsWith("watchdog:"));
		check("names the tool", reason.includes("`grep`"));
		check("gives the silence and the deadline", reason.includes("15m"));
		check("warns the answer above it is partial", reason.includes("partial"));
		check("and points at the trigger", reason.includes("$HOME"));
		check("the warning is one line", !W.warnMessage({ kind: "warn", toolName: "grep", silentMs: 300_000 }, 900_000).includes("\n"));
		check("in abort mode it says when the abort comes", W.warnMessage({ kind: "warn", toolName: "grep", silentMs: 300_000 }, 900_000, "abort").includes("aborts at 15m"));
		check("in warn mode it names no deadline — none is coming — and says what to do", (() => { const m = W.warnMessage({ kind: "warn", toolName: undefined, silentMs: 1_200_000 }, 900_000, "warn"); return !m.includes("15m") && m.includes("Esc") && m.includes("model stream"); })());

		// Real oracle, not a copy of the pattern list: pi auto-retries an errored
		// turn whose text looks transient. A watchdog abort is the opposite of
		// transient — retrying re-runs the tool that hung. If pi-ai ever adds a
		// pattern this wording trips, this check is how we find out.
		const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/compat");
		const retryable = (text) => isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: text });
		check("the oracle is live", retryable("connection error") === true && retryable("bad request") === false);
		check("a watchdog abort never reads as a transient error", retryable(reason) === false, reason);
		check("...whatever it is blaming", ["bash", "grep", "web_search", undefined].every((t) => !retryable(W.abortReason({ kind: "abort", toolName: t, silentMs: 900_000 }, 900_000))));
	}

	// -- configuration ---------------------------------------------------------
	{
		check("a TUI session warns — a human can see a hang and press Esc", W.resolveMode("tui", undefined) === "warn");
		check("an unattended session aborts", W.resolveMode("print", undefined) === "abort" && W.resolveMode("rpc", undefined) === "abort");
		check("PI_WATCHDOG_MODE overrides both ways", W.resolveMode("tui", "abort") === "abort" && W.resolveMode("print", "warn") === "warn");
		check("and can turn it off", W.resolveMode("print", "off") === "off");
		check("garbage in PI_WATCHDOG_MODE is ignored", W.resolveMode("print", "maybe") === "abort");
		// The deadline lives in `lib/`, not here.
		const { resolveDeadlineMs } = await jiti.import(`${KIT_ROOT}/lib/session/silence-deadline.ts`);
		check("default deadline is 15 minutes", resolveDeadlineMs(undefined) === 900_000);
		check("PI_WATCHDOG_MS overrides it", resolveDeadlineMs("60000") === 60_000);
		check("a nonsense deadline falls back", resolveDeadlineMs("soon") === 900_000 && resolveDeadlineMs("-5") === 900_000);
	}

	// -- wiring: the abort reaches the session and the parent ------------------
	{
		const wire = async (mode, env) => {
			const handlers = new Map();
			const entries = [];
			const notices = [];
			let aborts = 0;
			const renderers = new Map();
			const api = {
				events: { on: () => () => {}, emit: () => {} },
				on: (e, h) => handlers.set(e, h),
				appendEntry: (type, data) => entries.push({ type, data }),
				registerEntryRenderer: (type, render) => renderers.set(type, render),
			};
			let idle = false;
			let branch = [];
			const c = { mode, isIdle: () => idle, abort: () => { aborts++; }, ui: { notify: (m, l) => notices.push([m, l]) }, sessionManager: { getBranch: () => branch } };
			const setIdle = (v) => { idle = v; };
			const setBranch = (v) => { branch = v; };
			const saved = { ...process.env };
			Object.assign(process.env, env);
			try {
				const mod = await jiti.import(`${KIT_ROOT}/extensions/watchdog/index.ts?${mode}${JSON.stringify(env)}`);
				mod.default(api);
			} finally {
				for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
			}
			return { handlers, entries, notices, renderers, c, setIdle, setBranch, aborts: () => aborts };
		};

		const w = await wire("print", { PI_WATCHDOG_MS: "40" });
		check("the extension binds the events that mean liveness",
			["agent_start", "agent_settled", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"].every((e) => w.handlers.has(e)),
			[...w.handlers.keys()].join(","));

		w.handlers.get("agent_start")({}, w.c);
		w.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, w.c);
		await until(() => w.aborts() === 1);
		check("a real hung tool aborts its own session", w.aborts() === 1, String(w.aborts()));
		check("and records why, where the abort cannot erase it", w.entries.some((e) => e.type === "watchdog" && e.data.text.includes("grep")), JSON.stringify(w.entries));

		// The entry has to survive rendering: a throwing renderer is only found the
		// day something goes wrong, which is the day it must not.
		const render = w.renderers.get("watchdog");
		const theme = { fg: (_c, s) => s };
		const drawn = render({ type: "custom", customType: "watchdog", data: w.entries[0].data }, {}, theme);
		check("the recorded entry renders", typeof drawn?.render === "function", String(drawn));
		check("and survives an entry with no data", typeof render({ type: "custom", customType: "watchdog" }, {}, theme)?.render === "function");

		// The parent reads finalTurnError -> errorMessage. Rewrite it or it says
		// "This operation was aborted", which names neither cause nor culprit.
		const aborted = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" };
		const rewritten = w.handlers.get("message_end")({ message: aborted }, w.c);
		check("the aborted turn's error names the watchdog", rewritten?.message.errorMessage.startsWith("watchdog:"), JSON.stringify(rewritten));
		check("and keeps the role, or pi drops the replacement", rewritten.message.role === "assistant");
		check("leaving the rest of the message intact", rewritten.message.stopReason === "error" && Array.isArray(rewritten.message.content));
		check("the reason is consumed once", w.handlers.get("message_end")({ message: { ...aborted } }, w.c) === undefined);

		// The shape that would otherwise settle the child as "completed": a parent
		// reports a failure only for stopReason "error".
		const w2 = await wire("print", { PI_WATCHDOG_MS: "40" });
		w2.handlers.get("agent_start")({}, w2.c);
		w2.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, w2.c);
		await until(() => w2.aborts() === 1);
		const softAbort = w2.handlers.get("message_end")({ message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted" } }, w2.c);
		check("a stopReason:aborted turn is caught too", softAbort?.message.errorMessage.startsWith("watchdog:"), JSON.stringify(softAbort));
		check("and normalised to error, or the parent reads it as completed", softAbort.message.stopReason === "error");
		check("isFailedAssistant covers both shapes and nothing else",
			W.isFailedAssistant({ role: "assistant", stopReason: "error" })
			&& W.isFailedAssistant({ role: "assistant", stopReason: "aborted" })
			&& !W.isFailedAssistant({ role: "assistant", stopReason: "stop" })
			&& !W.isFailedAssistant({ role: "user", stopReason: "error" })
			&& !W.isFailedAssistant(null) && !W.isFailedAssistant(undefined));

		const clean = await wire("print", { PI_WATCHDOG_MS: "40" });
		clean.handlers.get("agent_start")({}, clean.c);
		check("a healthy turn's message is never rewritten", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "stop" } }, clean.c) === undefined);
		check("nor an unrelated provider error", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } }, clean.c) === undefined);
		check("nor a human pressing Esc", clean.handlers.get("message_end")({ message: { role: "assistant", stopReason: "aborted", errorMessage: "Operation aborted" } }, clean.c) === undefined);
		clean.handlers.get("agent_settled")({}, clean.c);
		await new Promise((r) => setTimeout(r, 120));
		check("a settled turn is never aborted after the fact", clean.aborts() === 0);

		// agent_end fires once per agent run, and a retry produces several inside
		// one turn. Disarming on it would leave the retried turn unwatched.
		const retried = await wire("print", { PI_WATCHDOG_MS: "40" });
		retried.handlers.get("agent_start")({}, retried.c);
		retried.handlers.get("agent_end")({ messages: [] }, retried.c);
		retried.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, retried.c);
		await until(() => retried.aborts() === 1);
		check("a retried turn stays watched past agent_end", retried.aborts() === 1, String(retried.aborts()));

		// A reload keeps the run going but starts none, so the new instance sees no agent_start for it.
		const reloaded = await wire("print", { PI_WATCHDOG_MS: "40" });
		reloaded.handlers.get("session_start")?.({ reason: "reload" }, reloaded.c);
		await until(() => reloaded.aborts() === 1);
		check("a run a reload lands in stays watched", reloaded.aborts() === 1, String(reloaded.aborts()));
		// The tools running at the reload are read off the branch: a call written, its result not.
		const message = (m) => ({ type: "message", message: m });
		const midTool = (name) => [
			message({ role: "assistant", content: [{ type: "toolCall", id: "old", name: "grep" }] }),
			message({ role: "toolResult", toolCallId: "old" }),
			message({ role: "assistant", content: [{ type: "toolCall", id: "done", name: "read" }, { type: "toolCall", id: "live", name }] }),
			message({ role: "toolResult", toolCallId: "done" }),
		];
		const reloadedWaiting = await wire("print", { PI_WATCHDOG_MS: "40" });
		reloadedWaiting.setBranch(midTool("bash"));
		reloadedWaiting.handlers.get("session_start")?.({ reason: "reload" }, reloadedWaiting.c);
		await new Promise((r) => setTimeout(r, 120));
		check("a self-bounded tool running at the reload is still known, so its silence does not count", reloadedWaiting.aborts() === 0, String(reloadedWaiting.aborts()));
		const reloadedHung = await wire("print", { PI_WATCHDOG_MS: "40" });
		reloadedHung.setBranch(midTool("find"));
		reloadedHung.handlers.get("session_start")?.({ reason: "reload" }, reloadedHung.c);
		await until(() => reloadedHung.aborts() === 1);
		check("and a hung one running at the reload is named in the abort", reloadedHung.aborts() === 1 && reloadedHung.entries.some((e) => e.data.text.includes("find")), JSON.stringify(reloadedHung.entries));
		const reloadedIdle = await wire("print", { PI_WATCHDOG_MS: "40" });
		reloadedIdle.setIdle(true);
		reloadedIdle.handlers.get("session_start")?.({ reason: "reload" }, reloadedIdle.c);
		await new Promise((r) => setTimeout(r, 120));
		check("and an idle reload arms nothing", reloadedIdle.aborts() === 0 && reloadedIdle.entries.length === 0, JSON.stringify(reloadedIdle.entries));

		// Belt and braces for a settle event that never arrives: isIdle() is the
		// real bit, so a quietly-finished run is disarmed, not aborted.
		const lost = await wire("print", { PI_WATCHDOG_MS: "40" });
		lost.handlers.get("agent_start")({}, lost.c);
		lost.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, lost.c);
		lost.setIdle(true);
		await new Promise((r) => setTimeout(r, 150));
		check("an idle session is never aborted, even if its settle went missing", lost.aborts() === 0 && lost.entries.length === 0, JSON.stringify(lost.entries));

		const tui = await wire("tui", { PI_WATCHDOG_MS: "40" });
		tui.handlers.get("agent_start")({}, tui.c);
		tui.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, tui.c);
		await until(() => tui.notices.length > 0);
		check("a TUI session is told, not killed", tui.aborts() === 0 && tui.notices.length > 0, `${tui.aborts()} aborts, ${tui.notices.length} notices`);
		check("the notice is a warning", tui.notices.every(([, level]) => level === "warning"));
		check("told once per warning — the toast, with no transcript entry doubling it", tui.entries.length === 0, JSON.stringify(tui.entries));
		check("and the toast names no deadline", tui.notices.every(([m]) => !m.includes("deadline")), JSON.stringify(tui.notices));

		const off = await wire("print", { PI_WATCHDOG_MODE: "off", PI_WATCHDOG_MS: "40" });
		off.handlers.get("agent_start")({}, off.c);
		off.handlers.get("tool_execution_start")({ toolCallId: "t", toolName: "grep" }, off.c);
		await new Promise((r) => setTimeout(r, 120));
		check("off means off — no timer, no abort, no entry", off.aborts() === 0 && off.entries.length === 0);
	}
}

await finish();
