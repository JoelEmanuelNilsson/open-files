/**
 * The workflow script sandbox: a `node:vm` context holding the script hooks
 * and ECMAScript's own built-ins bar the host-timed ones, nothing of the
 * host — no `process`, no `require`, no filesystem, no `eval`, `new Function`
 * or `import()`. Agents touch the disk; the script cannot.
 *
 * Isolation, not security: the script is authored by our own model and its
 * `meta` is shown before it runs. What is kept by construction is that the
 * script never holds a host object, since any one of them reaches the host's
 * `Function` through `.constructor` and from there `process`:
 *
 *   - Every hook the script sees is a function the prelude made inside the
 *     context. The prelude reaches the host through one bridge held in its
 *     closure, never on `globalThis`, and the bridge has no prototype, so no
 *     `constructor` either.
 *   - What crosses host → context is re-created there. An agent's result is
 *     re-parsed; the arrays `pipeline` and `parallel` return are built by a
 *     rest parameter inside the context; every hook that answers returns a
 *     context promise; a host error arrives as a context error with the same
 *     name and message. The script's own values go back as the same values.
 *   - The host never runs on the script's stack. A hook call is queued in
 *     the context and handed to the host from a microtask, so a script that
 *     calls a hook at its stack limit overflows in its own realm: host code
 *     entered there would throw the host's RangeError, and stop half way
 *     through whatever it was writing, Node's timer lists included. A hook
 *     reads its arguments then, a microtask after the call, and a hook that
 *     throws synchronously on the host's side (`phase`, `log`) ends the run.
 *   - The host never calls a method it looked up on a script value: the
 *     script owns the context's prototypes, and a host callback handed to one
 *     of its methods would be a host object in its hands. Nor does it resolve
 *     a host promise with one, which would call the value's own `then`, nor
 *     classify one: an error is the host's only by a prototype walk that runs
 *     no proxy trap, and any other is read inside the context.
 *   - The prelude's own `then()` finds no species on the script's
 *     `Promise.prototype`, and a call into the context that throws anyway
 *     ends the run rather than reaching Node's timer list or a promise job.
 *   - `import()` would reject with a host error, so a script using it is
 *     refused before it runs ({@link IMPORT_REFUSED}).
 *
 * The run ends once: the body settles, a hook fails with an error `endsRun`
 * accepts, or {@link WorkflowScriptRun.end} is called. From then on every
 * hook returns a promise that never settles, the timers are cleared, and
 * nothing more reaches the script, so a script that catches a run-ending
 * error and loops parks instead of spinning. The built-ins that would call
 * back on the host's or the GC's schedule — `Atomics`, `FinalizationRegistry`,
 * `SharedArrayBuffer`, `WeakRef`, `WebAssembly` — are deleted: they would
 * outlive the cleared timers and differ between a run and its resume.
 * `WebAssembly` goes with them because code generation off stops only
 * compiling; its `Memory` still hands out a `SharedArrayBuffer`.
 *
 * The context shares the host's promise-rejection tracker, so a promise the
 * script leaves rejected would reach Node as the seat's own and, by default,
 * kill it. Until the outcome settles, a process listener claims a rejection
 * whose promise descends from the context's `Object.prototype` as a failure
 * of the run, and hands any other back to Node untouched. What stays out of
 * reach: a promise the script re-parents onto `null`, or behind a proxy whose
 * `getPrototypeOf` trap throws; Node handles its rejection as the seat's own.
 *
 * The limit: {@link WORKFLOW_SCRIPT_TIMEOUT_MS} bounds only the body's
 * synchronous start. Once the script has awaited anything, a loop that never
 * awaits, or awaits only already-settled values, runs on the seat's event
 * loop and freezes the seat; only a worker thread could stop it, and the
 * script runs in-process.
 *
 * The clock and the RNG are banned because the journal keys on prompt
 * content (`lib/workflow-journal.ts`): a prompt with the time in it changes
 * its key every run and resume degrades to a full re-run. A date built from
 * explicit arguments stays legal. The workarounds live in the authoring
 * skill: pass timestamps in via `args`, stamp results after the workflow
 * returns, vary duplicates by index. The host's time zone and default locale
 * stay readable (`getHours()`, a default `Intl` format): the zone is the
 * process's, so pinning it here would mean shimming every local-time path.
 * A resume on a host set otherwise may take another branch, whose calls miss
 * the journal and run again. So may one on a host installed elsewhere, for a
 * script that reads a stack on the host's stack — its synchronous start, a
 * getter or trap the host runs: the host frames under it are named there,
 * file paths and all.
 */

