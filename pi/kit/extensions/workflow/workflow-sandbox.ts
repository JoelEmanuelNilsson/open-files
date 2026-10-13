import { types } from "node:util";
import vm from "node:vm";
import { openRejectionRealm } from "./workflow-rejection-route.ts";

/** The ruled cap on the script's synchronous start (ticket 54 §3). */
export const WORKFLOW_SCRIPT_TIMEOUT_MS = 30_000;

/** The ruled refusals, verbatim, so an author's error greps to this file. */
export const DATE_NOW_BANNED = "Date.now() is unavailable in workflow scripts (it would break resume)";
export const MATH_RANDOM_BANNED = "Math.random() is unavailable in workflow scripts (it would break resume)";
export const NEW_DATE_BANNED = "Date() and new Date() with no arguments are unavailable in workflow scripts (it would break resume)";
export const INTL_NOW_BANNED = "Intl.DateTimeFormat format() with no date is unavailable in workflow scripts (it would break resume)";
export const TEMPORAL_NOW_BANNED = "Temporal.Now is unavailable in workflow scripts (it would break resume)";
export const IMPORT_REFUSED = "import is unavailable in workflow scripts: the word is refused outside strings and comments, so write a property named import as obj['import']";

/** How a call into the script ended; `message` was read inside the context. */
export type WorkflowScriptSettled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

/** What the host side of a hook may do with the script's own functions. */
export interface WorkflowScriptCalls {
	call(fn: unknown, args: readonly unknown[]): Promise<WorkflowScriptSettled>;
}

/** The host side of the script's hooks, called a microtask after the script's call. Arguments are the script's own values: read them, keep copies, never call a method on one or resolve a host promise with one. */
export interface WorkflowSandboxHooks {
	readonly agent: (prompt: unknown, options: unknown) => Promise<unknown>;
	readonly pipeline: (items: unknown, stages: unknown) => Promise<readonly unknown[]>;
	readonly parallel: (thunks: unknown) => Promise<readonly unknown[]>;
	readonly phase: (title: string) => void;
	readonly log: (message: string) => void;
}

export interface StartWorkflowScriptOptions {
	readonly body: string;
	readonly args: unknown;
	readonly hooks: (calls: WorkflowScriptCalls) => WorkflowSandboxHooks;
	readonly endsRun: (error: Error) => boolean;
	readonly unhandledRejection: (message: string) => void;
	readonly scriptTimeoutMs?: number;
}

/** A started script: how it ends, and the way to end it from outside. */
export interface WorkflowScriptRun {
	readonly outcome: Promise<unknown>;
	end(error: Error): void;
}

interface ScriptPrelude {
	readonly resolveJson: (ticket: number, json: string | undefined) => void;
	readonly resolveList: (ticket: number, ...values: unknown[]) => void;
	readonly reject: (ticket: number, name: string, message: string) => void;
	readonly rejectWith: (ticket: number, error: unknown) => void;
	readonly describe: (error: unknown) => string;
	readonly invoke: (ticket: number, fn: unknown, ...args: unknown[]) => void;
	readonly fire: (timer: number) => void;
	readonly watch: (body: unknown) => void;
	readonly end: () => void;
}

const UNPRINTABLE = "an error that cannot be printed";

const MAX_TIMER_MS = 2 ** 31 - 1;

const IMPORT_WORD = /(?<![\p{ID_Continue}$\u200C\u200D])import(?![\p{ID_Continue}$\u200C\u200D])/gu;

const HOST_TIMED_BUILT_INS = ["Atomics", "FinalizationRegistry", "SharedArrayBuffer", "WeakRef", "WebAssembly"];

