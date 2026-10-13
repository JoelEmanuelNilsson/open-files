/**
 * Everything the kit sends has a way to draw itself.
 *
 * Two holes of the same shape shipped at once (issues/31 (a) and (b)): four
 * engine tools with no claimed row, printing `<task-notification>` XML into the
 * chat, and a background-bash notice with no message renderer. Neither is
 * visible to a test that drives a renderer, because the fault is that there is
 * no renderer to drive. So this file reads the source instead:
 *
 * - every `customType` a file that calls `pi.sendMessage` names must have a
 *   `pi.registerMessageRenderer` somewhere in the kit, matched by *value* —
 *   the sender and the renderer name the same string through different
 *   constants;
 * - every tool `extensions/agent-engine/index.ts` and `extensions/bash/index.ts` register
 *   must be drawn by `extensions/agent-rows/agent-receipt.ts` or be in {@link PI_DRAWS},
 *   which is where a tool that keeps pi's own row says so out loud.
 *
 * Constants are resolved from the source rather than imported, so a file that
 * needs a live session to load is still checked. A token that resolves to
 * nothing fails the run: an unreadable name is exactly how a hole hides.
 *
 *   node test/transcript/renderers.test.mjs
 */

import { check, finish } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import fs from "node:fs";
import path from "node:path";

const jiti = kitJiti({ moduleCache: false });

/** Tools that keep pi's own row on purpose. The reason is the point of the entry. */
const PI_DRAWS = {
	bash: "its definition ships renderCall/renderResult itself (extensions/bash/index.ts, rows())",
};

function sources(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sources(full));
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

const files = [...sources(path.join(KIT_ROOT, "extensions")), ...sources(path.join(KIT_ROOT, "lib"))];
const text = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));

// ---------------------------------------------------------------------------
// Resolving a name to the string it stands for.
// ---------------------------------------------------------------------------

/** `const NAME = "value"` and `OBJECT.KEY` from `const OBJECT = { KEY: "value" } as const`. */
const constants = new Map();
for (const source of text.values()) {
	for (const [, name, value] of source.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*)(?:: [^=]+)? = "([^"]*)"/g)) {
		constants.set(name, value);
	}
	for (const [, name, body] of source.matchAll(/(?:export )?const ([A-Z][A-Z0-9_]*) = \{([^}]*)\} as const/g)) {
		for (const [, key, value] of body.matchAll(/([A-Z][A-Z0-9_]*): "([^"]*)"/g)) constants.set(`${name}.${key}`, value);
	}
}

/** The string a source token stands for, or undefined when nothing here knows. */
function valueOf(token) {
	const literal = /^"([^"]*)"$/.exec(token.trim());
	if (literal) return literal[1];
	return constants.get(token.trim());
}

// A type annotation is not a value: `customType: string` in a signature matches
// the field pattern below as well as a message being built does.
const TYPE_WORDS = new Set(["string", "unknown", "undefined"]);

// ---------------------------------------------------------------------------
// Custom messages.
// ---------------------------------------------------------------------------

const rendered = new Set();
for (const source of text.values()) {
	for (const [, token] of source.matchAll(/pi\.registerMessageRenderer\(\s*([^,]+),/g)) {
		const value = valueOf(token);
		if (value !== undefined) rendered.add(value);
	}
}
check("the kit registers message renderers at all", rendered.size > 0, [...rendered].join(", "));

const sent = new Map();
for (const [file, source] of text) {
	if (!source.includes("pi.sendMessage(")) continue;
	for (const [, token] of source.matchAll(/customType:\s*("[^"]*"|[A-Za-z_$][\w$.]*)\s*[,\n]/g)) {
		if (TYPE_WORDS.has(token.trim())) continue;
		const value = valueOf(token);
		check(`${path.relative(KIT_ROOT, file)}: customType ${token.trim()} resolves to a string`, value !== undefined);
		if (value !== undefined && !sent.has(value)) sent.set(value, file);
	}
}
check("some custom message types were found to check", sent.size > 0);

for (const [type, file] of sent) {
	check(`${type} has a renderer (sent by ${path.relative(KIT_ROOT, file)})`, rendered.has(type), `renderers: ${[...rendered].sort().join(", ")}`);
}

// ---------------------------------------------------------------------------
// Tool rows.
// ---------------------------------------------------------------------------

const receipt = await jiti.import(`${KIT_ROOT}/extensions/agent-rows/agent-receipt.ts`);
const claimed = new Set(Object.keys(receipt.agentRowSlots()));

const registrars = ["extensions/agent-engine/index.ts", "extensions/bash/index.ts"];
const registered = new Map();
for (const relative of registrars) {
	const source = text.get(path.join(KIT_ROOT, relative));
	check(`${relative} is where tools are registered`, source !== undefined);
	// A tool definition is the one place `name` is immediately followed by
	// `label`; every other `name:` in these files belongs to a record or a schema.
	for (const [, token] of source?.matchAll(/name:\s*("[^"]*"|[\w$.]+),\s*\n\s*label:/g) ?? []) {
		const value = valueOf(token);
		check(`${relative}: tool name ${token} resolves to a string`, value !== undefined);
		if (value !== undefined) registered.set(value, relative);
	}
}
check("some registered tools were found to check", registered.size >= 5, [...registered.keys()].join(", "));

for (const [name, relative] of registered) {
	const why = PI_DRAWS[name];
	check(`${name} has a row (registered in ${relative})`, claimed.has(name) || why !== undefined, `claimed: ${[...claimed].join(", ")}`);
}
for (const name of Object.keys(PI_DRAWS)) {
	check(`the allowlist entry ${name} is for a tool that still exists`, registered.has(name));
	check(`and ${name} is not also claimed`, !claimed.has(name));
}

await finish();
