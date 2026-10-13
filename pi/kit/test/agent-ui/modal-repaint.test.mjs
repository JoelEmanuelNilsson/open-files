/**
 * The dock's repaint clock: frames run only while an open overlay claims them
 * with something live, and stop on the frame after that ends. Driven on node's
 * mock timers, so a frame is a tick and never a wait on a loaded machine.
 *
 *   node test/agent-ui/modal-repaint.test.mjs
 */

import { check, eq, finish } from "../support/check-harness.mjs";
import { mock } from "node:test";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti();
const repaintModule = await jiti.import(`${KIT_ROOT}/extensions/agent-dock/modal-repaint.ts`);

// The cadence. 10fps is expensive, so the only way to reach it is an open
// overlay that claims frames while something is live — there is no flag to
// leave on, and the clock re-derives itself on every frame it fires.
console.log("modal-repaint: the repaint clock");
{
	const { ModalRepaint } = repaintModule;
	mock.timers.enable({ apis: ["setInterval"] });
	let live = false;
	let paints = 0;
	const clock = new ModalRepaint(5);

	check("a closed dock animates nothing", clock.animating === false);
	clock.paint();
	check("and painting a closed dock starts nothing", clock.animating === false && paints === 0);

	clock.attach(() => paints++, () => live);
	check("an open list with nothing live is still", clock.animating === false);
	live = true;
	clock.paint();
	check("the first live child starts the frames", clock.animating === true);
	const started = paints;
	mock.timers.tick(15);
	eq("which repaint the list, once a frame", paints - started, 3);

	live = false;
	mock.timers.tick(5);
	check("the last child settling stops the clock, without anyone saying so", clock.animating === false);
	const settled = paints;
	mock.timers.tick(20);
	eq("after which nothing repaints at all", paints, settled);

	live = true;
	clock.paint();
	check("a new child starts it again", clock.animating === true);
	clock.detach();
	check("and closing the overlay stops it, whatever is still running", clock.animating === false);
	const closed = paints;
	mock.timers.tick(20);
	eq("a closed dock repaints nothing", paints, closed);

	clock.attach(() => paints++);
	clock.paint();
	check("an overlay that claims no frames never gets any", clock.animating === false);
	clock.detach();
	mock.timers.reset();
}

await finish();
