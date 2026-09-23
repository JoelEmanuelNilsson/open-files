import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
// Resolved from this file, not hardcoded: the suite has to test the checkout it
// lives in, or a git worktree silently verifies the main checkout instead.
const ROOT = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`); }
};

const policy = await jiti.import(`${ROOT}/lib/tool-policy.ts`);
const {
	applyToolPolicy,
	canonicalToolOrder,
	standingTools,
	scanRefusal,
	DELEGATION_TOOLS,
	MAIN_SEAT,
} = policy;

const HOME = os.homedir();
const REPO = path.join(HOME, "dotfiles");

// ---------------------------------------------------------------------------
console.log("tool-policy: the deadline is the tool's");
{
	// The kit's own bash (`extensions/bash.ts`) defaults and clamps `timeout`;
	// this module no longer reaches into a bash call's input.
	check("bash's timeout is not this module's business", !("bashTimeoutFor" in policy) && !("BASH_DEFAULT_TIMEOUT_SEC" in policy));
}

// ---------------------------------------------------------------------------
console.log("\ntool-policy: what a scan may be rooted at");
{
	const at = (cwd) => ({ cwd, home: HOME });
	const blocked = (name, input, cwd = REPO) => scanRefusal(name, input, at(cwd)) !== undefined;

	// grep/find/ls are deleted from every seat (map C6), so the only scan that
	// can still be typed is a bash one. A guard for a tool that cannot be called
	// is the false promise the ruling was written against.
	check("the deleted built-ins have no guard, because they have no seat", !blocked("grep", { pattern: "x", path: "/" }) && !blocked("find", { pattern: "*", path: HOME }) && !blocked("ls", { path: "/" }));

	const bash = (command, cwd = REPO) => scanRefusal("bash", { command }, at(cwd));
	check("bash `find /` is refused", bash("find / -name '*.log'") !== undefined);
	check("bash `find $HOME` is refused in every spelling", ["find $HOME -name x", "find ~ -name x", "find ${HOME} -name x", `find ${HOME} -name x`, "find ~/ -name x"].every((c) => bash(c) !== undefined));
	check("bash `grep -r` at a broad root is refused", bash("grep -r pattern /") !== undefined && bash("grep -rn pattern $HOME") !== undefined);
	check("recursive grep is refused at any root, not just broad ones", bash("grep -rn pattern src") !== undefined && bash("grep -R x .") !== undefined);
	check("a recursive flag hiding in a cluster is still one", bash("grep -inr x lib") !== undefined && bash("grep --recursive x lib") !== undefined);
	check("grep in a pipe is ordinary work", bash("ps aux | grep node") === undefined && bash("history | grep -i ssh") === undefined);
	check("bash `rg` at a broad root is refused", bash("rg --hidden pattern /") !== undefined && bash("rg pattern ~") !== undefined);
	check("a scan hiding behind a pipe or a && is still found", bash("cd /tmp && find / -name x") !== undefined && bash("echo hi; rg pattern $HOME | head") !== undefined);
	check("a full path to the program does not evade it", bash("/usr/bin/find / -name x") !== undefined);

	check("`find .` is ordinary work", bash("find . -name '*.ts'") === undefined && bash("find . -name '*.ts'", HOME) === undefined);
	check("a named subtree is ordinary work", bash("find pi/kit -name '*.ts'") === undefined && bash(`find ${REPO}/pi -type f`) === undefined && bash("rg pattern src/") === undefined);
	check("a path that merely contains a slash is not a broad root", bash("rg pattern /etc/nginx") === undefined && bash("find /var/log -name '*.log'") === undefined);
	check("a non-recursive grep of one file is not a scan", bash("grep pattern /etc/hosts") === undefined);
	check("a pattern that looks like a root is not one", bash("rg / --files-with-matches") === undefined);
	check("commands that walk nothing are untouched", bash("ls /") === undefined && bash("cat /etc/hosts") === undefined && bash("echo find /") === undefined);

	// The three false blocks of 2026-09-02/03. Each is text that merely mentions
	// a scan; the old regex split them into fake commands and refused a program
	// the user never ran, naming it in the refusal.
	check("a pipe inside quotes is not a pipeline", bash('echo "use rg not grep -r|find / here"') === undefined && bash(`node -e 'const s = "a|find /"'`) === undefined);
	check("a heredoc body is data, not commands", bash("cat <<'EOF'\nfind / -name x\ngrep -rn foo\nEOF") === undefined && bash("cat <<EOF > f\nsome | text\nEOF\nls") === undefined);
	check("a quoted scan in an argument is not a scan", bash("echo 'grep -rn foo'") === undefined && bash("git commit -m 'fix: find / bug'") === undefined);
	check("an alternation regex is a pattern, not a pipe", bash("rg 'a|b' src") === undefined && bash('rg "find /|rm -rf" lib') === undefined);
	check("a comment naming a scan does not run one", bash("# find / -name x\nls") === undefined);

	// The blindness ran the other way too: nothing looked inside a substitution.
	check("a scan inside $() is still a scan", bash("ls $(find / -name x)") !== undefined && bash("echo `grep -rn foo .`") !== undefined);
	check("and inside a nested one", bash("echo $(echo $(find ~ -name x))") !== undefined);
	check("arithmetic is not a command", bash("echo $((1 + 2))") === undefined);

	check("an env-var prefix does not hide the program", bash("FOO=1 BAR=2 find / -name x") !== undefined);
	check("a quoted program name is the same program", bash(`"find" / -name x`) !== undefined && bash("find '/' -name x") !== undefined);
	check("a line continuation keeps one command whole", bash("find \\\n / -name x") !== undefined);
	check("a redirection target is not an argument", bash("echo hi > /tmp/out && find / -x") !== undefined && bash("rg pattern src 2>/dev/null") === undefined);
	check("a scan in a subshell or brace group is found", bash("(cd /tmp && find / -name x)") !== undefined && bash("{ find ~ -name x; }") !== undefined);
	check("a run of separators makes no phantom command", bash("a | b; c && d || e") === undefined);

	const reason = scanRefusal("bash", { command: "find / -name x" }, at(REPO));
	check("the reason tells the model what to do instead", reason.includes("Re-run it rooted at a specific path"), reason);
	check("and names the root it refused", reason.includes("`find` at /"), reason);
	check("a $HOME refusal says so in words", bash("rg x $HOME").includes("your home directory"));

	const grepReason = bash("grep -rn pattern src");
	check("the grep refusal names rg and the gitignore gotcha", grepReason.includes("rg") && grepReason.includes("-uu"), grepReason);
}

// ---------------------------------------------------------------------------
console.log("\ntool-policy: the tool_call handler is the enforcement");
{
	const mod = await jiti.import(`${ROOT}/extensions/tool-policy.ts`);
	const handlers = new Map();
	mod.default({ on: (event, handler) => handlers.set(event, handler) });
	const ctxFor = (sessionId) => ({ cwd: REPO, sessionManager: { getSessionId: () => sessionId } });
	const ctx = ctxFor("main-session");
	const call = (toolName, input) => ({ result: handlers.get("tool_call")({ toolName, input, toolCallId: "t1" }, ctx), input });

	check("the extension binds exactly the call-time seam", [...handlers.keys()].join(",") === "tool_call");

	// The wire cut only hides a tool: every tool stays registered, so a model that
	// names one anyway reaches `execute` unless the call is refused here.
	{
		const { declareChildSeat, forgetChildSeat } = await jiti.import(`${ROOT}/lib/seat.ts`);
		const seatCall = (sessionId, toolName) => handlers.get("tool_call")({ toolName, input: {}, toolCallId: "t2" }, ctxFor(sessionId));
		const declare = (sessionId, seat) => declareChildSeat(sessionId, { name: sessionId, depth: 1, parentSessionId: "main-session", prompt: { kind: "inherit" }, ...seat });
		declare("worker-seat", { role: "worker", workflowChild: false, workflows: false });
		declare("lead-seat", { role: "lead", workflowChild: false, workflows: true });
		declare("lead-no-workflows", { role: "lead", workflowChild: false, workflows: false });
		declare("workflow-child-seat", { role: "worker", workflowChild: true, workflows: false });

		const blocked = seatCall("worker-seat", "Agent");
		check("a worker that calls Agent by name is refused, not run", blocked?.block === true && blocked.reason.includes("this seat does not carry Agent"), JSON.stringify(blocked));
		check("and the refusal says what the worker should do instead", blocked.reason.includes("put what matters in your final reply"));
		check("all six delegation tools are refused on a worker", DELEGATION_TOOLS.every((name) => seatCall("worker-seat", name)?.block === true));
		check("the five work tools run on a worker", ["Read", "Edit", "Write", "web_search"].every((name) => seatCall("worker-seat", name) === undefined));
		check("a lead may still delegate", DELEGATION_TOOLS.every((name) => seatCall("lead-seat", name) === undefined));
		// The launch answer is the other half of a seat: a session started without
		// workflows is refused the tool by name, however it learned the name.
		const noWorkflow = seatCall("lead-no-workflows", "Workflow");
		check("a seat launched without workflows is refused Workflow", noWorkflow?.block === true && noWorkflow.reason.includes("this seat does not carry Workflow"), JSON.stringify(noWorkflow));
		check("and the refusal says the answer is fixed for the session", noWorkflow.reason.includes("fixed for its whole life"));
		check("it still delegates everything else", DELEGATION_TOOLS.filter((name) => name !== "Workflow").every((name) => seatCall("lead-no-workflows", name) === undefined));
		check("an undeclared main seat carries no Workflow either", seatCall("main-session", "Workflow")?.block === true);
		check("and may still delegate", DELEGATION_TOOLS.filter((name) => name !== "Workflow").every((name) => seatCall("main-session", name) === undefined));
		check("StructuredOutput is refused everywhere but a workflow child", seatCall("main-session", "StructuredOutput")?.block === true && seatCall("lead-seat", "StructuredOutput")?.block === true && seatCall("worker-seat", "StructuredOutput")?.block === true);
		check("a workflow child returns its result through it", seatCall("workflow-child-seat", "StructuredOutput") === undefined);
		check("a workflow child is still a worker everywhere else", seatCall("workflow-child-seat", "Agent")?.block === true);

		for (const id of ["worker-seat", "lead-seat", "lead-no-workflows", "workflow-child-seat"]) forgetChildSeat(id);
		check("a seat whose declaration is gone is the main seat again", seatCall("worker-seat", "Agent") === undefined);
	}

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

// ---------------------------------------------------------------------------
console.log("\ntool-policy: the standing set, and the description that matches it");
{
	const tool = (name, extra = {}) => ({ name, description: `The ${name} tool`, input_schema: { type: "object", properties: {} }, ...extra });
	const bashTool = {
		name: "bash",
		description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" } } },
	};
	const names = (tools) => tools.map((t) => t.name).join(",");

	// C6: grep/find/ls are deleted from the harness whatever the seat is holding
	// — a tool nobody may call is dead weight everywhere.
	check("the deleted built-ins stand on no seat", standingTools(["read", "bash", "grep", "find", "ls", "write"]).join(",") === "read,bash,write");
	check("including a seat with no bash to route them through", standingTools(["read", "grep", "find", "ls"]).join(",") === "read");

	const cut = applyToolPolicy([tool("read"), bashTool, tool("edit"), tool("grep"), tool("find"), tool("ls"), tool("write")]);
	check("the cut lands on the payload", names(cut) === "read,bash,edit,write", names(cut));

	const explore = applyToolPolicy([tool("read"), tool("grep"), tool("find"), tool("ls")]);
	check("a bash-less seat gets the same cut", names(explore) === "read", names(explore));

	const bashOut = cut.find((t) => t.name === "bash");
	check("bash goes out exactly as registered — the owned tool's text is the truth", bashOut === bashTool);
	check("nothing else's description is touched", cut.find((t) => t.name === "read").description === "The read tool");

	// The tools breakpoint is the front of the cached prefix. Filtering the tool
	// that carried it would cost the whole prefix on every request afterwards.
	const withBreakpoint = applyToolPolicy([tool("read"), bashTool, tool("ls", { cache_control: { type: "ephemeral" } })]);
	check("a breakpoint on a cut tool moves to the new last tool", withBreakpoint.at(-1).name === "bash" && withBreakpoint.at(-1).cache_control.type === "ephemeral", JSON.stringify(withBreakpoint.map((t) => [t.name, t.cache_control])));

	// pi-ai 0.86 ends the list with its deferred placeholder on a model that
	// accepts native tool changes. A deferred tool is outside the cached prefix,
	// so the breakpoint stops at the last tool that is not deferred.
	const deferred = { name: "__pi_deferred_placeholder__", description: "Reserved placeholder. Never available. Never call this.", input_schema: { type: "object", properties: {}, required: [] }, defer_loading: true };
	const withDeferred = applyToolPolicy([tool("read"), bashTool, tool("ls", { cache_control: { type: "ephemeral" } }), deferred]);
	check("a breakpoint never lands on a deferred tool", withDeferred.at(-1).name === "__pi_deferred_placeholder__" && withDeferred.at(-1).cache_control === undefined && withDeferred.at(-2).cache_control.type === "ephemeral", JSON.stringify(withDeferred.map((t) => [t.name, t.cache_control])));
	check("nor does the canonical order carry one there", (() => {
		const sorted = canonicalToolOrder([{ ...tool("read"), cache_control: { type: "ephemeral" } }, tool("Bash"), deferred]);
		return sorted.every((t) => t.name !== "__pi_deferred_placeholder__" || t.cache_control === undefined) && sorted.filter((t) => t.cache_control !== undefined).length === 1;
	})());
	// pi-ai puts the breakpoint on the last initial tool, before the placeholder,
	// so a deferred tool never arrives carrying one. The rule is enforced anyway:
	// where it sits on arrival is pi-ai's business, and a list this module hands
	// back is a list the wire accepts.
	// Where it lands is the last non-deferred tool of whatever each function
	// returns, which is not the same tool for both: the cut keeps the order it
	// was given and the canonical order sorts the active tools by name.
	check("a breakpoint that arrives on a deferred tool is taken off it", (() => {
		const parked = { ...deferred, cache_control: { type: "ephemeral" } };
		for (const out of [applyToolPolicy([tool("read"), bashTool, parked]), canonicalToolOrder([tool("read"), bashTool, parked])]) {
			if (out.filter((t) => t.cache_control !== undefined).length !== 1) return false;
			const holder = out.findIndex((t) => t.cache_control !== undefined);
			const lastCacheable = out.map((t) => t.defer_loading !== true).lastIndexOf(true);
			if (holder !== lastCacheable) return false;
		}
		return true;
	})());
	check("with no tool that may hold one, the breakpoint goes", (() => {
		const parked = { ...deferred, cache_control: { type: "ephemeral" } };
		return applyToolPolicy([parked]).every((t) => t.cache_control === undefined) && canonicalToolOrder([parked]).every((t) => t.cache_control === undefined);
	})());

	// This runs inside the handler whose return value is the request: a throw
	// there drops the owned system prompt off the wire.
	check("a payload it cannot read comes back untouched rather than thrown over", (() => {
		for (const tools of [[], [null], [{ name: 7 }], [{ name: "bash", description: 3, input_schema: null }]]) {
			try { if (applyToolPolicy(tools).length !== tools.length) return false; } catch { return false; }
		}
		return true;
	})());
	check("the policy is a pure function — same array in, same bytes out", JSON.stringify(applyToolPolicy([tool("read"), bashTool, tool("grep")])) === JSON.stringify(applyToolPolicy([tool("read"), bashTool, tool("grep")])));

	// The Agent tool is the engine's own now (`extensions/agent-engine.ts`), so
	// its schema and its words are written where it is registered. Nothing here
	// rewrites a tool it did not remove.
	const agentTool = {
		name: "Agent",
		description: "Launch an autonomous agent.",
		input_schema: { type: "object", properties: { prompt: { type: "string" }, isolation: { type: "string" } }, required: ["prompt"] },
	};
	const agentOut = applyToolPolicy([tool("read"), bashTool, agentTool]).find((t) => t.name === "Agent");
	check("the Agent tool goes out exactly as the engine registered it", agentOut === agentTool);
	check("no field-description rewrites are left over from the vendor", policy.AGENT_PARAM_REWRITES === undefined);
}

// ---------------------------------------------------------------------------
// Three shapes of seat, decided at the wire: a worker cannot spawn, address,
// collect or stop agents, so the six delegation tools are cut off its wire; and
// only a workflow child carries the tool it returns its result through.
console.log("\ntool-policy: what each seat carries");
{
	const tool = (name) => ({ name, description: `The ${name} tool`, input_schema: { type: "object", properties: {} } });
	// Exactly the array a live seat sends today, before any seat cut.
	const live = ["Read", "Bash", "Edit", "Write", "web_search", "Agent", "Workflow", "SendMessage", "ListAgents", "TaskOutput", "TaskStop", "StructuredOutput"].map(tool);
	const names = (seat) => applyToolPolicy(live, seat).map((t) => t.name).join(",");
	const WORK_TOOLS = "Read,Bash,Edit,Write,web_search";
	const DELEGATING = `${WORK_TOOLS},Agent,SendMessage,ListAgents,TaskOutput,TaskStop`;
	const WITH_WORKFLOWS = `${WORK_TOOLS},Agent,Workflow,SendMessage,ListAgents,TaskOutput,TaskStop`;

	check("a worker carries the five work tools and nothing else", names({ role: "worker" }) === WORK_TOOLS, names({ role: "worker" }));
	check("an explore seat is a worker, so it carries the same five", names({ role: "worker", workflowChild: false }) === WORK_TOOLS);
	check("a worker gets no Workflow even where the launcher said yes", names({ role: "worker", workflows: true }) === WORK_TOOLS);
	check("a workflow child adds the tool it returns through, and only that", names({ role: "worker", workflowChild: true }) === `${WORK_TOOLS},StructuredOutput`, names({ role: "worker", workflowChild: true }));
	check("the main seat delegates and does not return a result", names(MAIN_SEAT) === DELEGATING, names(MAIN_SEAT));
	check("the launcher's yes is what puts Workflow on the wire", names({ role: "main", workflows: true }) === WITH_WORKFLOWS, names({ role: "main", workflows: true }));
	check("and a seat that never answered carries none", names({ role: "main" }) === DELEGATING);
	check("a lead is the main seat's shape", names({ role: "lead" }) === DELEGATING, names({ role: "lead" }));
	check("a lead started by a workflow keeps both halves", names({ role: "lead", workflowChild: true, workflows: true }) === `${WITH_WORKFLOWS},StructuredOutput`);
	check("the six cut ones are the delegation tools, named once", DELEGATION_TOOLS.join(",") === "Agent,Workflow,SendMessage,ListAgents,TaskOutput,TaskStop");
	check("an unstated seat is the main seat", applyToolPolicy(live).map((t) => t.name).join(",") === DELEGATING);
	check("the deleted built-ins are still cut on a worker too", applyToolPolicy([tool("Read"), tool("Grep"), tool("Agent")], { role: "worker" }).map((t) => t.name).join(",") === "Read");

	// The breakpoint sits on the last tool; cutting the tail may not drop it.
	const withBreakpoint = [...live.slice(0, -1).map((t) => ({ ...t })), { ...tool("StructuredOutput"), cache_control: { type: "ephemeral" } }];
	const worker = applyToolPolicy(withBreakpoint, { role: "worker" });
	check("a breakpoint on a cut tool moves to the worker's new last tool", worker.at(-1).name === "web_search" && worker.at(-1).cache_control.type === "ephemeral", JSON.stringify(worker.map((t) => [t.name, t.cache_control])));
	check("the seat cut is a pure function too", JSON.stringify(applyToolPolicy(live, { role: "worker" })) === JSON.stringify(applyToolPolicy(live, { role: "worker" })));
	// One rule, asked twice: the payload cut and the call-time refusal read the
	// same predicate, so they cannot drift into disagreeing.
	const { carriesTool, seatRefusal } = policy;
	for (const seat of [MAIN_SEAT, { role: "main", workflows: true }, { role: "lead" }, { role: "lead", workflows: true }, { role: "worker" }, { role: "worker", workflowChild: true }]) {
		const carried = new Set(applyToolPolicy(live, seat).map((t) => t.name));
		check(`the guard and the cut agree on a ${JSON.stringify(seat)} seat`, live.every((t) => carriesTool(t.name, seat) === carried.has(t.name) && (seatRefusal(t.name, seat) === undefined) === carried.has(t.name)));
	}
	check("the refusal names the tool plainly", seatRefusal("Workflow", { role: "worker" }).includes("this seat does not carry Workflow"));

	// A seat with nothing readable on it keeps the work tools and loses the two
	// that must be granted explicitly: silence is not a yes.
	check("a seat it cannot read does not throw the request away", (() => {
		try { return applyToolPolicy(live, {}).map((t) => t.name).join(",") === DELEGATING; } catch { return false; }
	})());
}

// ---------------------------------------------------------------------------
// The prompt used to restate the tool set as a bulleted list, and the cut had
// to be applied to it so it could not advertise a dropped tool. As of
// issues/31 there is no list to keep honest: `payload.tools` carries name,
// description and schema structurally, so the restatement was deleted rather
// than filtered. What survives is the part the payload does *not* carry — the
// cross-tool guidelines — and those still key off the standing set.
console.log("\ntool-policy: no tools list to keep honest, and guidelines that still are");
{
	const { buildOwnedSystemPrompt, SCAN_GUIDELINE, BASH_FILE_OPS_GUIDELINE } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kit-tool-policy-"));
	const snippets = {
		read: "Read file contents",
		bash: "Execute bash commands",
		edit: "Edit files",
		grep: "Search file contents for patterns",
		find: "Find files by glob pattern",
		ls: "List directory contents",
	};
	const promptFor = (selectedTools) => buildOwnedSystemPrompt({ cwd: dir, selectedTools, toolSnippets: snippets });
	const seats = {
		bash: promptFor(["read", "bash", "edit", "grep", "find", "ls"]),
		bashOnly: promptFor(["read", "bash", "edit", "write"]),
		readOnly: promptFor(["read", "grep", "find", "ls"]),
		defaulted: buildOwnedSystemPrompt({ cwd: dir, toolSnippets: snippets }),
	};

	for (const [seat, prompt] of Object.entries(seats)) {
		check(`the ${seat} seat gets no Available tools list`, !prompt.includes("Available tools:"), prompt.slice(0, 200));
		check(`nor the sentence that dangled under it (${seat})`, !prompt.includes("In addition to the tools above"));
		// A snippet is only ever rendered into that list, so none may survive.
		check(`no tool snippet reaches the ${seat} seat's prompt`, !Object.values(snippets).some((snippet) => prompt.includes(snippet)));
		check(`the ${seat} seat still gets the broad-scan rule, once`, prompt.split(SCAN_GUIDELINE).length === 2, prompt);
	}

	check("a bash seat is told which tool owns which kind of search", seats.bash.includes(`- ${BASH_FILE_OPS_GUIDELINE}`));
	check("and so is a seat that never asked for the built-ins", seats.bashOnly.includes(`- ${BASH_FILE_OPS_GUIDELINE}`));
	check("the map names every owner and the one ban", ["rg", "fd", "ast-grep", "jq", "grep -r"].every((word) => BASH_FILE_OPS_GUIDELINE.includes(word)));
	check("a seat with no shell is not told to use a bash it does not have", !seats.readOnly.includes("Use bash for file operations"));
	check("the guideline order is fixed: file ops, then the scan rule, then the standing file-path line", seats.bash.includes(`Guidelines:\n- ${BASH_FILE_OPS_GUIDELINE}\n- ${SCAN_GUIDELINE}\n- Show file paths clearly when working with files`), seats.bash);

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A tool's own guidelines still reach the prompt: pi collects `promptGuidelines`
// off every registered definition, and the builder adds each one once, in a
// fixed slot. No rewrite table stands between them any more — every agent
// guideline is written where the Agent tool is registered.
console.log("\ntool-policy: a tool's own guidelines, unrewritten");
{
	const { buildOwnedSystemPrompt, AGENT_GUIDELINE_REWRITES } = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
	check("no vendor guideline rewrite table survives", AGENT_GUIDELINE_REWRITES === undefined);
	const prompt = buildOwnedSystemPrompt({ cwd: os.tmpdir(), selectedTools: ["read", "bash"], promptGuidelines: ["Delegate wide work to Agent", "Delegate wide work to Agent"] });
	check("a tool's guideline reaches the prompt verbatim", prompt.includes("- Delegate wide work to Agent"));
	check("and exactly once, however many tools declare it", prompt.split("- Delegate wide work to Agent").length === 2, prompt);
}

