/**
 * Without pi-web-search under the agent dir, `web_search` is not registered and
 * session_start says why.
 *
 *   node test/tools/web-search-missing.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { jiti } from "../support/agent-engine-seat.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";

const { default: webSearch } = await jiti.import(`${KIT_ROOT}/extensions/web-search.ts`);

const tools = [];
const handlers = new Map();
await webSearch({ registerTool: (tool) => tools.push(tool.name), on: (event, handler) => handlers.set(event, handler) });
check("web_search is not registered", tools.length === 0, tools.join());

const notes = [];
handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: (message, level) => notes.push({ message, level }) } });
check("session_start warns that web_search is unavailable", notes.length === 1 && notes[0].level === "warning" && notes[0].message.startsWith("web_search is unavailable"), JSON.stringify(notes));

await finish();
