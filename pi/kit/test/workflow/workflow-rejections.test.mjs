/**
 * A workflow script's unhandled rejection is its run's failure; any other is
 * Node's. Each case runs in its own process, so a regression kills only it.
 */

import { check, finish } from "../support/check-harness.mjs";
import { inChild } from "../support/workflow-child-run.mjs";

// ---------------------------------------------------------------------------
// 3a. a script's unhandled rejection is its run's failure; any other is Node's
// ---------------------------------------------------------------------------
{
	console.log("\nunhandled rejections, each in its own process");
	const dropped = inChild("Promise.reject(new Error('dropped')); return 1");
	check("a promise the script drops in its last tick is a failure of the run, not a crash, and the run still returns", dropped.status === 0 && dropped.result?.value === 1 && dropped.result.failures.join() === "dropped", dropped.shown);
	check("no listener is left behind once the run has settled", dropped.result?.listeners === 0, dropped.shown);
	const midRun = inChild("(async () => { await agent('a'); throw new TypeError('floating') })(); await agent('b'); await agent('c'); return 2");
	check("so is one that rejects mid-run, after the script moved on", midRun.status === 0 && midRun.result?.value === 2 && midRun.result.failures.join() === "floating", midRun.shown);
	const reparented = inChild("const p = Promise.reject(new Error('reparented')); Object.setPrototypeOf(p, {}); return 3");
	check("a promise the script re-parents onto one of its own objects is still its own", reparented.status === 0 && reparented.result?.failures.join() === "reparented", reparented.shown);
	const foreign = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); return 4", "setTimeout(() => Promise.reject(new Error('the host dropped this')), 20);");
	check("a host rejection during a run keeps Node's own behaviour: the process dies with it", foreign.status === 1 && foreign.result === undefined && foreign.stderr.includes("the host dropped this"), foreign.shown);
	const heard = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); Promise.reject(new Error('mine')); return 5", "const heard = []; process.on('unhandledRejection', (reason) => heard.push(reason.message)); setTimeout(() => Promise.reject(new Error('the host dropped this')), 20); process.on('exit', () => console.log('HEARD ' + heard.join()));");
	check("with a listener of its own, the host hears every rejection as before and the run claims only the script's", heard.status === 0 && heard.result?.failures.join() === "mine" && /^HEARD the host dropped this,mine$/m.test(heard.stdout), heard.shown);
	const warned = inChild("await new Promise((resolve) => setTimeout(resolve, 200)); Promise.reject(new Error('mine')); return 6", "setTimeout(() => Promise.reject(new Error('the host dropped this')), 20);", ["--unhandled-rejections=warn"]);
	check("where Node only warns, the host's rejection is warned and the run still claims the script's later one: the listener that stepped aside came back", warned.status === 0 && warned.result?.value === 6 && warned.result.failures.join() === "mine" && warned.stderr.includes("the host dropped this"), warned.shown);
}

await finish();