// ---------------------------------------------------------------------------
console.log("\ntool-policy: display-cased wire names (the live payload shape)");
{
	const { applyToolPolicy } = await jiti.import(`${ROOT}/lib/tool-policy.ts`);
	// Exactly the names a live main-session payload carried on 2026-08-29, `todo`
	// (the plan tool, since removed) included.
	const live = ["Read", "Bash", "Edit", "Write", "web_search", "Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop", "todo", "Grep", "find", "ls"].map(
		(name) => ({ name, description: name === "Bash" ? "Execute a bash command in the current working directory. Optionally provide a timeout in seconds." : "d", input_schema: { type: "object", properties: name === "Bash" ? { timeout: { description: "Timeout in seconds (optional, no default timeout)" } } : {} } }),
	);
	live[live.length - 1].cache_control = { type: "ephemeral" };
	const out = applyToolPolicy(live);
	const names = out.map((t) => t.name);
	check("the cut fires on display-cased names", !names.includes("Grep") && !names.includes("find") && !names.includes("ls"), names.join(","));
	check("eleven tools stand", out.length === 11, String(out.length));
	check("the display-cased Bash passes through untouched", out.find((t) => t.name === "Bash") === live[1]);
	check("the orphaned breakpoint moved to the new last tool", out[out.length - 1].cache_control !== undefined && out[out.length - 1].name === "todo");
}

// ---------------------------------------------------------------------------
console.log("\ntool-policy: the order is canonical, so the tool set decides the bytes (issues/45, E')");
{
	const { wirePrint } = await jiti.import(`${ROOT}/lib/wire-trace.ts`);

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

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
