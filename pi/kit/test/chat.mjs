/**
 * The chat seat, pinned so it can never quietly grow.
 *
 * `chat` exists to cost roughly the question: PI_CHAT=1 must strip the wire
 * to the Claude Code invariant (attribution + identity, nothing after) and
 * exactly one tool. These checks are the fence — a change that adds one block
 * or one schema to a chat request fails here before it costs a token, and the
 * control case pins that a seat *without* the flag still carries the full
 * owned prompt.
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
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

const HOME = os.homedir();
const REPO = path.join(HOME, "dotfiles");

const policy = await jiti.import(`${ROOT}/lib/tool-policy.ts`);
const { applyChatToolPolicy, CHAT_TOOLS } = policy;
const cc = await jiti.import(`${ROOT}/lib/claude-code.ts`);
const { ATTRIBUTION_PREFIX, CLAUDE_CODE_IDENTITY } = cc;
const owned = await jiti.import(`${ROOT}/lib/owned-prompt.ts`);
const { CHAT_PROMPT, buildChatSystemPrompt } = owned;

// ---------------------------------------------------------------------------
console.log("chat: the owned block");
{
	check("no append text is the sentence alone", buildChatSystemPrompt(undefined) === CHAT_PROMPT);
	check("empty append text is the sentence alone", buildChatSystemPrompt("  \n ") === CHAT_PROMPT);
	check("append text follows the sentence, one blank line between", buildChatSystemPrompt("<COMMUNICATION>\nsay it simply\n</COMMUNICATION>") === `${CHAT_PROMPT}\n\n<COMMUNICATION>\nsay it simply\n</COMMUNICATION>`);
	check("the identity sentence stays a sentence", CHAT_PROMPT.length < 60, String(CHAT_PROMPT.length));
}

// ---------------------------------------------------------------------------
console.log("chat: the tool cut");
{
	const tool = (name, extra = {}) => ({ name, description: "d", input_schema: { type: "object", properties: {} }, ...extra });
	const bash = (extra = {}) => ({ name: "Bash", description: "Execute a bash command. Optionally provide a timeout in seconds.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { description: "Timeout in seconds (optional, no default timeout)" } } }, ...extra });
	const full = [tool("web_search"), tool("Read"), tool("Edit"), tool("url_context"), bash(), tool("Write", { cache_control: { type: "ephemeral" } })];

	const out = applyChatToolPolicy(full);
	check("the allowlist is web search and bash, nothing else", CHAT_TOOLS.join(",") === "web_search,bash");
	check("only web search and bash survive", out.map((t) => t.name).join(",") === "web_search,Bash", JSON.stringify(out.map((t) => t.name)));
	check("url_context is cut too — web_search takes urls itself", !out.some((t) => t.name === "url_context"));
	check("chat's bash passes through as registered — the owned tool's text is the truth", out[1].description === full[4].description && out[1].input_schema === full[4].input_schema);
	check("the orphaned breakpoint moved to the last surviving tool", out[1].cache_control?.type === "ephemeral");
	check("it fires on display casing too", applyChatToolPolicy([tool("Web_Search"), tool("Edit")]).length === 1);
	check("pi's own tool objects are not mutated", full[5].cache_control !== undefined && full[4].description.includes("Optionally provide") && full.length === 6);
	check("it is a pure function — same array in, same bytes out", JSON.stringify(applyChatToolPolicy(full)) === JSON.stringify(applyChatToolPolicy(full)));

	// It runs inside the handler whose return value is the request: a throw
	// there drops the owned system prompt off the wire.
	check("a payload it cannot read comes back rather than thrown over", (() => {
		for (const tools of [[], [null], [{ name: 7 }], [{ input_schema: null }]]) {
			try { if (!Array.isArray(applyChatToolPolicy(tools))) return false; } catch { return false; }
		}
		return true;
	})());
}

// ---------------------------------------------------------------------------
console.log("\nchat: the wire is the invariant alone");
{
	const APPEND = "<COMMUNICATION>\nCommunicate like Feynman.\n</COMMUNICATION>";
	const options = { cwd: REPO, selectedTools: ["read", "bash"], toolSnippets: { read: "Read", bash: "Bash" }, appendSystemPrompt: APPEND };
	const payload = () => ({
		messages: [{ role: "user", content: [{ type: "text", text: "what is a quark?" }] }],
		system: [{ type: "text", text: "vanilla pi prompt", cache_control: { type: "ephemeral" } }],
		tools: [
			{ name: "web_search", description: "d", input_schema: { type: "object", properties: {} } },
			{ name: "Read", description: "d", input_schema: { type: "object", properties: {} } },
			{ name: "Bash", description: "Execute a bash command. Optionally provide a timeout in seconds.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { description: "Timeout in seconds (optional, no default timeout)" } } } },
		],
	});
	// One session id per drive: the prompt capture is keyed by session and shared
	// across module instances on purpose (it has to survive an extension reload),
	// so two seats sharing an id would inherit each other's options.
	const ctx = (oauth = true, sessionId = "550e8400-e29b-41d4-a716-446655440000") => ({
		cwd: REPO,
		model: { id: "claude-test", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
		modelRegistry: { isUsingOAuth: () => oauth, find: (provider, id) => ({ provider, id }) },
		sessionManager: { getSessionId: () => sessionId, getHeader: () => ({}) },
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c, s) => s } },
	});

	let seats = 0;
	/** One wire instance driven through pi's seams, with PI_CHAT as given. */
	const drive = async (tag, { chat, oauth = true, capture = true } = {}) => {
		if (chat) process.env.PI_CHAT = "1";
		else delete process.env.PI_CHAT;
		try {
			const mod = await jiti.import(`${ROOT}/extensions/wire.ts?${tag}`);
			const handlers = new Map();
			mod.default({ events: { on: () => () => {}, emit: () => {} }, on: (e, h) => handlers.set(e, h), registerCommand: () => {} });
			const c = ctx(oauth, `550e8400-e29b-41d4-a716-4466554400${String(++seats).padStart(2, "0")}`);
			if (capture) handlers.get("before_agent_start")({ systemPromptOptions: options }, c);
			return handlers.get("before_provider_request")({ payload: payload() }, c);
		} finally {
			delete process.env.PI_CHAT;
		}
	};

	const chat = await drive("chatmain", { chat: true });
	check("system is exactly four blocks", chat.system.length === 4, JSON.stringify(chat.system.map((b) => b.text.slice(0, 40))));
	check("block 0 is the attribution", chat.system[0].text.startsWith(ATTRIBUTION_PREFIX));
	check("block 1 is the identity, byte for byte", chat.system[1].text === CLAUDE_CODE_IDENTITY);
	check("block 2 is the owned block, byte for byte", chat.system[2].text === `${CHAT_PROMPT}\n\n${APPEND}`, chat.system[2].text);
	check("the communication block rides along", chat.system[2].text.includes("Communicate like Feynman"));
	check("no block carries the coding prompt", !chat.system.some((b) => b.text.includes("personal agent") || b.text.includes("file operations")));
	check("and nothing else off the capture — no cwd, no tool list", !chat.system[2].text.includes(REPO) && !chat.system[2].text.includes("Available tools"));
	check("the cwd rides in the last block, past the breakpoint", chat.system[3].text === `Current working directory: ${REPO}` && chat.system[3].cache_control === undefined, JSON.stringify(chat.system[3]));
	check("pi's cache breakpoint moved to the owned block", chat.system[2].cache_control?.type === "ephemeral" && chat.system[1].cache_control === undefined);
	check("tools are web search and bash alone, in canonical order", chat.tools.map((t) => t.name).join(",") === "Bash,web_search", JSON.stringify(chat.tools.map((t) => t.name)));
	check("the wire does not rewrite bash — its registration is what goes out", chat.tools[0].description === "Execute a bash command. Optionally provide a timeout in seconds.");

	const degraded = await drive("chatdegraded", { chat: true, capture: false });
	check("no capture is still four blocks, the sentence without the append", degraded.system.length === 4 && degraded.system[2].text === CHAT_PROMPT, JSON.stringify(degraded.system[2]));
	check("and pi's prose never arrives on that path either", !degraded.system.some((b) => b.text.includes("vanilla pi prompt")));

	const apiKey = await drive("chatapikey", { chat: true, oauth: false });
	check(
		"an API-key chat request is the owned block and its cwd — no invariant on a Console key",
		apiKey.system.length === 2 && apiKey.system[0].text === `${CHAT_PROMPT}\n\n${APPEND}` && apiKey.system[1].text === `Current working directory: ${REPO}`,
		JSON.stringify(apiKey.system),
	);
	check("and still only web search and bash", apiKey.tools.map((t) => t.name).join(",") === "Bash,web_search");

	// The control: the same drive without the flag is a coding seat. The full
	// shape is pinned by the wire suites; here it only has to differ.
	const coding = await drive("chatcontrol", { chat: false });
	check("without PI_CHAT the owned prompt is on the wire", coding.system.length === 4 && coding.system[2].text.length > CLAUDE_CODE_IDENTITY.length);
	check("and the coding seat keeps its tools", coding.tools.length === 3);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
