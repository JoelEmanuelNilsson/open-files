import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { readLastRequest } from "../../lib/wire/last-request.ts";
import { forgetSideRequestBasis, publishSideRequestBasis } from "../../lib/session/side-seat.ts";

/** The literal line that opens side mode under main's chat. */
export const SIDE_MARKER = "<SIDE-CHAT-STARTED>";

/** The only tools a side question may run. */
export const SIDE_TOOLS: ReadonlySet<string> = new Set(["read", "web_search"]);

export const SIDE_TOOL_ROUND_CAP = 8;

/** Prepended to every side user message on every request, never stored: identical bytes keep earlier side turns cached. */
export const SIDE_THREAD_PREAMBLE = [
	"<side-thread>",
	"This is a side thread. The user is asking a side question while the main task continues elsewhere.",
	"Answer the side question below. Do not continue, plan, or act on the main task.",
	'Only the read and web_search tools run here; any other tool call returns "not found" or is refused.',
	"</side-thread>",
].join("\n");

const REFUSED_TOOL = "side thread: only read and web_search run";
const ROUND_LIMIT = "side thread tool limit reached; answer now with what you have";

/** Main's transcript up to its last complete point: every tool call there has its result. */
export function cutAtCompletePoint(messages: readonly AgentMessage[]): AgentMessage[] {
	const open = new Set<string>();
	let end = 0;
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			open.clear();
			if (message.stopReason !== "error" && message.stopReason !== "aborted") {
				for (const part of message.content) if (part.type === "toolCall") open.add(part.id);
			}
		} else if (message.role === "toolResult") open.delete(message.toolCallId);
		else if (message.role !== "system") open.clear();
		if (open.size === 0) end = index + 1;
	});
	return messages.slice(0, end);
}

/** A side user message as the model sees it: the preamble, then the user's text. */
export function wrapSideMessage(message: AgentMessage): AgentMessage {
	if (message.role !== "user") return message;
	const lead = `${SIDE_THREAD_PREAMBLE}\n\n`;
	if (typeof message.content === "string") return { ...message, content: `${lead}${message.content}` };
	const first = message.content[0];
	if (first?.type === "text") return { ...message, content: [{ ...first, text: `${lead}${first.text}` }, ...message.content.slice(1)] };
	return { ...message, content: [{ type: "text", text: lead.trimEnd() }, ...message.content] };
}

/** What a side run reads from main, fixed at the question and replaced only at the next one. */
export interface SideRunBasis {
	mainCut: AgentMessage[];
}

/** The child's own extension: request shape, tool guard, round cap, and no cache warmer of its own. */
export function sideChildExtension(basis: SideRunBasis): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let rounds = 0;
		pi.on("cache_warming_decision", () => ({ action: "stop" }));
		pi.on("context_with_system", (event) => {
			const side = event.messages.filter((message) => message.role !== "system").map(wrapSideMessage);
			const head = basis.mainCut[0]?.role === "system" ? [] : event.messages.slice(0, 1).filter((message) => message.role === "system");
			return { messages: [...head, ...basis.mainCut, ...side] };
		});
		pi.on("message_start", (event) => {
			if (event.message.role === "user") rounds = 0;
		});
		pi.on("turn_end", (event) => {
			if (event.toolResults.length > 0) rounds++;
		});
		pi.on("tool_call", (event) => {
			if (!SIDE_TOOLS.has(event.toolName)) return { block: true, reason: REFUSED_TOOL };
			if (rounds >= SIDE_TOOL_ROUND_CAP) return { block: true, reason: ROUND_LIMIT, terminate: true };
			if (rounds === SIDE_TOOL_ROUND_CAP - 1) return { block: true, reason: ROUND_LIMIT };
			return undefined;
		});
	};
}

/** The main seat a side thread belongs to. */
export interface MainSeat {
	readonly cwd: string;
	readonly sessionId: string;
	readonly modelRuntime: unknown;
}

/** Main as it stands when a side question is asked. */
export interface MainSnapshot {
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly messages: readonly AgentMessage[];
}

/** The extensions a side child loads: main's wire and transcript, and pi-web-search when installed. */
export const CHILD_EXTENSION_PATHS = [
	fileURLToPath(new URL("../wire/index.ts", import.meta.url)),
	fileURLToPath(new URL("../transcript", import.meta.url)),
	join(getAgentDir(), "npm/node_modules/pi-web-search"),
];

