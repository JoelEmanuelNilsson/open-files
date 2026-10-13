import { atFinish, check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, REPO_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const jiti = kitJiti({ moduleCache: false });

// The tools each seat is written to carry: a child's are its type file's list
// (`pi/agents`), the main seat's are every tool registered active: `Workflow`,
// `TaskStop` and `web_search` are deferred and reach main through `tool_search`, which the `defaultTools` setting activates
// only. A workflow child adds the tool it returns its result through.
const WORK = ["read", "bash", "edit", "write", "web_search"];
const MAIN_WORK = ["read", "bash", "edit", "write"];
const DELEGATION = ["Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop"];
const CARRIED = {
	main: () => [...MAIN_WORK, ...DELEGATION.filter((name) => name !== "TaskStop"), "tool_search"],
	lead: (workflows) => [...WORK, ...DELEGATION, ...(workflows ? ["Workflow"] : [])],
	worker: () => [...WORK, ...DELEGATION],
	"workflow-child": () => [...WORK, ...DELEGATION, "StructuredOutput"],
	explore: () => ["read", "bash", "web_search"],
};
const SEATS = Object.keys(CARRIED);
const RENDERS = SEATS.flatMap((seat) => [false, true].map((workflows) => ({ seat, workflows })));
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

// pi-prompt finds the kit through pi's agent dir, and ~/.pi/agent loads the
// live ~/dotfiles kit, so the render gets an agent dir built the way bin/pi-try
// builds one: this checkout's pi/ files and settings, with the kit package
// pointed at KIT_ROOT; credentials and installed npm packages linked read-only.
const LIVE_AGENT_DIR = path.join(homedir(), ".pi/agent");
const AGENT_DIR = mkdtempSync(path.join(process.env.XDG_STATE_HOME, "prompt-render-agent-"));
atFinish(() => rmSync(AGENT_DIR, { recursive: true, force: true }));
symlinkSync(path.join(LIVE_AGENT_DIR, "auth.json"), path.join(AGENT_DIR, "auth.json"));
if (existsSync(path.join(LIVE_AGENT_DIR, "npm"))) symlinkSync(path.join(LIVE_AGENT_DIR, "npm"), path.join(AGENT_DIR, "npm"));
for (const file of ["AGENTS.md", "APPEND_SYSTEM.md", "keybindings.json", "models.json", "agents"]) {
	const source = path.join(REPO_ROOT, "pi", file);
	if (existsSync(source)) symlinkSync(source, path.join(AGENT_DIR, file));
}
const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, "pi/settings.json"), "utf8"));
const livePackage = settings.packages.findIndex((entry) => typeof entry === "string" && entry.replace(/\/$/, "").endsWith("/dotfiles/pi/kit"));
if (livePackage === -1) throw new Error(`prompt-render: pi/settings.json names no dotfiles kit package to point at ${KIT_ROOT}`);
settings.packages[livePackage] = KIT_ROOT;
writeFileSync(path.join(AGENT_DIR, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
for (const file of ["models-store.json", "trust.json", "web-search.json"]) {
	if (existsSync(path.join(LIVE_AGENT_DIR, file))) copyFileSync(path.join(LIVE_AGENT_DIR, file), path.join(AGENT_DIR, file));
}

console.log("prompt-render: every seat renders the tools its policy carries");

const rendered = await Promise.all(
	RENDERS.map(async ({ seat, workflows }) => {
		const args = [`${KIT_ROOT}/bin/pi-prompt.mjs`, seat, ...(workflows ? ["--workflows"] : [])];
		const { stdout, stderr } = await run(process.execPath, args, { cwd: REPO_ROOT, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, maxBuffer: 32 * 1024 * 1024 });
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
	// in test/wire/tools-array-order.test.mjs.
	const expected = CARRIED[seat](workflows).map((name) => name.toLowerCase()).filter((name) => universe.includes(name)).sort();
	check(`${label} carries exactly its type file's tools`, lowerNames(names).sort().join(",") === expected.join(","), `rendered ${names.join(",")}\n       expected ${expected.join(",")}`);
	check(`${label} names no tool it could not render`, !stdout.includes("NOT RENDERED EXACTLY"), stdout.split("\n").find((line) => line.includes("NOT RENDERED EXACTLY")) ?? "");
	check(`${label} drops pi-web-search's url_context, which only a Google model keeps`, !lowerNames(names).includes("url_context"), names.join(","));
	check(`${label} reports its size on stderr`, /system \d+ chars.*tools \d+ chars.*\d+ tools/.test(stderr), stderr.trim());
	// A seat is never told about a tool it cannot reach: the ladder's workflow
	// rung is in the Agent description where Workflow is on the wire, and on main,
	// where it is deferred and `tool_search` loads it.
	const agent = agentToolIn(stdout);
	const carriesWorkflow = names.includes("Workflow") || seat === "main";
	check(`${label} mentions Workflow in the Agent ladder only when it carries one`, agent.includes("a `Workflow`") === carriesWorkflow, agent.slice(0, 200));
}

check(
	"the main seat's tools do not depend on the workflows flag, because Workflow is deferred",
	lists.get("main").join(",") === lists.get("main +workflows").join(","),
	`${lists.get("main").join(",")}\n       ${lists.get("main +workflows").join(",")}`,
);

for (const render of rendered) {
	const { seat, stdout } = render;
	const label = labelOf(render);
	const blocks = stdout.split(/^## system blocks /m)[1]?.split(/^## tools \(/m)[0] ?? "";
	const headings = [...blocks.matchAll(/^### block \d+ — .*$/gm)].map((m) => m[0]);
	check(`${label} sends the live wire's four system blocks`, blocks.startsWith("(4,") && headings.length === 4, headings.join("\n       "));
	check(`${label} ends its system with the cwd block, after the one breakpoint`, blocks.includes("Current working directory: ") && headings[2]?.includes("cache_control=") && !headings[3]?.includes("cache_control") && !headings[0]?.includes("cache_control"), headings.join("\n       "));
	check(`${label} names a human turn origin only on the main seat`, stdout.includes("cc_turn_origin=human;") === (seat === "main"));
	check(`${label} opens the first turn only on the main seat`, stdout.includes(" cc_prompt_index=1; cc_turn_index=1;") === (seat === "main"));
}

// A project extension that throws on import is absent from pi's loaded set, so
// its tools and narrowing would vanish silently; the render must say so and fail.
const brokenCwd = mkdtempSync(path.join(process.env.XDG_STATE_HOME, "prompt-render-broken-"));
atFinish(() => rmSync(brokenCwd, { recursive: true, force: true }));
mkdirSync(path.join(brokenCwd, ".pi/extensions"), { recursive: true });
writeFileSync(path.join(brokenCwd, ".pi/extensions/broken-fixture.ts"), 'throw new Error("fixture extension refuses to load");\n');
const broken = await run(process.execPath, [`${KIT_ROOT}/bin/pi-prompt.mjs`, "main"], { cwd: brokenCwd, env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR }, maxBuffer: 32 * 1024 * 1024 }).then(
	({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
	(error) => ({ code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
);
check("an extension that fails to load exits nonzero", broken.code === 1, `exit ${broken.code}\n${broken.stderr}`);
check("and is named on stdout as NOT RENDERED EXACTLY", /NOT RENDERED EXACTLY — extension .*broken-fixture\.ts failed to load: .*fixture extension refuses to load/.test(broken.stdout), broken.stdout.slice(-400));
check("the rest of the render is still printed", toolNamesIn(broken.stdout).length > 0);

// ---------------------------------------------------------------------------
await finish();
