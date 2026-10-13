import { createWriteToolDefinition, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerAbortBoundedTool } from "../../lib/tools/tool-abort-bound.ts";
import { receipt } from "../../lib/transcript/tool-receipt.ts";
import { executeWithOverwriteDiff } from "../../lib/transcript/write-receipt.ts";

/** The built-ins whose rows are the receipt. */
export const RECEIPT_TOOLS = ["read", "write"] as const;

const receipts = new Map(RECEIPT_TOOLS.map((tool) => [tool, receipt(tool)]));

// shared-state: a cwd-keyed cache of tool definitions; a second copy re-reads them, it never loses a registration
const writes = new Map<string, ToolDefinition<any, any, any>>();
function writeFor(cwd: string): ToolDefinition<any, any, any> {
	const cached = writes.get(cwd);
	if (cached) return cached;
	const made = createWriteToolDefinition(cwd);
	writes.set(cwd, made);
	return made;
}

/** Gives the five built-ins the receipt rows; `write` also carries the overwrite diff. */
export function registerBuiltinToolRows(pi: ExtensionAPI): void {
	// SAFETY: RECEIPT_TOOLS holds the built-in names; Map.get returns undefined for any other tool name
	pi.registerToolRenderer((tool, next) => receipts.get(tool as (typeof RECEIPT_TOOLS)[number]) ?? next());
	const meta = writeFor(process.cwd());
	const execute: ToolDefinition<any, any, any>["execute"] = (id, params, signal, onUpdate, ctx) =>
		writeFor(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
	registerAbortBoundedTool(pi, { ...meta, execute: executeWithOverwriteDiff(execute) }, () => "The write may still complete; read the file to see whether it did.");
}