const DETERMINISM_PRELUDE = `(() => {
	"use strict";
	for (const name of ${JSON.stringify(HOST_TIMED_BUILT_INS)}) delete globalThis[name];
	const { apply, construct } = Reflect;
	const banned = (message) => function () { throw new Error(message); };
	Math.random = banned(${JSON.stringify(MATH_RANDOM_BANNED)});
	const RealDate = Date;
	RealDate.now = banned(${JSON.stringify(DATE_NOW_BANNED)});
	// A null-prototype handler: a trap the handler lacks is otherwise looked up on Object.prototype, which the script owns.
	const ShimDate = new Proxy(RealDate, {
		__proto__: null,
		construct(target, args, newTarget) {
			if (args.length === 0) throw new Error(${JSON.stringify(NEW_DATE_BANNED)});
			return construct(target, args, newTarget);
		},
		apply() { throw new Error(${JSON.stringify(NEW_DATE_BANNED)}); },
	});
	RealDate.prototype.constructor = ShimDate;
	globalThis.Date = ShimDate;
	const formats = Intl.DateTimeFormat.prototype;
	const boundFormat = Object.getOwnPropertyDescriptor(formats, "format").get;
	const realFormatToParts = formats.formatToParts;
	Object.defineProperty(formats, "format", {
		configurable: true,
		get() {
			const format = apply(boundFormat, this, []);
			return (date) => {
				if (date === undefined) throw new Error(${JSON.stringify(INTL_NOW_BANNED)});
				return format(date);
			};
		},
	});
	formats.formatToParts = function formatToParts(date) {
		if (date === undefined) throw new Error(${JSON.stringify(INTL_NOW_BANNED)});
		return apply(realFormatToParts, this, [date]);
	};
	if (typeof Temporal === "object") {
		for (const key of Reflect.ownKeys(Temporal.Now)) {
			if (key !== "timeZoneId" && typeof Temporal.Now[key] === "function") Temporal.Now[key] = banned(${JSON.stringify(TEMPORAL_NOW_BANNED)});
		}
	}
})()`;

