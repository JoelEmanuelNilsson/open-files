import type { AgentStatus } from "./agent-registry.ts";

/** Expected spawn failures, as values. */
export class AgentSpawnRefused extends Error {
	readonly _tag = "AgentSpawnRefused" as const;
	constructor(
		readonly reason: "depth" | "unknown-type" | "no-model" | "worktree" | "cwd" | "thinking" | "retiring",
		message: string,
	) {
		super(message);
	}
}

/** A spawn or resume whose tool call was aborted before the child's first prompt was scheduled: it is abandoned, and nothing runs. */
export class AgentStartCancelled extends Error {
	readonly _tag = "AgentStartCancelled" as const;
	constructor(name: string) {
		super(`Agent "${name}" was not started: its tool call was aborted before the agent's first prompt.`);
	}
}

/** Expected failures of `send`. */
export class AgentSendRefused extends Error {
	readonly _tag = "AgentSendRefused" as const;
	constructor(
		readonly reason: "unknown-agent" | "no-transcript" | "no-model" | "retiring" | "cancelled" | "cold",
		message: string,
	) {
		super(message);
	}
}

/** A name that means the caller itself, or a seat above it. */
export class AgentAddressRefused extends Error {
	readonly _tag = "AgentAddressRefused" as const;
	constructor(
		readonly reason: "self" | "ancestor",
		message: string,
	) {
		super(message);
	}
}

/** Expected failures of `stop`. */
export class AgentStopRefused extends Error {
	readonly _tag = "AgentStopRefused" as const;
	constructor(
		readonly reason: "unknown-agent" | "not-running",
		message: string,
		readonly status?: AgentStatus,
	) {
		super(message);
	}
}

export function refuseToolCall(message: string): never {
	throw new Error(message);
}
