import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { childEnv } from "./files.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const { carriesTool } = await jiti.import(`${ROOT}/lib/tool-policy.ts`);

// The seat each name renders as, in tool-policy's words: only `lead` leads, an
// explorer is a worker, and a workflow child is a worker with its return tool.
// The workflow answer is the other half of a seat, so every name renders twice.
const SEATS = {
	main: { role: "main" },
	lead: { role: "lead" },
	worker: { role: "worker" },
	"workflow-child": { role: "worker", workflowChild: true },
	explore: { role: "worker" },
};
const RENDERS = Object.keys(SEATS).flatMap((seat) => [false, true].map((workflows) => ({ seat, workflows })));
const labelOf = ({ seat, workflows }) => (workflows ? `${seat} +workflows` : seat);

/** The Agent tool's block in the dump, or "" where the seat does not carry it. */
function agentToolIn(dump) {
	const section = dump.split(/^### Agent — /m)[1] ?? "";
	return section.split(/^### /m)[0] ?? "";
}

const run = promisify(execFile);

/** The tool names the dump lists, in wire order. */
function toolNamesIn(dump) {
	const section = dump.split(/^## tools \(/m)[1] ?? "";
	const body = section.split(/^## /m)[0] ?? "";
	return [...body.matchAll(/^### (\S+) — /gm)].map((m) => m[1]);
}

console.log("prompt-render: every seat renders the tools its policy carries");

const rendered = await Promise.all(
	RENDERS.map(async ({ seat, workflows }) => {
		const args = ["pi/kit/bin/pi-prompt.mjs", seat, ...(workflows ? ["--workflows"] : [])];
		const { stdout, stderr } = await run(process.execPath, args, { cwd: REPO, env: childEnv(), maxBuffer: 32 * 1024 * 1024 });
		return { seat, workflows, stdout, stderr };
	}),
);

// pi-ai anchors native mid-conversation tool changes with a tool of its own
// (`DEFERRED_TOOL_PLACEHOLDER`, pi-ai 0.86) on every model whose compat accepts
// them. It is pi's, on the wire ahead of any deferred declaration; no seat
// policy decides it, so it is pinned once here and kept out of the comparison.
const PI_DEFERRED_PLACEHOLDER = "__pi_deferred_placeholder__";

const wireLists = new Map(rendered.map((render) => [labelOf(render), toolNamesIn(render.stdout)]));
const lists = new Map([...wireLists].map(([label, names]) => [label, names.filter((name) => name !== PI_DEFERRED_PLACEHOLDER)]));
// Anthropic OAuth seats name tools `Bash`, Codex seats `bash`; the policy is
// about the tool, so the sets compare case-insensitively.
const lowerNames = (names) => names.map((name) => name.toLowerCase());
const universe = [...new Set([...lists.values()].flatMap(lowerNames))];

check("the render carries tools at all", universe.length > 0, universe.join(","));
check("pi anchors the main seat's tool list with its deferred-loading placeholder", wireLists.get("main")?.includes(PI_DEFERRED_PLACEHOLDER) === true, wireLists.get("main")?.join(","));

for (const render of rendered) {
	const { seat, workflows, stdout, stderr } = render;
	const label = labelOf(render);
	const names = lists.get(label);
	// The union is in first-encounter order and the render is in canonical order
	// (`canonicalToolOrder`), so the claim is about the set; the order is pinned
	// in test/tool-policy.mjs.
	const expected = universe.filter((name) => carriesTool(name, { ...SEATS[seat], workflows })).sort();
	check(`${label} carries exactly what the policy says`, lowerNames(names).sort().join(",") === expected.join(","), `rendered ${names.join(",")}\n       policy   ${expected.join(",")}`);
	check(`${label} names no tool it could not render`, !stdout.includes("NOT RENDERED EXACTLY"), stdout.split("\n").find((line) => line.includes("NOT RENDERED EXACTLY")) ?? "");
	check(`${label} reports its size on stderr`, /system \d+ chars.*tools \d+ chars.*\d+ tools/.test(stderr), stderr.trim());
	// A seat is never told about a tool it does not carry: the ladder's workflow
	// rung is in the Agent description exactly where Workflow is on the wire.
	const agent = agentToolIn(stdout);
	const carriesWorkflow = names.includes("Workflow");
	check(`${label} mentions Workflow in the Agent ladder only when it carries one`, agent.includes("a `Workflow`") === carriesWorkflow, agent.slice(0, 200));
}

check(
	"the main seat's two shapes differ by the Workflow tool and that one sentence",
	lists.get("main").concat("Workflow").sort().join(",") === lists.get("main +workflows").slice().sort().join(","),
	`${lists.get("main").join(",")}\n       ${lists.get("main +workflows").join(",")}`,
);

for (const workflows of [false, true]) {
	const { stdout } = rendered.find((render) => render.seat === "explore" && render.workflows === workflows);
	const label = labelOf({ seat: "explore", workflows });
	check(`${label} renders the Codex wire`, stdout.includes("- api: openai-codex-responses") && /^## instructions /m.test(stdout), stdout.slice(0, 300));
	check(`${label} carries no Claude Code headers`, !/claude code/i.test(stdout));
	check(`${label} names its tools as its own wire does`, !stdout.includes("Use Bash") && stdout.includes("Use bash"));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