function mainPayloadOf(mainSessionId: string, model: Model<Api>): Record<string, unknown> | undefined {
	const last = readLastRequest(mainSessionId, model);
	return last !== undefined && last.model.api === "anthropic-messages" ? structuredClone(last.payload) : undefined;
}

/** One main session's side thread: the child session, built on the first question and kept until dropped. */
export class SideThread {
	readonly #seat: MainSeat;
	readonly #onSession: (session: AgentSession) => void;
	readonly #basis: SideRunBasis = { mainCut: [] };
	#session: AgentSession | undefined;
	#building: Promise<AgentSession | undefined> | undefined;
	#running = false;
	#stopRequested = false;
	#disposed = false;

	public constructor(seat: MainSeat, onSession: (session: AgentSession) => void) {
		this.#seat = seat;
		this.#onSession = onSession;
	}

	public get session(): AgentSession | undefined {
		return this.#session;
	}

	public get busy(): boolean {
		return this.#running;
	}

	public async ask(text: string, images: ImageContent[] | undefined, main: MainSnapshot): Promise<void> {
		const mainCut = structuredClone(cutAtCompletePoint(main.messages));
		const mainPayload = mainPayloadOf(this.#seat.sessionId, main.model);
		this.#running = true;
		this.#stopRequested = false;
		try {
			const session = await this.#ensure(main);
			if (session === undefined) return;
			const current = session.model;
			if (current?.provider !== main.model.provider || current?.id !== main.model.id) await session.setModel(main.model);
			session.setThinkingLevel(main.thinkingLevel);
			this.#basis.mainCut = mainCut;
			publishSideRequestBasis(session.sessionId, { mainSessionId: this.#seat.sessionId, mainPayload });
			if (this.#stopRequested) return;
			await session.prompt(text, { expandPromptTemplates: false, source: "extension", ...(images ? { images } : {}) });
		} finally {
			this.#running = false;
		}
	}

	public async steer(text: string, images?: ImageContent[]): Promise<void> {
		const session = this.#session ?? (await this.#building?.catch(() => undefined));
		await session?.steer(text, images, { source: "extension" });
	}

	public async followUp(text: string, images?: ImageContent[]): Promise<void> {
		const session = this.#session ?? (await this.#building?.catch(() => undefined));
		await session?.followUp(text, images, { source: "extension" });
	}

	public async abort(): Promise<void> {
		this.#stopRequested = this.#running;
		await this.#session?.abort();
	}

	public async dispose(): Promise<void> {
		this.#disposed = true;
		const session = this.#session ?? (await this.#building?.catch(() => undefined));
		this.#session = undefined;
		if (session === undefined) return;
		forgetSideRequestBasis(session.sessionId);
		try {
			await session.abort();
		} finally {
			session.dispose();
		}
	}

	async #ensure(main: MainSnapshot): Promise<AgentSession | undefined> {
		if (this.#session !== undefined) return this.#session;
		if (this.#building === undefined) {
			const building = this.#build(main);
			this.#building = building;
			const settle = (): void => {
				if (this.#building === building) this.#building = undefined;
			};
			building.then(settle, settle);
		}
		return this.#building;
	}

	async #build(main: MainSnapshot): Promise<AgentSession | undefined> {
		const { cwd } = this.#seat;
		const sessionManager = SessionManager.inMemory(cwd);
		publishSideRequestBasis(sessionManager.getSessionId(), { mainSessionId: this.#seat.sessionId, mainPayload: undefined });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			additionalExtensionPaths: CHILD_EXTENSION_PATHS.filter((path) => existsSync(path)),
			extensionFactories: [{ name: "side-chat-child", factory: sideChildExtension(this.#basis), hidden: true }],
		});
		try {
			await loader.reload();
			const { session } = await createAgentSession({
				cwd,
				agentDir: getAgentDir(),
				model: main.model,
				thinkingLevel: main.thinkingLevel,
				sessionManager,
				resourceLoader: loader,
				tools: [...SIDE_TOOLS],
				// SAFETY: modelRuntime is the pi ModelRegistry runtime captured from ctx in index.ts; its type is not exported by pi
				...(this.#seat.modelRuntime !== undefined ? { modelRuntime: this.#seat.modelRuntime as never } : {}),
			});
			if (this.#disposed) {
				session.dispose();
				forgetSideRequestBasis(sessionManager.getSessionId());
				return undefined;
			}
			this.#session = session;
			this.#onSession(session);
			return session;
		} catch (error) {
			forgetSideRequestBasis(sessionManager.getSessionId());
			throw error;
		}
	}
}
