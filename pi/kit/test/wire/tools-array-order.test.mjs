/**
 * The tools array's canonical order (lib/wire/tools-array-order.ts): the tool
 * set, not its arrival order, decides the bytes, and the breakpoint rides along.
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";

const jiti = kitJiti({ moduleCache: false });
const { canonicalToolOrder } = await jiti.import(`${KIT_ROOT}/lib/wire/tools-array-order.ts`);

// ---------------------------------------------------------------------------
console.log("tools-array-order: the order is canonical, so the tool set decides the bytes (issues/45, E')");
{
	const { wirePrint } = await jiti.import(`${KIT_ROOT}/extensions/wire/wire-print.ts`);

	const tool = (name) => ({ name, description: `${name} does a thing`, input_schema: { type: "object", properties: {} } });
	/** The array as pi builds it: the tools breakpoint on whatever tool is last. */
	const arrayOf = (names) => {
		const tools = names.map(tool);
		tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
		return tools;
	};
	const names = (tools) => tools.map((t) => t.name).join(",");
	const toolsHash = (tools) => wirePrint({ messages: [], tools }).toolsHash;
	// Exactly the thirteen a main seat carried on 2026-09-14, in registration
	// order, `todo` (the plan tool, since removed) included.
	const THIRTEEN = ["Read", "Bash", "Edit", "Write", "web_search", "Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop", "todo", "Workflow", "StructuredOutput"];
	// A reload's array: pi's `_refreshToolRegistry` reseeds from the previous active
	// list, so the same thirteen come back in a different sequence.
	const reloaded = [...THIRTEEN.slice(5), ...THIRTEEN.slice(0, 5)];

	const first = canonicalToolOrder(arrayOf(THIRTEEN));
	check("the order is the names, sorted", names(first) === [...THIRTEEN].sort().join(","));
	check("and sorting again changes nothing", JSON.stringify(canonicalToolOrder(first)) === JSON.stringify(first));

	const permuted = arrayOf(reloaded);
	check("a reload really does move the hash", toolsHash(permuted) !== toolsHash(arrayOf(THIRTEEN)));
	const reordered = canonicalToolOrder(permuted);
	check("so the tools hash does not move across a reload", toolsHash(reordered) === toolsHash(first));
	check("and the reloaded array is byte-identical to the first", JSON.stringify(reordered) === JSON.stringify(first));
	check("the breakpoint rode to the last tool of the sorted array", reordered[reordered.length - 1].cache_control !== undefined);
	check("and left the tool it had been parked on", reordered.filter((t) => t.cache_control !== undefined).length === 1);
	check("which is the tool the wire keys the cut at", names(reordered).split(",").pop() === [...THIRTEEN].sort().pop());

	// A changed set is a real change: it must rewrite the prefix honestly.
	const added = canonicalToolOrder(arrayOf([...reloaded, "NewTool"]));
	check("a new tool sorts in where it belongs", names(added) === [...THIRTEEN, "NewTool"].sort().join(","));
	check("and the hash moves, as it must", toolsHash(added) !== toolsHash(first));
	const removed = canonicalToolOrder(arrayOf(THIRTEEN.slice(0, 12)));
	check("a removed tool is a changed set too", toolsHash(removed) !== toolsHash(first));

	// pi-ai 0.86's list on a model that takes native tool changes: the initial
	// tools with the breakpoint on the last, its placeholder, then every tool
	// added mid-session, deferred. The late ones stay behind the breakpoint.
	const placeholder = { ...tool("__pi_deferred_placeholder__"), defer_loading: true };
	const late = (name) => ({ ...tool(name), defer_loading: true });
	const shape = (tools) => tools.map((t) => `${t.name}${t.cache_control === undefined ? "" : "*"}${t.defer_loading === true ? "~" : ""}`).join(",");
	const cachedPart = (tools) => JSON.stringify(tools.slice(0, tools.findIndex((t) => t.cache_control !== undefined) + 1));
	const session = [...arrayOf(["bash", "read", "Write"]), placeholder];
	const started = canonicalToolOrder(session);
	check("active tools sort by name and deferred tools follow them", shape(started) === "Write,bash,read*,__pi_deferred_placeholder__~", shape(started));
	const grown = canonicalToolOrder([...session, late("zeta"), late("Artifact")]);
	check("a tool added mid-session stays behind the breakpoint, in arrival order", shape(grown) === "Write,bash,read*,__pi_deferred_placeholder__~,zeta~,Artifact~", shape(grown));
	check("so the cached part of the array is byte-identical across the addition", cachedPart(grown) === cachedPart(started));
	check("and ordering the grown array again changes nothing", JSON.stringify(canonicalToolOrder(grown)) === JSON.stringify(grown));
	check("a deferred tool that arrives first still goes out behind the active ones", shape(canonicalToolOrder([late("Artifact"), ...session])) === "Write,bash,read*,Artifact~,__pi_deferred_placeholder__~");

	check("an unreadable tool sorts first and keeps its place in the array", canonicalToolOrder([tool("a"), { note: "?" }]).length === 2);
	check("two tools of one name stay two tools", names(canonicalToolOrder([tool("a"), tool("a")])) === "a,a");
	check("an empty array is an empty array", canonicalToolOrder([]).length === 0);

	// A child seat carrying its parent's set must send its parent's bytes or it
	// pays for the parent's whole tools+system entry (map C4) — structural now,
	// rather than a map both seats had to share.
	check("every seat computes one order from the set alone (C4)", names(canonicalToolOrder(arrayOf(reloaded))) === names(first));
}

await finish();
