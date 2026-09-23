/**
 * The /prompt dump: the whole context window, verbatim (issues/37). Two
 * contracts under test — fidelity (tools and messages appear raw and in full,
 * snapshotted at send time so later mutation cannot lie) and totality
 * (capture runs on the provider hot path, where a throw strips the owned
 * system prompt off the wire, so nothing here may ever throw).
 */

import "./env.mjs";
import { createJiti } from "/Users/joel/.nvm/versions/node/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
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

const dump = await jiti.import(`${ROOT}/lib/wire-dump.ts`);
const { captureWire, renderWireCapture } = dump;

const capture = (overrides = {}) =>
	captureWire({
		api: "anthropic-messages",
		at: new Date("2026-08-30T12:00:00Z"),
		model: "claude-opus-4",
		oauth: true,
		degraded: false,
		headers: { "user-agent": "claude-cli/2.1.248" },
		system: [{ type: "text", text: "You are Claude Code." }],
		tools: undefined,
		messages: undefined,
		...overrides,
	});

const SCHEMA = {
	type: "object",
	properties: { command: { type: "string", description: "Shell command to execute" } },
	required: ["command"],
};

// ---------------------------------------------------------------------------
console.log("wire-dump: fidelity — every token of the request is in the dump");
{
	const tools = [
		{ name: "bash", description: "Run a shell command.", input_schema: SCHEMA },
		{ name: "read", description: "Read a file.", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
	];
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "a private thought", signature: "sig-abc" },
				{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls -la" } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "total 0", cache_control: { type: "ephemeral" } }] },
		{ role: "user", content: "plain string content" },
	];
	const text = renderWireCapture(capture({ tools, messages }));

	check("system text appears verbatim", text.includes("You are Claude Code."));
	check("a tool's description is in the dump", text.includes("Run a shell command."));
	check("a tool's input schema is in the dump", text.includes('"description": "Shell command to execute"'));
	check("tools keep wire order, not size order", text.indexOf("### bash") < text.indexOf("### read"), text);
	check("a tool's cache_control is noted", text.includes('### read — ') && /### read.*cache_control=\{"type":"ephemeral"\}/.test(text));
	check("message text appears raw", text.includes("hi"));
	check("thinking blocks appear in full", text.includes("a private thought") && text.includes("sig-abc"));
	check("tool_use input appears", text.includes('"command": "ls -la"'));
	check("tool_result content appears", text.includes("total 0"));
	check("string-form message content appears", text.includes("plain string content"));
	check("roles are labelled", text.includes("— user,") && text.includes("— assistant,"));
	check("per-tool token estimate present", /### bash — \d+ chars, ~\d+ tokens/.test(text));
	check("headers are listed", text.includes("user-agent: claude-cli/2.1.248"));

	const toolsChars = JSON.stringify(tools).length;
	const messagesChars = JSON.stringify(messages).length;
	check("totals line counts wire JSON chars/4",
		text.includes(`tools ~${Math.ceil(toolsChars / 4)}`) && text.includes(`messages ~${Math.ceil(messagesChars / 4)}`), text.split("\n")[6]);
	const totals = text.match(/- total: ~(\d+) tokens \(system ~(\d+) \+ tools ~(\d+) \+ messages ~(\d+)/);
	check("the totals line is an actual equation",
		totals !== null && Number(totals[1]) === Number(totals[2]) + Number(totals[3]) + Number(totals[4]), JSON.stringify(totals));
}

// ---------------------------------------------------------------------------
console.log("wire-dump: fidelity — a block is raw text only when it is purely text");
{
	// A text block carrying a field this module has never heard of holds bytes
	// the raw view would hide behind a count that says they went out — the exact
	// failure class the ticket exists to kill. It must take the JSON branch.
	const text = renderWireCapture(capture({
		messages: [{
			role: "user",
			content: [{ type: "text", text: "The sky is blue.", citations: [{ cited_text: "HIDDEN SOURCE" }] }],
		}],
	}));
	check("a text block with extra fields shows every field", text.includes("HIDDEN SOURCE") && text.includes("The sky is blue."));
	const pure = renderWireCapture(capture({
		messages: [{ role: "user", content: [{ type: "text", text: "plain", cache_control: { type: "ephemeral" } }] }],
	}));
	check("a pure text block (with cache_control) still renders raw", pure.includes("— text cache_control=") && pure.includes("\nplain\n"));
}

// ---------------------------------------------------------------------------
console.log("wire-dump: the totals line and the sections never disagree");
{
	// tools captured but not an array: whatever it is, it went on the wire —
	// so it is both counted and shown, never counted and hidden.
	const text = renderWireCapture(capture({ tools: { bash: { description: "odd shape" } } }));
	check("a non-array tools value is shown exactly", text.includes("unexpected non-array shape") && text.includes('"description": "odd shape"'));
	const counted = text.match(/tools ~(\d+)/);
	check("and counted in the totals line", counted !== null && Number(counted[1]) > 0, text.split("\n")[6]);
}

// ---------------------------------------------------------------------------
console.log("wire-dump: fidelity — the snapshot is taken at send time");
{
	const tools = [{ name: "bash", description: "original description", input_schema: {} }];
	const messages = [{ role: "user", content: [{ type: "text", text: "original message" }] }];
	const snapped = capture({ tools, messages });
	tools[0].description = "mutated later";
	messages[0].content[0].text = "mutated later";
	const text = renderWireCapture(snapped);
	check("mutating tools after capture changes nothing", text.includes("original description") && !text.includes("mutated later"));
	check("mutating messages after capture changes nothing", text.includes("original message"));
}

// ---------------------------------------------------------------------------
console.log("wire-dump: fences survive content that contains fences");
{
	const text = renderWireCapture(capture({
		system: [{ type: "text", text: "example:\n```bash\nls\n```\nend of prompt" }],
		messages: [{ role: "user", content: [{ type: "text", text: "four ```` backticks" }] }],
	}));
	check("fenced content is emitted intact", text.includes("```bash\nls\n```\nend of prompt"));
	const fenced = text.split("\n").filter((line) => /^`{4,}$/.test(line));
	check("a longer fence wraps content holding ```", fenced.length >= 2, JSON.stringify(fenced));
	check("five-backtick fence wraps content holding ````", text.split("\n").some((line) => line === "`````"));
	// The whole point: a reader (or renderer) sees the content between fences,
	// with no fence line of the content ever closing the wrapper early.
	check("content backticks appear verbatim", text.includes("four ```` backticks"));
}

// ---------------------------------------------------------------------------
console.log("wire-dump: totality — nothing on the hot path may throw");
{
	const cyclic = {};
	cyclic.self = cyclic;
	let snapped;
	check("circular tools/messages capture without throwing", (() => {
		try {
			snapped = capture({ tools: [cyclic], messages: [cyclic] });
			return true;
		} catch {
			return false;
		}
	})());
	const text = renderWireCapture(snapped);
	check("the dump says what it could not capture", text.includes("## tools") && text.includes("could not be serialized"));
	check("absent tools render as absent", renderWireCapture(capture()).includes("(not captured"));
	check("non-array messages render without throwing", (() => {
		try {
			renderWireCapture(capture({ messages: { role: "user" } }));
			return true;
		} catch {
			return false;
		}
	})());
	check("nameless tools and roleless messages render", (() => {
		const text = renderWireCapture(capture({ tools: [{ input_schema: {} }], messages: [{ content: 42 }] }));
		return text.includes("### ? —") && text.includes("— ?,");
	})());
	check("a message with no content field says so", renderWireCapture(capture({ messages: [{ role: "user" }] })).includes("(no content field)"));
}

// ---------------------------------------------------------------------------
console.log("wire-dump: a codex request renders as what it is");
{
	const input = [
		{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		{ type: "function_call", call_id: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" },
		{ type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "done" }] },
	];
	const text = renderWireCapture(capture({
		api: "openai-codex-responses",
		model: "gpt-6-luna",
		headers: { Authorization: "Bearer secret-token", "chatgpt-account-id": "acct" },
		system: [{ type: "text", text: "OWNED PROMPT\n\nCurrent working directory: /w" }],
		messages: input,
		payload: { model: "gpt-6-luna", instructions: "OWNED PROMPT", input, tools: [], prompt_cache_key: "k1", reasoning: { effort: "medium" } },
	}));
	check("the api is named", text.includes("- api: openai-codex-responses"));
	check("its prompt is the instructions, not system blocks", text.includes("## instructions (") && text.includes("OWNED PROMPT") && !text.includes("## system blocks"));
	check("its headers are pi's, with no claim of claude code", !text.includes("claude code headers") && !text.includes("not an OAuth request") && text.includes("- chatgpt-account-id: acct"));
	check("a credential header is named, never copied", text.includes("- Authorization: (redacted)") && !text.includes("secret-token"));
	check("the other request fields are shown, the sections' own fields are not repeated", /## request fields[\s\S]*"prompt_cache_key": "k1"[\s\S]*"effort": "medium"/.test(text) && !/## request fields[^#]*"instructions"/.test(text));
	check("the conversation is its input", text.includes("## input (3,"));
	check("a function call item shows every byte", text.includes("### message 1 — function_call") && text.includes('"call_id": "c1"'));
	check("a message item with fields beside role and content shows them", text.includes('"id": "msg_1"'));
	check("an anthropic capture keeps its own headings", renderWireCapture(capture()).includes("## claude code headers") && renderWireCapture(capture()).includes("## system blocks"));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