import { types } from "node:util";
import vm from "node:vm";

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
	/** Call a script function after a microtask, with script values; settles when its promise does, and never once the run has ended. */
	call(fn: unknown, args: readonly unknown[]): Promise<WorkflowScriptSettled>;
}

/** The host side of the script's hooks, called a microtask after the script's call. Arguments are the script's own values: read them, keep copies, never call a method on one or resolve a host promise with one. */
export interface WorkflowSandboxHooks {
	/** Resolves with host data, which the sandbox re-parses into the context. */
	readonly agent: (prompt: unknown, options: unknown) => Promise<unknown>;
	/** Resolves with script values (or `null`), handed back to the script in a context array. */
	readonly pipeline: (items: unknown, stages: unknown) => Promise<readonly unknown[]>;
	readonly parallel: (thunks: unknown) => Promise<readonly unknown[]>;
	readonly phase: (title: string) => void;
	readonly log: (message: string) => void;
}

export interface StartWorkflowScriptOptions {
	/** The source minus its `meta` declaration. */
	readonly body: string;
	readonly args: unknown;
	/** Called once, before the body runs. */
	readonly hooks: (calls: WorkflowScriptCalls) => WorkflowSandboxHooks;
	/** Whether a hook's error ends the run rather than reaching the script; asked only of an Error the host made, so a script can neither launder one nor run code here. */
	readonly endsRun: (error: unknown) => error is Error;
	/** A promise the script made was rejected with nothing to handle it, before the outcome settled; `message` was read inside the context. */
	readonly unhandledRejection: (message: string) => void;
	/** Defaults to {@link WORKFLOW_SCRIPT_TIMEOUT_MS}; tests use a small cap. */
	readonly scriptTimeoutMs?: number;
}

/** A started script: how it ends, and the way to end it from outside. */
export interface WorkflowScriptRun {
	/** The body's return value as host data (JSON, or the `String()` of a bigint, a symbol or `undefined`); rejects with a host copy of its error, with the reason JSON cannot write the value (a function among them), or with the error that ended the run. */
	readonly outcome: Promise<unknown>;
	/** End the run with this error, unless it has already ended. */
	end(error: Error): void;
}

/** The prelude's side of the bridge: context functions the host calls with primitives and script values only. */
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

// Node warns and fires at once past this; a longer wait is the longest one.
const MAX_TIMER_MS = 2 ** 31 - 1;

// V8 is the tokenizer: masking each `import` that could be the keyword keeps a string, comment or
// regex valid but breaks code, so a masked source that no longer compiles used the keyword.
const IMPORT_WORD = /(?<![\p{ID_Continue}$\u200C\u200D])import(?![\p{ID_Continue}$\u200C\u200D])/gu;

// Deleted before the script runs, and nothing left reaches them again: no built-in returns a WeakRef or
// a FinalizationRegistry, and WebAssembly.Memory({ shared: true }) was the other way to a SharedArrayBuffer.
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