// raw-timer(4): one host timer per script timer, cleared when the run ends; the host's `case "setTimeout":` counts too, and the other four are the script realm's own source text.
const HOOK_PRELUDE = `(bridge, argsJson) => {
	"use strict";
	const { Promise: P, String: S, Number: N } = globalThis;
	const { apply } = Reflect;
	const { defineProperty } = Object;
	const then = P.prototype.then;
	const { parse, stringify } = JSON;
	const errors = { __proto__: null, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
	const pending = { __proto__: null };
	const timers = { __proto__: null };
	let tickets = 0;
	let timerIds = 0;
	let ended = false;

	const makeError = (name, message) => {
		const error = new (errors[name] ?? errors.Error)(message);
		if (error.name !== name) defineProperty(error, "name", { value: name, writable: true, configurable: true });
		return error;
	};
	const nameOf = (error) => {
		try {
			return typeof error?.name === "string" ? error.name : "Error";
		} catch {
			return "Error";
		}
	};
	const describe = (error) => {
		try {
			return error !== null && typeof error === "object" && typeof error.message === "string" ? error.message : S(error);
		} catch {
			return ${JSON.stringify(UNPRINTABLE)};
		}
	};
	// then() asks the promise's constructor for its species, and the script owns Promise.prototype: an own
	// undefined constructor makes it use the realm's Promise. Only ever called on a promise the script cannot reach.
	const chain = (promise, onValue, onError) => {
		defineProperty(promise, "constructor", { value: undefined });
		return apply(then, promise, [onValue, onError]);
	};
	// Every call to the host is queued and handed over from a microtask, on a fresh stack: never on the script's.
	// The flush is chained on a promise made here, since a promise made at the stack limit would swallow the
	// overflow of its own executor, leaving a call queued with no flush to hand it over.
	const ready = new P((resolve) => resolve());
	const queue = { __proto__: null };
	let queued = 0;
	let handed = 0;
	const flush = () => {
		while (handed < queued) {
			const call = queue[handed];
			delete queue[handed++];
			bridge(call[0], call[1], call[2], call[3]);
		}
	};
	const host = (op, a, b, c) => {
		const call = [op, a, b, c];
		if (handed === queued) chain(ready, flush);
		queue[queued++] = call;
	};
	const request = (op, a, b) => {
		if (ended) return new P(() => {});
		const ticket = ++tickets;
		return new P((resolve, reject) => {
			pending[ticket] = { resolve, reject };
			host(op, ticket, a, b);
		});
	};
	const take = (ticket) => {
		const entry = pending[ticket];
		delete pending[ticket];
		return entry;
	};
	// An object prints as its JSON, else its String(), else its type: logging never throws into the script.
	const printable = (part) => {
		if (typeof part === "string") return part;
		let json;
		try {
			json = part !== null && typeof part === "object" ? stringify(part) : undefined;
		} catch {
			json = undefined;
		}
		try {
			return json ?? S(part);
		} catch {
			return "[" + typeof part + "]";
		}
	};
	const print = (...parts) => {
		let line = "";
		for (let i = 0; i < parts.length; i++) line += (i === 0 ? "" : " ") + printable(parts[i]);
		if (!ended) host("log", line);
	};
	// Always a JSON string, so the host only ever holds JSON: a bigint, a symbol or undefined is its String().
	// A function (a script that forgot to call it) and a value JSON cannot write whole, such as a cycle, end the run.
	const returned = (value) => {
		if (typeof value === "function") throw makeError("TypeError", "the return value is not JSON: a function");
		if (typeof value === "bigint") return host("returned", stringify(S(value)));
		let json;
		try {
			json = stringify(value);
		} catch (error) {
			throw makeError(nameOf(error), "the return value is not JSON: " + describe(error));
		}
		host("returned", json ?? stringify(S(value)));
	};

	Object.assign(globalThis, {
		agent: function agent(prompt, options) { return request("agent", prompt, options); },
		pipeline: function pipeline(items, ...stages) { return request("pipeline", items, stages); },
		parallel: function parallel(thunks) { return request("parallel", thunks); },
		phase: function phase(title) { if (!ended) host("phase", S(title)); },
		log: function log(message) { if (!ended) host("log", S(message)); },
		console: { log: print, info: print, warn: print, error: print, debug: print },
		setTimeout: function setTimeout(callback, delay, ...extra) {
			if (typeof callback !== "function") throw new errors.TypeError("setTimeout() needs a function");
			if (ended) return 0;
			const timer = ++timerIds;
			host("setTimeout", timer, N(delay));
			timers[timer] = { callback, extra };
			return timer;
		},
		clearTimeout: function clearTimeout(timer) {
			if (typeof timer !== "number" || timers[timer] === undefined) return;
			delete timers[timer];
			host("clearTimeout", timer);
		},
		args: argsJson === undefined ? undefined : parse(argsJson),
	});

	return {
		__proto__: null,
		resolveJson(ticket, json) { take(ticket)?.resolve(json === undefined ? undefined : parse(json)); },
		resolveList(ticket, ...values) { take(ticket)?.resolve(values); },
		reject(ticket, name, message) { take(ticket)?.reject(makeError(name, message)); },
		describe,
		rejectWith(ticket, error) { take(ticket)?.reject(makeError(nameOf(error), describe(error))); },
		invoke(ticket, fn, ...args) {
			const called = chain(new P((resolve) => resolve()), () => apply(fn, undefined, args));
			chain(called, (value) => host("settled", ticket, true, value), (error) => host("settled", ticket, false, describe(error)));
		},
		fire(timer) {
			const due = timers[timer];
			if (due === undefined) return;
			delete timers[timer];
			const ran = chain(new P((resolve) => resolve()), () => apply(due.callback, undefined, due.extra));
			chain(ran, undefined, (error) => { if (!ended) host("log", "setTimeout callback threw: " + describe(error)); });
		},
		watch(body) {
			chain(body, (value) => {
				try {
					returned(value);
				} catch (error) {
					host("threw", nameOf(error), describe(error));
				}
			}, (error) => host("threw", nameOf(error), describe(error)));
		},
		end() {
			ended = true;
			for (const ticket in pending) delete pending[ticket];
			for (const timer in timers) delete timers[timer];
		},
	};
}`;

