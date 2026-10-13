/**
 * Paths the kit builds at runtime, from its own location, point at files.
 *
 * An import that names a moved file fails at load. A path joined together at
 * runtime does not: the side child's extension list drops a missing entry
 * through its `existsSync` filter, the build stamp hashes an unreadable tree
 * to a constant. Each is checked here, so a move that breaks one
 * fails the suite instead of degrading a seat.
 *
 *   node test/kit/runtime-paths.test.mjs
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT, kitJiti } from "../support/pi-package.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-agent-"));

const jiti = kitJiti({ moduleCache: false });
const insideKit = (file) => file.startsWith(`${KIT_ROOT}${path.sep}`);

section("side chat: the child's extensions");
{
	const { CHILD_EXTENSION_PATHS } = await jiti.import(`${KIT_ROOT}/extensions/side-chat/side-session.ts`);
	const own = CHILD_EXTENSION_PATHS.filter(insideKit);
	check("wire and transcript are the kit's two", own.length === 2, CHILD_EXTENSION_PATHS.join(", "));
	const missing = own.filter((file) => !fs.existsSync(file));
	check("and both exist, so the existsSync filter drops neither", missing.length === 0, missing.join(", "));
}

section("git-settle: the repo files it settles");
{
	const { PI_SETTINGS_FILE, SETTINGS_FILTER_SCRIPT } = await jiti.import(`${KIT_ROOT}/extensions/git-settle.ts`);
	check("the settings filter exists", fs.existsSync(SETTINGS_FILTER_SCRIPT), SETTINGS_FILTER_SCRIPT);
	check("and so does pi/settings.json", fs.existsSync(PI_SETTINGS_FILE), PI_SETTINGS_FILE);
}

section("arc-waypoints: the prism module it loads by path");
{
	let out = "";
	try {
		out = execFileSync(process.execPath, [path.join(KIT_ROOT, "bin", "arc-waypoints.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		out = String(error.stderr ?? error);
	}
	check("the script runs and prints colours", /0xff[0-9a-f]{6}/.test(out), out.slice(0, 300));
}

await finish();
