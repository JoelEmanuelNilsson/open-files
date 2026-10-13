#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createToolSearchExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

const SEATS = ["main", "lead", "worker", "explore", "workflow-child"];
const WORKFLOWS_FLAG = "--workflows";
const USAGE = `usage: pi-prompt.mjs <${SEATS.join(" | ")}> [${WORKFLOWS_FLAG}]`;

const piDist = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const piAiDist = new URL("./", import.meta.resolve("@earendil-works/pi-ai"));

const { createAllToolDefinitions } = await import(new URL("core/tools/index.js", piDist).href);
const STREAMS = {
	"anthropic-messages": (await import(new URL("api/anthropic-messages.js", piAiDist).href)).stream,
	"openai-codex-responses": (await import(new URL("api/openai-codex-responses.js", piAiDist).href)).stream,
};
const { normalizeContext } = await import(new URL("index.js", piAiDist).href);

const KIT = new URL("../", import.meta.url).pathname;
const { createJiti } = await import(new URL("../node_modules/jiti/lib/jiti.mjs", piDist).href);
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const kitModule = async (relative) => jiti.import(`${KIT}${relative}`);

const { AGENT_TOOL_NAMES, agentParamsFor, agentToolDescription } = await kitModule("lib/agents/agent-tool-text.ts");
const { claudeCodeSystem, claudeCodeHeaders, claudeCodeToolName, isFirstParty, subagentIdentity } = await kitModule("lib/wire/claude-code.ts");
const { inheritedSessionPrompt, ownedSessionPrompt } = await kitModule("lib/wire/inherited-prompt.ts");
const { codexInstructions, cwdBlockText } = await kitModule("lib/wire/owned-prompt.ts");
const { newestInFamily } = await kitModule("lib/models/model-family.ts");
const { loadAgentTypes } = await kitModule("lib/agents/agent-type-files.ts");
const { agentTypesOf, childToolNames, startableTypes } = await kitModule("lib/agents/agent-runtime.ts");
const { canonicalToolOrder } = await kitModule("lib/wire/tools-array-order.ts");
const { captureWire, renderWireCapture } = await kitModule("lib/wire/wire-capture.ts");

function seatSpec(seat, types, workflows) {
	const type = types.find((candidate) => candidate.name === (seat === "workflow-child" ? "worker" : seat));
	if (!SEATS.includes(seat)) return undefined;
	return { type: seat === "main" ? undefined : type, workflows, workflowChild: seat === "workflow-child" };
}

function activeToolDefinitions(cwd, settings, extensions) {
	const base = createAllToolDefinitions(cwd, {
		read: { autoResizeImages: settings.getImageAutoResize() },
		bash: { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() },
	});
	const registry = new Map(Object.entries(base));
	const fromExtensions = [];
	createToolSearchExtension()({
		registerTool: (definition) => {
			registry.set(definition.name, definition);
			fromExtensions.push(definition.name);
		},
	});
	for (const extension of extensions) {
		for (const { definition } of extension.tools.values()) {
			registry.set(definition.name, definition);
			fromExtensions.push(definition.name);
		}
	}
	const names = [...new Set(["read", "bash", "edit", "write", ...fromExtensions])];
	return names.map((name) => registry.get(name)).filter((definition) => definition !== undefined);
}

