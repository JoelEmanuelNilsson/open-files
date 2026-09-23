#!/usr/bin/env node
/**
 * What a seat sends on its first request, rendered offline.
 *
 *   pi-prompt.mjs <main | lead | worker | explore | workflow-child> [--workflows]
 *
 * Same shape as the in-session `/prompt` dump (`lib/wire-dump.ts`), built from
 * the same modules the live request path uses: pi's resource loader for the
 * skills, context files and extension set; `lib/owned-prompt.ts` and
 * `lib/inherited-prompt.ts` for the system text; `lib/tool-policy.ts` for
 * which tools the seat carries and in what order.
 * Nothing is retyped here that one of those modules already decides.
 *
 * No provider call and no TUI: the tools are converted to their wire shape by
 * pi-ai's own request builder, stopped at `onPayload` — the hook whose
 * argument *is* the request — before a client is ever used. So the tool bytes
 * are the provider's, not this script's idea of them. A seat whose model runs
 * on the ChatGPT subscription (explore on Luna) renders as the Codex request
 * `extensions/wire.ts` sends: the owned prompt and cwd as `instructions`, no
 * Claude Code blocks or headers.
 *
 * Two things are synthesized, because they only exist once a session does: the
 * session and agent uuids in the headers and the attribution block, and the
 * conversation (rendered empty — a first request's messages are the brief,
 * which is not a property of the seat). Everything else is the live bytes.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DefaultResourceLoader, getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const SEATS = ["main", "lead", "worker", "explore", "workflow-child"];
/** The launch answer a live seat gets from `session-mode`; here it is a flag, because there is no launcher. */
const WORKFLOWS_FLAG = "--workflows";
const USAGE = `usage: pi-prompt.mjs <${SEATS.join(" | ")}> [${WORKFLOWS_FLAG}]`;

const piDist = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const piAiDist = new URL("./", import.meta.resolve("@earendil-works/pi-ai"));

const { createAllToolDefinitions } = await import(new URL("core/tools/index.js", piDist).href);
/** pi-ai's request builder for each wire this harness owns, keyed by `model.api`. */
const STREAMS = {
	"anthropic-messages": (await import(new URL("api/anthropic-messages.js", piAiDist).href)).stream,
	"openai-codex-responses": (await import(new URL("api/openai-codex-responses.js", piAiDist).href)).stream,
};
const { normalizeContext } = await import(new URL("index.js", piAiDist).href);

const KIT = new URL("../", import.meta.url).pathname;
const { createJiti } = await import(new URL("../node_modules/jiti/lib/jiti.mjs", piDist).href);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const lib = async (name) => jiti.import(`${KIT}lib/${name}.ts`);

const { AGENT_TOOL_NAMES, agentToolDescription } = await lib("agent-tool-text");
const { buildAttributionHeader, CLAUDE_CODE_IDENTITY, claudeCodeHeaders, claudeCodeToolName, isFirstParty, subagentIdentity } = await lib("claude-code");
const { inheritedSessionPrompt, ownedSessionPrompt } = await lib("inherited-prompt");
const { codexInstructions } = await lib("owned-prompt");
const { newestInFamily } = await lib("model-family");
const { loadAgentTypes } = await lib("agent-types");
const { applyToolPolicy, canonicalToolOrder } = await lib("tool-policy");
const { captureWire, renderWireCapture } = await lib("wire-dump");

/** What each seat is to the two modules that ask: the prompt seam and the tool cuts. */
function seatSpec(seat, types, workflows) {
	const type = types.find((candidate) => candidate.name === (seat === "workflow-child" ? "worker" : seat));
	switch (seat) {
		case "main":
			return { toolSeat: { role: "main", workflows }, type: undefined };
		case "lead":
			return { toolSeat: { role: "lead", workflows }, type };
		case "worker":
		case "explore":
			return { toolSeat: { role: "worker", workflows }, type };
		case "workflow-child":
			return { toolSeat: { role: "worker", workflowChild: true, workflows }, type };
		default:
			return undefined;
	}
}

