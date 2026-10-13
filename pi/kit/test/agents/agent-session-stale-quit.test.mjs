/**
 * No extension ctx is stale after a quit with work in flight: a plain quit, a
 * quit mid-compaction, and the dock's
 * stop reply after quit. The switches are
 * `agent-session-stale-switch.test.mjs`. The seats are
 * `support/session-lifecycle-seat.mjs`'s.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, liveCount, liveStreamOf, mainSeat, scriptFor, scriptedProvider, staleReport, text, watchForStale, wireSeat } from "../support/session-lifecycle-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { sleep, until } from "../support/async-waits.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

console.log("\nno extension ctx is stale across a quit with work in flight");
{
	process.env.PI_KIT_BACKGROUND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stale-quit-background-"));
	// The watchdog's warning is the pending timer: armed by the seat's own run, due after the switch.
	process.env.PI_WATCHDOG_MS = "1500";
	process.env.PI_WATCHDOG_MODE = "warn";
	const extensions = ["agent-engine/index", "wire/index", "bash/index", "watchdog/index", "side-chat/index", "workflow/index", "agent-dock/index", "zen-chrome/index"].map((name) => `${KIT_ROOT}/extensions/${name}.ts`);
	{
		const via = "quit";
		const tag = `stale-${via.replaceAll(" ", "-")}`;
		const child = liveStreamOf();
		const own = liveStreamOf();
		const found = await watchForStale(async () => {
			const seat = await wireSeat({ extensions });
			const old = seat.session();
			scriptFor(`Start the ${tag} work`, [[call("Agent", { description: "streams", prompt: `${tag} child streams`, name: tag }), call("bash", { command: "sleep 0.4; echo slept", run_in_background: true })], { content: [text("still streaming")], live: own }]);
			scriptFor(`${tag} child streams`, [{ content: [text(`${tag} child done`)], live: child }]);
			const prompted = old.prompt(`Start the ${tag} work`);
			await child.attached;
			await own.attached;
			await seat.runtime.dispose();
			(await child.attached).end();
			(await own.attached).end();
			await prompted.catch(() => {});
			// Past the background command, the watchdog's warning and a macrotask of slack.
			await sleep(1800);
		});
		check(`${via}: nothing reaches a stale runtime`, found.calls.length === 0 && found.lines.length === 0 && found.staleFiles.length === 0, staleReport(found));
	}
	delete process.env.PI_WATCHDOG_MS;
	delete process.env.PI_WATCHDOG_MODE;
	fs.rmSync(process.env.PI_KIT_BACKGROUND_DIR, { recursive: true, force: true });
	delete process.env.PI_KIT_BACKGROUND_DIR;
}

console.log("\na quit mid-compaction");
{
	const summary = liveStreamOf();
	const seat = await mainSeat();
	const session = seat.session();
	// Two turns past pi's 20k-token keep-recent window, so the first has something to summarise.
	const filler = "words ".repeat(20_000);
	scriptFor("compact-me", [[text("noted")], { content: [text("the summary")], live: summary }]);
	scriptFor("more", [[text("noted too")]]);
	await session.prompt(`compact-me ${filler}`);
	await session.prompt(`more ${filler}`);
	const compacting = session.compact().catch(() => {});
	await summary.attached;
	// Whether a bound fired, not how long quit took: under load the compaction's end can itself take a second.
	const boundsFired = [];
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout((...inner) => {
		if (ms >= 1000) boundsFired.push(ms);
		return fn(...inner);
	}, ms, ...args);
	const startedAt = Date.now();
	try { await seat.runtime.dispose(); } finally { globalThis.setTimeout = realSetTimeout; }
	const took = Date.now() - startedAt;
	const firedDuringQuit = [...boundsFired];
	await compacting;
	// No run settles a compaction: waiting for one held quit for the whole settle bound.
	check("waits for the compaction's end, not the settle bound", firedDuringQuit.length === 0, `bounds of ${firedDuringQuit.join(", ")}ms fired; quit took ${took}ms`);
}

console.log("\nthe dock's stop reply after quit");
{
	const tag = "stop-after-quit";
	const child = liveStreamOf();
	let bus;
	const found = await watchForStale(async () => {
		const seat = await mainSeat({ provider: (pi) => { scriptedProvider(pi); bus = pi.events; } });
		const main = seat.session();
		scriptFor(`Spawn the ${tag} child`, [[call("Agent", { description: "ignores abort", prompt: `${tag} works`, name: tag })], [text("spawned")]]);
		scriptFor(`${tag} works`, [{ content: [text("late words")], live: child, ignoreAbort: true }]);
		await main.prompt(`Spawn the ${tag} child`);
		const controls = await child.attached;
		// The stop is still waiting on a child that ignores its abort when quit invalidates the seat.
		bus.emit("subagents:rpc:stop", { requestId: tag, agentId: tag });
		await seat.runtime.dispose();
		controls.end();
		await until(() => liveCount() === 0, 3000);
		await sleep(100);
	});
	check("a stop that resolves after quit replies to no one", found.calls.length === 0 && found.lines.length === 0, staleReport(found));
}

await finish();
