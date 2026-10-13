/**
 * `support/child-extensions.mjs`: the list it builds is the one
 * `extensions/agent-engine/index.ts` parses, and a missing path fails setup by name.
 */

import { check, checkThrows, eq, finish } from "../support/check-harness.mjs";
import { childExtensionsList } from "../support/child-extensions.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { KIT_ROOT } from "../support/pi-package.mjs";

// The parser is a module-level constant read at load, not an export, so the
// check pins its source text and applies the same expression.
const ENGINE_PARSE = `process.env.PI_AGENT_CHILD_EXTENSIONS?.split(":").filter((entry) => entry !== "")`;
const engineSource = readFileSync(path.join(KIT_ROOT, "extensions/agent-engine/index.ts"), "utf8");
check("extensions/agent-engine/index.ts still parses the list by splitting on ':'", engineSource.includes(ENGINE_PARSE));
const parseLikeEngine = (value) => value.split(":").filter((entry) => entry !== "");

const probe = path.join(KIT_ROOT, "test/support/check-harness.mjs");
const value = childExtensionsList("extensions/agent-engine/index.ts", probe);
eq("kit-relative and absolute paths parse back as absolute paths, in order", parseLikeEngine(value), [path.join(KIT_ROOT, "extensions/agent-engine/index.ts"), probe]);

await checkThrows(
	"every missing path is named",
	() => childExtensionsList("extensions/no-such-one.ts", "extensions/agent-engine/index.ts", "/nowhere/two.ts"),
	`extension files do not exist: ${path.join(KIT_ROOT, "extensions/no-such-one.ts")}, /nowhere/two.ts`,
);
await checkThrows("a path containing the ':' separator is refused", () => childExtensionsList("/tmp/a:b.ts"), "paths contain the ':' separator: /tmp/a:b.ts");
await checkThrows("an empty list is refused", () => childExtensionsList(), "no extension paths given");

await finish();
