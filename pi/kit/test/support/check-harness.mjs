/**
 * Check counting and the `N passed, M failed` trailer the suite runner reads.
 * A test file imports it as its first code line, e.g.
 * `import { check, eq, finish } from "../support/check-harness.mjs";`,
 * records every check through it, and ends with `await finish();`.
 */

import "./suite-env.mjs";
import { inspect } from "node:util";

let passed = 0;
let failed = 0;
const skipped = [];
const finishHooks = [];

/** Records a check that passes when `ok` is truthy; `extra` is printed under a failure. Returns whether it passed. */
export function check(name, ok, extra = "") {
	if (ok) {
		passed++;
		console.log(`  ok   ${name}`);
		return true;
	}
	failed++;
	console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`);
	return false;
}

/** Checks that the JSON serialisations match, so distinct objects with equal JSON pass. */
export function eq(name, actual, expected) {
	const want = JSON.stringify(expected);
	const got = JSON.stringify(actual);
	return check(name, got === want, `expected ${want}, got ${got}`);
}

/** Checks strict equality (`===`): objects pass only as the same reference. */
export function is(name, actual, expected) {
	return actual === expected ? check(name, true) : check(name, false, `expected ${inspect(expected)}, got ${inspect(actual)}`);
}

/** Checks `Object.is` equality, which tells NaN and -0 apart where `===` does not. */
export function same(name, actual, expected) {
	return Object.is(actual, expected) ? check(name, true) : check(name, false, `expected ${inspect(expected)}, got ${inspect(actual)}`);
}

/** Prints what `render()` returns under a `--- name` header; passes unless it throws. */
export function show(name, render) {
	try {
		console.log(`--- ${name}\n${render()}`);
		passed++;
		return true;
	} catch (error) {
		failed++;
		console.log(`--- ${name}\nTHREW: ${error.message}\n${error.stack.split("\n").slice(1, 3).join("\n")}`);
		return false;
	}
}

/** Records a check whose oracle is absent on this machine: listed after the trailer, never a silent pass. */
export function skip(name) {
	skipped.push(name);
	console.log(`  skip ${name}`);
}

/** Checks that `fn` (sync or async) throws with a message containing `fragment`; must be awaited. */
export async function checkThrows(name, fn, fragment) {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return check(name, message.includes(fragment), message);
	}
	return check(name, false, "no throw");
}

/** Prints a section heading above the checks that follow. */
export function section(title) {
	console.log(`\n${title}`);
}

/** How many checks have failed so far, e.g. for a finish hook that keeps evidence on red. */
export function failures() {
	return failed;
}

/** Registers cleanup or extra output to run, in order, before `finish()` prints the trailer. */
export function atFinish(hook) {
	finishHooks.push(hook);
}

/** Runs the finish hooks, prints the trailer and skipped names, and always exits: 1 on any failure, else 0. */
export async function finish() {
	for (const hook of finishHooks) await hook();
	console.log(`\n${passed} passed, ${failed} failed`);
	if (skipped.length > 0) console.log(`${skipped.length} skipped\n  ${skipped.join("\n  ")}`);
	process.exit(failed ? 1 : 0);
}
