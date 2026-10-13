/**
 * The suite's own environment and roster: every file under test/ sets the
 * throwaway environment before anything else, is a file the runner discovers
 * or a preview, and sits where the layout puts it, so a file that exists is a
 * file that runs.
 */

import { check, finish, section } from "../support/check-harness.mjs";
import { KIT_ROOT } from "../support/pi-package.mjs";
import { discoverSuiteFiles, isPreviewScript, listTestModules, SUITE_RUNNER_FILE } from "../support/suite-files.mjs";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
section("the suite's own environment");
{
	// A file run on its own — `node test/wire/wire-trace.test.mjs`, which is how a failure
	// gets debugged — used to inherit the seat's environment and write into
	// `~/.local/state/pi-kit`. Six did, and on 2026-09-21 seven notice lines one
	// of them left there were read as a seat's own. The environment is
	// `support/suite-env.mjs` now, imported first by each file rather than handed
	// down by the runner; a file that forgets the import is a file that writes
	// into the seat again, so the roster is checked rather than remembered.
	const TEST_DIR = path.join(KIT_ROOT, "test");
	/** Support modules that set the environment before anything else: suite-env itself, or one importing it first. */
	const ENV_FIRST = ["suite-env.mjs", "check-harness.mjs", "pi-package.mjs"].map((name) => path.join(TEST_DIR, "support", name));
	/** The file from its first line that is neither blank nor comment — where the environment import has to be. */
	function fromFirstCodeLine(file) {
		let inBlock = false;
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (const [index, raw] of lines.entries()) {
			const line = raw.trim();
			if (inBlock) { if (line.includes("*/")) inBlock = false; continue; }
			if (line === "" || line.startsWith("//")) continue;
			if (line.startsWith("/*")) { if (!line.includes("*/")) inBlock = true; continue; }
			return lines.slice(index).join("\n").trimStart();
		}
		return "";
	}
	/** Whether the file's first statement is a static import of a module that sets the environment first. */
	function importsEnvironmentFirst(file) {
		const specifier = /^import\s+(?:[^;"'`]*?\bfrom\s*)?(["'])([^"']+)\1/.exec(fromFirstCodeLine(file))?.[2];
		return specifier !== undefined && specifier.startsWith(".") && ENV_FIRST.includes(path.resolve(path.dirname(file), specifier));
	}

	const checked = listTestModules(TEST_DIR).filter((file) => !file.startsWith("support/") && file !== SUITE_RUNNER_FILE);
	const missing = checked.filter((file) => !importsEnvironmentFirst(path.join(TEST_DIR, file)));
	check(`every suite file imports the environment first (${checked.length} of them)`, missing.length === 0, missing.join(", "));

	const suiteFiles = new Set(discoverSuiteFiles(TEST_DIR));
	const unclassified = checked.filter((file) => !suiteFiles.has(file) && !isPreviewScript(file));
	check("and every one of them is a suite file the runner discovers, or a preview", unclassified.length === 0, unclassified.join(", "));

	/** The folders a suite file may live in: test/<domain>/<concept>.test.mjs. */
	const SUITE_DOMAINS = ["agents", "workflow", "agent-ui", "transcript", "wire", "session", "chrome", "views", "tools", "kit"];
	const IN_LAYOUT = new RegExp(`^(?:support/[^/]+|preview/[^/]+|(?:${SUITE_DOMAINS.join("|")})/[^/]+\\.test)\\.mjs$`);
	const modules = listTestModules(TEST_DIR);
	const misplaced = modules.filter((file) => file !== SUITE_RUNNER_FILE && !IN_LAYOUT.test(file));
	check(`every .mjs under test/ is the runner, a support module, a preview or <domain>/<concept>.test.mjs (${modules.length} of them)`, misplaced.length === 0, misplaced.join(", "));
}

await finish();
