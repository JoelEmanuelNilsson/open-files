/**
 * Token estimates for a tool's words without a tokenizer: pi's own heuristic
 * (chars/4) and the kit inventory's (chars/3.7). The workflow tests hold the
 * `Workflow` description and its parameters under budget with it.
 */

/** Both estimates of `text`'s token count, rounded up. */
export function estimateWorkflowTextTokens(text) {
	return { byFour: Math.ceil(text.length / 4), byThreeSeven: Math.ceil(text.length / 3.7) };
}