// Evaluates to the installer. Built-ins are captured before the script runs, so a script that
// patches them breaks only its own calls; the bridge is only ever called, never passed on.
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

	// A value the host did not make is read only inside the context, so the host runs none of the script's code.
	const described = (value: unknown): string => {
		try {
			return prelude?.describe(value) ?? UNPRINTABLE;
		} catch {
			return UNPRINTABLE;
		}
	};
	const runError = (error: unknown): Error => (isHostError(error) ? error : new Error(described(error)));
	// Every call into the context comes through here. Whatever the script did to its realm, a throw never reaches
	// the host's caller (Node's timer list, a promise job); it ends the run.
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
		// A macrotask later: Node reports a promise dropped in the script's last tick only after that tick.
		setImmediate(() => {
			closeRealm();
			settle();
		});
	};
	const end = (error: Error) => finish(() => rejectOutcome(error));

	// `deliver` turns the host's answer into the context call that hands it over; a throw there rejects the ticket.
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

	// Called only from the prelude's queue. A throw would reject the queue's microtask and read as the script's own
	// unhandled rejection, so a hook that throws here (`log` or `phase`, whose emit is the host's) ends the run instead.
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
					const timer = Number(a);
					const delay = typeof b === "number" && b > 0 ? Math.min(b, MAX_TIMER_MS) : 0;
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
		const script = compileScript(`(async () => {\n${options.body}\n})()`);
		const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
		// SAFETY: an object literal evaluated in the context has the context's own Object.prototype, an object.
		const realm = vm.runInContext("Object.getPrototypeOf({})", context) as object;
		closeRealm = openRejectionRealm(realm, (reason) => options.unhandledRejection(prelude === undefined ? "a rejection before the script started" : described(reason)));
		vm.runInContext(DETERMINISM_PRELUDE, context, { filename: "workflow-determinism-prelude.js" });
		// SAFETY: the hook prelude's source evaluates to the installer, and its return value is the object ScriptPrelude describes.
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

/** The one `unhandledRejection` listener and the realms it claims for, shared by every copy of this module in the process. */
interface RejectionRoute {
	readonly realms: Map<object, (reason: unknown) => void>;
	readonly listener: (reason: unknown, promise: Promise<unknown>) => void;
	readonly sync: () => void;
}

const REJECTION_ROUTE = Symbol.for("pi-kit/workflow-sandbox/rejection-route");

/** Claim the unhandled rejections of promises descending from `realm` until the returned function is called. */
function openRejectionRealm(realm: object, sink: (reason: unknown) => void): () => void {
	const route = rejectionRoute();
	route.realms.set(realm, sink);
	route.sync();
	return () => {
		route.realms.delete(realm);
		route.sync();
	};
}

function rejectionRoute(): RejectionRoute {
	// SAFETY: the slot is keyed by a registered symbol only this function writes, and it writes a RejectionRoute.
	const slot = globalThis as { [REJECTION_ROUTE]?: RejectionRoute };
	const existing = slot[REJECTION_ROUTE];
	if (existing !== undefined) return existing;
	const realms = new Map<object, (reason: unknown) => void>();
	const listener = (reason: unknown, promise: Promise<unknown>): void => {
		for (const [realm, sink] of realms) {
			if (descendsFrom(promise, realm)) return sink(reason);
		}
		if (process.listenerCount("unhandledRejection") > 1) return;
		// Alone, this listener is all that holds back Node's own handling: step aside and reject again.
		process.off("unhandledRejection", listener);
		void Promise.reject(reason);
		setImmediate(sync);
	};
	const sync = (): void => {
		const listening = process.listeners("unhandledRejection").includes(listener);
		if (realms.size > 0 && !listening) process.on("unhandledRejection", listener);
		if (realms.size === 0 && listening) process.off("unhandledRejection", listener);
	};
	slot[REJECTION_ROUTE] = { realms, listener, sync };
	return slot[REJECTION_ROUTE];
}

// The host's own isPrototypeOf, never one looked up on a script value; a proxy trap that throws reads as not the script's.
function descendsFrom(value: object, realm: object): boolean {
	try {
		return Object.prototype.isPrototypeOf.call(realm, value);
	} catch {
		return false;
	}
}

function compileScript(source: string): vm.Script {
	const script = new vm.Script(source, { filename: "workflow.js" });
	const masked = source.replace(IMPORT_WORD, "\u2603");
	if (masked === source) return script;
	try {
		new vm.Script(masked);
	} catch {
		throw new Error(IMPORT_REFUSED);
	}
	return script;
}

// Walked link by link, since instanceof would run the getPrototypeOf trap of a proxy anywhere on the chain.
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
