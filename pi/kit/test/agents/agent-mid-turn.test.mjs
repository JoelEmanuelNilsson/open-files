/**
 * A result that lands while the seat's turn is in flight, offline: it appends
 * rather than starting a second turn, it is not yet in the conversation while
 * handed, and it reaches the next step.
 */

import { check, finish } from "../support/check-harness.mjs";
import { call, lastUserText, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";

// ---------------------------------------------------------------------------
// A result landing mid-turn appends; it never starts a second turn
// ---------------------------------------------------------------------------
{
	console.log("\na result landing mid-turn");
	const seat = await mainSeat();
	let turns = 0;
	seat.session.subscribe((event) => { if (event.type === "agent_start") turns++; });
	scriptFor("start one and keep working", [
		[call("Agent", { description: "quick job", prompt: "Land while I work.", name: "quick" })],
		{ delay: 1200, content: [text("still working")] },
	]);
	scriptFor("Land while I work.", [{ delay: 300, content: [text("Landed mid-turn.")] }]);
	await seat.session.prompt("start one and keep working");
	await seat.session.waitForIdle();
	check("the result arrived", seat.customs().some((m) => m.content.includes("<result>Landed mid-turn.</result>")), seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	check("as an append to the turn in flight, not a second turn", turns === 1, String(turns));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// Mid-turn, a handed result is not yet in the conversation (fault (a))
//
// `publishSettled` gives the text to pi's queue, which appends it at the end of
// the turn in flight. A `TaskOutput` asked during that window used to answer
// "scroll back" — pointing at a message that was not there yet, and would not
// be until after the caller had stopped looking.
// ---------------------------------------------------------------------------
{
	console.log("\na result handed but not yet in the conversation");
	const seat = await mainSeat();
	scriptFor("start one and ask mid-turn", [
		[call("Agent", { description: "quick job", prompt: "Land while I ask.", name: "quick" })],
		{ delay: 900, content: [call("TaskOutput", { names: ["quick"], block: false })] },
		{ delay: 300, content: [text("still working")] },
	]);
	scriptFor("Land while I ask.", [{ delay: 300, content: [text("Landed mid-turn.")] }]);
	await seat.session.prompt("start one and ask mid-turn");
	await seat.session.waitForIdle();
	const asked = seat.toolResults()[1]?.content[0].text ?? "";
	check("a seat is never sent looking for a message that has not landed", !asked.includes("scroll back"), asked);
	check("it is told where the result actually is: pi's queue", asked.includes("queued for your conversation; it arrives on its own before your next step"), asked);
	check("and told not to wait on it again", asked.includes("do not wait again"), asked);
	check("the promise is kept: the text does arrive in the conversation", seat.customs().some((m) => m.content.includes("<result>Landed mid-turn.</result>")), seat.customs().map((m) => m.content.slice(0, 60)).join(" | "));
	seat.session.dispose();
}

// ---------------------------------------------------------------------------
// A result that settles mid-turn is steered: pi drains steering after every
// step and follow-ups only where the seat would stop, so a follow-up waited out
// the whole turn (Joel's defect 3).
// ---------------------------------------------------------------------------
{
	console.log("\na result that settles mid-turn reaches the next step");
	const seat = await mainSeat();
	scriptFor("start one and take another step", [
		[call("Agent", { description: "quick job", prompt: "Land before my next step.", name: "stepper" })],
		{ delay: 1500, content: [call("read", { path: `${KIT_ROOT}/package.json` })] },
		[text("done stepping")],
	]);
	scriptFor("Land before my next step.", [{ delay: 300, content: [text("Landed before the next step.")] }]);
	await seat.session.prompt("start one and take another step");
	await seat.session.waitForIdle();
	const steps = requests.filter((r) => lastUserText(r) === "start one and take another step");
	check("the step after the one it settled in already reads it", JSON.stringify(steps[2]?.messages ?? []).includes("<result>Landed before the next step.</result>"), `${steps.length} steps`);
	seat.session.dispose();
}

await finish();
