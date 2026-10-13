import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_SEARCH = "tool_search";

/** Keeps the tools `tool_search` loaded across a restart, resume or reload, and lists the deferred ones in a `<deferred_tools>` prompt section whenever `tool_search` can load them. */
export default function deferredTools(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const declared = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "system") continue;
			for (const tool of entry.message.toolsRemoved ?? []) declared.delete(tool.name);
			for (const tool of entry.message.toolsAdded ?? []) declared.add(tool.name);
		}
		const loadable = new Set(pi.getAllTools().filter((tool) => tool.exposure === "deferred" || tool.exposure === "codemode").map((tool) => tool.name));
		const active = pi.getActiveTools();
		const lost = [...declared].filter((name) => loadable.has(name) && !active.includes(name));
		if (lost.length > 0) pi.setActiveTools([...active, ...lost]);
	});

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const { deferred_tools: _stale, ...sections } = options.sections ?? {};
		const deferred = pi.getAllTools().filter((tool) => tool.exposure === "deferred");
		if (deferred.length === 0 || !pi.getActiveTools().includes(TOOL_SEARCH)) {
			options.sections = sections;
			return;
		}
		const intro = `These tools exist for you but are declared only once loaded. Call ${TOOL_SEARCH} with a tool's name to load it, also when it was loaded before and is no longer declared.`;
		const lines = deferred.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\n|(?<=\.)\s/)[0]}`);
		options.sections = { ...sections, deferred_tools: [intro, ...lines].join("\n") };
	});
}
