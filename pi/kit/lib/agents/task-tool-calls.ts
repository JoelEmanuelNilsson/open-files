import { Type } from "typebox";
import { coerceDeclaredJsonArguments } from "../tools/tool-argument-coercion.ts";
import type { AgentNotificationDetails } from "./agent-task-notification.ts";
import { type AgentToolDetails, TASK_OUTPUT_DEFAULT_TIMEOUT_MS, TASK_OUTPUT_MAX_TIMEOUT_MS, TASK_OUTPUT_PARAMS, TASK_STOP_PARAMS } from "./agent-tool-text.ts";

export const taskOutputParams = Type.Object({
	task: Type.Optional(Type.Integer({ description: TASK_OUTPUT_PARAMS.task })),
	names: Type.Optional(Type.Array(Type.String(), { description: TASK_OUTPUT_PARAMS.names })),
	block: Type.Optional(Type.Boolean({ description: TASK_OUTPUT_PARAMS.block, default: true })),
	timeout: Type.Optional(Type.Number({ description: TASK_OUTPUT_PARAMS.timeout, default: TASK_OUTPUT_DEFAULT_TIMEOUT_MS, minimum: 0, maximum: TASK_OUTPUT_MAX_TIMEOUT_MS })),
	transcript: Type.Optional(Type.Boolean({ description: TASK_OUTPUT_PARAMS.transcript })),
});

export const taskStopParams = Type.Object({
	name: Type.Optional(Type.String({ description: TASK_STOP_PARAMS.name })),
	task: Type.Optional(Type.Integer({ description: TASK_STOP_PARAMS.task })),
});

/** What a `TaskOutput` call asks for: agents by name (none: every unread one), one background task, or both, which is refused. */
export type TaskOutputCall = { readonly kind: "agents"; readonly names: readonly string[] } | { readonly kind: "task"; readonly id: number } | { readonly kind: "invalid" };

/** What a `TaskStop` call asks to stop: an agent by name, one background task, or not exactly one of them, which is refused. */
export type TaskStopCall = { readonly kind: "agents"; readonly name: string } | { readonly kind: "task"; readonly id: number } | { readonly kind: "invalid" };

/** How a background task ended, as a task-form result's `details` carry it. */
export interface TaskEndDetails {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

/** The `details` of a `TaskOutput` result; one written before `kind` existed is the agents form's batch. */
export type TaskOutputDetails =
	| { readonly kind: "agents"; readonly batch: AgentNotificationDetails | undefined }
	| { readonly kind: "task"; readonly id: number; readonly outcome: "running" | "timed-out" | "aborted" | "noticed" | "owner-ended" }
	| ({ readonly kind: "task"; readonly id: number; readonly outcome: "finished" } & TaskEndDetails);

/** The `details` of a `TaskStop` result; one written before `kind` existed is the agents form's agent. */
export type TaskStopDetails =
	| { readonly kind: "agents"; readonly agent: AgentToolDetails }
	| { readonly kind: "task"; readonly id: number; readonly outcome: "stopping" | "in-conversation" }
	| ({ readonly kind: "task"; readonly id: number; readonly outcome: "ended" } & TaskEndDetails);

function fieldsOf(params: unknown, args: unknown): Record<string, unknown> {
	const coerced = coerceDeclaredJsonArguments(params, args);
	// SAFETY: coerced was checked to be a non-null object on this line
	return typeof coerced === "object" && coerced !== null ? (coerced as Record<string, unknown>) : {};
}

const isTaskId = (value: unknown): value is number => Number.isInteger(value);

/** Reads a `TaskOutput` call's raw or validated arguments. */
export function taskOutputCallOf(args: unknown): TaskOutputCall {
	const { task, names } = fieldsOf(taskOutputParams, args);
	if (task !== undefined) return isTaskId(task) && names === undefined ? { kind: "task", id: task } : { kind: "invalid" };
	if (names === undefined) return { kind: "agents", names: [] };
	return Array.isArray(names) && names.every((name) => typeof name === "string") ? { kind: "agents", names } : { kind: "invalid" };
}

/** Reads a `TaskStop` call's raw or validated arguments. */
export function taskStopCallOf(args: unknown): TaskStopCall {
	const { task, name } = fieldsOf(taskStopParams, args);
	if (task !== undefined) return isTaskId(task) && name === undefined ? { kind: "task", id: task } : { kind: "invalid" };
	return typeof name === "string" ? { kind: "agents", name } : { kind: "invalid" };
}