const HOST_ERRORS = new Map<string, ErrorConstructor>([
	["TypeError", TypeError],
	["RangeError", RangeError],
	["SyntaxError", SyntaxError],
	["ReferenceError", ReferenceError],
	["EvalError", EvalError],
	["URIError", URIError],
]);

/** Start a script body as the body of an async function in a fresh context. */
export function startWorkflowScript(options: StartWorkflowScriptOptions): WorkflowScriptRun {
	let ended = false;
	let resolveOutcome: (value: unknown) => void = () => {};
	let rejectOutcome: (error: unknown) => void = () => {};
	const outcome = new Promise<unknown>((resolve, reject) => {
		resolveOutcome = resolve;
		rejectOutcome = reject;
	});
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	const awaiting = new Map<number, (settled: WorkflowScriptSettled) => void>();
	let lastTicket = 0;
	let prelude: ScriptPrelude | undefined;
	let hooks: WorkflowSandboxHooks | undefined;
	let closeRealm = () => {};

	const described = (value: unknown): string => {
		try {
			return prelude?.describe(value) ?? UNPRINTABLE;
		} catch {
			return UNPRINTABLE;
		}
	};
	const runError = (error: unknown): Error => (isHostError(error) ? error : new Error(described(error)));
	const enter = (call: (context: ScriptPrelude) => void): void => {
		if (prelude === undefined) return;
		try {
			call(prelude);
		} catch (error) {
			end(runError(error));
		}
	};

	const finish = (settle: () => void) => {
		if (ended) return;
		ended = true;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		awaiting.clear();
		enter((context) => context.end());
		setImmediate(() => {
			closeRealm();
			settle();
		});
	};
	const end = (error: Error) => finish(() => rejectOutcome(error));

	const settleHook = <T>(ticket: number, pending: Promise<T>, deliver: (value: T) => (context: ScriptPrelude) => void) => {
		const fail = (error: unknown) => {
			if (!isHostError(error)) enter((context) => context.rejectWith(ticket, error));
			else if (options.endsRun(error)) end(error);
			else enter((context) => context.reject(ticket, error.name, error.message));
		};
		pending.then(
			(value) => {
				if (ended) return;
				let handOver: (context: ScriptPrelude) => void;
				try {
					handOver = deliver(value);
				} catch (error) {
					return fail(error);
				}
				enter(handOver);
			},
			(error: unknown) => {
				if (!ended) fail(error);
			},
		);
	};

	const bridge = (op: unknown, a?: unknown, b?: unknown, c?: unknown): void => {
		if (ended || prelude === undefined || hooks === undefined) return;
		const ticket = Number(a);
		try {
			switch (op) {
				case "agent":
					settleHook(ticket, hooks.agent(b, c), (value) => {
						const json = value === undefined ? undefined : JSON.stringify(value);
						return (context) => context.resolveJson(ticket, json);
					});
					return;
				case "pipeline":
					settleHook(ticket, hooks.pipeline(b, c), (values) => (context) => context.resolveList(ticket, ...values));
					return;
				case "parallel":
					settleHook(ticket, hooks.parallel(b), (values) => (context) => context.resolveList(ticket, ...values));
					return;
				case "phase":
					hooks.phase(String(a));
					return;
				case "log":
					hooks.log(String(a));
					return;
				case "setTimeout": {
					// raw-timer: one host timer per script timer, cleared when the run ends; the host's `case "setTimeout":` counts too, and the other four are the script realm's own source text.
					const timer = Number(a);
					const delay = typeof b === "number" && b > 0 ? Math.min(b, MAX_TIMER_MS) : 0;
					// raw-timer: one host timer per script timer, cleared when the run ends; the host's `case "setTimeout":` counts too, and the other four are the script realm's own source text.
					timers.set(
						timer,
						setTimeout(() => {
							timers.delete(timer);
							enter((context) => context.fire(timer));
						}, delay),
					);
					return;
				}
				case "clearTimeout":
					clearTimeout(timers.get(Number(a)));
					timers.delete(Number(a));
					return;
				case "settled": {
					const settle = awaiting.get(Number(a));
					awaiting.delete(Number(a));
					settle?.(b === true ? { ok: true, value: c } : { ok: false, message: String(c) });
					return;
				}
				case "returned":
					finish(() => resolveOutcome(JSON.parse(String(a))));
					return;
				case "threw":
					finish(() => rejectOutcome(hostError(String(a), String(b))));
					return;
			}
		} catch (error) {
			end(runError(error));
		}
	};
	Object.setPrototypeOf(bridge, null);

	const calls: WorkflowScriptCalls = {
		call: (fn, args) =>
			new Promise((resolve) => {
				if (ended || prelude === undefined) return;
				const ticket = ++lastTicket;
				awaiting.set(ticket, resolve);
				enter((context) => context.invoke(ticket, fn, ...args));
			}),
	};

	try {
		const script = compileWorkflowScript(options.body, "workflow.js");
		const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
		// SAFETY: Object.getPrototypeOf({}) evaluated in the new context returns that realm's Object.prototype
		const realm = vm.runInContext("Object.getPrototypeOf({})", context) as object;
		closeRealm = openRejectionRealm(realm, (reason) => options.unhandledRejection(prelude === undefined ? "a rejection before the script started" : described(reason)));
		vm.runInContext(DETERMINISM_PRELUDE, context, { filename: "workflow-determinism-prelude.js" });
		// SAFETY: HOOK_PRELUDE evaluates to the install function with this signature
		const install = vm.runInContext(HOOK_PRELUDE, context, { filename: "workflow-hook-prelude.js" }) as (bridge: unknown, argsJson: string | undefined) => ScriptPrelude;
		prelude = install(bridge, options.args === undefined ? undefined : JSON.stringify(options.args));
		hooks = options.hooks(calls);
		const body: unknown = script.runInContext(context, { timeout: options.scriptTimeoutMs ?? WORKFLOW_SCRIPT_TIMEOUT_MS });
		enter((installed) => installed.watch(body));
	} catch (error) {
		end(runError(error));
	}
	return { outcome, end };
}

