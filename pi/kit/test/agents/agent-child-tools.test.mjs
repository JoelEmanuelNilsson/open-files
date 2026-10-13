/**
 * Which tools pi activates for a child: its type file's list, and the two tools whose
 * presence depends on the seat (`Workflow` on the parent's launch answer, `StructuredOutput` on a workflow child).
 */

import { check, finish } from "../support/check-harness.mjs";
import { AGENT_DIR, call, jiti, mainSeat, requests, scriptFor, text } from "../support/agent-engine-seat.mjs";
import { until } from "../support/async-waits.mjs";
import fs from "node:fs";
import path from "node:path";
import { KIT_ROOT } from "../support/pi-package.mjs";

const { agentTypesOf, childToolNames } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-runtime.ts`);
const { parseAgentTypeFile } = await jiti.import(`${KIT_ROOT}/lib/agents/agent-type-files.ts`);

const typed = (tools) => parseAgentTypeFile(`---\nname: t\ntools: ${tools}\n---\n`, "/x/t.md");
const seat = (workflows, workflowChild = false) => ({ workflows, workflowChild });

console.log("\nchild tools");
check("Agent brings SendMessage, TaskOutput, TaskStop and ListAgents with it", childToolNames(typed("read, bash, Agent(explore)"), seat(false)).join() === "read,bash,Agent,SendMessage,ListAgents,TaskOutput,TaskStop");
check("a list without Agent has none of the five", childToolNames(typed("read, bash"), seat(false)).join() === "read,bash");
check("Workflow stands only where the parent carried it", childToolNames(typed("read, Workflow"), seat(false)).join() === "read" && childToolNames(typed("read, Workflow"), seat(true)).join() === "read,Workflow");
check("a workflow child adds StructuredOutput", childToolNames(typed("read"), seat(false, true)).join() === "read,StructuredOutput");
check("a type's Agent entry says which types its seat may start", JSON.stringify([agentTypesOf(typed("read, Agent(explore, worker)")), agentTypesOf(typed("read, Agent")), agentTypesOf(typed("read")), agentTypesOf(parseAgentTypeFile("---\nname: t\n---\n", "/x/t.md"))]) === JSON.stringify([["explore", "worker"], null, [], null]));
check("a type with no list takes pi's selection", childToolNames(parseAgentTypeFile("---\nname: t\n---\n", "/x/t.md"), seat(true)) === undefined && childToolNames(undefined, seat(true)) === undefined);
check("and a workflow child of one adds StructuredOutput to pi's selection", childToolNames(undefined, seat(false, true)).join() === "+StructuredOutput");

check("a tools line without commas is a reported problem, not an empty list", typed("read edit")?.reason?.includes('"read edit"') === true && typed("read, edit")?.tools?.length === 2);
check("a frontmatter line that is not key: value is a reported problem", parseAgentTypeFile("---\nname: t\n  - stray\n---\n", "/x/t.md")?.reason?.includes("stray") === true);

console.log("\nwhat a seat may start");
fs.writeFileSync(path.join(AGENT_DIR, "agents", "delegator.md"), "---\nname: delegator\ndescription: Starts explorers.\ntools: read, Agent(explore)\n---\nYou delegate reading to explorers.\n");
const seatOf = await mainSeat();
const enumOf = (request) => request?.tools.find((tool) => tool.name === "Agent")?.parameters.properties.subagent_type.enum;
scriptFor("start a delegator", [[call("Agent", { description: "delegate", prompt: "Delegate the reading.", subagent_type: "delegator", name: "delegating" })], [text("started")]]);
scriptFor("Delegate the reading.", [[call("Agent", { description: "read", prompt: "Read the files.", subagent_type: "explore", name: "reading" })], [text("delegated")]]);
scriptFor("Read the files.", [[text("Read.")]]);
await seatOf.session.prompt("start a delegator");
await seatOf.session.waitForIdle();
await until(() => seatOf.events.some((e) => e.channel === "subagents:completed" && e.name === "reading"), 5000);
const firstRequestOf = (brief) => requests.find((r) => JSON.stringify(r.messages).includes(brief));
const mainRequest = firstRequestOf("start a delegator");
const delegatorRequest = firstRequestOf("Delegate the reading.");
const explorerRequest = firstRequestOf("Read the files.");
check("main's Agent schema lists every type", JSON.stringify(enumOf(mainRequest)?.slice().sort()) === JSON.stringify(["delegator", "explore", "lead", "reviewer", "worker"]), JSON.stringify(enumOf(mainRequest)));
check("a seat whose type lists Agent(explore) has an Agent schema that lists only explore", JSON.stringify(enumOf(delegatorRequest)) === JSON.stringify(["explore"]), JSON.stringify(enumOf(delegatorRequest)));
check("and subagent_type is required there, because the default type is not offered", JSON.stringify(delegatorRequest?.tools.find((tool) => tool.name === "Agent")?.parameters.required.includes("subagent_type")) === "true");
check("it started an explorer, which the seat's engine ran", explorerRequest !== undefined);
check("an explorer registers no Agent tool", explorerRequest !== undefined && explorerRequest.tools.every((tool) => !["Agent", "SendMessage", "TaskOutput", "TaskStop", "ListAgents"].includes(tool.name)), explorerRequest?.tools.map((t) => t.name).join());
check("TaskStop is registered deferred", seatOf.tool("TaskStop")?.exposure === "deferred");
seatOf.session.dispose();

await finish();
