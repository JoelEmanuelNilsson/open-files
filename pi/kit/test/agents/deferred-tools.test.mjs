/**
 * `Workflow`, `TaskStop` and main's `web_search` are registered deferred: a main
 * seat's requests do not carry them until the model loads them with `tool_search`,
 * and the request after the load carries them. Every request's system prompt
 * names each deferred tool and says tool_search loads it, so a tool dropped from
 * the declared set is still known to be loadable. A resume or reload re-declares
 * the tools the transcript says were loaded.
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, call, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT, importPi } from "../support/pi-package.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIVE_NPM = path.join(os.homedir(), ".pi/agent/npm");
fs.symlinkSync(LIVE_NPM, path.join(AGENT_DIR, "npm"));

console.log("\ndeferred tools");
const { createToolSearchExtension } = await importPi("dist/extensions/tool-search/index.js");
const seat = await mainSeat({ extraFactories: [createToolSearchExtension()], extraExtensions: [`${KIT_ROOT}/extensions/workflow/index.ts`, `${KIT_ROOT}/extensions/web-search.ts`, `${KIT_ROOT}/extensions/deferred-tools.ts`] });
const exposureOf = (name) => seat.session.getAllTools().find((tool) => tool.name === name)?.exposure;
check("Workflow is registered deferred", exposureOf("Workflow") === "deferred", String(exposureOf("Workflow")));
check("TaskStop is registered deferred", exposureOf("TaskStop") === "deferred", String(exposureOf("TaskStop")));
check("web_search is registered deferred", exposureOf("web_search") === "deferred", String(exposureOf("web_search")));
check("tool_search is registered, inactive until settings name it", exposureOf("tool_search") !== undefined && !seat.session.getActiveToolNames().includes("tool_search"));

seat.session.setActiveToolsByName(seat.session.getActiveToolNames().filter((name) => name !== "TaskStop").concat("tool_search"));
scriptFor("find the workflow tool", [[call("tool_search", { query: "workflow" })], [text("found it")]]);
await seat.session.prompt("find the workflow tool");
await seat.session.waitForIdle();
const mine = requests.filter((r) => JSON.stringify(r.messages).includes("find the workflow tool"));
const namesOf = (request) => request.tools.map((tool) => tool.name);
check("two requests answered the prompt", mine.length === 2, String(mine.length));
check("the first lists tool_search and none of the deferred tools", namesOf(mine[0]).includes("tool_search") && !["Workflow", "TaskStop", "web_search"].some((name) => namesOf(mine[0]).includes(name)), namesOf(mine[0]).join());
check("the request after the search carries Workflow", namesOf(mine[1]).includes("Workflow"), namesOf(mine[1]).join());
check("and still not the deferred tools the search did not match", !namesOf(mine[1]).includes("web_search"), namesOf(mine[1]).join());
for (const name of ["Workflow", "TaskStop", "web_search"]) {
	check(`the system prompt names ${name} as loadable before any search`, /tool_search/.test(mine[0].system) && mine[0].system.includes(`- ${name}: `), mine[0].system.slice(-600));
}
check("and still names Workflow once it is loaded", mine[1].system.includes("- Workflow: "), mine[1].system.slice(-600));

console.log("\nloaded tools survive a reload and a resume");
const loaded = (session) => session.getActiveToolNames();
await seat.session.reload();
check("a reload keeps Workflow, which tool_search loaded", loaded(seat.session).includes("Workflow"), loaded(seat.session).join());
check("and keeps their order", loaded(seat.session).indexOf("tool_search") < loaded(seat.session).indexOf("Workflow"), loaded(seat.session).join());
const file = seat.session.sessionFile;
seat.session.dispose();
const resumed = await mainSeat({ extraFactories: [createToolSearchExtension()], extraExtensions: [`${KIT_ROOT}/extensions/workflow/index.ts`, `${KIT_ROOT}/extensions/web-search.ts`, `${KIT_ROOT}/extensions/deferred-tools.ts`], resume: file });
check("a resumed seat declares Workflow again", loaded(resumed.session).includes("Workflow"), loaded(resumed.session).join());
check("and not the deferred tool the search never loaded", !loaded(resumed.session).includes("web_search"), loaded(resumed.session).join());
resumed.session.dispose();

await finish();