/** Compile a script body as the sandbox runs it, or throw its SyntaxError or {@link IMPORT_REFUSED}. */
export function compileWorkflowScript(body: string, filename: string): vm.Script {
	const source = `(async () => {\n${body}\n})()`;
	const script = new vm.Script(source, { filename, lineOffset: -1 });
	const masked = source.replace(IMPORT_WORD, "\u2603");
	if (masked === source) return script;
	try {
		new vm.Script(masked);
	} catch {
		throw new Error(IMPORT_REFUSED);
	}
	return script;
}

function isHostError(value: unknown): value is Error {
	for (let link: unknown = value; typeof link === "object" && link !== null; link = Object.getPrototypeOf(link)) {
		if (types.isProxy(link)) return false;
		if (link === Error.prototype) return true;
	}
	return false;
}

function hostError(name: string, message: string): Error {
	const error = new (HOST_ERRORS.get(name) ?? Error)(message);
	if (error.name !== name) error.name = name;
	return error;
}

/** `file:LINE:COL: SyntaxError: message`, the source line and the caret. V8 keeps the location only in the stack: `file:LINE`, the line, the caret. */
export function syntaxErrorAt(error: SyntaxError, file: string): string {
	const [where = "", line = "", caret = ""] = (error.stack ?? "").split("\n");
	if (!where.startsWith(`${file}:`)) return `${error.name}: ${error.message}`;
	const column = (caret.includes("^") ? caret.indexOf("^") : caret.length) + 1;
	return `${where}:${column}: ${error.name}: ${error.message}\n${line}\n${caret}`;
}
