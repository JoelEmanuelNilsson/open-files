import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { jsonArgumentCoercionFor } from "./tool-argument-coercion.ts";

export const TOOL_ABORT_BOUND_MS = 2_000;

/** The cut-short tool result's text: what was cancelled, and what `stillRunning` says goes on without the call. */
export function toolCutShortText(toolName: string, stillRunning: string | undefined): string {
	return `Cancelled: ${toolName} did not finish within ${TOOL_ABORT_BOUND_MS / 1000} s of the abort, so the call ended without its result. ${stillRunning ?? "Its work may still be running in the background; this call will not report how it ends."}`;
}

export function registerAbortBoundedTool<TParams extends TSchema, TDetails, TState>(
	pi: Pick<ExtensionAPI, "registerTool">,
	tool: ToolDefinition<TParams, TDetails, TState>,
	stillRunning?: (params: Static<TParams>) => string,
): void {
	pi.registerTool({
		...tool,
		prepareArguments: tool.prepareArguments ?? jsonArgumentCoercionFor(tool.parameters),
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const work = tool.execute(toolCallId, params, signal, onUpdate, ctx);
			if (signal === undefined) return work;
			return new Promise((resolve, reject) => {
				let bound: ReturnType<typeof setTimeout> | undefined;
				const startBound = () => {
					// raw-timer: one call's deadline, cleared the moment the call settles
					bound = setTimeout(() => reject(new Error(toolCutShortText(tool.name, stillRunning?.(params)))), TOOL_ABORT_BOUND_MS);
				};
				const settle = () => {
					clearTimeout(bound);
					signal.removeEventListener("abort", startBound);
				};
				if (signal.aborted) startBound();
				else signal.addEventListener("abort", startBound, { once: true });
				work.then(
					(result) => {
						settle();
						resolve(result);
					},
					(error: unknown) => {
						settle();
						reject(error);
					},
				);
			});
		},
	});
}

/** Awaits `work` unless `signal` aborts first: `"aborted"` then, and `work` goes on unawaited. */
export async function awaitUnlessAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<"settled" | "aborted"> {
	let cancel = (): void => {};
	const aborted = new Promise<"aborted">((resolve) => (cancel = () => resolve("aborted")));
	if (signal?.aborted) cancel();
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		return await Promise.race([work.then(() => "settled" as const, () => "settled" as const), aborted]);
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}
