import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { notice } from "../lib/process/human-notice.ts";
import { registerAbortBoundedTool } from "../lib/tools/tool-abort-bound.ts";

const WEB_SEARCH_SOURCE = join("npm", "node_modules", "pi-web-search", "src", "web_search.ts");

export default async function (pi: ExtensionAPI) {
	let loaded: { webSearch: never; WebSearchSchema: never };
	try {
		loaded = await import(pathToFileURL(join(getAgentDir(), WEB_SEARCH_SOURCE)).href);
	} catch (error) {
		pi.on("session_start", (_event, ctx) => notice(ctx, `web_search is unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		return;
	}
	const { webSearch, WebSearchSchema } = loaded;
	registerAbortBoundedTool(pi, {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using the current supported provider (Google Gemini, OpenAI, or Anthropic). Optionally include URLs to analyze alongside search results.",
		parameters: WebSearchSchema,
		exposure: "deferred",
		execute: webSearch,
	});
}
