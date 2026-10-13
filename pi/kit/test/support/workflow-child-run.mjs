/**
 * One workflow run in a fresh node process, for the checks a regression could
 * crash the process with: the sandbox's bans and its unhandled-rejection route.
 * A regression kills that process, never the suite file, and the JIT starts cold.
 * A test calls `inChild(scriptBody, hostSetup?, nodeFlags?)` and reads back
 * `{ status, stdout, stderr, result, shown }`, `result` being the run's value,
 * error, unhandled-rejection failures and leftover listener count.
 */

import { KIT_ROOT } from "./pi-package.mjs";
import { spawnSync } from "node:child_process";

/** Runs `body` as a workflow script in a child node process over a spawner that answers each prompt with itself. */
export const inChild = (body, host = "", flags = []) => {
	const source = `
		import { kitJiti } from ${JSON.stringify(`${KIT_ROOT}/test/support/pi-package.mjs`)};
		import fs from "node:fs"; import os from "node:os"; import path from "node:path";
		const jiti = kitJiti({ moduleCache: false });
		const { runWorkflow } = await jiti.import(${JSON.stringify(`${KIT_ROOT}/extensions/workflow/workflow-runtime.ts`)});
		const { WorkflowJournal } = await jiti.import(${JSON.stringify(`${KIT_ROOT}/extensions/workflow/workflow-journal.ts`)});
		const journal = new WorkflowJournal(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-child-")), "j.jsonl"));
		const events = [];
		${host}
		let out, error;
		try {
			out = await runWorkflow({ source: ${JSON.stringify(`export const meta = { name: 'wf', description: 'test' }\n${body}`)}, args: undefined, journal, spawner: { run: async (r) => ({ kind: "completed", value: r.prompt }) }, emit: (e) => events.push(e), signal: new AbortController().signal });
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.name + ": " + thrown.message : "not an Error: " + String(thrown);
		}
		console.log("RESULT " + JSON.stringify({ value: out?.value, error, failures: events.filter((e) => e.type === "rejection-unhandled").map((e) => e.reason), listeners: process.listenerCount("unhandledRejection") }));
	`;
	const child = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", source], { cwd: KIT_ROOT, encoding: "utf8", timeout: 20_000 });
	const line = /^RESULT (.*)$/m.exec(child.stdout)?.[1];
	return { status: child.status, stdout: child.stdout, stderr: child.stderr, result: line === undefined ? undefined : JSON.parse(line), shown: `exit ${child.status} · ${child.stdout.trim()} · ${child.stderr.trim().split("\n").slice(0, 4).join(" / ")}` };
};
