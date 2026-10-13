/**
 * No extension ctx is stale across a session switch — /new and a reload —
 * with work in flight: every timer, reply and long await of an
 * extension lives on its session scope. The quits are
 * `agent-session-stale-quit.test.mjs`. The seats are
 * `support/session-lifecycle-seat.mjs`'s.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, liveStreamOf, scriptFor, staleReport, text, watchForStale, wireSeat } from "../support/session-lifecycle-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { sleep } from "../support/async-waits.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Every timer, reply and long await of an extension lives on its session
// scope, so nothing a runtime started reaches pi after its session ends.
// ---------------------------------------------------------------------------

console.log("\nno extension ctx is stale across /new and reload with work in flight");
{
	process.env.PI_KIT_BACKGROUND_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stale-switch-background-"));
	// The watchdog's warning is the pending timer: armed by the seat's own run, due after the switch.
	process.env.PI_WATCHDOG_MS = "1500";
	process.env.PI_WATCHDOG_MODE = "warn";
	const extensions = ["agent-engine/index", "wire/index", "bash/index", "watchdog/index", "side-chat/index", "workflow/index", "agent-dock/index", "zen-chrome/index"].map((name) => `${KIT_ROOT}/extensions/${name}.ts`);
	for (const via of ["new", "reload"]) {
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
			if (via === "new") await seat.runtime.newSession({});
			else await old.reload();
			(await child.attached).end();
			(await own.attached).end();
			await prompted.catch(() => {});
			// Past the background command, the watchdog's warning and a macrotask of slack.
			await sleep(1800);
			await seat.runtime.dispose();
		});
		check(`${via}: nothing reaches a stale runtime`, found.calls.length === 0 && found.lines.length === 0 && found.staleFiles.length === 0, staleReport(found));
	}
	delete process.env.PI_WATCHDOG_MS;
	delete process.env.PI_WATCHDOG_MODE;
	fs.rmSync(process.env.PI_KIT_BACKGROUND_DIR, { recursive: true, force: true });
	delete process.env.PI_KIT_BACKGROUND_DIR;
}

await finish();
