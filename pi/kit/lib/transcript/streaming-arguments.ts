const STREAMING = ["partialJson", "partialArgs", "n"] as const;

/** A tool-call block as far as its streaming fields go. */
export type StreamingFields = { readonly [field in (typeof STREAMING)[number]]?: unknown };

/** Whether a tool-call block is still receiving its arguments. */
export function argumentsStreaming(block: StreamingFields): boolean {
	return STREAMING.some((field) => block[field] !== undefined);
}