const OFFLINE_KEYS = {
	"anthropic-messages": "sk-ant-oat01-offline",
	"openai-codex-responses": ["{}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }), "offline"].map((part) => Buffer.from(part).toString("base64")).join("."),
};

const toolNamingOf = (model) => (model.api === "anthropic-messages" ? claudeCodeToolName : undefined);

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
		}
	} catch {
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

	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
	await runtime.refresh({ allowNetwork: false });
	const wanted = (spec.type?.model ?? settings.getDefaultModel() ?? "").split("/").pop();
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
	const parentModel = seat === "main" ? model : modelFor((settings.getDefaultModel() ?? "").split("/").pop());
	if (parentModel === undefined) {
		console.error(`no model for the main seat's "${settings.getDefaultModel()}" in this installation`);
		return 1;
	}

	const loaded = loader.getExtensions();
	const loadFailures = loaded.errors.map(({ path, error }) => `extension ${path} failed to load: ${error}`);
	const defaultTools = settings.getDefaultTools() ?? [];
	const childTools = spec.type === undefined ? undefined : childToolNames(spec.type, spec);
	const registered = activeToolDefinitions(cwd, settings, loaded.extensions).filter((definition) =>
		childTools !== undefined
			? childTools.includes(definition.name)
			: ((definition.defaultActive !== false || defaultTools.includes(definition.name)) && (definition.exposure ?? "direct") !== "deferred"),
	);
	const startable = startableTypes(types, spec.type === undefined ? undefined : agentTypesOf(spec.type));
	const definitions = registered
		.map((definition) =>
			definition.name === AGENT_TOOL_NAMES.AGENT
				? { ...definition, description: agentToolDescription(startable, childTools === undefined ? true : childTools.includes("Workflow")), parameters: agentParamsFor(startable.map((type) => type.name)) }
				: definition,
		);
	const promptNames = definitions.map((definition) => definition.name);
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
		selectedTools: promptNames,
		toolSnippets: {},
		promptGuidelines,
	};

	const sessionId = randomUUID();
	const parentSessionId = randomUUID();
	if (seat !== "main") ownedSessionPrompt({ ...options, customPrompt: undefined }, { sessionId: parentSessionId, parentSessionId: undefined }, toolNamingOf(parentModel));
	const lineage = { sessionId, parentSessionId: seat === "main" ? undefined : parentSessionId };
	const prompt = body === undefined && seat !== "main" ? inheritedSessionPrompt(options, lineage, toolNamingOf(model)) : ownedSessionPrompt(options, lineage, toolNamingOf(model));

	const payload = await wirePayload(model, definitions, sessionId);
	const tools = canonicalToolOrder(payload.tools ?? []);
	const capture = model.api === "openai-codex-responses" ? codexCapture(model, payload, prompt, cwd, tools) : anthropicCapture(model, payload, prompt, cwd, tools, seat, sessionId, parentSessionId);
	console.log(renderWireCapture(capture));
	for (const failure of loadFailures) {
		console.log(`NOT RENDERED EXACTLY — ${failure}; the tools it registers are missing here.`);
	}

	const systemChars = capture.system.reduce((sum, block) => sum + block.text.length, 0);
	const toolsChars = JSON.stringify(tools).length;
	const approx = Math.ceil((systemChars + toolsChars) / 4);
	console.error(
		`${seat}${workflows ? " +workflows" : ""}: system ${systemChars} chars, tools ${toolsChars} chars, ${tools.length} tools, ~${approx} tokens (chars/4), model ${model.provider}/${model.id}`,
	);
	return loadFailures.length > 0 ? 1 : 0;
}

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

function anthropicCapture(model, payload, prompt, cwd, tools, seat, sessionId, parentSessionId) {
	const subagent = seat === "main" ? undefined : subagentIdentity(sessionId, parentSessionId);
	const cacheControl = [...(payload.system ?? [])].reverse().find((block) => block.cache_control)?.cache_control;
	const system = claudeCodeSystem(
		{
			firstUserText: "",
			firstParty: isFirstParty(model.baseUrl),
			subagent,
			previousRequestId: undefined,
			promptId: randomUUID(),
			turnOrigin: subagent === undefined ? "human" : undefined,
			turnPosition: subagent === undefined ? { promptIndex: 1, turnIndex: 1 } : undefined,
		},
		{ type: "text", text: prompt, ...(cacheControl ? { cache_control: cacheControl } : {}) },
		{ type: "text", text: cwdBlockText(cwd) },
	);
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