/**
 * The tools the seat's session would hold, in the order pi's registry builds
 * them: the four base tools, then every extension-registered tool in load
 * order (pi's `_refreshToolRegistry` with `includeAllExtensionTools`), with a
 * same-named registration replacing the base tool in place.
 */
function activeToolDefinitions(cwd, settings, extensions) {
	const base = createAllToolDefinitions(cwd, {
		read: { autoResizeImages: settings.getImageAutoResize() },
		bash: { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() },
	});
	const registry = new Map(Object.entries(base));
	const fromExtensions = [];
	for (const extension of extensions) {
		// pi files each registration as `{definition, sourceInfo}`, keyed by name.
		for (const { definition } of extension.tools.values()) {
			registry.set(definition.name, definition);
			fromExtensions.push(definition.name);
		}
	}
	const names = [...new Set(["read", "bash", "edit", "write", ...fromExtensions])];
	return names.map((name) => registry.get(name)).filter((definition) => definition !== undefined);
}

/**
 * Two tools leave the active list at session start, each by a decision its own
 * extension makes and this script may not hold a second opinion of: pi-web-search
 * keeps `url_context` only on a model that has URL context, and plannotator
 * carries its submit tool only inside a planning phase. Both are asked through
 * the owner's own exported function, so a seat's first request here holds what
 * a live one holds. An owner this cannot load is reported, never guessed at.
 */
const NARROWINGS = [
	{
		owner: "pi-web-search",
		moduleOf: (path) => path,
		apply: (module, names, model) => {
			let active = names;
			const manager = module.createModelScopedToolManager({
				getActiveTools: () => active,
				setActiveTools: (next) => {
					active = next;
				},
			});
			manager.sync(model);
			return active;
		},
	},
	{
		owner: "@plannotator/pi-extension",
		moduleOf: (path) => join(path, "tool-scope.ts"),
		apply: (module, names) => module.stripPlanningOnlyTools(names),
	},
];

