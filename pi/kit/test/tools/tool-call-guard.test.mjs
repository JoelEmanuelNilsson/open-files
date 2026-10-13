/**
 * The call-time guard (extensions/tool-call-guard/index.ts): its `tool_call`
 * handler refuses a broad bash scan and never throws.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

const REPO = path.join(os.homedir(), "dotfiles");

// ---------------------------------------------------------------------------
console.log("tool-call-guard: the tool_call handler is the enforcement");
{
	const mod = await jiti.import(`${KIT_ROOT}/extensions/tool-call-guard/index.ts`);
	const handlers = new Map();
	mod.default({ on: (event, handler) => handlers.set(event, handler) });
	const ctxFor = (sessionId) => ({ cwd: REPO, sessionManager: { getSessionId: () => sessionId } });
	const ctx = ctxFor("main-session");
	const call = (toolName, input) => ({ result: handlers.get("tool_call")({ toolName, input, toolCallId: "t1" }, ctx), input });

	check("the extension binds exactly the call-time seam", [...handlers.keys()].join(",") === "tool_call");

	// The owned bash tool resolves its own timeout; this handler leaves the
	// call's input exactly as the model wrote it.
	const bare = call("bash", { command: "npm test" });
	check("a bash call's input is not touched", bare.input.timeout === undefined && bare.result === undefined);
	const greedy = call("bash", { command: "sleep 99999", timeout: 7200 });
	check("not even a greedy timeout — the tool clamps it", greedy.input.timeout === 7200 && greedy.result === undefined);

	const refusedBash = call("bash", { command: "rg x $HOME" });
	check("a broad-root bash call is blocked with a reason", refusedBash.result?.block === true && refusedBash.result.reason.includes("home directory"));
	const refusedGrep = call("bash", { command: "grep -rn x src" });
	check("a recursive grep is blocked at the handler with the rg lesson", refusedGrep.result?.block === true && refusedGrep.result.reason.includes("rg"));

	// The process tree is read for real: this test process stands in for pi, so its child is "started by this session" and launchd is not.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	check("a kill of a pid this process started runs", call("bash", { command: `kill ${child.pid}` }).result === undefined);
	check("a kill of a pid outside this process's tree is blocked", call("bash", { command: "kill -9 1" }).result?.block === true);
	check("and so is a kill of the pi process itself", call("bash", { command: `kill ${process.pid}` }).result?.block === true);
	child.kill("SIGKILL");

	// As of pi 0.86 a throw here *blocks* the call ("tool_call errors block the
	// tool"), where it used to run the tool anyway. Both are wrong on the same
	// input, so no input may throw: both name readers take `unknown`. Degrading
	// through the `catch` is not enough — that writes an error to the notice sink
	// the human reads, which is how `toolName: undefined` came to look like a live
	// defect in the log for a whole day.
	check("a malformed event degrades without reaching the catch", (() => {
		for (const event of [{ toolName: "bash" }, { toolName: "bash", input: null }, { toolName: undefined, input: {} }, { toolName: 7, input: {} }, { toolName: "bash", input: { command: 7 } }]) {
			const reported = [];
			try { handlers.get("tool_call")(event, { ...ctx, hasUI: true, ui: { notify: (m) => reported.push(m) } }); } catch { return false; }
			if (reported.length > 0) return false;
		}
		return true;
	})());
}

await finish();
