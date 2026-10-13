/**
 * The session scope (`lib/session/session-scope.ts`): the one way an extension
 * starts a turn of its own, refused until the runtime's first user turn, while a
 * switch is coming and once shutdown begins — across every scope of one
 * runtime, and not across a reload's new one. Several extensions share one
 * event bus here, as pi loads them. Then the same refusals on real pi seats
 * driven by a scripted provider: a result that settles while a user prompt is
 * starting, and a background command that ends while shutdown runs.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, importPi, kitJiti } from "../support/pi-package.mjs";
import { fakeExtensionApi } from "../support/fake-extension-api.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import { createScriptedAgentDir, createScriptedModel, scriptedCall as call, scriptedMainSeat, scriptedText as text } from "../support/scripted-seat.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });
const { createEventBus } = await importPi("dist/core/event-bus.js");

const AGENT_DIR = createScriptedAgentDir("session-scope");
process.env.PI_AGENT_CHILD_EXTENSIONS = childExtensionsList("extensions/agent-engine/index.ts");
const scripted = createScriptedModel();
const { scriptFor, requests } = scripted;
const provider = scripted.providerExtension();
/** A request's conversation, without the leading system message pi-ai folds the prompt and tools into. */
const userTextsOf = (request) => request.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));

console.log("the session scope");
{
	let scopes;
	try { scopes = await jiti.import(`${KIT_ROOT}/lib/session/session-scope.ts`); } catch (error) { check("lib/session/session-scope.ts loads", false, error.message.split("\n")[0]); }
	if (scopes !== undefined) {
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		// One extension runtime: several factories on one event bus, as pi loads them.
		const runtime = () => {
			const bus = createEventBus();
			const extension = () => {
				const pi = fakeExtensionApi({ events: bus });
				const fire = (event) => pi.fire(event, { type: event }, {});
				return { scope: scopes.createSessionScope(pi.api), sent: pi.sentMessages, fire };
			};
			return { extension };
		};
		const message = { customType: "t", content: "x", display: true };
		const first = runtime();
		const engine = first.extension();
		const bash = first.extension();
		check("unprimed: startTurn returns false and sends nothing", engine.scope.startTurn(message) === false && engine.sent.length === 0);
		await engine.fire("before_agent_start");
		check("once before_agent_start has fired, startTurn steers with triggerTurn and returns true", engine.scope.startTurn(message) === true && engine.sent.length === 1 && engine.sent[0].options.triggerTurn === true && engine.sent[0].options.deliverAs === "steer");
		await bash.fire("before_agent_start");
		// pi emits the switch to every extension, so every scope of the runtime refuses.
		const refusing = () => engine.scope.startTurn(message) === false && bash.scope.startTurn(message) === false && engine.sent.length === 1 && bash.sent.length === 0;
		const runStarts = async () => { await engine.fire("agent_start"); await bash.fire("agent_start"); };
		const open = () => {
			const ok = engine.scope.startTurn(message) === true && bash.scope.startTurn(message) === true;
			engine.sent.splice(1);
			bash.sent.splice(0);
			return ok;
		};
		for (const begins of ["session_before_switch", "session_before_fork"]) {
			await engine.fire(begins);
			await bash.fire(begins);
			const refused = refusing();
			// A cancelled switch: the refusal ends when the next run starts.
			await runStarts();
			check(`${begins}: every scope refuses until the next agent_start`, refused && open());
		}
		let fired = 0;
		bash.scope.timeout(5, () => fired++);
		bash.scope.interval(5, () => fired++);
		await engine.fire("session_shutdown");
		check("the first shutdown handler closes every scope of the runtime", engine.scope.signal.aborted && bash.scope.signal.aborted);
		check("closed: startTurn returns false and sends nothing", bash.scope.startTurn(message) === false && bash.sent.length === 0 && engine.scope.startTurn(message) === false && engine.sent.length === 1);
		await pause(30);
		check("closed: its timers are cleared, and a new one never starts", fired === 0 && (bash.scope.timeout(1, () => fired++), await pause(10), fired === 0));
		// A reload reuses the loader's bus: the new runtime's scopes share it with the closed ones.
		const reloaded = first.extension();
		check("a reload is a new runtime on the same bus, and it starts unprimed and open", reloaded.scope.startTurn(message) === false && reloaded.sent.length === 0 && !reloaded.scope.signal.aborted);
		await engine.fire("session_shutdown");
		await bash.fire("session_shutdown");
		await reloaded.fire("before_agent_start");
		check("the old runtime's shutdown does not close the new runtime's scopes", !reloaded.scope.signal.aborted && reloaded.scope.startTurn(message) === true && reloaded.sent.length === 1);
	}
}