/** The active tool names after every owner has narrowed them, and what could not be asked. */
async function narrowedToolNames(names, model, extensions) {
	const problems = [];
	let active = names;
	for (const narrowing of NARROWINGS) {
		const extension = extensions.find((candidate) => String(candidate.path).includes(narrowing.owner));
		if (extension === undefined) continue;
		try {
			active = narrowing.apply(await jiti.import(narrowing.moduleOf(extension.path)), active, model);
		} catch (error) {
			problems.push(`${narrowing.owner}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { active, problems };
}

/**
 * A credential pi-ai accepts offline for each wire: an OAuth-shaped Anthropic
 * key, and a JWT carrying the account claim the Codex builder reads before
 * `onPayload`. Neither is ever sent.
 */
const OFFLINE_KEYS = {
	"anthropic-messages": "sk-ant-oat01-offline",
	"openai-codex-responses": ["{}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }), "offline"].map((part) => Buffer.from(part).toString("base64")).join("."),
};

/** The tool names a seat's wire carries: Claude Code's casing on Anthropic OAuth, pi's own on Codex. */
const toolNamingOf = (model) => (model.api === "anthropic-messages" ? claudeCodeToolName : undefined);

/**
 * The request as the provider would receive it, built by pi-ai's own request
 * builder and taken off `onPayload` — the hook whose return value is the
 * request — before any client exists. The throw is what keeps it offline.
 */
async function wirePayload(model, definitions, sessionId) {
	const tools = definitions.map((definition) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(definition.constrainedSampling ? { constrainedSampling: definition.constrainedSampling } : {}),
	}));
	let captured;
	const stop = new Error("payload captured");
	const events = STREAMS[model.api](
		model,
		// pi-ai reads the prompt and the tools off the transcript's leading system
		// message; `normalizeContext` is its own entry point for building one.
		normalizeContext({ messages: [{ role: "user", content: "" }], tools, systemPrompt: "" }),
		{
			apiKey: OFFLINE_KEYS[model.api],
			sessionId,
			env: process.env,
			onPayload: async (payload) => {
				captured = payload;
				throw stop;
			},
		},
	);
	try {
		for await (const _event of events) {
			// Drained so the stream settles; it never reaches the provider.
		}
	} catch {
		// The sentinel throw, surfaced as a stream error. Nothing to report.
	}
	return captured ?? {};
}

async function main(argv) {
	const workflows = argv.includes(WORKFLOWS_FLAG);
	const rest = argv.filter((arg) => arg !== WORKFLOWS_FLAG);
	const seat = rest[0];
	if (seat === undefined || !SEATS.includes(seat) || rest.length > 1) {
		console.error(USAGE);
		return 1;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { types } = loadAgentTypes(join(agentDir, "agents"));
	const spec = seatSpec(seat, types, workflows);
	if (spec.type === undefined && seat !== "main") {
		console.error(`no agent type "${seat}" in ${join(agentDir, "agents")}`);
		return 1;
	}
	// The type's body is the child's custom prompt, exactly as the engine passes
	// it (`extensions/agent-engine.ts`'s childLoader). A type with no body is an
	// inheriting seat and gets its parent's published bytes instead.
	const body = spec.type?.prompt ? spec.type.prompt : undefined;

	const settings = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noPromptTemplates: true,
		noThemes: true,
		...(body !== undefined ? { systemPromptOverride: () => body } : {}),
	});
	await loader.reload();

	// `modelsPath: null` because there is no ~/.pi/agent/models.json: pi ships the
	// whole catalog, and the seat's frontmatter names a family, not a release.
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	await runtime.refresh({ allowNetwork: false });
	const wanted = (spec.type?.model ?? settings.getDefaultModel() ?? "").split("/").pop();
	// No fallback id. A release named here would be the hand-kept pin this module
	// exists to delete, and it would be reached exactly when the catalog read
	// failed — the one moment its answer cannot be trusted.
	const modelFor = (spec) => {
		const answer = newestInFamily(spec, runtime.getAvailableSnapshot());
		return answer.kind === "found" ? runtime.getModel(answer.model.provider, answer.model.id) : undefined;
	};
	const model = modelFor(wanted);
	if (model === undefined || STREAMS[model.api] === undefined) {
		const resolved = model === undefined ? "nothing" : `${model.provider}/${model.id} on ${model.api}`;
		console.error(`no model for "${wanted}" on a wire this harness owns (resolved: ${resolved})`);
		return 1;
	}
	// The parent a child inherits from is the main seat, on the launcher's model.
	const parentModel = seat === "main" ? model : modelFor((settings.getDefaultModel() ?? "").split("/").pop());
	if (parentModel === undefined) {
		console.error(`no model for the main seat's "${settings.getDefaultModel()}" in this installation`);
		return 1;
	}

	const extensions = loader.getExtensions().extensions;
	const registered = activeToolDefinitions(cwd, settings, extensions);
	const narrowed = await narrowedToolNames(
		registered.map((definition) => definition.name),
		model,
		extensions,
	);
	// The `Agent` tool's words are a function of the seat's workflow answer, which
	// a live session gives its engine at the first turn (`extensions/agent-engine.ts`).
	// Offline there is no turn, so the same function is asked here.
	const definitions = registered
		.filter((definition) => narrowed.active.includes(definition.name))
		.map((definition) =>
			definition.name === AGENT_TOOL_NAMES.AGENT ? { ...definition, description: agentToolDescription(types, workflows) } : definition,
		);
	const promptGuidelines = [];
	for (const definition of definitions) {
		for (const guideline of definition.promptGuidelines ?? []) promptGuidelines.push(guideline);
	}
	const append = loader.getAppendSystemPrompt();
	const options = {
		cwd,
		skills: loader.getSkills().skills,
		contextFiles: loader.getAgentsFiles().agentsFiles,
		customPrompt: loader.getSystemPrompt(),
		appendSystemPrompt: append.length > 0 ? append.join("\n\n") : undefined,
		selectedTools: definitions.map((definition) => definition.name),
		toolSnippets: {},
		promptGuidelines,
	};

	// The seat's own session id, and its parent's, invented here: a prompt is
	// published under one and inherited from the other, and offline there is no
	// session to ask. Only the headers and the attribution block show them.
	const sessionId = randomUUID();
	const parentSessionId = randomUUID();
	// Each rendered in the tool names its own wire carries (an Anthropic seat as the
	// OAuth request it mimics), exactly as a live seat's guidelines are.
	if (seat !== "main") ownedSessionPrompt({ ...options, customPrompt: undefined }, { sessionId: parentSessionId, parentSessionId: undefined }, toolNamingOf(parentModel));
	const lineage = { sessionId, parentSessionId: seat === "main" ? undefined : parentSessionId };
	const prompt = body === undefined && seat !== "main" ? inheritedSessionPrompt(options, lineage, toolNamingOf(model)) : ownedSessionPrompt(options, lineage, toolNamingOf(model));

	const payload = await wirePayload(model, definitions, sessionId);
	const tools = canonicalToolOrder(applyToolPolicy(payload.tools ?? [], spec.toolSeat));
	const capture = model.api === "openai-codex-responses" ? codexCapture(model, payload, prompt, cwd, tools) : anthropicCapture(model, prompt, tools, seat, sessionId, parentSessionId);
	console.log(renderWireCapture(capture));
	for (const problem of narrowed.problems) {
		console.log(`NOT RENDERED EXACTLY — could not ask ${problem}; its tools are shown as registered, which a live session may narrow.`);
	}

	const systemChars = capture.system.reduce((sum, block) => sum + block.text.length, 0);
	const toolsChars = JSON.stringify(tools).length;
	const approx = Math.ceil((systemChars + toolsChars) / 4);
	console.error(
		`${seat}${workflows ? " +workflows" : ""}: system ${systemChars} chars, tools ${toolsChars} chars, ${tools.length} tools, ~${approx} tokens (chars/4), model ${model.provider}/${model.id}`,
	);
	return 0;
}

/**
 * The Codex request `extensions/wire.ts` sends: pi-ai's body with the owned
 * prompt and cwd as its `instructions` and the seat's tools. No headers are
 * shown because offline there is no header bag for pi to hand over.
 */
function codexCapture(model, payload, prompt, cwd, tools) {
	const instructions = codexInstructions(prompt, cwd);
	return captureWire({
		api: "openai-codex-responses",
		at: new Date(),
		model: model.id,
		oauth: true,
		degraded: false,
		system: [{ type: "text", text: instructions }],
		headers: {},
		tools,
		messages: [],
		payload: { ...payload, instructions, tools },
	});
}

/** The Anthropic OAuth request: attribution, identity, the owned prompt, and the Claude Code headers. */
function anthropicCapture(model, prompt, tools, seat, sessionId, parentSessionId) {
	const subagent = seat === "main" ? undefined : subagentIdentity(sessionId, parentSessionId);
	const system = [
		{
			type: "text",
			text: buildAttributionHeader({
				firstUserText: "",
				firstParty: isFirstParty(model.baseUrl),
				subagent,
				previousRequestId: undefined,
				promptId: randomUUID(),
			}),
		},
		{ type: "text", text: CLAUDE_CODE_IDENTITY },
		{ type: "text", text: prompt, cache_control: { type: "ephemeral" } },
	];
	return captureWire({
		api: "anthropic-messages",
		at: new Date(),
		model: model.id,
		oauth: true,
		degraded: false,
		system,
		headers: claudeCodeHeaders({ sessionId, ...(subagent ? { subagent } : {}) }),
		tools,
		messages: [],
	});
}

process.exit(await main(process.argv.slice(2)));
