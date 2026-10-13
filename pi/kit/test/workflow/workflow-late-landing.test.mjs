/**
 * A workflow child whose spawn or nudge is still in flight when its run ends
 * is stopped as it lands, offline. The seat is `support/workflow-seat.mjs`'s: a real pi session on a scripted provider, with the engine and `Workflow` loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { META, call, mainSeat, onLifecycle, quiet, requests, scriptFor, text } from "../support/workflow-seat.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { until } from "../support/async-waits.mjs";

const jiti = kitJiti({ moduleCache: false });

// I: a child whose spawn or nudge is still in flight when the run ends is stopped as it lands
{
	console.log("\nWorkflow: a child that lands after its run ended");
	const { descendantStoppers } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-live-runs.ts`);
	const seat = await mainSeat();
	const settledAs = (name) => seat.events.filter((e) => e.name === name && (e.channel === "subagents:completed" || e.channel === "subagents:failed")).map((e) => e.status);
	// The stop lands inside the engine's spawn, between the record going up and the child's session starting,
	// and the session takes 500 ms to start: the run has ended long before the child lands.
	globalThis.__workflowTestSpawnDelayMs = 500;
	let runTaskId;
	onLifecycle.at = (event) => {
		if (event.channel === "subagents:created" && event.type === "workflow") runTaskId = event.id;
		if (event.channel === "subagents:created" && event.name === "orphan") void descendantStoppers().get(runTaskId)?.();
	};
	scriptFor("run the orphan workflow", [[call("Workflow", { script: `${META}return agent('Outlive the run.', { label: 'orphan' })` })], [text("started")]]);
	scriptFor("Outlive the run.", [{ delay: 1000, content: [text("outlived it")] }]);
	await seat.session.prompt("run the orphan workflow");
	await seat.session.waitForIdle();
	await until(() => settledAs("orphan").length > 0, 6000);
	await quiet(seat);
	check("a child whose spawn was in flight when the run was stopped is stopped once it lands, not left to run", settledAs("orphan").join() === "stopped" && seat.events.some((e) => e.channel === "subagents:failed" && e.type === "workflow" && e.status === "stopped"), `${settledAs("orphan").join()} · ${seat.events.filter((e) => e.type === "workflow").map((e) => `${e.channel}:${e.status}`).join()}`);
	const resultOf = (name) => seat.events.filter((e) => e.name === name && e.channel === "subagents:failed").map((e) => e.result ?? "").join();
	check("and the stop aborts its first turn rather than letting it run out", !resultOf("orphan").includes("outlived it"), resultOf("orphan"));

	// The same for the nudge: the run is stopped while the engine resumes a schema child.
	onLifecycle.at = (event) => {
		if (event.channel === "subagents:created" && event.type === "workflow") runTaskId = event.id;
		if (event.channel === "subagents:resumed" && event.name === "forgetter") void descendantStoppers().get(runTaskId)?.();
	};
	scriptFor("run the forgetful workflow", [[call("Workflow", { script: `${META}return agent('Forget the call.', { label: 'forgetter', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })` })], [text("started")]]);
	scriptFor("Forget the call.", [[text("no call from me")]]);
	scriptFor("You ended without calling StructuredOutput", [{ delay: 1000, content: [call("StructuredOutput", { result: { n: 1 } })] }, [text("done")]]);
	await seat.session.prompt("run the forgetful workflow");
	await seat.session.waitForIdle();
	await until(() => settledAs("forgetter").length > 1, 6000);
	await quiet(seat);
	check("a child whose nudge was in flight when the run was stopped is stopped once it resumes, not left to run", settledAs("forgetter").join() === "completed,stopped", settledAs("forgetter").join());
	check("and the stop aborts the nudge's turn rather than letting it run out", !requests.some((r) => r.messages.some((m) => m.role === "toolResult" && m.toolName === "StructuredOutput")), resultOf("forgetter"));
	onLifecycle.at = undefined;
	globalThis.__workflowTestSpawnDelayMs = 0;
	seat.session.dispose();
}

await finish();