// Between accepting a user prompt and starting its run, pi reads as idle
// (`isStreaming` is false through `_checkCompaction` and the
// `before_agent_start` handlers). A result that started its own turn there took
// the run, and the user's prompt threw "Agent is already processing a prompt".
console.log("\na result that settles while a user prompt is starting");
for (const moment of ["input", "before_agent_start"]) {
	console.log(`  -- during ${moment}`);
	const tag = `window-${moment}`;
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	let armed = false;
	let seat;
	const settle = async () => {
		if (!armed) return;
		armed = false;
		(await attached).end();
		await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
	};
	// Loaded after the engine, so its hook runs after the engine's (and its scope's) handlers for the same event.
	const settleInWindow = (pi) => {
		pi.on(moment, async () => { await settle(); return undefined; });
	};
	seat = await scriptedMainSeat(scripted, { extensions: ["extensions/agent-engine/index.ts"], factories: [provider, settleInWindow] });
	const main = seat.session;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles in the window", prompt: `${tag} child works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach } }]);
	scriptFor(`the ${tag} turn`, [[text("answered")], [text("answered again")]]);
	await main.prompt(`Spawn the ${tag} child`);
	await main.waitForIdle();
	let starts = 0;
	main.subscribe((event) => { if (event.type === "agent_start") starts++; });
	const before = requests.length;
	armed = true;
	let refused;
	try { await main.prompt(`the ${tag} turn`); } catch (error) { refused = error; }
	await main.waitForIdle();
	const turn = requests.slice(before).filter((r) => r.sessionId === main.sessionId);
	check(`${moment}: the user's prompt is not refused as already processing`, refused === undefined, refused?.message);
	check(`${moment}: one run, the user's`, starts === 1 && turn.length > 0 && userTextsOf(turn[0]).some((t) => t === `the ${tag} turn`), `${starts} runs; first request users ${JSON.stringify(turn[0] && userTextsOf(turn[0]))}`);
	check(`${moment}: the result arrives in that run`, turn.some((r) => JSON.stringify(r.messages).includes(`${tag} child done`)), `${turn.length} requests`);
	main.dispose();
}

// A submit another extension handles (side mode, a focused agent) starts no main
// run. On 2026-09-24 a lead settled after one while main was idle, and its result
// waited for Joel's next message.
console.log("\na result that settles after an idle submit another extension handled");
{
	const tag = "claimed-input";
	let attach;
	const attached = new Promise((resolve) => { attach = resolve; });
	// Loaded after the engine, as side-chat is in readdir order, so the engine's scope sees the input first.
	const claimer = (pi) => {
		pi.on("input", (event) => (event.text === "to the side" ? { action: "handled" } : undefined));
	};
	const seat = await scriptedMainSeat(scripted, { extensions: ["extensions/agent-engine/index.ts"], factories: [provider, claimer] });
	const main = seat.session;
	scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "settles while main is idle", prompt: `${tag} child works`, name: tag })], [text("spawned")]]);
	scriptFor(`${tag} child works`, [{ content: [text(`${tag} child done`)], live: { attach } }]);
	await main.prompt(`Spawn the ${tag} child`);
	await main.waitForIdle();
	await main.prompt("to the side");
	const before = requests.length;
	(await attached).end();
	await until(() => seat.events.some((e) => e.channel === "subagents:completed" && e.name === tag), 5000);
	const delivered = await until(() => requests.slice(before).some((r) => r.sessionId === main.sessionId && JSON.stringify(r.messages).includes(`${tag} child done`)), 3000);
	check("the result starts a main turn with no user message", delivered, `${requests.slice(before).filter((r) => r.sessionId === main.sessionId).length} main requests after the settle`);
	await main.waitForIdle();
	main.dispose();
}

console.log("\nno turn starts during shutdown");
{
	process.env.PI_KIT_BACKGROUND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "session-scope-background-"));
	// Stands in for a shutdown handler that awaits (the engine's retire will), registered between two scoped extensions.
	const slow = path.join(AGENT_DIR, "slow-shutdown.ts");
	fs.writeFileSync(slow, "export default function (pi) { pi.on(\"session_shutdown\", async () => { await globalThis.__slowShutdown?.(); }); }\n");
	const seat = await scriptedMainSeat(scripted, { extensions: ["extensions/agent-engine/index.ts", slow, "extensions/bash/index.ts"], factories: [provider] });
	const main = seat.session;
	scriptFor("Start a background sleep", [[call("bash", { command: "sleep 0.4; echo slept", run_in_background: true })], [text("started")], [text("a turn during shutdown")]]);
	await main.prompt("Start a background sleep");
	await main.waitForIdle();
	const before = requests.length;
	let turns = 0;
	main.subscribe((event) => { if (event.type === "agent_start") turns++; });
	globalThis.__slowShutdown = () => sleep(1200);
	await seat.runtime.dispose();
	delete globalThis.__slowShutdown;
	check("a background command that ends while shutdown runs starts no turn", turns === 0 && requests.length === before, `${turns} turns, ${requests.length - before} requests`);
	fs.rmSync(process.env.PI_KIT_BACKGROUND_DIR, { recursive: true, force: true });
	delete process.env.PI_KIT_BACKGROUND_DIR;
}

await finish();
